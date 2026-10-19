import type { VectorDiff } from '../protocol/vector.js';

/**
 * Where the version vector lives. `bump` records a write and returns the new cursor; `diff` is
 * every tag changed after a cursor. Implementations must keep the cursor monotonic across
 * restarts, or workers holding a higher cursor are told to reset.
 */
export interface VersionStore {
	bump(tags: readonly string[]): Promise<number>;
	cursor(): Promise<number>;
	diff(from: number): Promise<VectorDiff>;
}
