import type { DatasetRow } from './dataset.js';
import { ProtocolError } from './errors.js';
import { checkPattern, matchPattern } from './pattern.js';
import { defineRoute, type Identity, type Route } from './route.js';

/** the header that names one flush of one key; a retry of the same flush sends the same id */
export const WRITE_HEADERS = { id: 'spool-write-id', digest: 'spool-write-digest' } as const;

/** a write class name is 1 to 64 of letters, digits, `_` and `-` */
export const WRITE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const VERSION = /^[A-Za-z0-9._:~-]{1,128}$/;
const WRITE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** the most characters in a key */
export const MAX_WRITE_KEY = 256;

/** the most bytes `maxBytes` may declare for one value's JSON body */
export const MAX_WRITE_BYTES = 1_048_576;

/** the most records `maxPending` may declare per class and partition */
export const MAX_WRITE_PENDING = 1000;

/** why a write was refused; the server maps each to a status and the page API returns it as `code` */
export type WriteRefusalCode =
	| 'writes-off'
	| 'unknown-write'
	| 'bad-method'
	| 'bad-key'
	| 'missing-version'
	| 'bad-version'
	| 'bad-id'
	| 'bad-body'
	| 'too-large'
	| 'too-many'
	| 'id-reused'
	| 'forbidden'
	| 'sign-in'
	| 'no-partition'
	| 'no-record'
	| 'not-conflicted'
	| 'unavailable';

/** the status the server answers each refusal with */
export const WRITE_STATUS: Record<WriteRefusalCode, number> = {
	'writes-off': 403,
	'unknown-write': 404,
	'bad-method': 405,
	'bad-key': 400,
	'missing-version': 428,
	'bad-version': 400,
	'bad-id': 400,
	'bad-body': 400,
	'too-large': 413,
	'too-many': 429,
	'id-reused': 422,
	forbidden: 403,
	'sign-in': 401,
	'no-partition': 409,
	'no-record': 404,
	'not-conflicted': 409,
	unavailable: 503
};

/** a refusal the page API returns in place of throwing */
export type WriteRefusal = { ok: false; code: WriteRefusalCode; message: string };

/** where one queued value stands on the device */
export type WriteState = 'pending' | 'flushing' | 'conflicted';

/** the server's newest version of a key and its value, when the site's `read` returned one */
export type WriteConflict = { version: string; value?: unknown };

/** what a page may see of one queued value: no local value, and the server's side of a conflict */
export type WriteStatus = {
	name: string;
	key: string;
	state: WriteState;
	/** the version the first edit since the last flush started from */
	base: string;
	queuedAt: number;
	updatedAt: number;
	/** bytes of the queued value's JSON */
	bytes: number;
	/** flushes that failed before the network answered */
	attempts: number;
	conflict?: WriteConflict;
	/** the code of a refusal that stopped a flush for good; the record waits for `resolve` */
	refusal?: WriteRefusalCode;
};

/**
 * What one flush did, in counts only. `queued` is the records it tried, `flushed` the ones the server
 * applied, `conflicted` the ones that ended in the `conflicted` state.
 */
export type WriteFlush = { queued: number; flushed: number; conflicted: number };

/** the page API's answer to `write`: how many edits of this key since the last flush the queue holds */
export type WriteQueued = { ok: true; state: WriteState; edits: number };

/** the page API's answer to `resolve` */
export type WriteResolved = { ok: true; flush?: WriteFlush; server?: WriteConflict };

/** what the site's functions receive: the authenticated principal and the id of this flush */
export type WriteContext = {
	identity: Identity;
	/** the `Spool-Write-Id` of the request; a site may store it with the value to make `apply` atomic */
	writeId: string;
};

type MaybePromise<T> = T | Promise<T>;

/** what `read` returns: the version of the key now, and its value when the page needs it for a conflict */
export type WriteRead = { version: string; value?: unknown };

/** what `apply` returns: the new version, or the version and value that beat this write */
export type WriteApplied = { version: string } | { conflict: WriteConflict };

