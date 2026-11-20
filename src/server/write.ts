import {
	buildPack,
	bundleDigest,
	makeDelta,
	readBundle,
	type BundleRows
} from '../protocol/bundle.js';
import type { Dataset } from '../protocol/dataset.js';
import { HEADERS } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { shellHash } from '../protocol/hash.js';
import type { Identity, Route } from '../protocol/route.js';
import {
	isWriteId,
	isWriteKey,
	readIfMatch,
	WRITE_HEADERS,
	WRITE_STATUS,
	type Write,
	type WriteContext,
	type WriteRefusalCode
} from '../protocol/write.js';
import type { VersionStore } from '../stores/version-store.js';
import { buildBundle, indexTables, memoryBundleStore, type BundleStore } from './bundle.js';
import { json } from './sync.js';

/** how many `(class, principal, key)` slots the server remembers an applied write id for */
export const DEFAULT_REMEMBER = 10_000;

/** what {@link createWriteServer} takes */
export type WriteServerOptions = {
	/** false answers every request with `writes-off` */
	enabled: boolean;
	writes: readonly Write[];
	/** slots whose last applied id is remembered, oldest forgotten first; default {@link DEFAULT_REMEMBER} */
	remember?: number;
};

/** the handler `createSpool` routes `PUT /.spool/write` to */
export type WriteServer = {
	respond(request: Request, identity: Identity | null): Promise<Response>;
};

type Applied = { id: string; hash: string };

const refuse = (code: WriteRefusalCode, error: string, headers: Record<string, string> = {}) =>
	json({ code, error }, WRITE_STATUS[code], headers);

/** the body as text, or null when it is longer than `max` bytes; stops reading once it is */
async function readBounded(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? Number.NaN);
	if (declared > max) return null;
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const whole = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		whole.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(whole);
}

/**
 * Answers `PUT /.spool/write?name=<n>&key=<k>` with `If-Match: "<version>"` and a `Spool-Write-Id`.
 * It checks the declaration, the principal, the key the site derives for that principal, the version
 * header and the body size before `apply` runs, and runs one request per `(class, principal, key)` at
 * a time. The last applied write id of each slot is kept in memory: a repeat of that id and body
 * answers 200 with the current version and applies nothing, and the same id with another body is
 * refused. Memory is per server instance, so a deployment with several instances needs the site's
 * `apply` to store `ctx.writeId` with the value to keep a retry that lands on another instance from
 * reading as a conflict.
 */
export function createWriteServer(options: WriteServerOptions): WriteServer {
	const byName = new Map(options.writes.map((write) => [write.name, write]));
	const limit = options.remember ?? DEFAULT_REMEMBER;
	const applied = new Map<string, Applied>();
	const locks = new Map<string, Promise<unknown>>();

	const remember = (slot: string, entry: Applied) => {
		applied.delete(slot);
		applied.set(slot, entry);
		while (applied.size > limit) applied.delete(applied.keys().next().value as string);
	};

	/** runs `fn` after every earlier request for the same slot */
	function exclusive<T>(slot: string, fn: () => Promise<T>): Promise<T> {
		const run = (locks.get(slot) ?? Promise.resolve()).then(fn, fn);
		const tail = run.catch(() => undefined);
		locks.set(slot, tail);
		void tail.then(() => {
			if (locks.get(slot) === tail) locks.delete(slot);
		});
		return run;
	}

	return {
		async respond(request, identity) {
			if (!options.enabled) return refuse('writes-off', 'declared writes are off');
			if (request.method !== 'PUT') {
				return refuse('bad-method', 'use PUT', { allow: 'PUT' });
			}
			const url = new URL(request.url);
			const write = byName.get(url.searchParams.get('name') ?? '');
			if (!write) return refuse('unknown-write', 'no such write class');
			if (!identity) return refuse('sign-in', 'sign in to write');
			const key = url.searchParams.get('key');
			if (!isWriteKey(key)) return refuse('bad-key', 'key is missing or malformed');
			const id = request.headers.get(WRITE_HEADERS.id);
			if (!isWriteId(id)) return refuse('bad-id', 'Spool-Write-Id is missing or malformed');
			const header = request.headers.get('if-match');
			if (header === null) return refuse('missing-version', 'If-Match is required');
			const version = readIfMatch(header);
			if (version === null) return refuse('bad-version', 'If-Match is not one version');
			const ctx: WriteContext = { identity, writeId: id };
			if ((await write.key(ctx, request)) !== key) {
				return refuse('forbidden', 'that key is not yours');
			}
			const text = await readBounded(request, write.maxBytes);
			if (text === null)
				return refuse('too-large', `the body is over ${write.maxBytes} bytes`);
			let value: unknown;
			try {
				const body = JSON.parse(text) as { value?: unknown } | null;
				if (typeof body !== 'object' || body === null || !('value' in body))
					throw new Error();
				value = body.value;
			} catch {
				return refuse('bad-body', 'the body must be JSON of the form {"value": ...}');
			}
			const slot = `${write.name}\u0000${identity.principal}\u0000${key}`;
			return exclusive(slot, async () => {
				const hash = await shellHash(text);
				const last = applied.get(slot);
				if (last?.id === id) {
					if (last.hash !== hash)
						return refuse('id-reused', 'that id was used for another body');
					return json({ version: (await write.read(ctx, key)).version });
				}
				const result = await write.apply(ctx, key, value, version);
				if ('conflict' in result)
					return json({ code: 'conflict', conflict: result.conflict }, 412);
				remember(slot, { id, hash });
				return json({ version: result.version });
			});
		}
	};
}

