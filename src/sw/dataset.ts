import { applyChanges, type DatasetResponse, type DatasetRow } from '../protocol/dataset.js';
import { digestAdd, EMPTY_DIGEST } from '../protocol/query.js';
import type { DatasetMeta, DatasetRowRecord, ReplicaStorage } from './storage.js';

const encoder = new TextEncoder();

/** bytes of a row's JSON, the unit `maxBytes` and the storage budget count in */
export const rowBytes = (row: DatasetRow): number => encoder.encode(JSON.stringify(row)).length;

/** a dataset in memory, as a verified load or a commit left it */
export type Held = {
	meta: DatasetMeta;
	rows: Map<string, DatasetRow>;
	/** the hash of every row, so a patch never hashes a row it replaces or deletes */
	hashes: Map<string, string>;
};

/** what the store needs from the replica around it */
export type DatasetStoreDeps = {
	storage: ReplicaStorage;
	now(): number;
	/** the replica's wipe count; a commit that began under another one is dropped */
	epoch(): number;
	/** the row hash; {@link rowHash}. A test counts calls through it */
	hash?: (key: string, row: DatasetRow) => Promise<string>;
	/** told after every commit which row keys it put and which it removed */
	onChange?(name: string, puts: string[], deletes: string[]): Promise<void> | void;
};

/**
 * One dataset's state while a response or a run of seed pages is applied, before anything is
 * written. A staged seed replaces the held rows; a staged patch changes them. Nothing here
 * touches storage, so a failed or dropped apply leaves the store as it was.
 */
export class Staging {
	readonly name: string;
	/** whether the commit replaces every held row */
	clear: boolean;
	rows: Map<string, DatasetRow>;
	hashes: Map<string, string>;
	digest: string;
	bytes: number;
	readonly #deps: DatasetStoreDeps;
	readonly #puts = new Set<string>();
	readonly #deletes = new Set<string>();

	constructor(deps: DatasetStoreDeps, name: string, base?: Held) {
		this.#deps = deps;
		this.name = name;
		this.clear = base === undefined;
		this.rows = base?.rows ?? new Map();
		this.hashes = base?.hashes ?? new Map();
		this.digest = base?.meta.digest ?? EMPTY_DIGEST;
		this.bytes = base?.meta.bytes ?? 0;
	}

