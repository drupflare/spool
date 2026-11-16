import {
	isWriteKey,
	isWriteVersion,
	newWriteId,
	WRITE_STATUS,
	type WriteConfig,
	type WriteConflict,
	type WriteFlush,
	type WriteQueued,
	type WriteRefusal,
	type WriteRefusalCode,
	type WriteResolved,
	type WriteState,
	type WriteStatus
} from '../protocol/write.js';
import { seal, unseal, type KeyVault, type Row as Sealed } from './seal.js';

const DB = 'spool-writes';
const QUEUE = 'queue';
const encoder = new TextEncoder();

/** one queued value as the worker holds it, whole and unsealed */
export type WriteRecord = {
	name: string;
	key: string;
	/** the value a flush sends */
	value: unknown;
	/** the version the first edit since the last answered flush started from */
	base: string;
	/** the `Spool-Write-Id` the next request carries; a retry reuses it */
	id: string;
	state: WriteState;
	queuedAt: number;
	updatedAt: number;
	/** bytes of `{ value }` as JSON */
	bytes: number;
	/** edits folded into this record since it was created or last re-based */
	edits: number;
	/** flushes that failed with the outcome unknown; the same id and value are sent again */
	attempts: number;
	/** an edit made after a request for `value` may have left; it goes out in a later flush */
	next?: { value: unknown; bytes: number };
	conflict?: WriteConflict;
	refusal?: WriteRefusalCode;
};

/** durable records of one partition's queue, by class name and key */
export interface WriteStore {
	get(name: string, key: string): Promise<WriteRecord | undefined>;
	put(record: WriteRecord): Promise<void>;
	delete(name: string, key: string): Promise<void>;
	all(): Promise<WriteRecord[]>;
}

