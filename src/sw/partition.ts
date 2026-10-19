import type { Retention } from '../protocol/route.js';
import { idbStorage } from './idb.js';
import { sealedStorage, type KeyVault, type SealedStorage } from './seal.js';

const KEYS_DB = 'spool-keys';
const KEYS = 'keys';
const META = 'meta';
const CURRENT = 'partition';

function wrap<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function openKeysDb(factory: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(KEYS_DB, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(KEYS);
			request.result.createObjectStore(META);
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error);
	});
}

/**
 * Keys in two places. A `persistent` key is a non-extractable `CryptoKey` in IndexedDB, so it
 * survives a worker restart and a browser restart and is deleted on logout or a change of
 * partition. A `session` key lives in this worker's memory and is lost when the browser stops the
 * worker; what it sealed is unreadable from then on.
 */
export function idbVault(factory: IDBFactory = indexedDB): KeyVault {
	const session = new Map<string, CryptoKey>();
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.catch(() => undefined);
		return run;
	};
	const generate = () =>
		crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

	async function inDb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>) {
		const db = await openKeysDb(factory);
		try {
			const tx = db.transaction(KEYS, mode);
			const finished = new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
			const result = await run(tx.objectStore(KEYS));
			await finished;
			return result;
		} finally {
			db.close();
		}
	}

	return {
		get: (partition, retention, create) =>
			serial(async () => {
				if (retention === 'session') {
					let key = session.get(partition);
					if (!key && create) {
						key = await generate();
						session.set(partition, key);
					}
					return key;
				}
				const found = await inDb('readonly', (s) =>
					wrap<CryptoKey | undefined>(s.get(partition))
				);
				if (found || !create) return found;
				const key = await generate();
				await inDb('readwrite', async (s) => void (await wrap(s.put(key, partition))));
				return key;
			}),
		shred: (partition) =>
			serial(async () => {
				session.delete(partition);
				await inDb('readwrite', async (s) => void (await wrap(s.delete(partition))));
			})
	};
}

/** how the worker finds, opens and destroys the stores of the partition in use */
export interface PartitionHost {
	/** the partition the stores belong to now, or null */
	current(): Promise<string | null>;
	setCurrent(id: string | null): Promise<void>;
	/** the sealed store of a partition; `retentionOf` names the key of each artifact's route */
	open(
		id: string,
		retentionOf: (artifactId: string) => Retention,
		shared: Retention
	): SealedStorage;
	/** shreds the keys first, then deletes the store; the store is shut before either */
	destroy(id: string): Promise<void>;
}

/** partitions as IndexedDB databases named for the partition, sealed under `vault` */
export function idbPartitions(
	factory: IDBFactory = indexedDB,
	vault: KeyVault = idbVault(factory)
): PartitionHost {
	const opened = new Map<string, { sealed: SealedStorage; destroy(): Promise<void> }>();
	const dbName = (id: string) => `spool-p-${id}`;

	async function inMeta<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>) {
		const db = await openKeysDb(factory);
		try {
			const tx = db.transaction(META, mode);
			const finished = new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
			const result = await run(tx.objectStore(META));
			await finished;
			return result;
		} finally {
			db.close();
		}
	}

	return {
		current: async () =>
			(await inMeta('readonly', (s) => wrap<string | undefined>(s.get(CURRENT)))) ?? null,
		setCurrent: (id) =>
			inMeta('readwrite', async (s) => {
				if (id === null) await wrap(s.delete(CURRENT));
				else await wrap(s.put(id, CURRENT));
			}),
		open(id, retentionOf, shared) {
			const found = opened.get(id);
			if (found) return found.sealed;
			const base = idbStorage(factory, dbName(id));
			const sealed = sealedStorage(base, { partition: id, vault, retentionOf, shared });
			opened.set(id, { sealed, destroy: base.destroy });
			return sealed;
		},
		async destroy(id) {
			const held = opened.get(id);
			held?.sealed.kill();
			opened.delete(id);
			await vault.shred(id);
			if (held) await held.destroy();
			else {
				await new Promise<void>((resolve) => {
					const request = factory.deleteDatabase(dbName(id));
					request.onsuccess = () => resolve();
					request.onerror = () => resolve();
				});
			}
		}
	};
}
