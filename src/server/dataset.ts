import {
	DATASET_PAGE_ROWS,
	parseDatasetRequest,
	type Dataset,
	type DatasetContext,
	type DatasetDelete,
	type DatasetRequest,
	type DatasetResponse,
	type DatasetRow
} from '../protocol/dataset.js';
import { HEADERS } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { isSetProof, setProof, type SetProof } from '../protocol/query.js';
import { json } from './sync.js';

const encoder = new TextEncoder();

function bad(dataset: Dataset, message: string): never {
	throw new ProtocolError('bad-dataset', `${dataset.name}: ${message}`);
}

function limit(dataset: Dataset, message: string): never {
	throw new ProtocolError('dataset-limit', `${dataset.name}: ${message}`);
}

function checkCursor(dataset: Dataset, value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		return bad(dataset, `${what} must be a non-negative integer`);
	}
	return value;
}

function checkProof(dataset: Dataset, proof: unknown): SetProof | undefined {
	if (proof === undefined) return undefined;
	if (!isSetProof(proof)) return bad(dataset, 'a proof must be a set proof');
	return proof;
}

/** the key of a row, checked: a plain object with a non-empty string key */
function keyed(dataset: Dataset, row: unknown): [string, DatasetRow] {
	if (typeof row !== 'object' || row === null || Array.isArray(row)) {
		return bad(dataset, 'a row must be an object');
	}
	const key = dataset.key(row as DatasetRow);
	if (typeof key !== 'string' || key === '')
		return bad(dataset, 'key(row) must be a non-empty string');
	return [key, row as DatasetRow];
}

async function* rowsOf(dataset: Dataset, ctx: DatasetContext, after?: string) {
	const source = await dataset.seed(after === undefined ? ctx : { ...ctx, after });
	if (Array.isArray(source)) {
		for (const row of source) yield row as DatasetRow;
		return;
	}
	for await (const page of source as AsyncIterable<readonly DatasetRow[]>) {
		if (!Array.isArray(page)) return bad(dataset, 'seed must give rows or pages of rows');
		for (const row of page) yield row;
	}
}

type Scan = {
	page: Map<string, DatasetRow>;
	more: boolean;
	count: number;
};

/**
 * One pass over the seed in key order. Keeps the first `size` rows after `after`, notes whether
 * another follows, and with `admit` keeps going to count rows and bytes against the dataset's limits.
 */
async function scan(
	dataset: Dataset,
	ctx: DatasetContext,
	size: number,
	after: string | undefined,
	admit: boolean
): Promise<Scan> {
	const page = new Map<string, DatasetRow>();
	let more = false;
	let count = 0;
	let bytes = 0;
	let previous: string | undefined;
	for await (const raw of rowsOf(dataset, ctx, after)) {
		const [key, row] = keyed(dataset, raw);
		if (after !== undefined && key <= after) continue;
		if (previous !== undefined && key <= previous) {
			return bad(dataset, 'seed rows must come in strictly ascending key order');
		}
		previous = key;
		count += 1;
		if (page.size < size) page.set(key, row);
		else {
			more = true;
			if (!admit) break;
		}
		if (admit) {
			bytes += encoder.encode(JSON.stringify(row)).length;
			if (count > dataset.maxRows) limit(dataset, `a seed over ${dataset.maxRows} rows`);
			if (bytes > dataset.maxBytes) limit(dataset, `a seed over ${dataset.maxBytes} bytes`);
		}
	}
	return { page, more, count };
}

/** the proof from reading every row; the cost a backend avoids by returning one */
async function readProof(dataset: Dataset, ctx: DatasetContext): Promise<SetProof> {
	const all = new Map<string, DatasetRow>();
	let previous: string | undefined;
	for await (const raw of rowsOf(dataset, ctx)) {
		const [key, row] = keyed(dataset, raw);
		if (previous !== undefined && key <= previous) {
			return bad(dataset, 'seed rows must come in strictly ascending key order');
		}
		previous = key;
		all.set(key, row);
	}
	return setProof(all);
}

function response(
	dataset: Dataset,
	cursor: number,
	body: Pick<DatasetResponse, 'reset' | 'puts' | 'deletes'> &
		Partial<Pick<DatasetResponse, 'after' | 'next' | 'proof'>>
): DatasetResponse {
	return { protocol: 1, name: dataset.name, schema: dataset.schema, cursor, ...body };
}

