import type { Artifact, AssemblyBody, Text } from '../../protocol/artifact.js';
import {
	collectRefs,
	resolveRefs,
	type ProjectionEntry,
	type RefLookup,
	type RefSet
} from '../../protocol/graph.js';
import type { ReplicaStorage, StoredArtifact } from '../storage.js';
import { DependencyIndex } from './invalidate.js';
import { projectionStore } from './projections.js';
import { recordStore } from './records.js';

export { DependencyIndex } from './invalidate.js';
export { projectionStore, type ProjectionStore } from './projections.js';
export { recordStore, type RecordStore } from './records.js';
export { EntryStore, type EntryBacking } from './store.js';

/** what a change reached; every list is sorted */
export type Invalidated = { records: string[]; projections: string[]; artifacts: string[] };

/** a page with every reference resolved, or why it cannot be built from what is held */
export type Materialized = { ok: true; artifact: Artifact } | { ok: false; reason: string };

/** what the graph reads from the replica around it */
export type GraphDeps = {
	storage: ReplicaStorage;
	/** the newest version learned for a tag, 0 when none */
	tagVersion(tag: string): number;
	/** every stored artifact, read once to build the index on first use */
	artifacts(): Promise<StoredArtifact[]>;
};

/** whether an artifact references anything in the graph */
export function usesGraph(artifact: Artifact): boolean {
	return (
		artifact.records !== undefined ||
		artifact.projections !== undefined ||
		hasRefs(collectRefs(artifact.body))
	);
}

const hasRefs = (refs: RefSet) => refs.records.length + refs.projections.length > 0;

function childProjections(entry: ProjectionEntry): string[] {
	return collectRefs(entry.data).projections;
}

/**
 * Records and projections stored once, the index over them, and the rules that tie them to
 * artifacts. Nothing is read from storage until {@link Graph.ensure}: a worker that wakes for a
 * page with no references never touches it.
 */
export class Graph {
	readonly records;
	readonly projections;
	readonly index = new DependencyIndex();
	readonly #deps: GraphDeps;
	#loaded: Promise<string[]> | undefined;

	constructor(deps: GraphDeps) {
		this.#deps = deps;
		this.records = recordStore(deps.storage);
		this.projections = projectionStore(deps.storage);
	}

	/** whether `ensure` has been called */
	get loaded(): boolean {
		return this.#loaded !== undefined;
	}

	/**
	 * Loads records and projections, builds the index from the stored artifacts, and drops what a
	 * change learned while the graph was asleep outdated. Resolves to the artifacts that lost a
	 * dependency on the first call and to nothing after.
	 */
	ensure(): Promise<string[]> {
		const first = this.#loaded === undefined;
		this.#loaded ??= this.#load();
		return first ? this.#loaded : this.#loaded.then(() => []);
	}

	async #load(): Promise<string[]> {
		await Promise.all([this.records.load(), this.projections.load()]);
		for (const entry of this.projections.all()) {
			this.index.addProjection(entry.id, entry.deps, childProjections(entry));
		}
		for (const { artifact } of await this.#deps.artifacts()) {
			const uses = collectRefs(artifact.body);
			if (hasRefs(uses)) this.index.addArtifact(artifact.id, uses);
		}
		const changed: Record<string, number> = {};
		for (const record of this.records.all()) {
			const version = this.#deps.tagVersion(record.id);
			if (version > record.version) changed[record.id] = version;
		}
		for (const projection of this.projections.all()) {
			for (const dep of projection.deps) {
				const version = this.#deps.tagVersion(dep);
				if (version > projection.version) changed[dep] = version;
			}
		}
		return (await this.invalidate(changed)).artifacts;
	}

	/** stores what an artifact brought and indexes the artifact's references */
	async put(artifact: Artifact, persist: boolean): Promise<void> {
		await this.records.put(artifact.records ?? [], persist);
		const added = await this.projections.put(artifact.projections ?? [], persist);
		for (const id of added) {
			const entry = this.projections.get(id) as ProjectionEntry;
			this.index.addProjection(id, entry.deps, childProjections(entry));
		}
		const uses = collectRefs(artifact.body);
		if (hasRefs(uses)) this.index.addArtifact(artifact.id, uses);
	}

	/** forgets artifacts in the index; their records stay, so a refetch can reuse them */
	forgetArtifacts(ids: readonly string[]): void {
		this.index.removeArtifacts(ids);
	}

	/** records and projections held, with the version each is at, for an artifact request's `have` */
	held(limit: number): Record<string, number> {
		const out: Record<string, number> = {};
		for (const entry of [...this.records.all(), ...this.projections.all()].slice(0, limit)) {
			out[entry.id] = entry.version;
		}
		return out;
	}

	/**
	 * Applies tag versions learned from a sync. A record is dropped when its tag moved past its
	 * version. A projection is dropped when a tag it reads did, or when a projection it references
	 * was. Artifacts that reference anything dropped are reported, not removed: the replica owns them.
	 */
	async invalidate(changed: Readonly<Record<string, number>>): Promise<Invalidated> {
		const tags = Object.keys(changed);
		const stale = (id: string, version: number) => (changed[id] ?? 0) > version;
		const records = tags.filter((tag) => {
			const held = this.records.get(tag);
			return held !== undefined && stale(tag, held.version);
		});
		const direct = this.index.projectionsReading(tags).filter((id) => {
			const held = this.projections.get(id);
			return held !== undefined && held.deps.some((dep) => stale(dep, held.version));
		});
		const projections = this.index.withParents(direct).filter((id) => this.projections.get(id));
		const artifacts = this.index.artifactsUsing(records, projections);
		await this.records.drop(records);
		await this.projections.drop(projections);
		this.index.removeProjections(projections);
		return { records: records.sort(), projections, artifacts };
	}

	/** forgets everything in memory and in storage */
	async clear(): Promise<void> {
		this.records.forget();
		this.projections.forget();
		this.index.clear();
		await this.#deps.storage.clearGraph();
	}

	/** the artifact with every reference replaced by what the graph holds */
	async materialize(artifact: Artifact): Promise<Materialized> {
		if (artifact.strategy === 'static' || !hasRefs(collectRefs(artifact.body))) {
			return { ok: true, artifact };
		}
		await this.ensure();
		const lookup: RefLookup = {
			record: (id) => this.records.get(id),
			projection: (id) => this.projections.get(id)
		};
		if (artifact.strategy !== 'assembly') {
			const data = resolveRefs(artifact.body.data, lookup);
			if (!data.ok) return data;
			return { ok: true, artifact: { ...artifact, body: { data: data.value } } };
		}
		const text = (values: Record<string, Text> | undefined) => {
			const out: Record<string, string> = {};
			for (const [name, value] of Object.entries(values ?? {})) {
				const resolved = resolveRefs(value, lookup);
				if (!resolved.ok) return resolved;
				if (typeof resolved.value !== 'string') {
					return { ok: false as const, reason: `${name} did not resolve to text` };
				}
				out[name] = resolved.value;
			}
			return { ok: true as const, value: out };
		};
		const fragments = text(artifact.body.fragments);
		if (!fragments.ok) return fragments;
		const slots = text(artifact.body.slots);
		if (!slots.ok) return slots;
		const body: AssemblyBody = { shell: artifact.body.shell };
		if (artifact.body.fragments) body.fragments = fragments.value;
		if (artifact.body.slots) body.slots = slots.value;
		return { ok: true, artifact: { ...artifact, body } };
	}
}
