import {
	BLOCK_ROWS,
	buildPack,
	bundleDigest,
	compactionDue,
	readBlock,
	readFrames,
	type BundleDelta,
	type BundleDeltaTable,
	type BundleIndex,
	type BundleRows
} from '../../protocol/bundle.js';
import type { DatasetRow } from '../../protocol/dataset.js';
import { ProtocolError } from '../../protocol/errors.js';
import {
	canonicalJson,
	digestAdd,
	digestSub,
	EMPTY_DIGEST,
	rowHash
} from '../../protocol/query.js';
import type { Ring } from '../../protocol/ring.js';
import type { SerializedRoute } from '../../protocol/route.js';
import type { CompiledTemplate } from '../../protocol/template/compile.js';
import { done, wrap } from '../idb.js';

type Bytes = Uint8Array<ArrayBuffer>;
type Change = DatasetRow | null;
type Changes = Array<[string, Change]>;
type RouteRecord = { order: number; route: SerializedRoute; template?: CompiledTemplate };

/**
 * the active pack: version, set digest, generation (the key space of its records) and layout. A
 * partial head is a ring: its rows sit in the overlay and it has no blocks, so a key it does not
 * hold is a miss.
 */
export type PackHead = StoredHead & {
	/** rows a write predicted and no verified delta has confirmed or dropped yet */
	unconfirmed: number;
};

type StoredHead = {
	version: number;
	digest: string;
	generation: number;
	blockRows: number;
	codec: 'gzip';
	tables: string[];
	partial?: true;
};

/** rows a write's answer predicts: a row to put, or a key to delete, per table */
export type Predicted = {
	puts: Array<[table: string, key: string, row: DatasetRow]>;
	deletes: Array<[table: string, key: string]>;
};

/** one table of one generation: its row count and, per block, first key, last key and hash */
export type PackIndex = { rows: number; first: string[]; last: string[]; hashes: string[] };

export type PackCounters = { blockReads: number; blockInflates: number; overlayReads: number };

export type RecordCounts = { blocks: number; index: number; overlay: number; head: number };

export type FitOutcome =
	| { checked: false; fits: true }
	| { checked: true; fits: true }
	| { checked: true; fits: false; bytes: number; usage: number; quota: number };

export type InstallOutcome =
	| { installed: true; version: number; tables: number; rows: number; blocks: number }
	| { installed: false; fit: Extract<FitOutcome, { fits: false }> };

/** a ring is refused when it is older than the held pack, or names the complete pack already held */
export type RingOutcome =
	| { installed: true; version: number; rows: number; complete: boolean }
	| { installed: false; reason: 'older' | 'held' };

export type InstallOptions = {
	/** the pack's size in bytes; when given, the install is refused if it would not fit */
	bytes?: number;
};

export type StorageEstimate = { usage?: number; quota?: number };

export type PackStoreOptions = {
	/** the database name; `spool-bundle` unless a test names its own */
	name?: string;
	/** the storage estimate; defaults to `navigator.storage.estimate` where the browser has it */
	estimate?: () => Promise<StorageEstimate | undefined>;
};

export type PackStore = {
	readonly counters: PackCounters;
	head(): Promise<PackHead | undefined>;
	recordCounts(): Promise<RecordCounts>;
	installPack(source: AsyncIterable<Bytes>, options?: InstallOptions): Promise<InstallOutcome>;
	/** holds a ring as a partial or a complete head; its routes and templates are replaced */
	installRing(ring: Ring): Promise<RingOutcome>;
	estimateBeforeInstall(bytes: number): Promise<FitOutcome>;
	applyDelta(delta: BundleDelta): Promise<void>;
	/** lays predicted rows over the pack without moving its version; a no-op when no pack is held */
	applyPredicted(predicted: Predicted): Promise<void>;
	/** moves to `to` with the predicted rows as the change; throws and keeps them when `digest` is not theirs */
	confirmPredicted(to: number, digest: string): Promise<void>;
	/** removes every predicted row and keeps the version */
	dropPredicted(): Promise<void>;
	getRow(table: string, key: string): Promise<DatasetRow | undefined>;
	scanTable(table: string): Promise<BundleRows>;
	compact(): Promise<boolean>;
	/** replaces the held routes with `routes`, kept in the order given */
	/** `templates` holds the compiled template of each route that has one, keyed by pattern */
	putRoutes(
		routes: SerializedRoute[],
		templates?: Record<string, CompiledTemplate>
	): Promise<void>;
	getRoutes(): Promise<SerializedRoute[]>;
	getTemplates(): Promise<Record<string, CompiledTemplate>>;
};

