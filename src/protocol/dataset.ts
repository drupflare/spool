import { PROTOCOL_VERSION } from './artifact.js';
import { ProtocolError } from './errors.js';
import type { Plain, SetProof } from './query.js';
import {
	DATASET_NAME,
	digestAdd,
	digestSub,
	EMPTY_DIGEST,
	isSetProof,
	rowHash,
	setProof
} from './query.js';
import type { Identity } from './route.js';

/** a row of a dataset: a flat or nested JSON object, replaced whole when it changes */
export type DatasetRow = Plain;

/** what a dataset's functions receive; a public dataset has no identity */
export type DatasetContext = {
	/** the request being answered */
	request: Request;
	/** the request URL, parsed */
	url: URL;
	/** who is asking; set for a principal dataset and absent, not null, for a public one */
	principal?: Identity;
};

/** what `seed` receives: the context, and the key after which to start when the request pages */
export type DatasetSeedContext = DatasetContext & {
	/** rows with a key at or before this are not wanted; a backend may use it to skip them */
	after?: string;
};

/** a row that left the dataset, and the cursor at which it did */
export type DatasetDelete = { key: string; cursor: number };

/**
 * What `changes` returns: the net change since a cursor. A key appears in `puts` or in `deletes`,
 * never both. A row that entered the dataset's scope with its own version unchanged is a put; a row
 * that left the scope is a delete. Deciding scope membership is `changes`' job, and spool cannot see
 * it. `proof` is the set proof of the whole collection at `cursor`, when the backend keeps one.
 */
export type DatasetChanges = {
	/** the cursor these changes bring a device to */
	cursor: number;
	/** keys of the rows to send whole; spool reads them with `read` */
	puts: readonly string[];
	/** keys of the rows to remove */
	deletes: readonly DatasetDelete[];
	/** the collection's proof at `cursor`; without it spool reads the whole collection to make one */
	proof?: SetProof;
};

/** what `head` returns: the dataset's current cursor and, when the backend keeps one, its proof */
export type DatasetHead = {
	/** the current cursor; a device that seeds at it asks for changes after it */
	cursor: number;
	/** the proof at `cursor` */
	proof?: SetProof;
};

type MaybePromise<T> = T | Promise<T>;

/** the declaration `defineDataset` takes */
export type DatasetDeclaration<Row extends DatasetRow = DatasetRow> = {
	/**
	 * `public` rows are the same for everyone. A `principal` dataset holds rows that differ per
	 * signed-in principal; it needs `maxStaleMs`, `defineDataset`'s `principalDatasets` option and
	 * `createSpool`'s `principalDatasets` flag. Unreviewed.
	 */
	scope: 'public' | 'principal';
	/**
	 * Principal datasets only, and required there: how long held rows may answer a query after the
	 * last sync that returned and verified. Past it the query goes to the network. It is also the
	 * longest a device keeps serving rows after the server stopped admitting its principal.
	 */
	maxStaleMs?: number;
	/** the row's key; unique, and stable while the row exists */
	key(row: Row): string;
	/**
	 * Every row in ascending key order (code unit order), as an array or as pages of rows. With
	 * `ctx.after` set it may start after that key. It runs once to admit a seed and once per page.
	 */
	seed(
		ctx: DatasetSeedContext
	): MaybePromise<readonly Row[] | Iterable<readonly Row[]> | AsyncIterable<readonly Row[]>>;
	/** a keyed read: the rows for these keys, omitting any that no longer exist; never a full load */
	read(ids: readonly string[], ctx: DatasetContext): MaybePromise<readonly Row[]>;
	/** the net change since `since`, or `reset` when it cannot answer */
	changes(since: number, ctx: DatasetContext): MaybePromise<DatasetChanges | 'reset'>;
	/** the oldest cursor `changes` can still answer; a device older than this reseeds */
	horizon(ctx: DatasetContext): MaybePromise<number>;
	/** the current cursor, read before a seed so every later change reaches the device */
	head(ctx: DatasetContext): MaybePromise<DatasetHead>;
	/** a version string for the row shape; a device holding another one reseeds */
	schema: string;
	/** most rows a seed may hold */
	maxRows: number;
	/** most bytes of row JSON a seed may hold */
	maxBytes: number;
	/**
	 * Principal datasets only: the field names of `row` that `viewer` may hold, from `null` for an
	 * anonymous request. The server sends each viewer only those fields, so the device never holds
	 * the others. Absent, every field goes to every viewer.
	 */
	fields?(viewer: Identity | null, row: Row): readonly string[];
	/**
	 * `always` (the default) answers every seed. `auto` answers a seed only while `datasetBenefit`
	 * says the dataset beats both v0.3 and native HTTP; otherwise the seed is refused with `409`.
	 */
	provision?: 'always' | 'auto';
};

