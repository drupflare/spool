import type { DatasetRow } from './dataset.js';
import { ProtocolError } from './errors.js';
import { canonicalJson, digestAdd, EMPTY_DIGEST, rowHash } from './query.js';

/** rows per block when the caller names no size */
export const BLOCK_ROWS = 128;

/** overlay rows past which a base pack is compacted; a default, not measured */
export const COMPACT_OVERLAY_ROWS = 1000;

/** overlay bytes past which a base pack is compacted; a default, not measured */
export const COMPACT_OVERLAY_BYTES = 65_536;

/** the largest payload a frame may declare; a reader refuses a larger header before the payload */
export const MAX_BUNDLE_FRAME_BYTES = 8_388_608;

type Bytes = Uint8Array<ArrayBuffer>;

/** rows of one table, sorted by key in code unit order */
export type BundleRows = Array<[string, DatasetRow]>;

/** a version and the tables it holds; an empty table is not held */
export type BundleState = { version: number; tables: Record<string, BundleRows> };

/** one table's entry in the index: its row count, first key and the hash of each block */
export type BundleTableIndex = {
	name: string;
	rows: number;
	first: string | null;
	blocks: string[];
};

/** the index frame: the version, the set digest and every table's blocks, in table order */
export type BundleIndex = {
	version: number;
	codec: 'gzip';
	blockRows: number;
	digest: string;
	tables: BundleTableIndex[];
};

/** the rows to put and the keys to remove in one table */
export type BundleDeltaTable = { puts: BundleRows; deletes: string[] };

/** the change from `from` to `to`; `digest` is the set digest of the state it reaches */
export type BundleDelta = {
	from: number;
	to: number;
	digest: string;
	tables: Record<string, BundleDeltaTable>;
};

/** one frame of a pack: the index table and ordinal it carries, and its payload */
export type BundleFrame = { table: number; ordinal: number; payload: Bytes };

const INDEX_FRAME = -1;
const HEADER_LIMIT = 256;
const DIGEST_FORM = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (text: string): Bytes => new Uint8Array(encoder.encode(text));

function refuse(message: string): never {
	throw new ProtocolError('bad-bundle', message);
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPlain = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function concatBytes(parts: readonly Bytes[]): Bytes {
	const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

async function sha256Url(bytes: Bytes): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function transform(
	bytes: Bytes,
	stream: TransformStream<BufferSource, Uint8Array>
): Promise<Bytes> {
	const piped = new Response(bytes).body?.pipeThrough(stream);
	if (!piped) refuse('no body to transform');
	return new Uint8Array(await new Response(piped).arrayBuffer());
}

const gzip = (bytes: Bytes) => transform(bytes, new CompressionStream('gzip'));
const gunzip = (bytes: Bytes) => transform(bytes, new DecompressionStream('gzip'));

function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** the rows of one table sorted by key; a repeated key is refused */
function sortRows(name: string, rows: BundleRows): BundleRows {
	const sorted = [...rows].sort(([a], [b]) => compareKeys(a, b));
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i - 1]?.[0] === sorted[i]?.[0]) refuse(`${name}: key ${sorted[i]?.[0]} repeats`);
	}
	return sorted;
}

function frame(table: number, ordinal: number, payload: Bytes): Bytes {
	const header = encode(JSON.stringify({ table, ordinal, bytes: payload.length }));
	const prefix = new Uint8Array(4);
	new DataView(prefix.buffer).setUint32(0, header.length);
	return concatBytes([prefix, header, payload]);
}

/**
 * The set digest of every table: the sum of each row's hash modulo 2^256, where a row's hash covers
 * its table name and its key as well as its value. An empty table adds nothing.
 */
export async function bundleDigest(tables: Record<string, BundleRows>): Promise<string> {
	let sum = EMPTY_DIGEST;
	for (const name of Object.keys(tables)) {
		for (const [key, row] of tables[name] ?? []) {
			sum = digestAdd(sum, await rowHash(JSON.stringify([name, key]), row));
		}
	}
	return sum;
}

/**
 * Encodes a state as a pack: an index frame, then one frame per block in table order. Empty tables
 * are left out. Throws `bad-bundle` for a repeated key, a block size under one, or a block over
 * `maxFrameBytes`, which a reader would refuse.
 */