/** the most bytes a `Spool-Delta` header may carry; past it the worker fetches the delta route */
export const DELTA_HEADER_BYTES = 16_384;

/** what {@link createResourceWrites} takes */
export type ResourceWriteOptions = {
	datasets: ReadonlyMap<string, Dataset>;
	store: VersionStore;
	bundles: BundleStore;
	/** the site's routes; their index tables go into every pack a write builds, as `publish` does */
	routes: readonly Route[];
	blockRows?: number;
	maxBytes?: number;
};

/**
 * Runs a declared resource write's handler and, when it answers 2xx, attaches the rows the handler
 * changed as `Spool-Delta`. The store moves to the version of the new pack, and that pack is kept, so the
 * delta route and the worker script can reach it. Writes run one at a time, so each starts from the pack
 * the one before it left.
 */
export function createResourceWrites(
	options: ResourceWriteOptions
): (
	request: Request,
	next: (request: Request) => Response | Promise<Response>
) => Promise<Response> {
	let tail: Promise<unknown> = Promise.resolve();
	return (request, next) => {
		const run = tail.then(() => runResourceWrite(request, next, options));
		tail = run.catch(() => undefined);
		return run;
	};
}

/** the rows of one public dataset, read in full; for a dataset whose `changes` answers `reset` */
async function reseed(dataset: Dataset, url: URL): Promise<BundleRows> {
	const scratch = memoryBundleStore();
	await buildBundle({ store: scratch, datasets: [dataset], version: 0, url });
	const bytes = await scratch.get(0);
	if (!bytes) throw new ProtocolError('bad-bundle', `${dataset.name}: the reseed stored no pack`);
	return (await readBundle(bytes)).state.tables[dataset.name] ?? [];
}

async function runResourceWrite(
	request: Request,
	next: (request: Request) => Response | Promise<Response>,
	{ datasets, store, bundles, routes, blockRows, maxBytes }: ResourceWriteOptions
): Promise<Response> {
	const url = new URL(request.url);
	const ctx = { request, url };
	const publics = [...datasets.values()].filter((dataset) => dataset.scope === 'public');
	const before = await store.cursor();
	const heads = new Map<string, number>();
	for (const dataset of publics) heads.set(dataset.name, (await dataset.head(ctx)).cursor);
	if (!(await bundles.get(before))) {
		await buildBundle({
			store: bundles,
			datasets: publics,
			routes,
			version: before,
			url,
			blockRows,
			maxBytes
		});
	}
	const bytes = await bundles.get(before);
	const response = await next(request);
	if (!bytes || !response.ok) return response;

	const base = await readBundle(bytes);
	const tables: Record<string, BundleRows> = {};
	for (const dataset of publics) tables[dataset.name] = base.state.tables[dataset.name] ?? [];
	const moved: string[] = [];
	for (const dataset of publics) {
		const change = await dataset.changes(heads.get(dataset.name) as number, ctx);
		if (change === 'reset') {
			tables[dataset.name] = await reseed(dataset, url);
			moved.push(dataset.name);
			continue;
		}
		if (change.puts.length === 0 && change.deletes.length === 0) continue;
		const rows = new Map(tables[dataset.name] ?? []);
		for (const { key } of change.deletes) rows.delete(key);
		if (change.puts.length > 0) {
			for (const row of await dataset.read(change.puts, ctx)) rows.set(dataset.key(row), row);
		}
		tables[dataset.name] = [...rows];
		moved.push(dataset.name);
	}
	if (moved.length === 0) return response;

	const to = await store.bump(moved);
	const state = { version: to, tables: { ...tables, ...indexTables(routes, tables) } };
	const built = await buildPack(state, blockRows, maxBytes);
	await bundles.put(to, built.bytes);
	const text = JSON.stringify(await makeDelta(base.state, state));
	const headers = new Headers(response.headers);
	if (new TextEncoder().encode(text).length <= DELTA_HEADER_BYTES) {
		headers.set(HEADERS.delta, text);
	} else {
		headers.set(WRITE_HEADERS.digest, await bundleDigest(state.tables));
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
