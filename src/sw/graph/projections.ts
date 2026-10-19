import type { ProjectionEntry } from '../../protocol/graph.js';
import type { ReplicaStorage } from '../storage.js';
import { EntryStore } from './store.js';

/** projections derived from records, stored once and shared by every route that references them */
export type ProjectionStore = EntryStore<ProjectionEntry>;

/** a projection store over the replica's storage */
export function projectionStore(storage: ReplicaStorage): ProjectionStore {
	return new EntryStore<ProjectionEntry>({
		all: () => storage.allProjections(),
		put: (entries) => storage.putProjections(entries),
		delete: (ids) => storage.deleteProjections(ids)
	});
}
