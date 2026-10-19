import type { ProjectionEntry, RecordEntry } from '../protocol/graph.js';
import type { Retention } from '../protocol/route.js';
import type { ReplicaStorage, StoredArtifact } from './storage.js';

/** where the keys that seal a partition live */
export interface KeyVault {
	/** the key of `retention` for `partition`; with `create` false, undefined when none exists */
	get(partition: string, retention: Retention, create: boolean): Promise<CryptoKey | undefined>;
	/** deletes every key of `partition`; what it sealed cannot be read afterwards */
	shred(partition: string): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const generate = () =>
	crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

/** keys held in memory only, both retentions; for tests and for a worker with no IndexedDB */
export function memoryVault(): KeyVault {
	const keys = new Map<string, CryptoKey>();
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.catch(() => undefined);
		return run;
	};
	return {
		get: (partition, retention, create) =>
			serial(async () => {
				const id = `${partition}\u0000${retention}`;
				let key = keys.get(id);
				if (!key && create) {
					key = await generate();
					keys.set(id, key);
				}
				return key;
			}),
		shred: (partition) =>
			serial(async () => {
				for (const id of [...keys.keys()])
					if (id.startsWith(`${partition}\u0000`)) keys.delete(id);
			})
	};
}

/** a sealed value as it sits in storage, beside the id and version the store needs as keys */
type Row = { sealed: { iv: Uint8Array; data: ArrayBuffer; at: Retention } };

async function seal(key: CryptoKey, aad: string, value: unknown, at: Retention): Promise<Row> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) as BufferSource },
		key,
		encoder.encode(JSON.stringify(value)) as BufferSource
	);
	return { sealed: { iv, data, at } };
}

async function unseal<T>(
	vault: KeyVault,
	partition: string,
	aad: string,
	row: Row | undefined
): Promise<T | undefined> {
	const sealed = row?.sealed;
	if (!sealed) return undefined;
	const key = await vault.get(partition, sealed.at, false);
	if (!key) return undefined;
	try {
		const plain = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: sealed.iv as BufferSource,
				additionalData: encoder.encode(aad) as BufferSource
			},
			key,
			sealed.data
		);
		return JSON.parse(decoder.decode(plain)) as T;
	} catch {
		return undefined;
	}
}

/** what {@link sealedStorage} needs to decide a key and to bind a value to its place */
export type SealOptions = {
	partition: string;
	vault: KeyVault;
	/** the retention of the route that owns artifact `id` */
	retentionOf(id: string): Retention;
	/** the retention for records, projections and the bookkeeping, which no one route owns */
	shared: Retention;
};

/** a partition's storage that can be shut for good */
export type SealedStorage = ReplicaStorage & { kill(): void };

/**
 * Wraps a partition's storage so artifacts, records, projections and the replica meta are AES-GCM
 * ciphertext at rest. The ids and versions that serve as keys stay readable; everything else,
 * dependency tags included, is sealed. Each value is bound to its partition, kind and id as
 * additional data, so a row copied into another slot or another partition does not decrypt. A row
 * whose key is gone (a shredded partition, or a session key lost with the worker) reads as absent.
 * Once `kill` runs, writes do nothing and reads find nothing, so a request that outlives a wipe
 * cannot bring the store back.
 *
 * This is crypto-shredding for data at rest. Script running with the origin's privileges can ask
 * the worker for the same data the page can, so it is not a defence against injected script.
 */
export function sealedStorage(inner: ReplicaStorage, options: SealOptions): SealedStorage {
	const { partition, vault } = options;
	let dead = false;
	const aad = (kind: string, id: string) => `${partition}\u0000${kind}\u0000${id}`;

	async function sealWith(retention: Retention, kind: string, id: string, value: unknown) {
		const key = await vault.get(partition, retention, true);
		if (!key) throw new Error('no key');
		return seal(key, aad(kind, id), value, retention);
	}

	const open = <T>(kind: string, id: string, row: unknown) =>
		unseal<T>(vault, partition, aad(kind, id), row as Row | undefined);

	return {
		kill: () => void (dead = true),
		async getArtifact(id) {
			if (dead) return undefined;
			const row = await inner.getArtifact(id);
			if (!row) return undefined;
			const value = await open<StoredArtifact>('artifact', id, row);
			if (!value) await inner.deleteArtifacts([id]);
			return value;
		},
		async putArtifact(stored) {
			if (dead) return;
			const id = stored.artifact.id;
			const row = await sealWith(options.retentionOf(id), 'artifact', id, stored);
			if (dead) return;
			await inner.putArtifact({ artifact: { id }, ...row } as unknown as StoredArtifact);
		},
		deleteArtifacts: (ids) => (dead ? Promise.resolve() : inner.deleteArtifacts(ids)),
		async allArtifacts() {
			if (dead) return [];
			const out: StoredArtifact[] = [];
			const lost: string[] = [];
			for (const row of await inner.allArtifacts()) {
				const id = row.artifact.id;
				const value = await open<StoredArtifact>('artifact', id, row);
				if (value) out.push(value);
				else lost.push(id);
			}
			if (lost.length > 0) await inner.deleteArtifacts(lost);
			return out;
		},
		clearArtifacts: () => (dead ? Promise.resolve() : inner.clearArtifacts()),
		async getMeta() {
			if (dead) return undefined;
			return open('meta', 'replica', await inner.getMeta());
		},
		async setMeta(meta) {
			if (dead) return;
			const row = await sealWith(options.shared, 'meta', 'replica', meta);
			if (!dead) await inner.setMeta(row as never);
		},
		addBeacon: (event) => inner.addBeacon(event),
		readBeacons: () => inner.readBeacons(),
		removeBeacons: (keys) => inner.removeBeacons(keys),
		getFlush: () => inner.getFlush(),
		setFlush: (state) => inner.setFlush(state),
		async putRecords(entries) {
			if (dead) return;
			const rows = await Promise.all(
				entries.map(async (e) => ({
					id: e.id,
					version: e.version,
					...(await sealWith(options.shared, 'record', e.id, e))
				}))
			);
			if (!dead) await inner.putRecords(rows as unknown as RecordEntry[]);
		},
		async allRecords() {
			if (dead) return [];
			const out: RecordEntry[] = [];
			for (const row of await inner.allRecords()) {
				const value = await open<RecordEntry>('record', row.id, row);
				if (value) out.push(value);
			}
			return out;
		},
		deleteRecords: (ids) => (dead ? Promise.resolve() : inner.deleteRecords(ids)),
		async putProjections(entries) {
			if (dead) return;
			const rows = await Promise.all(
				entries.map(async (e) => ({
					id: e.id,
					version: e.version,
					...(await sealWith(options.shared, 'projection', e.id, e))
				}))
			);
			if (!dead) await inner.putProjections(rows as unknown as ProjectionEntry[]);
		},
		async allProjections() {
			if (dead) return [];
			const out: ProjectionEntry[] = [];
			for (const row of await inner.allProjections()) {
				const value = await open<ProjectionEntry>('projection', row.id, row);
				if (value) out.push(value);
			}
			return out;
		},
		deleteProjections: (ids) => (dead ? Promise.resolve() : inner.deleteProjections(ids)),
		clearGraph: () => (dead ? Promise.resolve() : inner.clearGraph())
	};
}