/**
 * The declaration `defineWrite` takes. Every write class is "the last value wins" for one key per
 * principal, applied only when the version the device edited from is still current. There is no
 * class for a comment, a cart, a payment, a counter, an inventory change or an audit record, and
 * `kind` accepts nothing but `last-value`.
 */
export type WriteDeclaration = {
	name: string;
	/** `principal` only; a public write is refused */
	scope: 'principal';
	/** the compaction; `last-value` is the only kind there is */
	kind?: 'last-value';
	/** the pattern of the principal route this write edits; `createSpool` refuses a public route */
	path: string;
	/** the key this principal may write for this request; a device naming any other key is refused */
	key(ctx: WriteContext, request: Request): MaybePromise<string>;
	/** the key's version now, read when a flush that already applied is repeated */
	read(ctx: WriteContext, key: string): MaybePromise<WriteRead>;
	/**
	 * Writes `value` when the key is still at `expectedVersion` and returns the new version, or
	 * returns `{ conflict }` when it has moved. The check and the write must be one atomic step in
	 * the site's own storage.
	 */
	apply(
		ctx: WriteContext,
		key: string,
		value: unknown,
		expectedVersion: string
	): MaybePromise<WriteApplied>;
	/** the most bytes of one value's JSON body */
	maxBytes: number;
	/** the most queued keys of this class one partition holds on a device */
	maxPending: number;
	/**
	 * The longest a queued write of this class may wait before the worker flushes it. Unset keeps the
	 * flush at the next network moment, an explicit flush or a page hide. Set, the first queued write
	 * starts a deadline, and the flush at it sends every queued record: one request per key.
	 */
	maxDelayMs?: number;
};

/** a validated write class */
export type Write = Readonly<WriteDeclaration & { kind: 'last-value' }>;

/** what the worker needs of a class: the limits it enforces before anything is queued */
export type WriteConfig = {
	name: string;
	maxBytes: number;
	maxPending: number;
	maxDelayMs?: number;
};

function bad(name: string, message: string): never {
	throw new ProtocolError('bad-write', `${name}: ${message}`);
}

/**
 * Declares a write class, or with a route pattern a resource write: the request reaches the server
 * once and the device applies the rows the server reports. A class throws `bad-write` for a public
 * scope, a kind other than `last-value`, a name or pattern that does not parse, a missing function or
 * a limit that is not a positive integer within its cap.
 */
export function defineWrite(pattern: string, declaration: ResourceWriteDeclaration): ResourceWrite;
export function defineWrite(declaration: WriteDeclaration): Write;
export function defineWrite(
	first: WriteDeclaration | string,
	second?: ResourceWriteDeclaration
): Write | ResourceWrite {
	if (typeof first === 'string') return defineResourceWrite(first, second);
	return defineQueuedWrite(first);
}

function defineQueuedWrite(declaration: WriteDeclaration): Write {
	const name = String(declaration?.name);
	if (typeof declaration?.name !== 'string' || !WRITE_NAME.test(declaration.name)) {
		return bad(name, 'a write name is 1 to 64 of letters, digits, _ and -');
	}
	const scope: string = declaration.scope;
	if (scope !== 'principal') {
		return bad(name, `scope must be "principal"; a "${scope}" write is never queued`);
	}
	const kind: string = declaration.kind ?? 'last-value';
	if (kind !== 'last-value') {
		return bad(name, `kind "${kind}" does not exist; the only kind is "last-value"`);
	}
	if (typeof declaration.path !== 'string') return bad(name, 'path must be a route pattern');
	checkPattern(declaration.path);
	for (const fn of ['key', 'read', 'apply'] as const) {
		if (typeof declaration[fn] !== 'function') return bad(name, `${fn} must be a function`);
	}
	const caps = { maxBytes: MAX_WRITE_BYTES, maxPending: MAX_WRITE_PENDING } as const;
	for (const limit of ['maxBytes', 'maxPending'] as const) {
		const value = declaration[limit];
		if (!Number.isSafeInteger(value) || value < 1 || value > caps[limit]) {
			return bad(name, `${limit} must be an integer from 1 to ${caps[limit]}`);
		}
	}
	const delay = declaration.maxDelayMs;
	if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0)) {
		return bad(name, 'maxDelayMs must be a non-negative integer');
	}
	return Object.freeze({ ...declaration, kind: 'last-value' as const });
}