export async function buildPack(
	state: BundleState,
	blockRows = BLOCK_ROWS,
	maxFrameBytes = MAX_BUNDLE_FRAME_BYTES
): Promise<{ index: BundleIndex; bytes: Bytes }> {
	if (!Number.isSafeInteger(blockRows) || blockRows < 1) refuse('blockRows must be 1 or more');
	const frames: Bytes[] = [];
	const tables: BundleTableIndex[] = [];
	const names = Object.keys(state.tables)
		.filter((name) => (state.tables[name]?.length ?? 0) > 0)
		.sort(compareKeys);
	for (const [table, name] of names.entries()) {
		const rows = sortRows(name, state.tables[name] ?? []);
		const blocks: string[] = [];
		for (let ordinal = 0; ordinal * blockRows < rows.length; ordinal++) {
			const chunk = rows.slice(ordinal * blockRows, (ordinal + 1) * blockRows);
			const payload = await gzip(encode(canonicalJson(chunk)));
			if (payload.length > maxFrameBytes) {
				refuse(`block ${name}/${ordinal} is over the frame cap`);
			}
			blocks.push(await sha256Url(payload));
			frames.push(frame(table, ordinal, payload));
		}
		tables.push({ name, rows: rows.length, first: rows[0]?.[0] ?? null, blocks });
	}
	const index: BundleIndex = {
		version: state.version,
		codec: 'gzip',
		blockRows,
		digest: await bundleDigest(state.tables),
		tables
	};
	const head = frame(INDEX_FRAME, 0, encode(canonicalJson(index)));
	return { index, bytes: concatBytes([head, ...frames]) };
}

/**
 * Yields the frames of a pack as their bytes arrive, so a reader can verify and keep each block
 * before the next one lands. Throws `bad-bundle` for a frame that is cut short, has a bad header,
 * or declares a payload over `maxFrameBytes`; that check runs before the payload is read.
 */
export async function* readFrames(
	source: AsyncIterable<Bytes>,
	maxFrameBytes = MAX_BUNDLE_FRAME_BYTES
): AsyncGenerator<BundleFrame> {
	const chunks = source[Symbol.asyncIterator]();
	let buffer: Bytes = new Uint8Array(0);
	const fill = async (size: number): Promise<boolean> => {
		while (buffer.length < size) {
			const next = await chunks.next();
			if (next.done) return false;
			buffer = concatBytes([buffer, next.value]);
		}
		return true;
	};
	const take = (size: number): Bytes => {
		const out = buffer.slice(0, size);
		buffer = buffer.subarray(size);
		return out;
	};
	while (await fill(1)) {
		if (!(await fill(4))) refuse('a frame is cut short');
		const headerSize = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
		if (headerSize === 0 || headerSize > HEADER_LIMIT) refuse('a frame header has a bad size');
		if (!(await fill(4 + headerSize))) refuse('a frame is cut short');
		const header: unknown = JSON.parse(decoder.decode(buffer.subarray(4, 4 + headerSize)));
		take(4 + headerSize);
		if (
			!isPlain(header) ||
			typeof header['table'] !== 'number' ||
			!Number.isSafeInteger(header['table']) ||
			header['table'] < INDEX_FRAME ||
			!isCount(header['ordinal']) ||
			!isCount(header['bytes'])
		) {
			refuse('a frame header is not { table, ordinal, bytes }');
		}
		const table = header['table'];
		const ordinal = header['ordinal'];
		const bytes = header['bytes'];
		if (bytes > maxFrameBytes) refuse('a frame is over the frame cap');
		if (!(await fill(bytes))) refuse('a frame is cut short');
		yield { table, ordinal, payload: take(bytes) };
	}
}

function parseIndex(value: unknown): BundleIndex {
	if (!isPlain(value)) refuse('the index is not an object');
	const { version, codec, blockRows, digest, tables } = value;
	if (
		!isCount(version) ||
		codec !== 'gzip' ||
		typeof blockRows !== 'number' ||
		!Number.isSafeInteger(blockRows) ||
		blockRows < 1 ||
		typeof digest !== 'string' ||
		!DIGEST_FORM.test(digest) ||
		!Array.isArray(tables)
	) {
		refuse('the index has a bad version, codec, block size or digest');
	}
	const names = new Set<string>();
	const out = tables.map((table: unknown): BundleTableIndex => {
		if (
			!isPlain(table) ||
			typeof table['name'] !== 'string' ||
			names.has(table['name']) ||
			!isCount(table['rows']) ||
			table['rows'] < 1 ||
			typeof table['first'] !== 'string' ||
			!Array.isArray(table['blocks']) ||
			!table['blocks'].every((hash) => typeof hash === 'string') ||
			table['blocks'].length !== Math.ceil(table['rows'] / blockRows)
		) {
			refuse('an index table does not match its rows and blocks');
		}
		names.add(table['name']);
		return {
			name: table['name'],
			rows: table['rows'],
			first: table['first'],
			blocks: table['blocks'] as string[]
		};
	});
	return { version, codec, blockRows, digest, tables: out };
}