const STORES = ['blocks', 'index', 'overlay', 'head', 'templates', 'predicted'] as const;
const ACTIVE = 'active';
const INDEX_FRAME = -1;
const DIGEST_FORM = /^[0-9a-f]{64}$/;

/** bytes kept free past an install's own size; a default, not measured */
export const QUOTA_MARGIN_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function refuse(message: string): never {
	throw new ProtocolError('bad-sync', message);
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseIndex(payload: Bytes): BundleIndex {
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(payload));
	} catch {
		refuse('the index is not JSON');
	}
	if (typeof value !== 'object' || value === null) refuse('the index is not an object');
	const index = value as BundleIndex;
	if (
		!isCount(index.version) ||
		index.codec !== 'gzip' ||
		!isCount(index.blockRows) ||
		index.blockRows < 1 ||
		typeof index.digest !== 'string' ||
		!DIGEST_FORM.test(index.digest) ||
		!Array.isArray(index.tables)
	) {
		refuse('the index has a bad version, codec, block size or digest');
	}
	const names = new Set<string>();
	for (const entry of index.tables) {
		if (
			typeof entry.name !== 'string' ||
			names.has(entry.name) ||
			!isCount(entry.rows) ||
			entry.rows < 1 ||
			typeof entry.first !== 'string' ||
			!Array.isArray(entry.blocks) ||
			entry.blocks.length !== Math.ceil(entry.rows / index.blockRows) ||
			!entry.blocks.every((hash) => typeof hash === 'string')
		) {
			refuse('an index table does not match its rows and blocks');
		}
		names.add(entry.name);
	}
	return index;
}

/** the block whose first and last keys hold `key`, or -1 */
function blockFor(record: PackIndex, key: string): number {
	let low = 0;
	let high = record.first.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if ((record.first[mid] ?? '') <= key) {
			found = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return found >= 0 && key <= (record.last[found] ?? '') ? found : -1;
}

function find(rows: BundleRows, key: string): DatasetRow | undefined {
	let low = 0;
	let high = rows.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const entry = rows[mid];
		if (entry?.[0] === key) return entry[1];
		if ((entry?.[0] ?? '') < key) low = mid + 1;
		else high = mid - 1;
	}
	return undefined;
}

