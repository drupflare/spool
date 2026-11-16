import { ProtocolError } from './errors.js';
import { checkPattern } from './pattern.js';
import type { Identity } from './route.js';

/** the header that names one flush of one key; a retry of the same flush sends the same id */
export const WRITE_HEADERS = { id: 'spool-write-id' } as const;

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
};

/** a validated write class */
export type Write = Readonly<WriteDeclaration & { kind: 'last-value' }>;

/** what the worker needs of a class: the limits it enforces before anything is queued */
export type WriteConfig = { name: string; maxBytes: number; maxPending: number };

function bad(name: string, message: string): never {
	throw new ProtocolError('bad-write', `${name}: ${message}`);
}

/**
 * Declares a write class. Throws `bad-write` for a public scope, a kind other than `last-value`, a
 * name or pattern that does not parse, a missing function or a limit that is not a positive
 * integer within its cap.
 */
export function defineWrite(declaration: WriteDeclaration): Write {
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
	return Object.freeze({ ...declaration, kind: 'last-value' as const });
}

/** the config entry the worker gets for a class */
export function serializeWrite(write: Write): WriteConfig {
	return { name: write.name, maxBytes: write.maxBytes, maxPending: write.maxPending };
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
