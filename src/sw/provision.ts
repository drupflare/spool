import type { Cost } from '../protocol/provision.js';

export * from '../protocol/provision.js';

/** what one artifact cost and what it served */
export type LedgerEntry = { id: string; bytes: number; requests: number; views: number };

/** the whole ledger summed; `bytesPerView` is null until a view has been served */
export type LedgerTotals = {
	bytes: number;
	requests: number;
	views: number;
	bytesPerView: number | null;
};

/**
 * Bytes and requests spent provisioning each artifact, against the local views served from it.
 * It lives in memory, so a worker restart starts it over.
 */
export class Ledger {
	readonly #rows = new Map<string, LedgerEntry>();

	#row(id: string): LedgerEntry {
		const row = this.#rows.get(id) ?? { id, bytes: 0, requests: 0, views: 0 };
		this.#rows.set(id, row);
		return row;
	}

	/** charges a fetch of `id` */
	spend(id: string, cost: Cost): void {
		const row = this.#row(id);
		row.bytes += cost.bytes;
		row.requests += cost.requests;
	}

	/** counts a local view served from `id` */
	serve(id: string): void {
		this.#row(id).views += 1;
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
			bytesPerView: views === 0 ? null : bytes / views
		};
	}

	/** the mean cost of one fetch so far, or null before the first */
	meanFetchBytes(): number | null {
		const rows = [...this.#rows.values()].filter((r) => r.bytes > 0);
		return rows.length === 0 ? null : rows.reduce((t, r) => t + r.bytes, 0) / rows.length;
	}
}
