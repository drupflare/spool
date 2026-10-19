import type { BeaconEvent } from '../protocol/beacon.js';
import type { ProjectionEntry, RecordEntry } from '../protocol/graph.js';
import type {
	FlushState,
	QueuedBeacon,
	ReplicaMeta,
	ReplicaStorage,
	StoredArtifact
} from './storage.js';

const NAME = 'spool';
const ARTIFACTS = 'artifacts';
const META = 'meta';
const BEACONS = 'beacons';
const RECORDS = 'records';
const PROJECTIONS = 'projections';
const META_KEY = 'replica';
const FLUSH_KEY = 'flush';

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

/**
 * The replica in IndexedDB: artifacts by id, one meta record and an auto-numbered beacon queue.
 * `factory` is the `indexedDB` global unless a test passes `fake-indexeddb`.
 */
export function idbStorage(
	factory: IDBFactory = indexedDB,
	name: string = NAME
): ReplicaStorage & { destroy(): Promise<void> } {
	let opened: Promise<IDBDatabase> | undefined;
	const open = () =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(name, 2);
			request.onupgradeneeded = () => {
				const db = request.result;
				const missing = (name: string) => !db.objectStoreNames.contains(name);
				if (missing(ARTIFACTS)) db.createObjectStore(ARTIFACTS, { keyPath: 'artifact.id' });
				if (missing(META)) db.createObjectStore(META);
				if (missing(BEACONS)) db.createObjectStore(BEACONS, { autoIncrement: true });
				if (missing(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
				if (missing(PROJECTIONS)) db.createObjectStore(PROJECTIONS, { keyPath: 'id' });
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

	async function tx<T>(
		store: string,
		mode: IDBTransactionMode,
		run: (s: IDBObjectStore) => Promise<T> | T
	): Promise<T> {
		const db = await open();
		const transaction = db.transaction(store, mode);
		const finished = done(transaction);
		const result = await run(transaction.objectStore(store));
		await finished;
		return result;
	}

	return {
		destroy: async () => {
			const db = await opened?.catch(() => undefined);
			db?.close();
			opened = undefined;
			await new Promise<void>((resolve) => {
				const request = factory.deleteDatabase(name);
				request.onsuccess = () => resolve();
				request.onerror = () => resolve();
			});
		},
		getArtifact: (id) =>
			tx(ARTIFACTS, 'readonly', (s) => wrap<StoredArtifact | undefined>(s.get(id))),
		putArtifact: (stored) =>
			tx(ARTIFACTS, 'readwrite', async (s) => void (await wrap(s.put(stored)))),
		deleteArtifacts: (ids) =>
			tx(ARTIFACTS, 'readwrite', async (s) => {
				await Promise.all(ids.map((id) => wrap(s.delete(id))));
			}),
		allArtifacts: () => tx(ARTIFACTS, 'readonly', (s) => wrap<StoredArtifact[]>(s.getAll())),
		clearArtifacts: () => tx(ARTIFACTS, 'readwrite', async (s) => void (await wrap(s.clear()))),
		getMeta: () => tx(META, 'readonly', (s) => wrap<ReplicaMeta | undefined>(s.get(META_KEY))),
		setMeta: (meta) =>
			tx(META, 'readwrite', async (s) => void (await wrap(s.put(meta, META_KEY)))),
		addBeacon: (event) =>
			tx(BEACONS, 'readwrite', async (s) => void (await wrap(s.add(event)))),
		readBeacons: () =>
			tx(BEACONS, 'readonly', async (s) => {
				const [keys, events] = await Promise.all([
					wrap<IDBValidKey[]>(s.getAllKeys()),
					wrap<BeaconEvent[]>(s.getAll())
				]);
				return keys.map((key, i): QueuedBeacon => ({
					key: key as number,
					event: events[i] as BeaconEvent
				}));
			}),
		removeBeacons: (keys) =>
			tx(BEACONS, 'readwrite', async (s) => {
				await Promise.all(keys.map((key) => wrap(s.delete(key))));
			}),
		getFlush: () => tx(META, 'readonly', (s) => wrap<FlushState | undefined>(s.get(FLUSH_KEY))),
		setFlush: (state) =>
			tx(META, 'readwrite', async (s) => void (await wrap(s.put(state, FLUSH_KEY)))),
		putRecords: (entries) =>
			tx(RECORDS, 'readwrite', async (s) => {
				await Promise.all(entries.map((entry) => wrap(s.put(entry))));
			}),
		allRecords: () => tx(RECORDS, 'readonly', (s) => wrap<RecordEntry[]>(s.getAll())),
		deleteRecords: (ids) =>
			tx(RECORDS, 'readwrite', async (s) => {
				await Promise.all(ids.map((id) => wrap(s.delete(id))));
			}),
		putProjections: (entries) =>
			tx(PROJECTIONS, 'readwrite', async (s) => {
				await Promise.all(entries.map((entry) => wrap(s.put(entry))));
			}),
		allProjections: () =>
			tx(PROJECTIONS, 'readonly', (s) => wrap<ProjectionEntry[]>(s.getAll())),
		deleteProjections: (ids) =>
			tx(PROJECTIONS, 'readwrite', async (s) => {
				await Promise.all(ids.map((id) => wrap(s.delete(id))));
			}),
		clearGraph: async () => {
			await tx(RECORDS, 'readwrite', async (s) => void (await wrap(s.clear())));
			await tx(PROJECTIONS, 'readwrite', async (s) => void (await wrap(s.clear())));
		}
	};
}
