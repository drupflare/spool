import type { BundleRows } from '../protocol/bundle.js';
import { readBundle } from '../protocol/bundle.js';
import { BUNDLE_PREFIX, COOKIES } from '../protocol/config.js';
import type { DatasetRow } from '../protocol/dataset.js';
import {
	type BootstrapGate,
	DELTA_ELEMENT_ID,
	type Ring,
	RING_ELEMENT_ID,
	type WorkerMode,
	WRITES_ELEMENT_ID
} from '../protocol/ring.js';
import { matchRoute, type Route, type SerializedRoute, serializeRoute } from '../protocol/route.js';
import type { CompiledTemplate } from '../protocol/template/compile.js';
import type { ResourceWrite } from '../protocol/write.js';
import type { BundleStore } from './bundle.js';

/** the ring's byte budget when `createSpool` names none; a default, not measured */
export const RING_BYTES = 24_576;

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).length;

/** a stored pack as a ring reads it: its digest, its rows by table and its byte length */
export type RingPack = { digest: string; tables: Record<string, BundleRows>; bytes: number };

/** a row of one table: the table, its key and the row */
type Entry = [table: string, key: string, row: DatasetRow];

export type RingOptions = {
	/** the pathname of the page the ring is for */
	path: string;
	version: number;
	digest: string;
	/** the declared routes; only the public family and query routes take part */
	routes: readonly Route[];
	tables: Record<string, BundleRows>;
	/** the byte length of the pack the ring falls back to */
	packBytes: number;
	ringBytes: number;
	bootstrap: BootstrapGate;
	worker: WorkerMode;
	/** the boot script path the ring names, when the page loads its runtime through the gate */
	boot?: string;
	/** the worker script's lease in seconds, carried so the page counts views inside one lease */
	lease?: number;
	/**
	 * a ring with no rows, routes or templates: the pack location and the boot script only. The
	 * boot script carries the pack, the routes and the templates, so none of them rides in every
	 * document or is installed twice.
	 */
	slim?: boolean;
	/** the declared resource writes; they count against the budget as the routes do */
	writes?: readonly ResourceWrite[];
};

const pathIndexes = new WeakMap<Record<string, BundleRows>, Map<string, Map<string, Entry[]>>>();

/** each dataset's `path:<dataset>` rows by row key, so a row finds its concrete paths */
function pathIndex(tables: Record<string, BundleRows>): Map<string, Map<string, Entry[]>> {
	const held = pathIndexes.get(tables);
	if (held) return held;
	const out = new Map<string, Map<string, Entry[]>>();
	for (const [name, rows] of Object.entries(tables)) {
		if (!name.startsWith('path:')) continue;
		const byKey = new Map<string, Entry[]>();
		for (const [path, value] of rows) {
			const key = String(value['key']);
			byKey.set(key, [...(byKey.get(key) ?? []), [name, path, value]]);
		}
		out.set(name.slice('path:'.length), byKey);
	}
	pathIndexes.set(tables, out);
	return out;
}

function rowAt(rows: BundleRows | undefined, key: string): DatasetRow | undefined {
	if (!rows) return undefined;
	let low = 0;
	let high = rows.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const entry = rows[mid];
		if (!entry) return undefined;
		if (entry[0] === key) return entry[1];
		if (entry[0] < key) low = mid + 1;
		else high = mid - 1;
	}
	return undefined;
}

/** a row with its concrete paths and its query row: everything a page of it needs from the pack */
function recordOf(
	tables: Record<string, BundleRows>,
	paths: Map<string, Map<string, Entry[]>>,
	dataset: string,
	key: string
): Entry[] | undefined {
	const row = rowAt(tables[dataset], key);
	if (row === undefined) return undefined;
	const query = rowAt(tables[`query:${dataset}`], key);
	return [
		[dataset, key, row],
		...(paths.get(dataset)?.get(key) ?? []),
		...(query === undefined ? [] : [[`query:${dataset}`, key, query] as Entry])
	];
}

/** the rows a page joins, one record each, in the order the plan declares its joins */
function joinedOf(
	tables: Record<string, BundleRows>,
	paths: Map<string, Map<string, Entry[]>>,
	route: Route,
	row: DatasetRow
): Entry[][] {
	const out: Entry[][] = [];
	for (const join of route.query?.plan?.join ?? []) {
		const [from, to] = join.on;
		const value = row[from];
		if (value === undefined) continue;
		if (to === null) {
			const record =
				typeof value === 'string'
					? recordOf(tables, paths, join.dataset, value)
					: undefined;
			if (record) out.push(record);
			continue;
		}
		for (const [key, other] of tables[join.dataset] ?? []) {
			if (other[to] !== value) continue;
			const record = recordOf(tables, paths, join.dataset, key);
			if (record) out.push(record);
		}
	}
	return out;
}

