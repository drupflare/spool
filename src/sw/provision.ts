import type { Cost } from '../protocol/provision.js';

export * from '../protocol/provision.js';

/**
 * What one artifact cost and what it served. `catalogueBytes` is the part of `bytes` that arrived
 * in a catalogue bundle (the JSON text, uncompressed) and `catalogueViews` the part of `views`
 * that was the first open of a catalogue entry.
 */
export type LedgerEntry = {
	id: string;
	bytes: number;
	requests: number;
	views: number;
	catalogueBytes: number;
	catalogueViews: number;
};

/** the whole ledger summed; `bytesPerView` is null until a view has been served */
export type LedgerTotals = {
	bytes: number;
	requests: number;
	views: number;
	bytesPerView: number | null;
	catalogueBytes: number;
	catalogueViews: number;
};

/**
 * Bytes and requests spent provisioning each artifact, against the local views served from it.
 * It lives in memory, so a worker restart starts it over.
 */
export class Ledger {
	readonly #rows = new Map<string, LedgerEntry>();

	#row(id: string): LedgerEntry {
		const row = this.#rows.get(id) ?? {
			id,
			bytes: 0,
			requests: 0,
			views: 0,
			catalogueBytes: 0,
			catalogueViews: 0
		};
		this.#rows.set(id, row);
		return row;
	}

	/** charges a fetch of `id`; `catalogue` marks bytes that came in a catalogue bundle */
	spend(id: string, cost: Cost, catalogue = false): void {
		const row = this.#row(id);
		row.bytes += cost.bytes;
		row.requests += cost.requests;
		if (catalogue) row.catalogueBytes += cost.bytes;
	}

	/** counts a local view served from `id`; `catalogue` marks the first open of a catalogue entry */
	serve(id: string, catalogue = false): void {
		const row = this.#row(id);
		row.views += 1;
		if (catalogue) row.catalogueViews += 1;
	}

	entries(): LedgerEntry[] {
		return [...this.#rows.values()]
			.map((r) => ({ ...r }))
			.sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	totals(): LedgerTotals {
		const rows = [...this.#rows.values()];
		const sum = (pick: (r: LedgerEntry) => number) => rows.reduce((t, r) => t + pick(r), 0);
		const views = sum((r) => r.views);
		const bytes = sum((r) => r.bytes);
		return {
			bytes,
			requests: sum((r) => r.requests),
			views,
			bytesPerView: views === 0 ? null : bytes / views,
			catalogueBytes: sum((r) => r.catalogueBytes),
			catalogueViews: sum((r) => r.catalogueViews)
		};
	}

	/** the mean cost of one fetch so far, catalogue entries left out, or null before the first */
	meanFetchBytes(): number | null {
		const rows = [...this.#rows.values()].filter((r) => r.bytes > r.catalogueBytes);
		return rows.length === 0
			? null
			: rows.reduce((t, r) => t + r.bytes - r.catalogueBytes, 0) / rows.length;
	}
}