/** a validated dataset */
export type Dataset<Row extends DatasetRow = DatasetRow> = DatasetDeclaration<Row> & {
	/** the name a device asks for */
	name: string;
};

const NAME = DATASET_NAME;

function bad(name: string, message: string): never {
	throw new ProtocolError('bad-dataset', `${name}: ${message}`);
}

/** what `defineDataset` may be told besides the declaration */
export type DefineDatasetOptions = {
	/** accept `scope: 'principal'`; `createSpool` still refuses it unless its own flag is on */
	principalDatasets?: boolean;
};

/**
 * Declares a dataset. Validates the name, the scope and the limits and returns the declaration with
 * the name attached. Throws `bad-dataset` for a principal scope unless `options.principalDatasets`
 * is true, and for a principal dataset without a positive `maxStaleMs` or with `provision: 'auto'`.
 */
export function defineDataset<Row extends DatasetRow = DatasetRow>(
	name: string,
	declaration: DatasetDeclaration<Row>,
	options: DefineDatasetOptions = {}
): Dataset<Row> {
	if (typeof name !== 'string' || !NAME.test(name)) {
		return bad(String(name), 'a dataset name is 1 to 128 of letters, digits and . _ : -');
	}
	const scope: string = declaration.scope;
	if (scope === 'principal' && options.principalDatasets !== true) {
		return bad(
			name,
			'a principal dataset needs the principal datasets flag: pass { principalDatasets: true } here and set the principalDatasets option of createSpool'
		);
	}
	if (scope !== 'public' && scope !== 'principal') return bad(name, `unknown scope "${scope}"`);
	if (declaration.fields !== undefined) {
		if (scope !== 'principal') return bad(name, 'fields applies to a principal dataset');
		if (typeof declaration.fields !== 'function') return bad(name, 'fields must be a function');
	}
	if (scope === 'principal') {
		const stale = declaration.maxStaleMs;
		if (typeof stale !== 'number' || !Number.isSafeInteger(stale) || stale < 1) {
			return bad(
				name,
				'a principal dataset needs maxStaleMs, a positive integer of milliseconds'
			);
		}
		if (declaration.provision === 'auto') {
			return bad(name, 'a principal dataset cannot use provision "auto"');
		}
	} else if (declaration.maxStaleMs !== undefined) {
		return bad(name, 'maxStaleMs applies to a principal dataset');
	}
	for (const fn of ['key', 'seed', 'read', 'changes', 'horizon', 'head'] as const) {
		if (typeof declaration[fn] !== 'function') return bad(name, `${fn} must be a function`);
	}
	if (typeof declaration.schema !== 'string' || declaration.schema === '') {
		return bad(name, 'schema must be a non-empty string');
	}
	for (const limit of ['maxRows', 'maxBytes'] as const) {
		const value = declaration[limit];
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
			return bad(name, `${limit} must be a positive integer`);
		}
	}
	if (
		declaration.provision !== undefined &&
		!['always', 'auto'].includes(declaration.provision)
	) {
		return bad(name, 'provision must be "always" or "auto"');
	}
	return { ...declaration, name };
}

/** rows in a seed page when the request names no `limit` */
export const DATASET_PAGE_ROWS = 500;