/**
 * Checks one block frame against the index and returns its rows. The hash is checked before the
 * block is decompressed, so a corrupt block is refused without being parsed.
 */
export async function readBlock(index: BundleIndex, block: BundleFrame): Promise<BundleRows> {
	const table = index.tables[block.table];
	const expected = table?.blocks[block.ordinal];
	if (expected === undefined) refuse(`no block ${block.table}/${block.ordinal} in the index`);
	if ((await sha256Url(block.payload)) !== expected) {
		refuse(`block ${block.table}/${block.ordinal} does not match its hash`);
	}
	let rows: unknown;
	try {
		rows = JSON.parse(decoder.decode(await gunzip(block.payload)));
	} catch {
		refuse(`block ${block.table}/${block.ordinal} does not decode`);
	}
	if (!Array.isArray(rows)) refuse(`block ${block.table}/${block.ordinal} is not a row list`);
	for (const entry of rows) {
		if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !isPlain(entry[1])) {
			refuse(`block ${block.table}/${block.ordinal} has a row that is not [key, row]`);
		}
	}
	return rows as BundleRows;
}

/**
 * Reads a whole pack, or a pack that arrives in chunks, and returns its index and state. Every
 * block is checked as it lands, and the set digest is checked at the end. Throws `bad-bundle`.
 */
export async function readBundle(
	source: Bytes | AsyncIterable<Bytes>,
	maxFrameBytes = MAX_BUNDLE_FRAME_BYTES
): Promise<{ index: BundleIndex; state: BundleState }> {
	async function* whole(bytes: Bytes) {
		yield bytes;
	}
	const frames = readFrames(source instanceof Uint8Array ? whole(source) : source, maxFrameBytes);
	let index: BundleIndex | undefined;
	const tables: Record<string, BundleRows> = {};
	let table = 0;
	let ordinal = 0;
	for await (const block of frames) {
		if (!index) {
			if (block.table !== INDEX_FRAME) refuse('the pack does not start with its index');
			index = parseIndex(parseJson(block.payload));
			continue;
		}
		const entry = index.tables[table];
		if (!entry || block.table !== table || block.ordinal !== ordinal) {
			refuse(`expected block ${table}/${ordinal}, got ${block.table}/${block.ordinal}`);
		}
		const size = Math.min(index.blockRows, entry.rows - ordinal * index.blockRows);
		const rows = await readBlock(index, block);
		if (rows.length !== size) refuse(`block ${table}/${ordinal} holds ${rows.length} rows`);
		const held = (tables[entry.name] ??= []);
		for (const [key, row] of rows) {
			if (held.length > 0 && (held[held.length - 1]?.[0] ?? '') >= key) {
				refuse(`${entry.name}: key ${key} is out of order`);
			}
			held.push([key, row]);
		}
		if (ordinal === 0 && rows[0]?.[0] !== entry.first) refuse(`${entry.name}: wrong first key`);
		if (ordinal + 1 < entry.blocks.length) ordinal++;
		else {
			table++;
			ordinal = 0;
		}
	}
	if (!index) refuse('the pack is empty');
	if (table !== index.tables.length) refuse('the pack ends before its last block');
	if ((await bundleDigest(tables)) !== index.digest) refuse('the set digest does not match');
	return { index, state: { version: index.version, tables } };
}

function parseJson(payload: Bytes): unknown {
	try {
		return JSON.parse(decoder.decode(payload));
	} catch {
		return refuse('the index is not JSON');
	}
}