/** the config entry the worker gets for a class */
export function serializeWrite(write: Write): WriteConfig {
	const config = { name: write.name, maxBytes: write.maxBytes, maxPending: write.maxPending };
	return write.maxDelayMs === undefined ? config : { ...config, maxDelayMs: write.maxDelayMs };
}

/** whether `key` is a key the wire carries: a non-empty string of at most {@link MAX_WRITE_KEY} characters without NUL */
export function isWriteKey(key: unknown): key is string {
	return (
		typeof key === 'string' &&
		key.length > 0 &&
		key.length <= MAX_WRITE_KEY &&
		!key.includes('\u0000')
	);
}

/** whether `version` is a version the wire carries */
export const isWriteVersion = (version: unknown): version is string =>
	typeof version === 'string' && VERSION.test(version);

/** whether `id` is a write id the wire carries */
export const isWriteId = (id: unknown): id is string => typeof id === 'string' && WRITE_ID.test(id);

/** the `If-Match` value for a version: a strong entity tag */
export const ifMatch = (version: string): string => `"${version}"`;

/** the version in an `If-Match` value, or null when it is not one strong entity tag of a valid version */
export function readIfMatch(header: string | null): string | null {
	const match = header === null ? null : /^"([^"]*)"$/.exec(header.trim());
	return match && isWriteVersion(match[1]) ? (match[1] as string) : null;
}

/** a random write id: 22 base64url characters of 128 random bits */
export function newWriteId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** the methods a resource write may declare */
export const RESOURCE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** how a declared write changes the held rows; `invalidate` marks the touched rows stale */
export const RESOURCE_APPLY = ['response', 'merge', 'delete', 'invalidate'] as const;

export type ResourceMethod = (typeof RESOURCE_METHODS)[number];

export type ResourceApplyMode = (typeof RESOURCE_APPLY)[number];

/**
 * The change a declared write makes to a row when it is not one of the modes. `set` writes a JSON
 * constant, or the value at a dotted path of the request body when it is `{ body: '<path>' }`. `inc`
 * adds a number to a numeric field, a missing field counting as 0. `unset` removes fields.
 */
export type ResourcePatch = {
	set?: Readonly<Record<string, unknown>>;
	inc?: Readonly<Record<string, number>>;
	unset?: readonly string[];
};

export type ResourceApply = ResourceApplyMode | ResourcePatch;

/** what `defineWrite(pattern, ...)` takes */
export type ResourceWriteDeclaration = {
	method: ResourceMethod;
	/** the dataset the write changes; the server reports the changed rows of each public dataset */
	dataset: string;
	/** the route param whose value is the row's key */
	key: string;
	apply: ResourceApply;
	/** the GET families the write changes, as route patterns */
	updates: readonly string[];
	/** the origin the write goes to when it is not the page's own; absent means same-origin only */
	origin?: string;
};

/** a validated resource write; the worker gets these in its config */
export type ResourceWrite = Readonly<ResourceWriteDeclaration & { pattern: string }>;

/** what `defineResource` returns: the item family and the writes that change it */
export type Resource = {
	pattern: string;
	dataset: string;
	key: string;
	routes: Route[];
	writes: ResourceWrite[];
};

