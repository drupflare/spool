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
	readonly #projectionsByRow = new Map<string, Set<string>>();
	readonly #artifactsByRow = new Map<string, Set<string>>();
	readonly #usesByArtifact = new Map<string, RefSet>();
	readonly #readsByProjection = new Map<
		string,
		{ deps: string[]; children: string[]; rows: string[] }
	>();

	/**
	 * records that `projection` reads the tags in `deps`, references the projections in `children`
	 * and the dataset rows in `rows`
	 */
	addProjection(
		projection: string,
		deps: readonly string[],
		children: readonly string[],
		rows: readonly string[] = []
	): void {
		this.removeProjections([projection]);
		this.#readsByProjection.set(projection, {
			deps: [...deps],
			children: [...children],
			rows: [...rows]
		});
		for (const tag of deps) add(this.#projectionsByTag, tag, projection);
		for (const child of children) add(this.#parentsByProjection, child, projection);
		for (const row of rows) add(this.#projectionsByRow, row, projection);
	}

	removeProjections(ids: readonly string[]): void {
		for (const id of ids) {
			const reads = this.#readsByProjection.get(id);
			if (!reads) continue;
			for (const tag of reads.deps) remove(this.#projectionsByTag, tag, id);
			for (const child of reads.children) remove(this.#parentsByProjection, child, id);
			for (const row of reads.rows) remove(this.#projectionsByRow, row, id);
			this.#readsByProjection.delete(id);
		}
	}

	/** records that `artifact` references these records, projections and dataset rows */
	addArtifact(artifact: string, uses: RefSet): void {
		this.removeArtifacts([artifact]);
		this.#usesByArtifact.set(artifact, uses);
		for (const id of uses.records) add(this.#artifactsByRecord, id, artifact);
		for (const id of uses.projections) add(this.#artifactsByProjection, id, artifact);
		for (const id of uses.rows ?? []) add(this.#artifactsByRow, id, artifact);
	}

	removeArtifacts(ids: readonly string[]): void {
		for (const id of ids) {
			const uses = this.#usesByArtifact.get(id);
			if (!uses) continue;
			for (const record of uses.records) remove(this.#artifactsByRecord, record, id);
			for (const projection of uses.projections)
				remove(this.#artifactsByProjection, projection, id);
			for (const row of uses.rows ?? []) remove(this.#artifactsByRow, row, id);
			this.#usesByArtifact.delete(id);
		}
	}

	/** forgets everything */
	clear(): void {
		this.#projectionsByTag.clear();
		this.#parentsByProjection.clear();
		this.#artifactsByRecord.clear();
		this.#artifactsByProjection.clear();
		this.#projectionsByRow.clear();
		this.#artifactsByRow.clear();
		this.#usesByArtifact.clear();
		this.#readsByProjection.clear();
	}

	/**
	 * What a change to dataset rows reaches: the projections that reference one directly, those
	 * and every projection above them, and the artifacts that use a reached projection or one of
	 * the rows. Row ids are `<dataset>/<key>`.
	 */
	rowsReaching(rows: Iterable<string>): { projections: string[]; artifacts: string[] } {
		const direct = new Set<string>();
		const artifacts = new Set<string>();
		for (const row of rows) {
			for (const id of this.#projectionsByRow.get(row) ?? []) direct.add(id);
			for (const id of this.#artifactsByRow.get(row) ?? []) artifacts.add(id);
		}
		const projections = this.withParents(direct);
		for (const id of this.artifactsUsing([], projections)) artifacts.add(id);
		return { projections, artifacts: [...artifacts].sort() };
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
