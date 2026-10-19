import type { RefSet } from '../../protocol/graph.js';

function add(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key) ?? new Set<string>();
	set.add(value);
	map.set(key, set);
}

function remove(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key);
	if (!set) return;
	set.delete(value);
	if (set.size === 0) map.delete(key);
}

/**
 * The dependency index: which projections read a tag, which projections read another projection,
 * and which artifacts use a record or a projection. It answers "what does this change reach"
 * without reading any data.
 */
export class DependencyIndex {
	readonly #projectionsByTag = new Map<string, Set<string>>();
	readonly #parentsByProjection = new Map<string, Set<string>>();
	readonly #artifactsByRecord = new Map<string, Set<string>>();
	readonly #artifactsByProjection = new Map<string, Set<string>>();
	readonly #usesByArtifact = new Map<string, RefSet>();
	readonly #readsByProjection = new Map<string, { deps: string[]; children: string[] }>();

	/** records that `projection` reads the tags in `deps` and references the projections in `children` */
	addProjection(projection: string, deps: readonly string[], children: readonly string[]): void {
		this.removeProjections([projection]);
		this.#readsByProjection.set(projection, { deps: [...deps], children: [...children] });
		for (const tag of deps) add(this.#projectionsByTag, tag, projection);
		for (const child of children) add(this.#parentsByProjection, child, projection);
	}

	removeProjections(ids: readonly string[]): void {
		for (const id of ids) {
			const reads = this.#readsByProjection.get(id);
			if (!reads) continue;
			for (const tag of reads.deps) remove(this.#projectionsByTag, tag, id);
			for (const child of reads.children) remove(this.#parentsByProjection, child, id);
			this.#readsByProjection.delete(id);
		}
	}

	/** records that `artifact` references these records and projections */
	addArtifact(artifact: string, uses: RefSet): void {
		this.removeArtifacts([artifact]);
		this.#usesByArtifact.set(artifact, uses);
		for (const id of uses.records) add(this.#artifactsByRecord, id, artifact);
		for (const id of uses.projections) add(this.#artifactsByProjection, id, artifact);
	}

	removeArtifacts(ids: readonly string[]): void {
		for (const id of ids) {
			const uses = this.#usesByArtifact.get(id);
			if (!uses) continue;
			for (const record of uses.records) remove(this.#artifactsByRecord, record, id);
			for (const projection of uses.projections)
				remove(this.#artifactsByProjection, projection, id);
			this.#usesByArtifact.delete(id);
		}
	}

	/** forgets everything */
	clear(): void {
		this.#projectionsByTag.clear();
		this.#parentsByProjection.clear();
		this.#artifactsByRecord.clear();
		this.#artifactsByProjection.clear();
		this.#usesByArtifact.clear();
		this.#readsByProjection.clear();
	}

	/** the projections that read any of `tags` directly */
	projectionsReading(tags: Iterable<string>): string[] {
		const out = new Set<string>();
		for (const tag of tags) for (const id of this.#projectionsByTag.get(tag) ?? []) out.add(id);
		return [...out].sort();
	}

	/** `projections` and every projection that references one of them, directly or not */
	withParents(projections: Iterable<string>): string[] {
		const out = new Set<string>();
		const queue = [...projections];
		for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
			if (out.has(id)) continue;
			out.add(id);
			queue.push(...(this.#parentsByProjection.get(id) ?? []));
		}
		return [...out].sort();
	}

	/** the artifacts that reference any of these records or projections */
	artifactsUsing(records: Iterable<string>, projections: Iterable<string>): string[] {
		const out = new Set<string>();
		for (const id of records) for (const a of this.#artifactsByRecord.get(id) ?? []) out.add(a);
		for (const id of projections) {
			for (const a of this.#artifactsByProjection.get(id) ?? []) out.add(a);
		}
		return [...out].sort();
	}
}