/** a queue in memory, for tests */
export function memoryWriteStore(): WriteStore {
	const rows = new Map<string, WriteRecord>();
	const slot = (name: string, key: string) => `${name}\u0000${key}`;
	return {
		get: async (name, key) => structuredClone(rows.get(slot(name, key))),
		put: async (record) =>
			void rows.set(slot(record.name, record.key), structuredClone(record)),
		delete: async (name, key) => void rows.delete(slot(name, key)),
		all: async () => structuredClone([...rows.values()])
	};
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const rangeOf = (partition: string) => IDBKeyRange.bound([partition], [partition, []]);

/**
 * The queue of one partition in its own database, `spool-writes` at version 1 (the shared `spool`
 * database is never raised: older workers open it at 2). A row is `{ partition, name, key, sealed }`:
 * the partition, class and key stay readable as the keys, and the value, the versions, the write
 * id and the conflict are AES-GCM ciphertext under the partition's persistent key, bound to the
 * partition, class and key as additional data. A persistent key is used for every queue, since a key
 * that lives in the worker's memory would lose an unflushed value when the browser stops the worker.
 * The database is created by the first call that reaches the store.
 */
export function idbWriteStore(factory: IDBFactory, partition: string, vault: KeyVault): WriteStore {
	let opened: Promise<IDBDatabase> | undefined;
	const open = () =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(DB, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore(QUEUE, { keyPath: ['partition', 'name', 'key'] });
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
	const aad = (name: string, key: string) => `${partition}\u0000write\u0000${name}\u0000${key}`;

	async function inStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>) {
		const db = await open();
		const tx = db.transaction(QUEUE, mode);
		const finished = done(tx);
		const result = await run(tx.objectStore(QUEUE));
		await finished;
		return result;
	}

	type Row = Sealed & { partition: string; name: string; key: string };
	const read = async (row: Row | undefined): Promise<WriteRecord | undefined> =>
		row && (await unseal<WriteRecord>(vault, partition, aad(row.name, row.key), row));

	return {
		get: async (name, key) =>
			read(
				await inStore('readonly', (s) =>
					wrap<Row | undefined>(s.get([partition, name, key]))
				)
			),
		put: async (record) => {
			const key = await vault.get(partition, 'persistent', true);
			if (!key) throw new Error('no key');
			const sealed = await seal(key, aad(record.name, record.key), record, 'persistent');
			await inStore('readwrite', async (s) => {
				await wrap(s.put({ partition, name: record.name, key: record.key, ...sealed }));
			});
		},
		delete: (name, key) =>
			inStore('readwrite', async (s) => void (await wrap(s.delete([partition, name, key])))),
		all: async () => {
			const rows = await inStore('readonly', (s) =>
				wrap<Row[]>(s.getAll(rangeOf(partition)))
			);
			const out: WriteRecord[] = [];
			for (const row of rows) {
				const value = await read(row);
				if (value) out.push(value);
				else {
					await inStore(
						'readwrite',
						async (s) => void (await wrap(s.delete([partition, row.name, row.key])))
					);
				}
			}
			return out;
		}
	};
}

/**
 * Deletes every row of `partition` from `spool-writes`. A database that was never created stays
 * uncreated: the open is rolled back when it would have made one.
 */
export async function destroyWrites(factory: IDBFactory, partition: string): Promise<void> {
	const db = await new Promise<IDBDatabase | null>((resolve) => {
		const request = factory.open(DB);
		request.onupgradeneeded = () => {
			try {
				request.transaction?.abort();
			} catch {
				// nothing was created
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
	if (!db) return;
	try {
		if (!db.objectStoreNames.contains(QUEUE)) return;
		const tx = db.transaction(QUEUE, 'readwrite');
		const finished = done(tx);
		tx.objectStore(QUEUE).delete(rangeOf(partition));
		await finished;
	} catch {
		// the rows are sealed under a key that is shredded alongside
	} finally {
		db.close();
	}
}

/** what the worker's network layer answers for one flush request */
export type WriteAnswer = { status: number; body?: unknown };

/** what {@link WriteQueue} needs from the worker */
export type WriteQueueDeps = {
	store: WriteStore;
	/** the declared classes and their limits */
	classes(): readonly WriteConfig[];
	now(): number;
	/** sends one record's value as `PUT /.spool/write`; rejects when the network fails */
	send(record: WriteRecord): Promise<WriteAnswer>;
	/** called after a flush that tried at least one record, with counts only */
	onFlush?(flush: WriteFlush): void;
};

const refuse = (code: WriteRefusalCode, message: string): WriteRefusal => ({
	ok: false,
	code,
	message
});

const REFUSAL_CODES = new Set(Object.keys(WRITE_STATUS));
const codeOf = (body: unknown): WriteRefusalCode | undefined => {
	const code = (body as { code?: unknown } | null)?.code;
	return typeof code === 'string' && REFUSAL_CODES.has(code)
		? (code as WriteRefusalCode)
		: undefined;
};

function conflictOf(body: unknown): WriteConflict | undefined {
	const conflict = (body as { conflict?: { version?: unknown; value?: unknown } } | null)
		?.conflict;
	if (!conflict || !isWriteVersion(conflict.version)) return undefined;
	return 'value' in conflict
		? { version: conflict.version, value: conflict.value }
		: { version: conflict.version };
}

/**
 * The device queue of one partition for declared writes of the `last-value` kind. One record holds
 * the newest value of a `(class, key)` and the version its first edit started from, and a flush sends
 * one request per record. A record leaves the queue only after the server answers 200; any failure
 * leaves it, and a retry sends the same write id. A 412 or a permanent refusal parks the record as
 * `conflicted` with its local value, and nothing sends it again until `resolve`. Every change to the
 * store runs one at a time, and `kill` stops all of them, so a wipe cannot be followed by a send or
 * a store change.
 */
export class WriteQueue {
	readonly #deps: WriteQueueDeps;
	#tail: Promise<unknown> = Promise.resolve();
	#flushing: Promise<WriteFlush> | null = null;
	#dead = false;

	constructor(deps: WriteQueueDeps) {
		this.#deps = deps;
	}

	/** stops the queue for good: no later call sends or stores anything */
	kill(): void {
		this.#dead = true;
	}

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(fn, fn);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	/**
	 * Queues `value` as the newest for `(name, key)`. An edit folds into the record already there and
	 * keeps the version the first edit started from. When a request for the earlier value may have
	 * left, the edit waits in `next` so that request and its retry stay byte-identical.
	 */
	write(
		name: string,
		key: string,
		value: unknown,
		version: unknown
	): Promise<WriteQueued | WriteRefusal> {
		if (this.#dead) return Promise.resolve(refuse('no-partition', 'the queue was wiped'));
		const config = this.#deps.classes().find((c) => c.name === name);
		if (!config) return Promise.resolve(refuse('unknown-write', `no write class "${name}"`));
		if (!isWriteKey(key)) return Promise.resolve(refuse('bad-key', 'the key is malformed'));
		if (version === undefined || version === null) {
			return Promise.resolve(
				refuse('missing-version', 'say which version the edit started from')
			);
		}
		if (!isWriteVersion(version)) {
			return Promise.resolve(refuse('bad-version', 'the version is malformed'));
		}
		let bytes: number;
		try {
			const text = JSON.stringify({ value });
			if (value === undefined) throw new Error('no value');
			bytes = encoder.encode(text).length;
		} catch {
			return Promise.resolve(refuse('bad-body', 'the value is not JSON'));
		}
		if (bytes > config.maxBytes) {
			return Promise.resolve(
				refuse('too-large', `the value is over ${config.maxBytes} bytes`)
			);
		}
		return this.#serial(async () => {
			if (this.#dead) return refuse('no-partition', 'the queue was wiped');
			const now = this.#deps.now();
			const held = await this.#deps.store.get(name, key);
			if (!held) {
				const pending = (await this.#deps.store.all()).filter(
					(r) => r.name === name
				).length;
				if (pending >= config.maxPending) {
					return refuse(
						'too-many',
						`${config.maxPending} keys of "${name}" are already queued`
					);
				}
				const record: WriteRecord = {
					name,
					key,
					value,
					base: version,
					id: newWriteId(),
					state: 'pending',
					queuedAt: now,
					updatedAt: now,
					bytes,
					edits: 1,
					attempts: 0
				};
				await this.#deps.store.put(record);
				return { ok: true, state: record.state, edits: 1 };
			}
			const sent = held.state === 'flushing' || held.attempts > 0;
			const next: WriteRecord = {
				...held,
				updatedAt: now,
				edits: held.edits + 1,
				...(sent && held.state !== 'conflicted'
					? { next: { value, bytes } }
					: { value, bytes })
			};
			await this.#deps.store.put(next);
			return { ok: true, state: next.state, edits: next.edits };
		});
	}

	/** what the page may see of each queued value */
	list(): Promise<WriteStatus[]> {
		return this.#serial(async () => {
			if (this.#dead) return [];
			const records = await this.#deps.store.all();
			return records
				.sort((a, b) => a.queuedAt - b.queuedAt || (a.key < b.key ? -1 : 1))
				.map((r): WriteStatus => ({
					name: r.name,
					key: r.key,
					state: r.state,
					base: r.base,
					queuedAt: r.queuedAt,
					updatedAt: r.updatedAt,
					bytes: r.bytes,
					attempts: r.attempts,
					...(r.conflict ? { conflict: r.conflict } : {}),
					...(r.refusal ? { refusal: r.refusal } : {})
				}));
		});
	}

	/**
	 * Sends one request per record that is not conflicted, or only `only`'s record, and reports
	 * counts. A flush already running is joined. A network failure, a sign-in answer and a turned-off
	 * server stop the pass and leave the rest queued.
	 */
	flush(only?: { name: string; key: string }): Promise<WriteFlush> {
		if (this.#flushing && !only) return this.#flushing;
		const run = this.#run(only);
		if (!only) {
			this.#flushing = run.finally(() => {
				this.#flushing = null;
			});
			return this.#flushing;
		}
		return run;
	}

	async #run(only?: { name: string; key: string }): Promise<WriteFlush> {
		const counts: WriteFlush = { queued: 0, flushed: 0, conflicted: 0 };
		if (this.#dead) return counts;
		const records = await this.#serial(async () =>
			this.#dead ? [] : (await this.#deps.store.all()).filter((r) => r.state !== 'conflicted')
		);
		for (const listed of records) {
			if (only && (listed.name !== only.name || listed.key !== only.key)) continue;
			const sending = await this.#serial(async () => {
				if (this.#dead) return undefined;
				const current = await this.#deps.store.get(listed.name, listed.key);
				if (!current || current.state === 'conflicted') return undefined;
				const record = { ...current, state: 'flushing' as const };
				await this.#deps.store.put(record);
				return record;
			});
			if (!sending) continue;
			counts.queued += 1;
			let answer: WriteAnswer | undefined;
			try {
				answer = await this.#deps.send(sending);
			} catch {
				answer = undefined;
			}
			// a store that fails leaves the record `flushing`; the retry sends the same id and body
			const stop = await this.#serial(() => this.#settle(sending, answer, counts)).catch(
				() => true
			);
			if (stop) break;
		}
		if (counts.queued > 0 && !this.#dead) this.#deps.onFlush?.(counts);
		return counts;
	}

	/** applies the answer to the record, in one store step; true when the pass should stop */
	async #settle(
		sent: WriteRecord,
		answer: WriteAnswer | undefined,
		counts: WriteFlush
	): Promise<boolean> {
		if (this.#dead) return true;
		const { store } = this.#deps;
		const now = this.#deps.now();
		const current = await store.get(sent.name, sent.key);
		if (!current) return false;
		const retry = async (bumped: boolean) => {
			await store.put({
				...current,
				state: 'pending',
				updatedAt: now,
				attempts: current.attempts + (bumped ? 1 : 0)
			});
			return true;
		};
		if (!answer) return retry(true);
		const { status, body } = answer;
		if (status === 200) {
			const version = (body as { version?: unknown } | null)?.version;
			if (!isWriteVersion(version)) return retry(true);
			counts.flushed += 1;
			if (!current.next) {
				await store.delete(current.name, current.key);
				return false;
			}
			const { value, bytes } = current.next;
			await store.put({
				name: current.name,
				key: current.key,
				value,
				bytes,
				base: version,
				id: newWriteId(),
				state: 'pending',
				queuedAt: current.queuedAt,
				updatedAt: now,
				edits: 1,
				attempts: 0
			});
			return false;
		}
		const code = codeOf(body);
		if (status === 412) {
			const conflict = conflictOf(body);
			if (conflict) {
				counts.conflicted += 1;
				await store.put(this.#park(current, now, { conflict }));
				return false;
			}
			counts.conflicted += 1;
			await store.put(this.#park(current, now, { refusal: 'unavailable' }));
			return false;
		}
		if (status === 401 || status === 429 || code === 'writes-off' || code === 'sign-in') {
			return retry(false);
		}
		if (status >= 500 || status === 408) return retry(true);
		counts.conflicted += 1;
		await store.put(this.#park(current, now, { refusal: code ?? 'unavailable' }));
		return false;
	}

	/** the record as `conflicted`, keeping the newest local value */
	#park(
		record: WriteRecord,
		now: number,
		why: { conflict: WriteConflict } | { refusal: WriteRefusalCode }
	): WriteRecord {
		const { next: later, conflict: _c, refusal: _r, ...rest } = record;
		return {
			...rest,
			...(later ? { value: later.value, bytes: later.bytes } : {}),
			state: 'conflicted',
			updatedAt: now,
			...why
		};
	}

	/**
	 * Settles a conflicted record. `local` keeps the local value, re-bases it onto the server's
	 * version, gives it a new write id and flushes that key. `server` drops the local value and
	 * returns what the server held.
	 */
	async resolve(
		name: string,
		key: string,
		use: 'local' | 'server'
	): Promise<WriteResolved | WriteRefusal> {
		if (this.#dead) return refuse('no-partition', 'the queue was wiped');
		if (use !== 'local' && use !== 'server') {
			return refuse('bad-body', 'resolve with "local" or "server"');
		}
		const outcome = await this.#serial(async (): Promise<WriteResolved | WriteRefusal> => {
			if (this.#dead) return refuse('no-partition', 'the queue was wiped');
			const held = await this.#deps.store.get(name, key);
			if (!held) return refuse('no-record', 'nothing is queued for that key');
			if (held.state !== 'conflicted') {
				return refuse('not-conflicted', 'that record has no conflict to resolve');
			}
			if (use === 'server') {
				await this.#deps.store.delete(name, key);
				return { ok: true, ...(held.conflict ? { server: held.conflict } : {}) };
			}
			const { conflict, refusal: _r, ...rest } = held;
			await this.#deps.store.put({
				...rest,
				base: conflict?.version ?? held.base,
				id: newWriteId(),
				state: 'pending',
				updatedAt: this.#deps.now(),
				edits: 1,
				attempts: 0
			});
			return { ok: true };
		});
		if (!outcome.ok || use === 'server') return outcome;
		return { ok: true, flush: await this.flush({ name, key }) };
	}
}
