import { shellHash } from '../protocol/hash.js';
import type { Identity } from '../protocol/route.js';
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