/** every string value of a row, in the order the row holds them */
function stringsOf(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
	else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) stringsOf(item, out);
	}
	return out;
}

/** the public family and query routes a ring or a boot script carries, serialized, with their templates */
function ringRoutes(declared: readonly Route[]) {
	const routes = declared.filter(
		(route) => route.scope === 'public' && (route.family || route.query)
	);
	const templates = Object.fromEntries(
		routes.flatMap((route) =>
			route.template ? [[route.pattern, route.template] as const] : []
		)
	);
	return { routes, serialized: routes.map(serializeRoute), templates };
}

/** the routes and templates a boot script carries, with `id`, a digest of both */
export type BootShape = {
	id: string;
	routes: SerializedRoute[];
	templates: Record<string, CompiledTemplate>;
};

/** the shape of `declared`; its id is 12 hex characters of the SHA-256 of the routes and templates */
export async function bootShape(declared: readonly Route[]): Promise<BootShape> {
	const { serialized, templates } = ringRoutes(declared);
	const hash = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(JSON.stringify([serialized, templates]))
	);
	const id = [...new Uint8Array(hash).subarray(0, 6)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return { id, routes: serialized, templates };
}

/**
 * Builds the ring for one family page: its row and the rows its links reach, breadth first, until
 * the next record would pass `ringBytes`. The entry row, the routes and their templates are always
 * held: they count against the budget but are never dropped. Returns `undefined` for a path no
 * public family route matches, or whose row the pack does not hold. A `slim` ring does not depend
 * on the page: it is the same for every path, and `undefined` only when no public route reads data.
 */