async function sha256Url(bytes: Bytes): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gzip(bytes: Bytes): Promise<Bytes> {
	const piped = new Response(bytes).body?.pipeThrough(new CompressionStream('gzip'));
	if (!piped) refuse('no body to compress');
	return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function* once(bytes: Bytes): AsyncGenerator<Bytes> {
	yield bytes;
}

/** the overlay's changes grouped by table; each list stays in key order */
function byTable(entries: Array<[string, string, Change]>): Map<string, Changes> {
	const out = new Map<string, Changes>();
	for (const [table, key, row] of entries) {
		const list = out.get(table) ?? [];
		list.push([key, row]);
		out.set(table, list);
	}
	return out;
}

/** `above` laid over `below`, both in key order; a key in both takes the `above` change */
function laid(below: Changes, above: Changes): Changes {
	const out = new Map<string, Change>(below);
	for (const [key, row] of above) out.set(key, row);
	return [...out].sort(([a], [b]) => (a < b ? -1 : 1));
}

function deltaTables(changes: Map<string, Changes>): Record<string, BundleDeltaTable> {
	const tables: Record<string, BundleDeltaTable> = {};
	for (const [table, list] of changes) {
		tables[table] = {
			puts: list.flatMap(([key, row]): BundleRows => (row === null ? [] : [[key, row]])),
			deletes: list.flatMap(([key, row]) => (row === null ? [key] : []))
		};
	}
	return tables;
}

async function browserEstimate(): Promise<StorageEstimate | undefined> {
	const browser = (
		globalThis as unknown as {
			navigator?: { storage?: { estimate(): Promise<StorageEstimate> } };
		}
	).navigator;
	return browser?.storage?.estimate();
}

/**
 * A device's site pack in IndexedDB `spool-bundle`: compressed blocks of sorted rows, an overlay of
 * changed rows, and one head record that names the active pack. A read inflates at most one block.
 */
export function createPackStore(
	factory: IDBFactory = indexedDB,
	options: PackStoreOptions = {}
): PackStore {
	const name = options.name ?? 'spool-bundle';
	const estimate = options.estimate ?? browserEstimate;
	const counters: PackCounters = { blockReads: 0, blockInflates: 0, overlayReads: 0 };
	const cache = new Map<string, { generation: number; ordinal: number; rows: BundleRows }>();
	let opened: Promise<IDBDatabase> | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	const open = () =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(name, 2);
			request.onupgradeneeded = () => {
				for (const store of STORES) {
					if (!request.result.objectStoreNames.contains(store)) {
						request.result.createObjectStore(store);
					}
				}
			};
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => {
					db.close();
					opened = undefined;
				};
				resolve(db);
			};
			request.onerror = () => reject(request.error);
		}));

	async function run<T>(
		stores: string[],
		mode: IDBTransactionMode,
		body: (t: IDBTransaction) => T | Promise<T>
	): Promise<T> {
		const db = await open();
		const t = db.transaction(stores, mode);
		const finished = done(t);
		finished.catch(() => undefined);
		try {
			const result = await body(t);
			await finished;
			return result;
		} catch (error) {
			try {
				t.abort();
			} catch {
				// already finished
			}
			throw error;
		}
	}

	// installs, deltas and compactions run one at a time; reads do not wait on them
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const next = queue.then(work);
		queue = next.catch(() => undefined);
		return next;
	};

	const readHead = () =>
		run(['head', 'predicted'], 'readonly', async (t): Promise<PackHead | undefined> => {
			const head = await wrap<StoredHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (!head) return undefined;
			return { ...head, unconfirmed: await wrap<number>(t.objectStore('predicted').count()) };
		});

	const readIndex = (generation: number, table: string) =>
		run(['index'], 'readonly', (t) =>
			wrap<PackIndex | undefined>(t.objectStore('index').get([generation, table]))
		);

	async function overlayIn(
		t: IDBTransaction,
		range: IDBKeyRange,
		layer: 'overlay' | 'predicted' = 'overlay'
	): Promise<Array<[string, string, Change]>> {
		const store = t.objectStore(layer);
		const [keys, values] = await Promise.all([
			wrap<IDBValidKey[]>(store.getAllKeys(range)),
			wrap<Change[]>(store.getAll(range))
		]);
		if (layer === 'overlay') counters.overlayReads += keys.length;
		return keys.map((key, i): [string, string, Change] => {
			const [table, id] = key as [string, string];
			return [table, id, values[i] as Change];
		});
	}

	function inflate(
		head: PackHead,
		table: string,
		record: PackIndex,
		ordinal: number,
		payload: Bytes
	): Promise<BundleRows> {
		counters.blockInflates++;
		return readBlock(
			{
				version: head.version,
				codec: 'gzip',
				blockRows: head.blockRows,
				digest: head.digest,
				tables: [
					{
						name: table,
						rows: record.rows,
						first: record.first[0] ?? null,
						blocks: record.hashes
					}
				]
			},
			{ table: 0, ordinal, payload }
		);
	}

	async function blockAt(
		head: PackHead,
		table: string,
		record: PackIndex,
		ordinal: number
	): Promise<BundleRows> {
		const payload = await run(['head', 'blocks'], 'readonly', async (t) => {
			const now = await wrap<PackHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (now?.generation !== head.generation) refuse('the pack changed during a read');
			counters.blockReads++;
			return wrap<Bytes | undefined>(
				t.objectStore('blocks').get([head.generation, table, ordinal])
			);
		});
		if (!payload) refuse(`block ${table}/${ordinal} is missing`);
		return inflate(head, table, record, ordinal, payload);
	}

	/** a table's rows in key order: each block with the changes laid over it */
	async function* rowsOf(
		head: PackHead,
		record: PackIndex | undefined,
		table: string,
		changes: Changes
	): AsyncGenerator<[string, DatasetRow]> {
		const count = record?.hashes.length ?? 0;
		let at = 0;
		for (let ordinal = 0; ordinal <= count; ordinal++) {
			const last = record && ordinal < count;
			const base = last ? await blockAt(head, table, record, ordinal) : [];
			const end = last ? record.last[ordinal] : undefined;
			let b = 0;
			for (;;) {
				const change = changes[at];
				const next = base[b];
				if (
					change &&
					(end === undefined || change[0] <= end) &&
					(!next || change[0] <= next[0])
				) {
					at++;
					if (next && next[0] === change[0]) b++;
					if (change[1] !== null) yield [change[0], change[1]];
				} else if (next) {
					b++;
					yield next;
				} else break;
			}
		}
	}

	async function lookup(
		table: string,
		key: string,
		predicted: boolean
	): Promise<DatasetRow | undefined> {
		return run(['head', 'index', 'overlay', 'predicted', 'blocks'], 'readonly', async (t) => {
			const head = await wrap<PackHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (!head) return undefined;
			if (predicted) {
				const guess = await wrap<Change | undefined>(
					t.objectStore('predicted').get([table, key])
				);
				if (guess !== undefined) return guess ?? undefined;
			}
			counters.overlayReads++;
			const held = await wrap<Change | undefined>(t.objectStore('overlay').get([table, key]));
			if (held !== undefined) return held ?? undefined;
			if (!head.tables.includes(table)) return undefined;
			const record = await wrap<PackIndex | undefined>(
				t.objectStore('index').get([head.generation, table])
			);
			const ordinal = record ? blockFor(record, key) : -1;
			if (!record || ordinal < 0) return undefined;
			const hit = cache.get(table);
			if (hit?.generation === head.generation && hit.ordinal === ordinal) {
				return find(hit.rows, key);
			}
			const payload = await wrap<Bytes | undefined>(
				t.objectStore('blocks').get([head.generation, table, ordinal])
			);
			counters.blockReads++;
			if (!payload) refuse(`block ${table}/${ordinal} is missing`);
			const rows = await inflate(head, table, record, ordinal, payload);
			cache.set(table, { generation: head.generation, ordinal, rows });
			return find(rows, key);
		});
	}

	const getRow = (table: string, key: string) => lookup(table, key, true);

	async function scanTable(table: string): Promise<BundleRows> {
		const snap = await run(['head', 'index', 'overlay', 'predicted'], 'readonly', async (t) => {
			const head = await wrap<PackHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (!head) return undefined;
			const record = head.tables.includes(table)
				? await wrap<PackIndex | undefined>(
						t.objectStore('index').get([head.generation, table])
					)
				: undefined;
			const range = IDBKeyRange.bound([table], [table, []]);
			const entries = await overlayIn(t, range);
			const predicted = await overlayIn(t, range, 'predicted');
			const changes = laid(
				byTable(entries).get(table) ?? [],
				byTable(predicted).get(table) ?? []
			);
			return { head, record, changes };
		});
		if (!snap) return [];
		const out: BundleRows = [];
		for await (const row of rowsOf(snap.head, snap.record, table, snap.changes)) out.push(row);
		return out;
	}

	function dropStaged(generation: number): Promise<void> {
		return run(['blocks', 'index'], 'readwrite', (t) => {
			const range = IDBKeyRange.lowerBound([generation]);
			t.objectStore('blocks').delete(range);
			t.objectStore('index').delete(range);
		});
	}

	/**
	 * Makes `next` the active head and drops the records of `previous`. The head must still be
	 * `previous` when the swap commits.
	 */
	function swap(previous: PackHead | undefined, next: StoredHead): Promise<void> {
		cache.clear();
		return run(['head', 'blocks', 'index', 'overlay', 'predicted'], 'readwrite', async (t) => {
			const current = await wrap<PackHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (current?.generation !== previous?.generation)
				refuse('the head moved during a swap');
			if (previous) {
				const old = IDBKeyRange.bound([previous.generation], [previous.generation, []]);
				t.objectStore('blocks').delete(old);
				t.objectStore('index').delete(old);
			}
			t.objectStore('overlay').clear();
			t.objectStore('predicted').clear();
			t.objectStore('head').put(next, ACTIVE);
		});
	}

	/** writes a pack's blocks under a new generation; the head does not point at them yet */
	async function stage(
		source: AsyncIterable<Bytes>,
		generation: number,
		held: PackHead | undefined
	) {
		let index: BundleIndex | undefined;
		const records: PackIndex[] = [];
		let table = 0;
		let ordinal = 0;
		let seen = 0;
		let rows = 0;
		let blocks = 0;
		let previous: string | undefined;
		let digest = EMPTY_DIGEST;
		for await (const frame of readFrames(source)) {
			if (!index) {
				if (frame.table !== INDEX_FRAME) refuse('the pack does not start with its index');
				index = parseIndex(frame.payload);
				if (held && index.version < held.version) {
					refuse(`the pack is version ${index.version}, the head holds ${held.version}`);
				}
				for (const entry of index.tables) {
					records.push({ rows: entry.rows, first: [], last: [], hashes: [] });
				}
				continue;
			}
			const entry = index.tables[table];
			if (!entry || frame.table !== table || frame.ordinal !== ordinal) {
				refuse(`expected block ${table}/${ordinal}, got ${frame.table}/${frame.ordinal}`);
			}
			const block = await readBlock(index, frame);
			const size = Math.min(index.blockRows, entry.rows - ordinal * index.blockRows);
			if (block.length !== size)
				refuse(`block ${table}/${ordinal} holds ${block.length} rows`);
			if (ordinal === 0) previous = undefined;
			for (const [key, row] of block) {
				if (previous !== undefined && previous >= key) {
					refuse(`${entry.name}: key ${key} is out of order`);
				}
				previous = key;
				digest = digestAdd(digest, await rowHash(JSON.stringify([entry.name, key]), row));
			}
			const first = block[0]?.[0] ?? '';
			if (ordinal === 0 && first !== entry.first) refuse(`${entry.name}: wrong first key`);
			records[table]?.first.push(first);
			records[table]?.last.push(block[block.length - 1]?.[0] ?? '');
			records[table]?.hashes.push(entry.blocks[ordinal] ?? '');
			await run(['blocks'], 'readwrite', (t) =>
				wrap(t.objectStore('blocks').put(frame.payload, [generation, entry.name, ordinal]))
			);
			seen += block.length;
			rows += block.length;
			blocks++;
			if (ordinal + 1 < entry.blocks.length) {
				ordinal++;
				continue;
			}
			if (seen !== entry.rows)
				refuse(`${entry.name}: ${seen} rows, the index says ${entry.rows}`);
			table++;
			ordinal = 0;
			seen = 0;
		}
		if (!index) refuse('the pack is empty');
		if (table !== index.tables.length) refuse('the pack ends before its last block');
		if (digest !== index.digest) refuse('the set digest does not match');
		const parsed = index;
		await run(['index'], 'readwrite', (t) => {
			parsed.tables.forEach((entry, i) =>
				t.objectStore('index').put(records[i], [generation, entry.name])
			);
		});
		return { index: parsed, rows, blocks };
	}

	async function estimateBeforeInstall(bytes: number): Promise<FitOutcome> {
		const storage = await estimate();
		if (storage?.quota === undefined) return { checked: false, fits: true };
		const usage = storage.usage ?? 0;
		if (usage + bytes + QUOTA_MARGIN_BYTES <= storage.quota)
			return { checked: true, fits: true };
		return { checked: true, fits: false, bytes, usage, quota: storage.quota };
	}

	/** stages a pack under a new generation and swaps it in; the caller holds the queue */
	async function installSource(
		source: AsyncIterable<Bytes>
	): Promise<Extract<InstallOutcome, { installed: true }>> {
		const head = await readHead();
		const generation = (head?.generation ?? 0) + 1;
		await dropStaged(generation);
		try {
			const { index, rows, blocks } = await stage(source, generation, head);
			await swap(head, {
				version: index.version,
				digest: index.digest,
				generation,
				blockRows: index.blockRows,
				codec: 'gzip',
				tables: index.tables.map((entry) => entry.name)
			});
			return {
				installed: true,
				version: index.version,
				tables: index.tables.length,
				rows,
				blocks
			};
		} catch (error) {
			await dropStaged(generation);
			throw error;
		}
	}

	function installPack(source: AsyncIterable<Bytes>, options: InstallOptions = {}) {
		return exclusive<InstallOutcome>(async () => {
			if (options.bytes !== undefined) {
				const fit = await estimateBeforeInstall(options.bytes);
				if (!fit.fits) return { installed: false, fit };
			}
			return installSource(source);
		});
	}

	/**
	 * A ring of the same version as a complete head is `held`, one older is `older`, and neither
	 * touches the store. A partial ring replaces the head and its overlay in one transaction, and a
	 * complete ring is checked against its own rows and installed as a pack.
	 */
	function installRing(ring: Ring): Promise<RingOutcome> {
		return exclusive<RingOutcome>(async () => {
			const head = await readHead();
			if (head && ring.version < head.version) return { installed: false, reason: 'older' };
			if (head && !head.partial && ring.version === head.version) {
				return { installed: false, reason: 'held' };
			}
			const rows = Object.values(ring.tables).reduce((sum, list) => sum + list.length, 0);
			if (ring.complete) {
				if ((await bundleDigest(ring.tables)) !== ring.digest) {
					refuse('the ring digest does not match its rows');
				}
				const { bytes } = await buildPack({ version: ring.version, tables: ring.tables });
				if (ring.routes) await putRoutes(ring.routes, ring.templates);
				const { version, rows: installed } = await installSource(once(bytes));
				return { installed: true, version, rows: installed, complete: true };
			}
			if (ring.routes) await putRoutes(ring.routes, ring.templates);
			const generation = (head?.generation ?? 0) + 1;
			await run(
				['head', 'blocks', 'index', 'overlay', 'predicted'],
				'readwrite',
				async (t) => {
					const current = await wrap<PackHead | undefined>(
						t.objectStore('head').get(ACTIVE)
					);
					if (current?.generation !== head?.generation)
						refuse('the head moved during a ring');
					if (head) {
						const old = IDBKeyRange.bound([head.generation], [head.generation, []]);
						t.objectStore('blocks').delete(old);
						t.objectStore('index').delete(old);
					}
					t.objectStore('overlay').clear();
					t.objectStore('predicted').clear();
					for (const [table, list] of Object.entries(ring.tables)) {
						for (const [key, row] of list)
							t.objectStore('overlay').put(row, [table, key]);
					}
					t.objectStore('head').put(
						{
							version: ring.version,
							digest: ring.digest,
							generation,
							blockRows: BLOCK_ROWS,
							codec: 'gzip',
							tables: Object.keys(ring.tables),
							partial: true
						},
						ACTIVE
					);
				}
			);
			cache.clear();
			return { installed: true, version: ring.version, rows, complete: false };
		});
	}

	function applyDelta(delta: BundleDelta): Promise<void> {
		return exclusive(() => applyDeltaNow(delta));
	}

	/** the caller holds the queue */
	async function applyDeltaNow(delta: BundleDelta): Promise<void> {
		const head = await readHead();
		if (!head) refuse('no pack is installed');
		if (head.partial) refuse('the held pack is partial; install the pack first');
		if (head.version !== delta.from) {
			refuse(`the delta starts at ${delta.from}, the store holds ${head.version}`);
		}
		if (delta.to < delta.from)
			refuse(`the delta ends at ${delta.to}, before it starts at ${delta.from}`);
		// the set digest moves by the rows that leave and the rows that arrive
		const without = async (digest: string, table: string, key: string) => {
			const old = await lookup(table, key, false);
			if (old === undefined) return digest;
			return digestSub(digest, await rowHash(JSON.stringify([table, key]), old));
		};
		let digest = head.digest;
		for (const [table, change] of Object.entries(delta.tables)) {
			for (const key of change.deletes) digest = await without(digest, table, key);
			for (const [key, row] of change.puts) {
				digest = digestAdd(
					await without(digest, table, key),
					await rowHash(JSON.stringify([table, key]), row)
				);
			}
		}
		if (digest !== delta.digest) refuse('the candidate digest does not match the delta');
		await run(['head', 'overlay', 'predicted'], 'readwrite', async (t) => {
			// a verified delta settles the rows it covers; one that moves the version drops the rest
			const predicted = t.objectStore('predicted');
			for (const [table, change] of Object.entries(delta.tables)) {
				for (const key of change.deletes) predicted.delete([table, key]);
				for (const [key] of change.puts) predicted.delete([table, key]);
			}
			if (delta.to !== delta.from) predicted.clear();
			const current = await wrap<PackHead | undefined>(t.objectStore('head').get(ACTIVE));
			if (!current || current.version !== head.version || current.digest !== head.digest) {
				refuse('the base moved during a delta');
			}
			for (const [table, change] of Object.entries(delta.tables)) {
				for (const key of change.deletes) t.objectStore('overlay').put(null, [table, key]);
				for (const [key, row] of change.puts)
					t.objectStore('overlay').put(row, [table, key]);
			}
			t.objectStore('head').put(
				{ ...current, version: delta.to, digest: delta.digest },
				ACTIVE
			);
		});
	}

	/**
	 * Lays predicted rows over the held pack. Nothing is checked: the rows wait until the next verified
	 * delta confirms or drops them, and a compaction waits for them too.
	 */
	function applyPredicted(predicted: Predicted): Promise<void> {
		return exclusive(async () => {
			if (!(await readHead())) return;
			await run(['predicted'], 'readwrite', (t) => {
				const store = t.objectStore('predicted');
				for (const [table, key, row] of predicted.puts) store.put(row, [table, key]);
				for (const [table, key] of predicted.deletes) store.put(null, [table, key]);
			});
		});
	}

	/**
	 * Confirms the predicted rows as the change from the held version to `to`. The change is checked like a
	 * verified delta: when the digest of the held rows with the predicted rows laid over them is not `digest`,
	 * it throws and the rows stay.
	 */
	function confirmPredicted(to: number, digest: string): Promise<void> {
		return exclusive(async () => {
			const head = await readHead();
			if (!head) refuse('no pack is installed');
			const changes = await run(['predicted'], 'readonly', (t) =>
				overlayIn(t, IDBKeyRange.lowerBound(['']), 'predicted')
			);
			await applyDeltaNow({
				from: head.version,
				to,
				digest,
				tables: deltaTables(byTable(changes))
			});
		});
	}

	/** removes every predicted row and keeps the version */
	function dropPredicted(): Promise<void> {
		return exclusive(() =>
			run(['predicted'], 'readwrite', (t) => {
				t.objectStore('predicted').clear();
			})
		);
	}

	function compact(): Promise<boolean> {
		return exclusive<boolean>(async () => {
			const head = await readHead();
			if (!head || head.partial || head.unconfirmed > 0) return false;
			const changes = byTable(
				await run(['overlay'], 'readonly', (t) =>
					overlayIn(t, IDBKeyRange.lowerBound(['']))
				)
			);
			const delta: BundleDelta = {
				from: head.version,
				to: head.version,
				digest: head.digest,
				tables: deltaTables(changes)
			};
			if (!compactionDue(delta)) return false;
			const generation = head.generation + 1;
			await dropStaged(generation);
			try {
				const tables: string[] = [];
				for (const table of [...new Set([...head.tables, ...changes.keys()])].sort()) {
					const record = head.tables.includes(table)
						? await readIndex(head.generation, table)
						: undefined;
					const out: PackIndex = { rows: 0, first: [], last: [], hashes: [] };
					let chunk: BundleRows = [];
					const flush = async () => {
						const payload = await gzip(
							new Uint8Array(encoder.encode(canonicalJson(chunk)))
						);
						const ordinal = out.hashes.length;
						out.first.push(chunk[0]?.[0] ?? '');
						out.last.push(chunk[chunk.length - 1]?.[0] ?? '');
						out.hashes.push(await sha256Url(payload));
						out.rows += chunk.length;
						await run(['blocks'], 'readwrite', (t) =>
							wrap(t.objectStore('blocks').put(payload, [generation, table, ordinal]))
						);
						chunk = [];
					};
					for await (const row of rowsOf(head, record, table, changes.get(table) ?? [])) {
						chunk.push(row);
						if (chunk.length === head.blockRows) await flush();
					}
					if (chunk.length > 0) await flush();
					if (out.rows > 0) {
						tables.push(table);
						await run(['index'], 'readwrite', (t) =>
							wrap(t.objectStore('index').put(out, [generation, table]))
						);
					}
				}
				await swap(head, {
					version: head.version,
					digest: head.digest,
					generation,
					blockRows: head.blockRows,
					codec: 'gzip',
					tables
				});
				return true;
			} catch (error) {
				await dropStaged(generation);
				throw error;
			}
		});
	}

	// getAll returns records by pattern, but routes match first-come
	function putRoutes(
		routes: SerializedRoute[],
		templates: Record<string, CompiledTemplate> = {}
	): Promise<void> {
		return run(['templates'], 'readwrite', (t) => {
			const store = t.objectStore('templates');
			store.clear();
			routes.forEach((route, order) => {
				const template = templates[route.pattern];
				store.put(template ? { order, route, template } : { order, route }, route.pattern);
			});
		});
	}

	async function routeRecords(): Promise<RouteRecord[]> {
		const records = await run(['templates'], 'readonly', (t) =>
			wrap<RouteRecord[]>(t.objectStore('templates').getAll())
		);
		return records.sort((a, b) => a.order - b.order);
	}

	async function getRoutes(): Promise<SerializedRoute[]> {
		return (await routeRecords()).map((record) => record.route);
	}

	async function getTemplates(): Promise<Record<string, CompiledTemplate>> {
		const out: Record<string, CompiledTemplate> = {};
		for (const { route, template } of await routeRecords()) {
			if (template) out[route.pattern] = template;
		}
		return out;
	}

	return {
		counters,
		head: readHead,
		recordCounts: () =>
			run(['blocks', 'index', 'overlay', 'head'], 'readonly', async (t) => {
				const count = (store: string) => wrap<number>(t.objectStore(store).count());
				const [blocks, index, overlay, head] = await Promise.all([
					count('blocks'),
					count('index'),
					count('overlay'),
					count('head')
				]);
				return { blocks, index, overlay, head };
			}),
		installPack,
		installRing,
		estimateBeforeInstall,
		applyDelta,
		applyPredicted,
		confirmPredicted,
		dropPredicted,
		getRow,
		scanTable,
		compact,
		putRoutes,
		getRoutes,
		getTemplates
	};
}