async function seedOf(
	dataset: Dataset,
	ask: DatasetRequest,
	ctx: DatasetContext
): Promise<DatasetResponse> {
	const head = await dataset.head(ctx);
	const cursor = checkCursor(dataset, head?.cursor, 'head().cursor');
	const known = checkProof(dataset, head.proof);
	if (known && known.count > dataset.maxRows) {
		limit(dataset, `a seed over ${dataset.maxRows} rows`);
	}
	const size = ask.limit ?? DATASET_PAGE_ROWS;
	const { page, more } = await scan(dataset, ctx, size, ask.after, ask.after === undefined);
	const puts = [...page].map(([key, row]) => ({ key, row }));
	const paging = ask.after === undefined ? {} : { after: ask.after };
	if (more) {
		const next = puts[puts.length - 1]?.key as string;
		return response(dataset, cursor, { reset: true, puts, deletes: [], ...paging, next });
	}
	const proof =
		known ?? (ask.after === undefined ? await setProof(page) : await readProof(dataset, ctx));
	return response(dataset, cursor, { reset: true, puts, deletes: [], ...paging, proof });
}

async function patchOf(
	dataset: Dataset,
	since: number,
	ctx: DatasetContext
): Promise<DatasetResponse | null> {
	const oldest = checkCursor(dataset, await dataset.horizon(ctx), 'horizon()');
	if (since < oldest) return null;
	const found = await dataset.changes(since, ctx);
	if (found === 'reset') return null;
	const cursor = checkCursor(dataset, found?.cursor, 'changes().cursor');
	if (since > cursor) return null;

	const wanted = [...new Set(found.puts)].sort();
	if (wanted.some((key) => typeof key !== 'string' || key === '')) {
		return bad(dataset, 'changes().puts must be non-empty strings');
	}
	const gone = new Map<string, DatasetDelete>();
	for (const del of found.deletes) {
		if (typeof del?.key !== 'string' || del.key === '') {
			return bad(dataset, 'changes().deletes need a key');
		}
		gone.set(del.key, {
			key: del.key,
			cursor: checkCursor(dataset, del.cursor, 'a delete cursor')
		});
	}
	const asked = new Set(wanted);
	for (const key of gone.keys()) {
		if (asked.has(key)) return bad(dataset, `${key} is both a put and a delete`);
	}

	const read = new Map<string, DatasetRow>();
	if (wanted.length > 0) {
		for (const raw of await dataset.read(wanted, ctx)) {
			const [key, row] = keyed(dataset, raw);
			if (!asked.has(key))
				return bad(dataset, `read returned ${key}, which was not asked for`);
			read.set(key, row);
		}
	}
	for (const key of wanted) {
		if (!read.has(key)) gone.set(key, { key, cursor });
	}
	const proof = checkProof(dataset, found.proof) ?? (await readProof(dataset, ctx));
	return response(dataset, cursor, {
		reset: false,
		puts: wanted.flatMap((key) =>
			read.has(key) ? [{ key, row: read.get(key) as DatasetRow }] : []
		),
		deletes: [...gone.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
		proof
	});
}

/**
 * The body for a request. With `since` and the current schema it is a patch of the rows that
 * changed, read by key. A `since` before the horizon, a schema that differs, a backend that says
 * `reset` or a device ahead of the backend gets the first seed page instead. Without `since` it is a
 * seed page, with the proof on the last.
 */
export async function answerDataset(
	dataset: Dataset,
	ask: DatasetRequest,
	ctx: DatasetContext
): Promise<DatasetResponse> {
	if (ask.since !== undefined && ask.schema === dataset.schema) {
		const patch = await patchOf(dataset, ask.since, ctx);
		if (patch) return patch;
	}
	return seedOf(dataset, ask, ctx);
}

/** answers `/.spool/dataset`; `datasets` is keyed by name */
export async function respondDataset(
	request: Request,
	url: URL,
	datasets: ReadonlyMap<string, Dataset>
): Promise<Response> {
	const ask = parseDatasetRequest(url.searchParams);
	const dataset = datasets.get(ask.name);
	if (!dataset) return json({ error: 'no dataset' }, 404);
	const body = await answerDataset(dataset, ask, { request, url });
	return json(body, 200, { [HEADERS.protocol]: '1' });
}