function defineResourceWrite(
	pattern: string,
	declaration: ResourceWriteDeclaration | undefined
): ResourceWrite {
	checkPattern(pattern);
	if (!declaration) return bad(pattern, 'a resource write needs a declaration');
	if (!(RESOURCE_METHODS as readonly string[]).includes(declaration.method)) {
		return bad(pattern, `method must be one of ${RESOURCE_METHODS.join(', ')}`);
	}
	if (typeof declaration.dataset !== 'string' || declaration.dataset === '') {
		return bad(pattern, 'dataset must be a dataset name');
	}
	if (typeof declaration.key !== 'string' || declaration.key === '') {
		return bad(pattern, 'key must be a param name');
	}
	const apply: unknown = declaration.apply;
	if (isObject(apply)) checkPatch(pattern, apply);
	else if (typeof apply !== 'string' || !(RESOURCE_APPLY as readonly string[]).includes(apply)) {
		return bad(pattern, `apply must be one of ${RESOURCE_APPLY.join(', ')}, or a patch`);
	}
	if (!Array.isArray(declaration.updates)) {
		return bad(pattern, 'updates must be a list of route patterns');
	}
	for (const update of declaration.updates) checkPattern(update);
	if (declaration.origin !== undefined) checkOrigin(pattern, declaration.origin);
	return Object.freeze({ ...declaration, updates: [...declaration.updates], pattern });
}

const PATCH_KEYS: readonly string[] = ['set', 'inc', 'unset'];
const UNSAFE_FIELDS: readonly string[] = ['__proto__'];

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isBodyRef = (value: unknown): value is { body: string } =>
	isObject(value) && Object.keys(value).length === 1 && typeof value.body === 'string';

function isJson(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return isObject(value) && Object.values(value).every(isJson);
}

function checkField(pattern: string, field: unknown): void {
	if (
		typeof field !== 'string' ||
		field === '' ||
		field.includes('.') ||
		UNSAFE_FIELDS.includes(field)
	) {
		bad(pattern, `patch field "${String(field)}" must be a field name with no dot`);
	}
}

function checkPatch(pattern: string, patch: Record<string, unknown>): void {
	const keys = Object.keys(patch);
	if (keys.length === 0) bad(pattern, 'a patch needs set, inc or unset');
	for (const key of keys) {
		if (!PATCH_KEYS.includes(key)) bad(pattern, `patch key "${key}" is not set, inc or unset`);
	}
	if (patch.set !== undefined) {
		if (!isObject(patch.set)) bad(pattern, 'set must be an object');
		for (const [field, value] of Object.entries(patch.set)) {
			checkField(pattern, field);
			if (isBodyRef(value)) {
				for (const segment of value.body.split('.')) checkField(pattern, segment);
			} else if (!isJson(value)) {
				bad(pattern, `set "${field}" must be a JSON value or { body: "<path>" }`);
			}
		}
	}
	if (patch.inc !== undefined) {
		if (!isObject(patch.inc)) bad(pattern, 'inc must be an object');
		for (const [field, amount] of Object.entries(patch.inc)) {
			checkField(pattern, field);
			if (typeof amount !== 'number' || !Number.isFinite(amount)) {
				bad(pattern, `inc "${field}" must be a finite number`);
			}
		}
	}
	if (patch.unset !== undefined) {
		if (!Array.isArray(patch.unset)) bad(pattern, 'unset must be a list of field names');
		for (const field of patch.unset) checkField(pattern, field);
	}
}

/** the JSON value at a dotted path of the body, or undefined when a segment is missing or not an object */
function readBodyPath(body: unknown, path: string): unknown {
	let at = body;
	for (const segment of path.split('.')) {
		if (!isObject(at) || !Object.prototype.hasOwnProperty.call(at, segment)) return undefined;
		at = at[segment];
	}
	return at;
}

/**
 * The row a declared patch makes of `row` for a request `body`. It is pure, so the worker and any caller
 * get the same row. Returns undefined when a body path names no value or an `inc` field is not a number.
 */
