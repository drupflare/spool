import type { Artifact } from '../protocol/artifact.js';
import { CLEAR_ALL, type Envelope } from '../protocol/envelope.js';
import {
	ARTIFACT_TAG_PREFIX,
	artifactTag,
	MAX_HAVE,
	MAX_NEED,
	type SyncResponse
} from '../protocol/sync.js';
import { isCurrent, validatedAt } from './freshness.js';
import { Graph, usesGraph, type Materialized } from './graph/index.js';
import { MAX_POLICY_PATHS, type HeaderSet } from './policy.js';
import type { ReplicaStorage, StoredArtifact } from './storage.js';

/**
 * The device-side copy: artifacts, the tag versions learned from syncs, and the cursor they are
 * current to. An artifact is valid while no dependency tag has a version above the cursor the
 * artifact was built at; every sync and piggybacked diff only ever raises tag versions, so
 * a stale copy is never revived.
 */
export class Replica {
	readonly #storage: ReplicaStorage;
	readonly #version: string;
	readonly #now: () => number;
	readonly #memory = new Map<string, StoredArtifact>();
	// ponytail: tag versions are never pruned (one entry per distinct changed tag)
	#tags = new Map<string, number>();
	#cursor: number | null = null;
	#syncedAt = 0;
	#epoch = 0;
	#site: HeaderSet | undefined;
	#policies = new Map<string, HeaderSet>();
	/** records and projections; untouched until a page that references them is stored or shown */
	readonly graph: Graph;

	constructor(storage: ReplicaStorage, version: string, now: () => number = Date.now) {
		this.#storage = storage;
		this.#version = version;
		this.#now = now;
		this.graph = new Graph({
			storage,
			tagVersion: (tag) => this.#tags.get(tag) ?? 0,
			artifacts: () => this.#all()
		});
	}

	/** reads the persisted meta; a different runtime version wipes what the old one stored */
	async load(): Promise<void> {
		const meta = await this.#storage.getMeta();
		if (meta && meta.version === this.#version) {
			this.#cursor = meta.cursor;
			this.#syncedAt = meta.syncedAt;
			this.#tags = new Map(meta.tags);
			this.#site = meta.policy?.site;
			this.#policies = new Map(meta.policy?.paths);
			return;
		}
		await this.#storage.clearArtifacts();
		await this.graph.clear();
		await this.#save();
	}

	/** the vector cursor the replica is current to, or null before the first artifact */
	get cursor(): number | null {
		return this.#cursor;
	}

	/** when the replica last completed a sync or a piggybacked diff */
	get syncedAt(): number {
		return this.#syncedAt;
	}

	/** the security headers of the latest network navigation, or undefined before one was seen */
	get sitePolicy(): HeaderSet | undefined {
		return this.#site;
	}

	/** the security headers `path` itself was last answered with, or undefined */
	policyOf(path: string): HeaderSet | undefined {
		return this.#policies.get(path);
	}

