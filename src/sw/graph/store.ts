/** how an {@link EntryStore} reaches durable storage */
export type EntryBacking<T> = {
	all(): Promise<T[]>;
	put(entries: readonly T[]): Promise<void>;
	delete(ids: readonly string[]): Promise<void>;
};

/**
 * Versioned entries by id, each held once at its newest version. An entry that arrives at a
 * version the store already has is not written again.
 */
export class EntryStore<T extends { id: string; version: number }> {
	readonly #backing: EntryBacking<T>;
	readonly #entries = new Map<string, T>();

	constructor(backing: EntryBacking<T>) {
		this.#backing = backing;
	}

	/** reads what is persisted */
	async load(): Promise<void> {
		for (const entry of await this.#backing.all()) this.#entries.set(entry.id, entry);
	}

	get(id: string): T | undefined {
		return this.#entries.get(id);
	}

	/** every held entry */
	all(): T[] {
		return [...this.#entries.values()];
	}

	/** ids in sorted order */
	ids(): string[] {
		return [...this.#entries.keys()].sort();
	}

	/**
	 * Stores the entries newer than what is held and returns their ids. `persist: false` keeps
	 * them in memory only and removes any persisted copy, so a restart cannot bring back an older one.
	 */
	async put(entries: readonly T[], persist: boolean): Promise<string[]> {
		const fresh = entries.filter((e) => (this.#entries.get(e.id)?.version ?? -1) < e.version);
		for (const entry of fresh) this.#entries.set(entry.id, entry);
		if (fresh.length > 0) {
			if (persist) await this.#backing.put(fresh);
			else await this.#backing.delete(fresh.map((e) => e.id));
		}
		return fresh.map((e) => e.id);
	}

	async drop(ids: readonly string[]): Promise<void> {
		const held = ids.filter((id) => this.#entries.delete(id));
		if (held.length > 0) await this.#backing.delete(held);
	}

	/** forgets every entry in memory; the caller clears the backing store */
	forget(): void {
		this.#entries.clear();
	}
}
