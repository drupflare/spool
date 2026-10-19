import { VersionVector, type VectorSnapshot } from '../protocol/vector.js';
import type { VersionStore } from './version-store.js';

/** a store that lives as long as the process; fine for tests, single-instance Node and Bun */
export function memoryStore(initial?: VectorSnapshot): VersionStore {
	const vector = initial ? VersionVector.from(initial) : new VersionVector();
	return {
		bump: async (tags) => vector.bump(tags),
		cursor: async () => vector.cursor,
		diff: async (from) => vector.diff(from)
	};
}