/** the most rows one seed page may carry, whatever `limit` asks for */
export const DATASET_PAGE_CAP = 5000;

/** a row with its key, as it travels */
export type DatasetPut = { key: string; row: DatasetRow };

/**
 * The body of `/.spool/dataset`. A patch has `reset: false` and `proof`. A seed, or a reset, has
 * `reset: true` and one page of rows in `puts`: a page with `next` set is followed by a request
 * with `after=<next>`, and the last page has no `next` and carries `proof`. A page after the first
 * echoes that `after`.
 */
export type DatasetResponse = {
	protocol: typeof PROTOCOL_VERSION;
	name: string;
	schema: string;
	/** the cursor the response brings a device to */
	cursor: number;
	/** the device drops every row it holds before applying `puts` (unless `after` is set) */
	reset: boolean;
	puts: DatasetPut[];
	deletes: DatasetDelete[];
	/** on a seed page after the first: the key the request paged from */
	after?: string;
	/** on a seed page with more to come: the `after` of the next request */
	next?: string;
	/** the collection's proof at `cursor`; absent on a seed page that has a `next` */
	proof?: SetProof;
};

/** what a device asks of `/.spool/dataset` */
export type DatasetRequest = {
	name: string;
	/** the cursor the device holds; absent for a seed */
	since?: number;
	/** the schema the device holds; required with `since` */
	schema?: string;
	/** the key to page from; seed pages only */
	after?: string;
	/** rows per seed page; the server's default when absent */
	limit?: number;
};

function reject(message: string): never {
	throw new ProtocolError('bad-dataset', message);
}

const INTEGER = /^\d{1,15}$/;

/** the query string of a request, for `/.spool/dataset?` */
export function encodeDatasetRequest(request: DatasetRequest): string {
	const params = new URLSearchParams({ name: request.name });
	if (request.since !== undefined) params.set('since', String(request.since));
	if (request.schema !== undefined) params.set('schema', request.schema);
	if (request.after !== undefined) params.set('after', request.after);
	if (request.limit !== undefined) params.set('limit', String(request.limit));
	return params.toString();
}

/** reads a request's parameters; throws `bad-dataset` for a missing name, a bad number, or `since` with `after` */
export function parseDatasetRequest(params: URLSearchParams): DatasetRequest {
	const name = params.get('name');
	if (name === null || !NAME.test(name)) return reject('name is required');
	const out: DatasetRequest = { name };
	const since = params.get('since');
	if (since !== null) {
		if (!INTEGER.test(since)) return reject('since must be a non-negative integer');
		out.since = Number(since);
	}
	const schema = params.get('schema');
	if (schema !== null) out.schema = schema;
	const after = params.get('after');
	if (after !== null) out.after = after;
	const limit = params.get('limit');
	if (limit !== null) {
		if (!/^[1-9]\d{0,8}$/.test(limit)) return reject('limit must be a positive integer');
		out.limit = Math.min(Number(limit), DATASET_PAGE_CAP);
	}
	if (out.since !== undefined && out.schema === undefined) {
		return reject('since needs the schema the device holds');
	}
	if (out.since !== undefined && out.after !== undefined) {
		return reject('since and after are exclusive');
	}
	return out;
}

