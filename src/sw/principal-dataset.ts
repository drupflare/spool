import type { Retention } from '../protocol/route.js';
import { seal, unseal, type KeyVault, type Row as Sealed } from './seal.js';
import type { DatasetCommit, DatasetMeta, DatasetRowRecord, ReplicaStorage } from './storage.js';

const DB = 'spool-principal-datasets';
const ROWS = 'rows';
const METAS = 'meta';
const encoder = new TextEncoder();

/** a stored row: the dataset and a salted slot stay readable, the key, row and hash are sealed */
export type StoredRow = Sealed & { name: string; slot: string };

/** a stored dataset meta: the name stays readable, the meta, its digest and the slot salt are sealed */
export type StoredMeta = Sealed & { name: string };

/** what one commit writes, in sealed form; `deletes` are slots */
export type StoredCommit = {
	name: string;
	meta: StoredMeta | null;
	clear: boolean;
	puts: readonly StoredRow[];
	deletes: readonly string[];
};

/** the durable half of one partition's principal datasets; it sees only sealed records */
export interface PrincipalDatasetBackend {
	metas(): Promise<StoredMeta[]>;
	meta(name: string): Promise<StoredMeta | undefined>;
	rows(name: string): Promise<StoredRow[]>;
	/** applies a commit in one transaction, or none of it */
	commit(commit: StoredCommit): Promise<void>;
	/** removes every dataset of the partition */
	clear(): Promise<void>;
}

/** the dataset half of {@link ReplicaStorage} for a principal partition, and the switch that shuts it */
export type PrincipalDatasets = Pick<
	ReplicaStorage,
	'getDatasets' | 'readDataset' | 'commitDataset' | 'clearDatasets'
> & { kill(): void };

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
const rangeOfDataset = (partition: string, name: string) =>
	IDBKeyRange.bound([partition, name], [partition, name, []]);

/**
 * The sealed records of one partition in their own database, `spool-principal-datasets` at version
 * 1 (the shared `spool` database is never raised, and `spool-datasets` holds the public rows only).
 * Every record carries its partition as the first key part, so one partition's rows are never read
 * for another and a logout deletes a key range. The database is created by the first call that
 * reaches it.
 */
export function idbPrincipalDatasets(
	factory: IDBFactory,
	partition: string
): PrincipalDatasetBackend {
	let opened: Promise<IDBDatabase> | undefined;
	const open = () =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(DB, 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				db.createObjectStore(ROWS, { keyPath: ['partition', 'name', 'slot'] });
				db.createObjectStore(METAS, { keyPath: ['partition', 'name'] });
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

	const strip = <T extends { partition?: string }>(record: T): Omit<T, 'partition'> => {
		const { partition: _partition, ...rest } = record;
		return rest;
	};

	async function read<T>(store: string, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const db = await open();
		const tx = db.transaction(store, 'readonly');
		const finished = done(tx);
		const result = await wrap(run(tx.objectStore(store)));
		await finished;
		return result;
	}

	return {
		metas: async () =>
			(await read(METAS, (s) => s.getAll(rangeOf(partition)))).map(
				(record) => strip(record) as StoredMeta
			),
		meta: async (name) => {
			const record = await read(METAS, (s) => s.get([partition, name]));
			return record ? (strip(record) as StoredMeta) : undefined;
		},
		rows: async (name) =>
			(await read(ROWS, (s) => s.getAll(rangeOfDataset(partition, name)))).map(
				(record) => strip(record) as StoredRow
			),
		commit: async (commit) => {
			const db = await open();
			// strict durability: the commit is reported only after the engine verified the write
			const tx = db.transaction([ROWS, METAS], 'readwrite', { durability: 'strict' });
			const finished = done(tx);
			// a rejected commit has aborted its transaction; the caller learns it from `finished`
			finished.catch(() => undefined);
			try {
				const rows = tx.objectStore(ROWS);
				const metas = tx.objectStore(METAS);
				if (commit.clear) rows.delete(rangeOfDataset(partition, commit.name));
				for (const slot of commit.deletes) rows.delete([partition, commit.name, slot]);
				for (const put of commit.puts) rows.put({ partition, ...put });
				if (commit.meta) metas.put({ partition, ...commit.meta });
				else metas.delete([partition, commit.name]);
			} catch (error) {
				try {
					tx.abort();
				} catch {
					// already finished
				}
				throw error;
			}
			await finished;
		},
		clear: async () => {
			const db = await open();
			const tx = db.transaction([ROWS, METAS], 'readwrite');
			const finished = done(tx);
			tx.objectStore(ROWS).delete(rangeOf(partition));
			tx.objectStore(METAS).delete(rangeOf(partition));
			await finished;
		}
	};
}

/**
 * Deletes every principal dataset record of `partition`. A database that was never created stays
 * uncreated: the open is rolled back when it would have made one.
 */
export async function destroyPrincipalDatasets(
	factory: IDBFactory,
	partition: string
): Promise<void> {
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
		if (!db.objectStoreNames.contains(ROWS) || !db.objectStoreNames.contains(METAS)) return;
		const tx = db.transaction([ROWS, METAS], 'readwrite');
		const finished = done(tx);
		tx.objectStore(ROWS).delete(rangeOf(partition));
		tx.objectStore(METAS).delete(rangeOf(partition));
		await finished;
	} catch {
		// the records are sealed under a key that is shredded alongside
	} finally {
		db.close();
	}
}