	/** keeps the headers of a network view: for `path`, or for the whole site when `path` is null */
	async keepPolicy(path: string | null, headers: HeaderSet): Promise<void> {
		const same = (a: HeaderSet | undefined) => JSON.stringify(a) === JSON.stringify(headers);
		if (path === null) {
			if (same(this.#site)) return;
			this.#site = headers;
		} else {
			if (same(this.#policies.get(path))) return;
			this.#policies.delete(path);
			this.#policies.set(path, headers);
			if (this.#policies.size > MAX_POLICY_PATHS) {
				this.#policies.delete(this.#policies.keys().next().value as string);
			}
		}
		await this.#save();
	}

	/** the stored artifact for `id`, memory-only routes included */
	async get(id: string): Promise<StoredArtifact | undefined> {
		return this.#memory.get(id) ?? (await this.#storage.getArtifact(id));
	}

	/** every stored artifact id */
	async ids(): Promise<string[]> {
		return (await this.#all()).map((s) => s.artifact.id);
	}

	/** counts the wipes so far; a write that began before one and ends after it can tell and drop itself */
	get epoch(): number {
		return this.#epoch;
	}

	/** whether no dependency of `artifact` has changed since it was built */
	isCurrent(artifact: Artifact): boolean {
		return isCurrent(artifact, (tag) => this.#tags.get(tag) ?? 0);
	}

	/** when `stored` was last known good */
	validatedAt(stored: StoredArtifact): number {
		return Math.max(validatedAt(stored.fetchedAt, this.#syncedAt), stored.validatedAt ?? 0);
	}

	/** records that a sync just confirmed `id`, if it is still stored */
	async validate(id: string): Promise<void> {
		const stored = await this.get(id);
		if (!stored || !this.isCurrent(stored.artifact)) return;
		const next = { ...stored, validatedAt: this.#now() };
		if (this.#memory.has(id)) this.#memory.set(id, next);
		else await this.#storage.putArtifact(next);
	}

	/**
	 * What to ask `/.spool/sync?need=` about before showing `artifact`: each tag it depends on at
	 * the version it was built, plus its own drop tag. Null for an artifact with no references,
	 * which a full sync validates unless `always` is set, and for one that depends on more than the
	 * server accepts.
	 */
	needFor(artifact: Artifact, always = false): Record<string, number> | null {
		if (!always && !usesGraph(artifact)) return null;
		const tags = [...new Set([...artifact.deps, artifactTag(artifact.id)])];
		if (tags.length > MAX_NEED) return null;
		return Object.fromEntries(tags.map((tag) => [tag, artifact.vector]));
	}

	/** the records and projections held, for an artifact request's `have`; loads the graph */
	async held(): Promise<Record<string, number>> {
		await this.#wake();
		return this.graph.held(MAX_HAVE);
	}

	/** the artifact with its references resolved from the graph; loads the graph when it has any */
	async materialize(artifact: Artifact): Promise<Materialized> {
		if (usesGraph(artifact)) await this.#wake();
		return this.graph.materialize(artifact);
	}

	async #wake(): Promise<void> {
		const gone = await this.graph.ensure();
		if (gone.length > 0) await this.drop(gone);
	}

	/**
	 * Stores an artifact unless a change it missed is already known. The first one sets the cursor
	 * to its vector, since nothing earlier can affect it. Returns whether it was kept.
	 */
	async put(artifact: Artifact, persist: boolean, catalogue = false): Promise<boolean> {
		if (!this.isCurrent(artifact)) return false;
		if (usesGraph(artifact)) {
			await this.#wake();
			await this.graph.put(artifact, persist);
		}
		const { records: _records, projections: _projections, ...rest } = artifact;
		const stored: StoredArtifact = {
			artifact: rest as Artifact,
			fetchedAt: this.#now(),
			...(catalogue ? { catalogue: true as const } : {})
		};
		if (persist) {
			this.#memory.delete(artifact.id);
			await this.#storage.putArtifact(stored);
		} else {
			await this.#storage.deleteArtifacts([artifact.id]);
			this.#memory.set(artifact.id, stored);
		}
		if (this.#cursor === null) {
			this.#cursor = artifact.vector;
			await this.#save();
		}
		return true;
	}

	/** marks the catalogue entry `id` as opened, so it is an ordinary artifact from now on */
	async open(id: string): Promise<void> {
		const stored = await this.get(id);
		if (!stored?.catalogue) return;
		const { catalogue: _catalogue, ...opened } = stored;
		if (this.#memory.has(id)) this.#memory.set(id, opened);
		else await this.#storage.putArtifact(opened);
	}

	/**
	 * `need` with the dependency tags and drop tag of every unopened catalogue entry added, each at
	 * the vector its entry was built at. A revoked entry that no page opens is named by no page's
	 * sync, so a required sync of a principal page carries this. Null when the union is over
	 * `MAX_NEED`, which the caller answers with a full sync.
	 */
	async sweep(need: Record<string, number>): Promise<Record<string, number> | null> {
		const out = { ...need };
		for (const { artifact, catalogue } of await this.#all()) {
			if (!catalogue) continue;
			for (const tag of [...artifact.deps, artifactTag(artifact.id)]) {
				out[tag] = Math.min(out[tag] ?? Infinity, artifact.vector);
			}
		}
		return Object.keys(out).length > MAX_NEED ? null : out;
	}

	/** removes artifacts by id */
	async drop(ids: readonly string[]): Promise<void> {
		for (const id of ids) this.#memory.delete(id);
		await this.#storage.deleteArtifacts(ids);
		if (this.graph.loaded) this.graph.forgetArtifacts(ids);
	}

	/** empties the replica; `cursor` is where it restarts */
	async wipe(cursor: number | null = null): Promise<void> {
		this.#epoch += 1;
		this.#memory.clear();
		await this.#storage.clearArtifacts();
		await this.graph.clear();
		this.#tags = new Map();
		this.#site = undefined;
		this.#policies = new Map();
		this.#cursor = cursor;
		await this.#save();
	}

	/** applies a `/.spool/sync` answer and returns the ids of the artifacts it invalidated */
	async applySync(response: SyncResponse): Promise<string[]> {
		if (response.reset) {
			const held = await this.ids();
			await this.wipe(response.cursor);
			this.#syncedAt = this.#now();
			await this.#save();
			return held;
		}
		const gone = await this.#merge(response.changed);
		await this.drop(response.dropped);
		if (!response.partial) {
			this.#cursor = Math.max(this.#cursor ?? 0, response.cursor);
			this.#syncedAt = this.#now();
		}
		await this.#save();
		return [...new Set([...gone, ...response.dropped])];
	}

	/**
	 * Applies the spool headers of a network response. Invalidations always apply. The cursor and
	 * the sync clock move only when the response answers the cursor this worker sent and carries
	 * no `Age`, so a copy replayed from a shared cache cannot extend freshness.
	 */
	async applyEnvelope(envelope: Envelope, sent: number | null, aged: boolean): Promise<string[]> {
		let gone: string[] = [];
		if (envelope.clear?.includes(CLEAR_ALL)) {
			gone = await this.ids();
			await this.wipe(envelope.vector ?? this.#cursor);
		} else if (envelope.invalidate) {
			gone = await this.#merge(envelope.invalidate);
		}
		const answered = sent !== null && envelope.seen === sent && envelope.vector !== undefined;
		if (answered && !aged) {
			this.#cursor = Math.max(this.#cursor ?? 0, envelope.vector as number);
			this.#syncedAt = this.#now();
		}
		await this.#save();
		return gone;
	}

	async #all(): Promise<StoredArtifact[]> {
		return [...this.#memory.values(), ...(await this.#storage.allArtifacts())];
	}

	async #merge(changed: Readonly<Record<string, number>>): Promise<string[]> {
		const dropAt = new Map<string, number>();
		for (const [tag, version] of Object.entries(changed)) {
			if (tag.startsWith(ARTIFACT_TAG_PREFIX)) {
				dropAt.set(tag.slice(ARTIFACT_TAG_PREFIX.length), version);
			} else if (version > (this.#tags.get(tag) ?? 0)) this.#tags.set(tag, version);
		}
		const reached = this.graph.loaded
			? (await this.graph.invalidate(Object.fromEntries(this.#changedTags(changed))))
					.artifacts
			: [];
		const gone = (await this.#all())
			.filter(({ artifact }) => {
				const at = dropAt.get(artifact.id);
				return (
					(at !== undefined && artifact.vector < at) ||
					!this.isCurrent(artifact) ||
					reached.includes(artifact.id)
				);
			})
			.map(({ artifact }) => artifact.id);
		await this.drop(gone);
		return gone;
	}

	#changedTags(changed: Readonly<Record<string, number>>): Array<[string, number]> {
		return Object.entries(changed).filter(([tag]) => !tag.startsWith(ARTIFACT_TAG_PREFIX));
	}

	async #save(): Promise<void> {
		await this.#storage.setMeta({
			version: this.#version,
			cursor: this.#cursor,
			tags: [...this.#tags],
			syncedAt: this.#syncedAt,
			policy: { ...(this.#site ? { site: this.#site } : {}), paths: [...this.#policies] }
		});
	}
}