export function buildRing(options: RingOptions): Ring | undefined {
	const { routes, serialized, templates } = ringRoutes(options.routes);
	const writes = options.writes ?? [];
	const worker = {
		worker: options.worker === 'never' ? ('never' as const) : ('auto' as const),
		...(options.worker === 'always' ? { webkitWorker: true as const } : {})
	};
	if (options.slim) {
		if (routes.length === 0) return undefined;
		return {
			protocol: 1,
			version: options.version,
			digest: options.digest,
			tables: {},
			complete: false,
			bootstrap: options.bootstrap,
			...worker,
			...(options.boot ? { boot: options.boot } : {}),
			...(options.lease === undefined ? {} : { lease: options.lease }),
			pack: { url: `${BUNDLE_PREFIX}${options.version}`, bytes: options.packBytes },
			...(writes.length > 0 ? { writes: [...writes] } : {})
		};
	}
	const entry = matchRoute(routes, options.path);
	const family = entry?.route.family;
	if (!entry || !family) return undefined;
	const tables = options.tables;
	const paths = pathIndex(tables);
	const rowKey = entry.params[family.key];
	const first =
		rowKey === undefined ? undefined : recordOf(tables, paths, family.dataset, rowKey);
	if (!first) return undefined;

	const held = new Map<string, Map<string, DatasetRow>>();
	let used =
		bytesOf(JSON.stringify(serialized)) +
		bytesOf(JSON.stringify(templates)) +
		bytesOf(JSON.stringify(writes));
	const admit = (record: Entry[], force = false): boolean => {
		const fresh = record.filter(([table, key]) => !held.get(table)?.has(key));
		const size = fresh.reduce(
			(sum, [, key, row]) => sum + bytesOf(JSON.stringify([key, row])),
			0
		);
		if (!force && used + size > options.ringBytes) return false;
		for (const [table, key, row] of fresh) {
			const rows = held.get(table) ?? new Map<string, DatasetRow>();
			rows.set(key, row);
			held.set(table, rows);
		}
		used += size;
		return true;
	};

	admit(first, true);
	const seen = new Set([`${family.dataset}\n${rowKey}`]);
	const pages: Array<{ route: Route; row: DatasetRow }> = [
		{ route: entry.route, row: first[0]?.[2] ?? {} }
	];
	let open = true;
	for (let i = 0; i < pages.length && open; i++) {
		const page = pages[i] as { route: Route; row: DatasetRow };
		for (const record of joinedOf(tables, paths, page.route, page.row)) {
			if (!admit(record)) {
				open = false;
				break;
			}
		}
		for (const value of stringsOf(page.row)) {
			if (!open) break;
			const path = value.split(/[?#]/)[0] ?? '';
			const hit = path.startsWith('/') ? matchRoute(routes, path) : null;
			const linked = hit?.route.family;
			const key = linked ? hit?.params[linked.key] : undefined;
			if (!hit || !linked || key === undefined) continue;
			const id = `${linked.dataset}\n${key}`;
			if (seen.has(id)) continue;
			const record = recordOf(tables, paths, linked.dataset, key);
			if (!record) continue;
			if (!admit(record)) {
				open = false;
				break;
			}
			seen.add(id);
			pages.push({ route: hit.route, row: record[0]?.[2] ?? {} });
		}
	}

	const out: Record<string, BundleRows> = {};
	let heldRows = 0;
	for (const [table, rows] of held) {
		const sorted = [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		out[table] = sorted;
		heldRows += sorted.length;
	}
	const totalRows = Object.values(tables).reduce((sum, rows) => sum + rows.length, 0);
	const complete = heldRows === totalRows;
	const ring: Ring = {
		protocol: 1,
		version: options.version,
		digest: options.digest,
		routes: serialized,
		templates,
		tables: out,
		complete,
		bootstrap: options.bootstrap,
		...worker,
		...(options.boot ? { boot: options.boot } : {}),
		...(options.lease === undefined ? {} : { lease: options.lease }),
		...(writes.length > 0 ? { writes: [...writes] } : {})
	};
	if (!complete)
		ring.pack = { url: `${BUNDLE_PREFIX}${options.version}`, bytes: options.packBytes };
	return ring;
}

/**
 * The paths a click may load the boot script for: the part of each public template family
 * pattern before its first parameter, and `?` plus the path of each list that answers a query
 * string. The page runtime answers only these, so a click anywhere else stays a document load.
 */
export function gatePaths(routes: readonly Route[]): string[] {
	const out = new Set<string>();
	for (const route of routes) {
		if (route.scope !== 'public' || route.strategy !== 'template' || !route.template) continue;
		if (route.navigation === 'document') continue;
		const param = route.pattern.search(/:|\*\*/);
		let path = '';
		if (route.family) path = param < 0 ? route.pattern : route.pattern.slice(0, param);
		else if (
			param < 0 &&
			route.query?.dataset !== undefined &&
			route.query.plan === undefined
		) {
			path = `?${route.pattern}`;
		}
		if (path && !/\s/.test(path)) out.add(path);
	}
	return [...out];
}

/** the script element that carries the declared writes of a page with no ring; `<` becomes a `\u` escape */
export function writesElement(writes: readonly ResourceWrite[]): string {
	const json = JSON.stringify(writes).replace(/</g, '\\u003c');
	return `<script type="application/json" id="${WRITES_ELEMENT_ID}">${json}</script>`;
}

/** the script element that carries `ring`; `<` becomes a `\u` escape, so no row can close it */
export function ringElement(ring: Ring): string {
	const json = JSON.stringify(ring).replace(/</g, '\\u003c');
	return `<script type="application/json" id="${RING_ELEMENT_ID}">${json}</script>`;
}

/** the held version a request names in its cookie, or undefined */
export function heldVersion(cookie: string | null): number | undefined {
	const match =
		cookie && new RegExp(`(?:^|;\\s*)${COOKIES.held}=(\\d{1,15})(?:;|$)`).exec(cookie);
	return match ? Number(match[1]) : undefined;
}

/** the script element that carries the delta from `from` to `to`; no `text` makes a pointer the client fetches */
export function deltaElement(from: number, to: number, text?: string): string {
	const json = (text ?? '').replace(/</g, '\\u003c');
	return `<script type="application/json" id="${DELTA_ELEMENT_ID}" data-from="${from}" data-to="${to}">${json}</script>`;
}

/** `html` with `element` before `</head>`, else before `</body>`, else at the end */
export function placeRing(html: string, element: string): string {
	for (const close of [/<\/head\s*>/i, /<\/body\s*>/i]) {
		const at = html.search(close);
		if (at >= 0) return html.slice(0, at) + element + html.slice(at);
	}
	return html + element;
}

/**
 * The pack the store holds at a version, read once and kept until the version moves. A version
 * with no stored pack answers `undefined` and is not kept.
 */
export function ringPacks(
	bundles: BundleStore
): (version: number) => Promise<RingPack | undefined> {
	let held: { version: number; pack: Promise<RingPack> } | undefined;
	return async (version) => {
		if (held?.version === version) return held.pack;
		const bytes = await bundles.get(version);
		if (bytes === undefined) return undefined;
		const pack = readBundle(bytes).then(({ index, state }) => ({
			digest: index.digest,
			tables: state.tables,
			bytes: bytes.length
		}));
		held = { version, pack };
		return pack;
	};
}
