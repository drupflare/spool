import type { Artifact } from '../protocol/artifact.js';
import type { BeaconEvent } from '../protocol/beacon.js';
import type { DatasetRow } from '../protocol/dataset.js';
import type { ProjectionEntry, RecordEntry } from '../protocol/graph.js';
import type { HeaderSet } from './policy.js';

/** an artifact as held on the device, with the time the worker stored it */
export type StoredArtifact = {
	artifact: Artifact;
	fetchedAt: number;
	/** when a need-sync last confirmed this artifact; later than `fetchedAt` once it has */
	validatedAt?: number;
	/** set while the artifact is a catalogue entry that no page has opened */
	catalogue?: true;
};

/** when the worker last tried a standalone flush, and when it last looked; both epoch milliseconds */
export type FlushState = {
	lastStandalone: number;
	checkedAt: number;
	/** when a catalogue was last asked for each page path, oldest first; epoch milliseconds */
	catalogue?: Record<string, number>;
};

/** the replica's bookkeeping: what runtime wrote it, how far it has synced, what changed when */
export type ReplicaMeta = {
	version: string;
	/** the vector cursor the replica has caught up to, or null before the first artifact */
	cursor: number | null;
	/** tag and the vector version of its last known change */
	tags: Array<[string, number]>;
	/** when the last sync (or a piggybacked diff) completed, epoch milliseconds */
	syncedAt: number;
	/** the security headers seen on network views: the latest site-wide set and each path's own */
	policy?: { site?: HeaderSet; paths: Array<[string, HeaderSet]> };
};

/** a queued beacon with the key to remove it by */
export type QueuedBeacon = { key: number; event: BeaconEvent };

/** what the device keeps about one held dataset; the rows sit beside it, by name and key */
export type DatasetMeta = {
	name: string;
	/** the row shape version the rows were seeded at */
	schema: string;
	/** the cursor the rows are current to */
	cursor: number;
	/** rows held */
	count: number;
	/** the collection digest of the held rows, 64 hex digits */
	digest: string;
	/** bytes of row JSON held */
	bytes: number;
	/** when the last apply or confirming sync finished, epoch milliseconds */
	appliedAt: number;
};

/** a row as stored, with its hash so a patch and a load need not compute it again */
export type DatasetRowRecord = { name: string; key: string; row: DatasetRow; hash: string };

/**
 * Everything one apply writes. The store commits all of it or none of it: `clear` removes the
 * dataset's rows first, then `deletes` and `puts` apply, and `meta` is written, or removed when null.
 */
export type DatasetCommit = {
	name: string;
	meta: DatasetMeta | null;
	clear: boolean;
	puts: readonly DatasetRowRecord[];
	deletes: readonly string[];
};

/** the steps of a commit, in order; a test makes the in-memory store fail at one */
export type DatasetStep = 'clear' | 'deletes' | 'puts' | 'meta';

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
	/** the meta of every held dataset */
	getDatasets(): Promise<DatasetMeta[]>;
	/** the stored rows of one dataset in ascending key order */
	readDataset(name: string): Promise<DatasetRowRecord[]>;
	/** applies a commit atomically; rejects, leaving the store as it was, when any step fails */
	commitDataset(commit: DatasetCommit): Promise<void>;
	/** removes every dataset's rows and meta */
	clearDatasets(): Promise<void>;
}

/** what {@link memoryStorage} can be told to do wrong */
export type MemoryOptions = {
	/** called before each step of a dataset commit; true makes the commit fail at that step */
	failDatasetAt?: (step: DatasetStep) => boolean;
};

/** storage in memory, for tests and for routes that opt out of persistence */
export function memoryStorage(options: MemoryOptions = {}): ReplicaStorage {
	const artifacts = new Map<string, StoredArtifact>();
	const beacons = new Map<number, BeaconEvent>();
	const records = new Map<string, RecordEntry>();
	const projections = new Map<string, ProjectionEntry>();
	const datasetMeta = new Map<string, DatasetMeta>();
	const datasetRows = new Map<string, Map<string, DatasetRowRecord>>();
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
		setFlush: async (state) => void (flush = structuredClone(state)),
		putRecords: async (entries) => void entries.forEach((e) => records.set(e.id, e)),
		allRecords: async () => [...records.values()],
		deleteRecords: async (ids) => void ids.forEach((id) => records.delete(id)),
		putProjections: async (entries) => void entries.forEach((e) => projections.set(e.id, e)),
		allProjections: async () => [...projections.values()],
		deleteProjections: async (ids) => void ids.forEach((id) => projections.delete(id)),
		clearGraph: async () => {
			records.clear();
			projections.clear();
		},
		getDatasets: async () => structuredClone([...datasetMeta.values()]),
		readDataset: async (name) =>
			structuredClone([...(datasetRows.get(name)?.values() ?? [])]).sort((a, b) =>
				a.key < b.key ? -1 : a.key > b.key ? 1 : 0
			),
		commitDataset: async (commit) => {
			const fail = (step: DatasetStep) => {
				if (options.failDatasetAt?.(step))
					throw new Error(`dataset commit failed at ${step}`);
			};
			// steps run on a copy, so a failure leaves the held rows as they were
			const staged = new Map<string, DatasetRowRecord>(
				commit.clear ? undefined : datasetRows.get(commit.name)
			);
			fail('clear');
			for (const key of commit.deletes) staged.delete(key);
			fail('deletes');
			for (const put of commit.puts) staged.set(put.key, structuredClone(put));
			fail('puts');
			fail('meta');
			if (staged.size === 0) datasetRows.delete(commit.name);
			else datasetRows.set(commit.name, staged);
			if (commit.meta) datasetMeta.set(commit.name, structuredClone(commit.meta));
			else datasetMeta.delete(commit.name);
		},
		clearDatasets: async () => {
			datasetMeta.clear();
			datasetRows.clear();
		}
	};
}
