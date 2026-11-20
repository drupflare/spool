import { buildPack, type BundleIndex, type BundleRows } from '../protocol/bundle.js';
import type { Dataset, DatasetRow, DatasetSeedContext } from '../protocol/dataset.js';
import { ProtocolError } from '../protocol/errors.js';
import { indexPlan, indexRowsOf } from '../protocol/index-rows.js';
import { canonicalJson } from '../protocol/query.js';
import type { Route } from '../protocol/route.js';
import type { BootShape } from './ring.js';
import { json } from './sync.js';

/** where built packs are kept, by version; a version's bytes never change once stored */
export interface BundleStore {
	put(version: number, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	get(version: number): Promise<Uint8Array<ArrayBuffer> | undefined>;
}

/** a store that lives as long as the process; fine for tests and single-instance Node */
export function memoryBundleStore(): BundleStore {
	const held = new Map<number, Uint8Array<ArrayBuffer>>();
	return {
		put: async (version, bytes) => {
			held.set(version, bytes);
		},
		get: async (version) => held.get(version)
	};
}

/** what `buildBundle` takes */
export type BuildBundleOptions = {
	store: BundleStore;
	/** the datasets given to createSpool; a principal dataset is left out, since a pack is public */
	datasets: readonly Dataset[];
	/** the version the pack is built for; the caller keeps it unique per content */
	version: number;
	/** the URL the datasets' seed functions receive; their path and origin only */
	url: URL;
	/** rows per block; the protocol default when absent */
	blockRows?: number;
	/** the routes the pack answers; their path and query index tables go into the pack */
	routes?: readonly Route[];
	/** most compressed bytes of one block; the frame cap a reader accepts when absent */
	maxBytes?: number;
};

/** what `buildBundle` returns */
export type BuiltBundle = { version: number; index: BundleIndex; bytes: Uint8Array<ArrayBuffer> };

const encoder = new TextEncoder();

async function seedRows(dataset: Dataset, ctx: DatasetSeedContext): Promise<BundleRows> {
	const rows: BundleRows = [];
	let bytes = 0;
	const take = (row: DatasetRow) => {
		const key = dataset.key(row);
		if (typeof key !== 'string') {
			throw new ProtocolError('bad-dataset', `${dataset.name}: a row key must be a string`);
		}
		rows.push([key, row]);
		bytes += encoder.encode(canonicalJson(row)).length;
		if (rows.length > dataset.maxRows || bytes > dataset.maxBytes) {
			throw new ProtocolError('dataset-limit', `${dataset.name}: over the seed limit`);
		}
	};
	const add = (item: unknown) => {
		if (Array.isArray(item)) for (const row of item) take(row as DatasetRow);
		else take(item as DatasetRow);
	};
	const result: unknown = await dataset.seed(ctx);
	if (Array.isArray(result)) for (const item of result) add(item);
	else if (Symbol.asyncIterator in Object(result)) {
		for await (const item of result as AsyncIterable<unknown>) add(item);
	} else for (const item of result as Iterable<unknown>) add(item);
	return rows;
}

function sameBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * The index tables the public routes need. A family route adds `path:<dataset>`, each row's
 * concrete path mapped to its key. A query route adds `query:<dataset>`, each row's filter and sort
 * fields. A plan, a principal route and a pattern with a param other than the key add nothing.
 */
export function indexTables(
	routes: readonly Route[],
	tables: Record<string, BundleRows>
): Record<string, BundleRows> {
	const held = (dataset: string, pattern: string) => {
		if (!Object.hasOwn(tables, dataset)) {
			throw new ProtocolError('bad-bundle', `${pattern}: ${dataset} is not a public dataset`);
		}
	};
	for (const route of routes) {
		if (route.scope !== 'public') continue;
		if (route.family) held(route.family.dataset, route.pattern);
		if (route.query?.dataset !== undefined && route.query.plan === undefined) {
			held(route.query.dataset, route.pattern);
		}
	}
	const plan = indexPlan(routes);
	const pathDatasets = [...new Set(plan.paths.map((path) => path.dataset))];
	const datasets = new Set([...pathDatasets, ...plan.fields.keys()]);
	const out: Record<string, BundleRows> = {};
	for (const dataset of pathDatasets) out[`path:${dataset}`] = [];
	for (const dataset of plan.fields.keys()) out[`query:${dataset}`] = [];
	for (const name of Object.keys(out)) {
		if (Object.hasOwn(tables, name)) {
			throw new ProtocolError('bad-bundle', `${name} is already a table of the pack`);
		}
	}
	for (const dataset of datasets) {
		for (const [key, row] of tables[dataset] ?? []) {
			for (const [table, rowKey, value] of indexRowsOf(plan, dataset, key, row)) {
				if (value !== null) out[table]?.push([rowKey, value]);
			}
		}
	}
	return out;
}

/**
 * Builds the pack of the public datasets at `version` and keeps it in `store`. A version that
 * already holds other bytes is refused, since its URL is served as immutable. A site with no
 * dataset builds an empty pack.
 */
export async function buildBundle(options: BuildBundleOptions): Promise<BuiltBundle> {
	const ctx: DatasetSeedContext = { request: new Request(options.url), url: options.url };
	const tables: Record<string, BundleRows> = {};
	for (const dataset of options.datasets) {
		if (dataset.scope !== 'public') continue;
		if (Object.hasOwn(tables, dataset.name)) {
			throw new ProtocolError('bad-dataset', `${dataset.name}: declared twice`);
		}
		tables[dataset.name] = await seedRows(dataset, ctx);
	}
	const { index, bytes } = await buildPack(
		{
			version: options.version,
			tables: { ...tables, ...indexTables(options.routes ?? [], tables) }
		},
		options.blockRows,
		options.maxBytes
	);
	const held = await options.store.get(options.version);
	if (held === undefined) await options.store.put(options.version, bytes);
	else if (!sameBytes(held, bytes)) {
		throw new ProtocolError(
			'bad-bundle',
			`bundle ${options.version} already holds other bytes`
		);
	}
	return { version: options.version, index, bytes };
}

/** the response to `GET /.spool/bundle/<version>`: the pack bytes, or 404 for a version not held */
export async function respondBundle(
	store: BundleStore | undefined,
	version: string
): Promise<Response> {
	const number = /^\d{1,15}$/.test(version) ? Number(version) : undefined;
	const bytes = store && number !== undefined ? await store.get(number) : undefined;
	if (bytes === undefined) return json({ error: 'no bundle' }, 404);
	return new Response(bytes, {
		headers: {
			'content-type': 'application/octet-stream',
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
}

/** base64 of `bytes`, built in slices so the argument list of `fromCharCode` stays small */
function base64(bytes: Uint8Array): string {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(text);
}

/**
 * The response to `GET /.spool/<runtime>/boot/<version>.js`: `code`, the page runtime and the
 * navigation script, after a line that hands the pack at `version` to the runtime as base64. One
 * script tag then installs the runtime and the pack in one request. With a `shape` the same line
 * also hands over the routes and templates, so no document has to carry them. 404 for a version
 * not held.
 */
export async function respondBoot(
	store: BundleStore | undefined,
	version: string,
	code: string,
	shape?: BootShape
): Promise<Response> {
	const number = /^\d{1,15}$/.test(version) ? Number(version) : undefined;
	const bytes = store && number !== undefined ? await store.get(number) : undefined;
	if (bytes === undefined || number === undefined) return json({ error: 'no bundle' }, 404);
	const boot = '(globalThis.__SPOOL_BOOT__=globalThis.__SPOOL_BOOT__||{})';
	const given = shape ? `${boot}.shape=${JSON.stringify(shape)};` : '';
	const hand = `${given}${boot}.pack={version:${number},data:"${base64(bytes)}"};\n`;
	return new Response(hand + code, {
		headers: {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
}
