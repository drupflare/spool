import type { RecordEntry } from '../../protocol/graph.js';
import type { ReplicaStorage } from '../storage.js';
import { EntryStore } from './store.js';

/** records stored once by id at their newest version */
export type RecordStore = EntryStore<RecordEntry>;

/** a record store over the replica's storage */
export function recordStore(storage: ReplicaStorage): RecordStore {
	return new EntryStore<RecordEntry>({
		all: () => storage.allRecords(),
		put: (entries) => storage.putRecords(entries),
		delete: (ids) => storage.deleteRecords(ids)
	});
}