/** what the sealed layer needs to bind a record to its partition and to pick its key */
export type SealedDatasetOptions = {
	partition: string;
	vault: KeyVault;
	/** the retention of the key that seals rows and metas */
	retention: Retention;
};

type MetaValue = { meta: DatasetMeta; salt: string };

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Seals a partition's datasets. A row is `{ name, slot, sealed }` where the slot is SHA-256 of a
 * per-dataset random salt, the dataset and the row key, so no key, field name or value sits in
 * IndexedDB in the clear. The row record, the meta and the digest are AES-GCM ciphertext bound to
 * the partition, dataset and slot as additional data: a record copied into another partition or
 * slot does not open. The salt lives only inside the sealed meta, and a clearing commit draws a new
 * one. A record whose key is gone reads as absent, and a meta that does not open clears its
 * dataset. After `kill` every call does nothing, so a request that outlives a wipe writes nothing.
 */
export function sealedDatasets(
	backend: PrincipalDatasetBackend,
	options: SealedDatasetOptions
): PrincipalDatasets {
	const { partition, vault, retention } = options;
	let dead = false;
	const salts = new Map<string, string>();
	const aadMeta = (name: string) => `${partition}\u0000dataset-meta\u0000${name}`;
	const aadRow = (name: string, slot: string) =>
		`${partition}\u0000dataset-row\u0000${name}\u0000${slot}`;

	async function sealWith(aad: string, value: unknown): Promise<Sealed> {
		const key = await vault.get(partition, retention, true);
		if (!key) throw new Error('no key');
		return seal(key, aad, value, retention);
	}

	async function slotOf(name: string, key: string, salt: string): Promise<string> {
		const bytes = encoder.encode(`${salt}\u0000${name}\u0000${key}`);
		return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
	}

	async function open(record: StoredMeta): Promise<MetaValue | undefined> {
		const value = await unseal<MetaValue>(vault, partition, aadMeta(record.name), record);
		if (value) {
			salts.set(record.name, value.salt);
			return value;
		}
		salts.delete(record.name);
		await backend.commit({ name: record.name, meta: null, clear: true, puts: [], deletes: [] });
		return undefined;
	}

	async function saltOf(name: string): Promise<string | undefined> {
		const known = salts.get(name);
		if (known !== undefined) return known;
		const record = await backend.meta(name);
		return record ? (await open(record))?.salt : undefined;
	}

	return {
		kill: () => void (dead = true),
		async getDatasets() {
			if (dead) return [];
			const out: DatasetMeta[] = [];
			for (const record of await backend.metas()) {
				const value = await open(record);
				if (value) out.push(value.meta);
			}
			return out;
		},
		async readDataset(name) {
			if (dead || (await saltOf(name)) === undefined) return [];
			const out: DatasetRowRecord[] = [];
			for (const record of await backend.rows(name)) {
				const value = await unseal<DatasetRowRecord>(
					vault,
					partition,
					aadRow(name, record.slot),
					record
				);
				if (value && value.name === name) out.push(value);
			}
			return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		},
		async commitDataset(commit: DatasetCommit) {
			if (dead) return;
			const { name } = commit;
			if (commit.meta === null) {
				await backend.commit({ name, meta: null, clear: true, puts: [], deletes: [] });
				salts.delete(name);
				return;
			}
			let salt = commit.clear ? undefined : await saltOf(name);
			const fresh = salt === undefined;
			salt ??= base64url(crypto.getRandomValues(new Uint8Array(16)));
			const puts: StoredRow[] = [];
			for (const put of commit.puts) {
				const slot = await slotOf(name, put.key, salt);
				puts.push({ name, slot, ...(await sealWith(aadRow(name, slot), put)) });
			}
			const deletes = await Promise.all(commit.deletes.map((key) => slotOf(name, key, salt)));
			const sealedMeta = await sealWith(aadMeta(name), { meta: commit.meta, salt });
			if (dead) return;
			await backend.commit({
				name,
				meta: { name, ...sealedMeta },
				clear: commit.clear || fresh,
				puts,
				deletes
			});
			salts.set(name, salt);
		},
		async clearDatasets() {
			if (dead) return;
			await backend.clear();
			salts.clear();
		}
	};
}