	/** applies a response; returns whether the result equals the response's proof, null without one */
	async add(response: DatasetResponse): Promise<boolean | null> {
		const fresh = response.reset && response.after === undefined;
		if (fresh) {
			this.clear = true;
			this.bytes = 0;
			this.#puts.clear();
			this.#deletes.clear();
		}
		// bytes follow the rows in the order the response applies them, deletes first
		const overlay = new Map<string, DatasetRow | undefined>();
		const current = (key: string) =>
			overlay.has(key) ? overlay.get(key) : fresh ? undefined : this.rows.get(key);
		for (const { key } of response.deletes) {
			const old = current(key);
			if (old !== undefined) this.bytes -= rowBytes(old);
			overlay.set(key, undefined);
		}
		for (const { key, row } of response.puts) {
			const old = current(key);
			if (old !== undefined) this.bytes -= rowBytes(old);
			this.bytes += rowBytes(row);
			overlay.set(key, row);
		}
		const options = {
			hashes: this.hashes,
			...(this.#deps.hash ? { hash: this.#deps.hash } : {})
		};
		const applied = await applyChanges(this.rows, response, this.digest, options);
		this.rows = applied.rows;
		this.hashes = applied.hashes as Map<string, string>;
		this.digest = applied.digest;
		for (const { key } of response.deletes) {
			this.#deletes.add(key);
			this.#puts.delete(key);
		}
		for (const { key } of response.puts) {
			this.#puts.add(key);
			this.#deletes.delete(key);
		}
		return applied.matches;
	}

	/** the rows a commit writes: all of them for a replacement, the touched ones for a patch */
	writes(): { puts: DatasetRowRecord[]; deletes: string[] } {
		const keys = this.clear ? [...this.rows.keys()] : [...this.#puts];
		return {
			puts: keys.map((key) => ({
				name: this.name,
				key,
				row: this.rows.get(key) as DatasetRow,
				hash: this.hashes.get(key) as string
			})),
			deletes: this.clear ? [] : [...this.#deletes]
		};
	}
}

/**
 * The datasets a device holds. Rows live once in memory after a verified load and once in
 * storage, and a response is applied to a {@link Staging} first and committed in one storage
 * transaction. Reads and writes of the held set go through one queue, so a commit and a wipe
 * never interleave.
 */
export class DatasetStore {
	readonly #deps: DatasetStoreDeps;
	readonly #held = new Map<string, Promise<Held | undefined>>();
	readonly #loaded = new Map<string, Held>();
	#metas: Promise<Map<string, DatasetMeta>> | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	#sorted = new Map<string, DatasetRow[]>();
	/** datasets found damaged on a load and cleared, since the worker started */
	evicted = 0;

	constructor(deps: DatasetStoreDeps) {
		this.#deps = deps;
	}

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	#metaMap(): Promise<Map<string, DatasetMeta>> {
		this.#metas ??= this.#deps.storage
			.getDatasets()
			.then((all) => new Map(all.map((meta) => [meta.name, meta])));
		return this.#metas;
	}

	/** the meta of every held dataset */
	async list(): Promise<DatasetMeta[]> {
		return [...(await this.#metaMap()).values()].sort((a, b) => (a.name < b.name ? -1 : 1));
	}

	/**
	 * Loads one dataset into memory and checks it: the stored row count and the sum of the stored row
	 * hashes must equal the meta. A dataset that fails, which is what a partly evicted store looks
	 * like, is cleared and reads as absent. No row is hashed.
	 */
	get(name: string): Promise<Held | undefined> {
		let held = this.#held.get(name);
		if (!held) {
			held = this.#load(name);
			this.#held.set(name, held);
		}
		return held;
	}

	async #load(name: string): Promise<Held | undefined> {
		const meta = (await this.#metaMap()).get(name);
		if (!meta) return undefined;
		const records = await this.#deps.storage.readDataset(name);
		let sum = EMPTY_DIGEST;
		let sound = records.length === meta.count;
		try {
			for (const record of records) sum = digestAdd(sum, record.hash);
		} catch {
			sound = false;
		}
		if (!sound || sum !== meta.digest) {
			this.evicted += 1;
			await this.drop(name);
			return undefined;
		}
		const held: Held = {
			meta,
			rows: new Map(records.map((r) => [r.key, r.row])),
			hashes: new Map(records.map((r) => [r.key, r.hash]))
		};
		this.#loaded.set(name, held);
		return held;
	}

	/** the held rows in ascending key order, or undefined when `name` is not loaded and held */
	async rows(name: string): Promise<DatasetRow[] | undefined> {
		const held = await this.get(name);
		if (!held) return undefined;
		let sorted = this.#sorted.get(name);
		if (!sorted) {
			sorted = [...held.rows.keys()].sort().map((key) => held.rows.get(key) as DatasetRow);
			this.#sorted.set(name, sorted);
		}
		return sorted;
	}

	/** whether `name` is held and in memory */
	loaded(name: string): boolean {
		return this.#loaded.has(name);
	}

	/** a held row, looked up in memory; undefined unless {@link DatasetStore.get} loaded the dataset */
	row(name: string, key: string): DatasetRow | undefined {
		return this.#loaded.get(name)?.rows.get(key);
	}

	/** a staging area over the held rows of `name`, or an empty one for a seed */
	stage(name: string, base?: Held): Staging {
		return new Staging(this.#deps, name, base);
	}

	/**
	 * Writes a staged apply. `cursor` and `schema` are what the response brought the rows to.
	 * Returns false, writing nothing, when the replica was wiped since `epoch` was read. Rejects,
	 * with the held rows and the memory copy untouched, when the storage transaction fails.
	 */
	commit(
		staging: Staging,
		at: { cursor: number; schema: string },
		epoch: number
	): Promise<boolean> {
		return this.#serial(async () => {
			if (this.#deps.epoch() !== epoch) return false;
			const before = this.#loaded.get(staging.name);
			const meta: DatasetMeta = {
				name: staging.name,
				schema: at.schema,
				cursor: at.cursor,
				count: staging.rows.size,
				digest: staging.digest,
				bytes: staging.bytes,
				appliedAt: this.#deps.now()
			};
			const { puts, deletes } = staging.writes();
			await this.#deps.storage.commitDataset({
				name: staging.name,
				meta,
				clear: staging.clear,
				puts,
				deletes
			});
			const held: Held = { meta, rows: staging.rows, hashes: staging.hashes };
			await this.#set(staging.name, held);
			await this.#deps.onChange?.(staging.name, ...changedKeys(before, held));
			return true;
		});
	}

	/** records that a sync found the held rows current, with no change to them */
	touch(name: string, epoch: number): Promise<boolean> {
		return this.#serial(async () => {
			const held = this.#loaded.get(name);
			if (!held || this.#deps.epoch() !== epoch) return false;
			const meta = { ...held.meta, appliedAt: this.#deps.now() };
			await this.#deps.storage.commitDataset({
				name,
				meta,
				clear: false,
				puts: [],
				deletes: []
			});
			await this.#set(name, { ...held, meta });
			return true;
		});
	}

	/** clears one dataset's rows and meta, and nothing else */
	drop(name: string): Promise<void> {
		return this.#serial(async () => {
			const before = this.#loaded.get(name);
			await this.#deps.storage.commitDataset({
				name,
				meta: null,
				clear: true,
				puts: [],
				deletes: []
			});
			await this.#set(name, undefined);
			if (before) await this.#deps.onChange?.(name, [], [...before.rows.keys()]);
		});
	}

	/** clears every dataset, for a wipe of the replica */
	clear(): Promise<void> {
		return this.#serial(async () => {
			await this.#deps.storage.clearDatasets();
			this.#held.clear();
			this.#loaded.clear();
			this.#sorted.clear();
			this.#metas = Promise.resolve(new Map());
		});
	}

	async #set(name: string, held: Held | undefined): Promise<void> {
		const metas = await this.#metaMap();
		this.#sorted.delete(name);
		if (held) {
			metas.set(name, held.meta);
			this.#loaded.set(name, held);
			this.#held.set(name, Promise.resolve(held));
		} else {
			metas.delete(name);
			this.#loaded.delete(name);
			this.#held.delete(name);
		}
	}
}

/** the keys a commit put (new or different rows) and removed, by comparing row hashes */
function changedKeys(before: Held | undefined, after: Held): [string[], string[]] {
	const puts: string[] = [];
	for (const [key, hash] of after.hashes) {
		if (before?.hashes.get(key) !== hash) puts.push(key);
	}
	const deletes = [...(before?.hashes.keys() ?? [])].filter((key) => !after.hashes.has(key));
	return [puts, deletes];
}