/** the change from `from` to `to`: puts for new or changed rows, deletes for rows that left */
export async function makeDelta(from: BundleState, to: BundleState): Promise<BundleDelta> {
	const names = [...new Set([...Object.keys(from.tables), ...Object.keys(to.tables)])].sort(
		compareKeys
	);
	const tables: Record<string, BundleDeltaTable> = {};
	for (const name of names) {
		const before = new Map(from.tables[name] ?? []);
		const after = sortRows(name, to.tables[name] ?? []);
		const kept = new Set(after.map(([key]) => key));
		const puts = after.filter(([key, row]) => {
			const old = before.get(key);
			return old === undefined || canonicalJson(old) !== canonicalJson(row);
		});
		const deletes = [...before.keys()].filter((key) => !kept.has(key)).sort(compareKeys);
		if (puts.length > 0 || deletes.length > 0) tables[name] = { puts, deletes };
	}
	return { from: from.version, to: to.version, digest: await bundleDigest(to.tables), tables };
}

/**
 * Applies a delta to the state at its `from` version and returns the state at `to`. Refuses a base
 * at another version, and a result whose set digest is not the delta's.
 */
export async function applyDelta(base: BundleState, delta: BundleDelta): Promise<BundleState> {
	if (base.version !== delta.from) {
		refuse(`the delta starts at ${delta.from}, the base holds ${base.version}`);
	}
	const names = new Set([...Object.keys(base.tables), ...Object.keys(delta.tables)]);
	const tables: Record<string, BundleRows> = {};
	for (const name of names) {
		const change = delta.tables[name];
		const rows = new Map(base.tables[name] ?? []);
		for (const key of change?.deletes ?? []) rows.delete(key);
		for (const [key, row] of change?.puts ?? []) rows.set(key, row);
		if (rows.size > 0) tables[name] = sortRows(name, [...rows]);
	}
	if ((await bundleDigest(tables)) !== delta.digest) {
		refuse('the applied state does not match the delta digest');
	}
	return { version: delta.to, tables };
}

/**
 * One delta equal to applying `deltas` in order. The deltas must chain: each `from` is the previous
 * `to`. A key put and then removed becomes a tombstone, which a holder without the key ignores.
 */
export function mergeDeltas(deltas: readonly BundleDelta[]): BundleDelta {
	const first = deltas[0];
	const last = deltas[deltas.length - 1];
	if (!first || !last) refuse('there is no delta to merge');
	for (let i = 1; i < deltas.length; i++) {
		if (deltas[i - 1]?.to !== deltas[i]?.from) refuse('the deltas do not chain');
	}
	const ops = new Map<string, Map<string, DatasetRow | null>>();
	for (const delta of deltas) {
		for (const [name, change] of Object.entries(delta.tables)) {
			const table = ops.get(name) ?? new Map<string, DatasetRow | null>();
			ops.set(name, table);
			for (const key of change.deletes) table.set(key, null);
			for (const [key, row] of change.puts) table.set(key, row);
		}
	}
	const tables: Record<string, BundleDeltaTable> = {};
	for (const name of [...ops.keys()].sort(compareKeys)) {
		const entries = [...(ops.get(name) ?? [])].sort(([a], [b]) => compareKeys(a, b));
		const puts: BundleRows = [];
		const deletes: string[] = [];
		for (const [key, row] of entries) {
			if (row === null) deletes.push(key);
			else puts.push([key, row]);
		}
		if (puts.length > 0 || deletes.length > 0) tables[name] = { puts, deletes };
	}
	return { from: first.from, to: last.to, digest: last.digest, tables };
}

/**
 * whether a delta has more than {@link COMPACT_OVERLAY_ROWS} rows or
 * {@link COMPACT_OVERLAY_BYTES} bytes of JSON
 */
export function compactionDue(delta: BundleDelta): boolean {
	let rows = 0;
	for (const change of Object.values(delta.tables)) {
		rows += change.puts.length + change.deletes.length;
	}
	return (
		rows > COMPACT_OVERLAY_ROWS ||
		encoder.encode(JSON.stringify(delta)).length > COMPACT_OVERLAY_BYTES
	);
}

/**
 * Folds a delta into a base pack and returns the new pack, built with the base's block size. Its
 * bytes equal {@link buildPack} run on the state the delta reaches.
 */
export async function compactBundle(
	base: Bytes,
	overlay: BundleDelta
): Promise<{ index: BundleIndex; bytes: Bytes }> {
	const { index, state } = await readBundle(base);
	return buildPack(await applyDelta(state, overlay), index.blockRows);
}
