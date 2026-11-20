import { PROTOCOL_VERSION, type Artifact } from '../protocol/artifact.js';
import type { DatasetRow } from '../protocol/dataset.js';
import { matchPattern } from '../protocol/pattern.js';
import type { SerializedRoute } from '../protocol/route.js';
import type { StoredArtifact } from './storage.js';

/**
 * The page a family route answers for `path`, built from the row `held` finds under its key. The
 * template or renderer gets `{ params, row }` in the artifact's data, the same context the server
 * builds; a data route gets the row itself, since its answer is the row's JSON. Undefined when no
 * row is held under that key; the network answers.
 */
export async function familyPage(
	held: (key: string) => Promise<DatasetRow | undefined>,
	route: SerializedRoute,
	path: string,
	now: number
): Promise<StoredArtifact | undefined> {
	const family = route.family;
	if (family === undefined) return undefined;
	if (!['template', 'projection', 'data'].includes(route.strategy)) return undefined;
	const params = matchPattern(route.pattern, path);
	const key = params?.[family.key];
	if (params === null || key === undefined) return undefined;
	const row = await held(key);
	if (row === undefined) return undefined;
	const artifact = {
		protocol: PROTOCOL_VERSION,
		id: path,
		scope: route.scope,
		strategy: route.strategy,
		deps: [],
		vector: 0,
		body: { data: route.strategy === 'data' ? row : { params, row } }
	} as Artifact;
	return { artifact, fetchedAt: now };
}

/**
 * The page of a cross-origin collection. Its list is the held rows of `query.dataset`, which the
 * route's query runs over at render time, so the artifact carries no items of its own.
 */
export function collectionPage(path: string, now: number): StoredArtifact {
	const artifact: Artifact = {
		protocol: PROTOCOL_VERSION,
		id: path,
		scope: 'public',
		strategy: 'data',
		deps: [],
		vector: 0,
		body: { data: {} }
	};
	return { artifact, fetchedAt: now };
}