const isPlain = (value: unknown): value is Plain =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isCursor = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** validates JSON from `/.spool/dataset`; throws `bad-dataset` */
export function parseDatasetResponse(value: unknown): DatasetResponse {
	if (!isPlain(value)) return reject('dataset response must be an object');
	if (value['protocol'] !== PROTOCOL_VERSION) return reject('unsupported protocol version');
	const { name, schema, cursor, reset, puts, deletes, after, next, proof } = value;
	if (typeof name !== 'string' || typeof schema !== 'string') {
		return reject('name and schema must be strings');
	}
	if (!isCursor(cursor)) return reject('cursor must be a non-negative integer');
	if (typeof reset !== 'boolean') return reject('reset must be a boolean');
	if (!Array.isArray(puts)) return reject('puts must be a list');
	const outPuts: DatasetPut[] = puts.map((put) => {
		if (!isPlain(put) || typeof put['key'] !== 'string' || !isPlain(put['row'])) {
			return reject('a put is { key, row }');
		}
		return { key: put['key'], row: put['row'] };
	});
	if (!Array.isArray(deletes)) return reject('deletes must be a list');
	const outDeletes: DatasetDelete[] = deletes.map((del) => {
		if (!isPlain(del) || typeof del['key'] !== 'string' || !isCursor(del['cursor'])) {
			return reject('a delete is { key, cursor }');
		}
		return { key: del['key'], cursor: del['cursor'] };
	});
	const out: DatasetResponse = {
		protocol: PROTOCOL_VERSION,
		name,
		schema,
		cursor,
		reset,
		puts: outPuts,
		deletes: outDeletes
	};
	if (after !== undefined) {
		if (typeof after !== 'string') return reject('after must be a string');
		out.after = after;
	}
	if (next !== undefined) {
		if (typeof next !== 'string') return reject('next must be a string');
		out.next = next;
	}
	if (proof !== undefined) {
		if (!isSetProof(proof)) return reject('proof must be a set proof');
		out.proof = { kind: 'set', count: proof.count, digest: proof.digest };
	}
	if (out.next === undefined && out.proof === undefined) {
		return reject('a response without next carries a proof');
	}
	return out;
}

/** what {@link applyChanges} returns */
export type Applied = {
	/** the rows after the response, a new map */
	rows: Map<string, DatasetRow>;
	/** the collection's digest after the response */
	digest: string;
	/** whether the result matches `response.proof`; null when the response carries none */
	matches: boolean | null;
	/** the row hashes after the response; present when the caller passed `options.hashes` */
	hashes?: Map<string, string>;
};

/** what {@link applyChanges} may be given besides the rows and the response */
export type ApplyOptions = {
	/** the hash of every row in `rows`; a replaced or deleted row then costs no hash of its old copy */
	hashes?: ReadonlyMap<string, string>;
	/** the row hash function; {@link rowHash} when absent */
	hash?: (key: string, row: DatasetRow) => Promise<string>;
};

/**
 * Applies a response to `rows` and returns the result, leaving `rows` as it was. A reset response
 * without `after` starts from no rows; a later seed page adds to what is held. Deletes apply
 * before puts. `digest` is the digest of `rows` when the caller holds it, which makes the work one
 * row hash per replaced, deleted or added row; without it the digest of `rows` is computed first.
 * With `options.hashes` a replaced or deleted row's old hash is read, not computed, and the result
 * carries the hashes after the response. Pure: no I/O, no clock.
 */
export async function applyChanges(
	rows: ReadonlyMap<string, DatasetRow>,
	response: DatasetResponse,
	digest?: string,
	options: ApplyOptions = {}
): Promise<Applied> {
	const hash = options.hash ?? rowHash;
	const fresh = response.reset && response.after === undefined;
	const out = new Map(fresh ? [] : rows);
	const hashes = options.hashes ? new Map(fresh ? [] : options.hashes) : undefined;
	let sum = fresh ? EMPTY_DIGEST : (digest ?? (await setProof(rows)).digest);
	const drop = async (key: string) => {
		const old = out.get(key);
		if (old === undefined) return;
		sum = digestSub(sum, hashes?.get(key) ?? (await hash(key, old)));
		out.delete(key);
		hashes?.delete(key);
	};
	for (const { key } of response.deletes) await drop(key);
	for (const { key, row } of response.puts) {
		await drop(key);
		out.set(key, row);
		const added = await hash(key, row);
		hashes?.set(key, added);
		sum = digestAdd(sum, added);
	}
	const proof = response.proof;
	return {
		rows: out,
		digest: sum,
		matches: proof === undefined ? null : proof.count === out.size && proof.digest === sum,
		...(hashes ? { hashes } : {})
	};
}