export function applyPatch(
	row: DatasetRow,
	body: unknown,
	patch: ResourcePatch
): DatasetRow | undefined {
	const next: Record<string, unknown> = { ...row };
	for (const [field, value] of Object.entries(patch.set ?? {})) {
		if (!isBodyRef(value)) {
			next[field] = structuredClone(value);
			continue;
		}
		const found = readBodyPath(body, value.body);
		if (found === undefined) return undefined;
		next[field] = found;
	}
	for (const [field, amount] of Object.entries(patch.inc ?? {})) {
		const held = next[field] === undefined ? 0 : next[field];
		if (typeof held !== 'number') return undefined;
		next[field] = held + amount;
	}
	for (const field of patch.unset ?? []) delete next[field];
	return next as DatasetRow;
}

function checkOrigin(pattern: string, origin: unknown): void {
	if (typeof origin !== 'string') return bad(pattern, 'origin must be a string');
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return bad(pattern, `origin "${origin}" is not a URL`);
	}
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
		return bad(pattern, `origin "${origin}" must be an http or https origin with no path`);
	}
}

/**
 * Declares a resource. `GET <pattern>` is the collection of the dataset, with no query string; a query
 * string is not answered locally. `GET <pattern>/:key` is a data family of the dataset; `POST <pattern>`
 * inserts; `PUT` and `PATCH <pattern>/:key` replace and update; `DELETE <pattern>/:key` removes. Any
 * `POST`, `PUT`, `PATCH` or `DELETE` of `<pattern>/:key/:action` is a write on that item. Every write
 * updates the collection and the item.
 */
export function defineResource(
	pattern: string,
	declaration: { dataset: string; key: string; origin?: string }
): Resource {
	checkPattern(pattern);
	const { dataset, key, origin } = declaration;
	const item = `${pattern}/:${key}`;
	const action = `${item}/:action`;
	const families = [pattern, item];
	const extra = origin === undefined ? {} : { origin };
	const routes = [
		defineRoute(pattern, {
			strategy: 'data',
			load: () => ({}),
			query: { list: dataset, dataset },
			...(origin === undefined ? {} : { origin })
		}),
		defineRoute(item, {
			strategy: 'data',
			family: { dataset, key },
			...(origin === undefined ? {} : { origin })
		})
	];
	const writes = [
		defineResourceWrite(pattern, {
			method: 'POST',
			dataset,
			key,
			apply: 'response',
			updates: families,
			...extra
		}),
		defineResourceWrite(item, {
			method: 'PUT',
			dataset,
			key,
			apply: 'response',
			updates: families,
			...extra
		}),
		defineResourceWrite(item, {
			method: 'PATCH',
			dataset,
			key,
			apply: 'response',
			updates: families,
			...extra
		}),
		defineResourceWrite(item, {
			method: 'DELETE',
			dataset,
			key,
			apply: 'delete',
			updates: families,
			...extra
		}),
		...RESOURCE_METHODS.map((method) =>
			defineResourceWrite(action, {
				method,
				dataset,
				key,
				apply: 'invalidate',
				updates: families,
				...extra
			})
		)
	];
	return Object.freeze({ pattern, dataset, key, routes, writes });
}

/**
 * The resource write a request matches: its method, a pattern that matches its path, and its origin.
 * A write with no origin matches only the page's own origin; one with an origin matches that origin.
 */
export function writeFor(
	writes: readonly ResourceWrite[],
	method: string,
	url: URL,
	pageOrigin: string
): ResourceWrite | undefined {
	return writes.find(
		(write) =>
			write.method === method &&
			matchPattern(write.pattern, url.pathname) !== null &&
			url.origin === (write.origin ?? pageOrigin)
	);
}

/**
 * For each write a page made, the resource it couples to and the GET families it updates. A write that
 * couples to no resource reports `resource: null` and no families; that is the uncovered case.
 */
export function couplingReport(
	writes: readonly { method: string; url: string }[],
	resources: readonly Resource[],
	pageOrigin: string
): Array<{ method: string; url: string; resource: string | null; families: string[] }> {
	return writes.map(({ method, url }) => {
		for (const resource of resources) {
			const hit = writeFor(resource.writes, method, new URL(url), pageOrigin);
			if (hit) return { method, url, resource: resource.pattern, families: [...hit.updates] };
		}
		return { method, url, resource: null, families: [] };
	});
}
