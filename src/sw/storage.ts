import type { Artifact } from '../protocol/artifact.js';
import type { BeaconEvent } from '../protocol/beacon.js';
import type { ProjectionEntry, RecordEntry } from '../protocol/graph.js';

/** an artifact as held on the device, with the time the worker stored it */
export type StoredArtifact = {
	artifact: Artifact;
	fetchedAt: number;
	/** when a need-sync last confirmed this artifact; later than `fetchedAt` once it has */
	validatedAt?: number;
};

/** when the worker last tried a standalone flush, and when it last looked; both epoch milliseconds */
export type FlushState = { lastStandalone: number; checkedAt: number };

/** the replica's bookkeeping: what runtime wrote it, how far it has synced, what changed when */
export type ReplicaMeta = {
	version: string;
	/** the vector cursor the replica has caught up to, or null before the first artifact */
	cursor: number | null;
	/** tag and the vector version of its last known change */
	tags: Array<[string, number]>;
	/** when the last sync (or a piggybacked diff) completed, epoch milliseconds */
	syncedAt: number;
};

/** a queued beacon with the key to remove it by */
export type QueuedBeacon = { key: number; event: BeaconEvent };

/** durable state of the replica; IndexedDB in a browser, a Map in tests */
export interface ReplicaStorage {
	getArtifact(id: string): Promise<StoredArtifact | undefined>;
	putArtifact(stored: StoredArtifact): Promise<void>;
	deleteArtifacts(ids: readonly string[]): Promise<void>;
	allArtifacts(): Promise<StoredArtifact[]>;
	clearArtifacts(): Promise<void>;
	getMeta(): Promise<ReplicaMeta | undefined>;
	setMeta(meta: ReplicaMeta): Promise<void>;
	addBeacon(event: BeaconEvent): Promise<void>;
	readBeacons(): Promise<QueuedBeacon[]>;
	removeBeacons(keys: readonly number[]): Promise<void>;
	getFlush(): Promise<FlushState | undefined>;
	setFlush(state: FlushState): Promise<void>;
	putRecords(entries: readonly RecordEntry[]): Promise<void>;
	allRecords(): Promise<RecordEntry[]>;
	deleteRecords(ids: readonly string[]): Promise<void>;
	putProjections(entries: readonly ProjectionEntry[]): Promise<void>;
	allProjections(): Promise<ProjectionEntry[]>;
	deleteProjections(ids: readonly string[]): Promise<void>;
	clearGraph(): Promise<void>;
}

/** storage in memory, for tests and for routes that opt out of persistence */
export function memoryStorage(): ReplicaStorage {
	const artifacts = new Map<string, StoredArtifact>();
	const beacons = new Map<number, BeaconEvent>();
	const records = new Map<string, RecordEntry>();
	const projections = new Map<string, ProjectionEntry>();
	let meta: ReplicaMeta | undefined;
	let flush: FlushState | undefined;
	let next = 1;
	return {
		getArtifact: async (id) => artifacts.get(id),
		putArtifact: async (stored) => void artifacts.set(stored.artifact.id, stored),
		deleteArtifacts: async (ids) => void ids.forEach((id) => artifacts.delete(id)),
		allArtifacts: async () => [...artifacts.values()],
		clearArtifacts: async () => artifacts.clear(),
		getMeta: async () => meta,
		setMeta: async (value) => void (meta = structuredClone(value)),
		addBeacon: async (event) => void beacons.set(next++, event),
		readBeacons: async () => [...beacons].map(([key, event]) => ({ key, event })),
		removeBeacons: async (keys) => void keys.forEach((key) => beacons.delete(key)),
		getFlush: async () => flush,
		setFlush: async (state) => void (flush = { ...state }),
		putRecords: async (entries) => void entries.forEach((e) => records.set(e.id, e)),
		allRecords: async () => [...records.values()],
		deleteRecords: async (ids) => void ids.forEach((id) => records.delete(id)),
		putProjections: async (entries) => void entries.forEach((e) => projections.set(e.id, e)),
		allProjections: async () => [...projections.values()],
		deleteProjections: async (ids) => void ids.forEach((id) => projections.delete(id)),
		clearGraph: async () => {
			records.clear();
			projections.clear();
		}
	};
}
