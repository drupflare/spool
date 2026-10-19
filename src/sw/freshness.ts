import type { Artifact } from '../protocol/artifact.js';
import type { Freshness } from '../protocol/route.js';

/** what to do with a stored artifact before showing it */
export type Verdict = 'serve' | 'sync-first' | 'serve-then-sync';

/**
 * Applies a route's staleness contract. Within `maxStale` seconds of the last validation the
 * artifact is shown as is. Past it, a hard route blocks on a required sync and a soft route shows
 * the artifact and syncs once afterwards. A clock that moved backwards counts as past the bound,
 * since the age cannot be known.
 */
export function verdict(freshness: Freshness, validatedAt: number, now: number): Verdict {
	const age = now >= validatedAt ? (now - validatedAt) / 1000 : Infinity;
	if (age <= freshness.maxStale) return 'serve';
	return freshness.mode === 'hard' ? 'sync-first' : 'serve-then-sync';
}

/** when an artifact was last known good: its own fetch or the last sync, whichever is later */
export function validatedAt(fetchedAt: number, syncedAt: number): number {
	return Math.max(fetchedAt, syncedAt);
}

/** whether no dependency of `artifact` has changed since the vector it was built at */
export function isCurrent(artifact: Artifact, tagVersion: (tag: string) => number): boolean {
	return artifact.deps.every((dep) => tagVersion(dep) <= artifact.vector);
}
