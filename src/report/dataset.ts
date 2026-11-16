import { DATASET_DEFAULTS } from '../protocol/provision.js';
import type { Row } from './measurement.js';
import { attributionalJoules } from './model.js';

/** bytes of the 304 a plain HTTP cache gets back, socket bytes (L1, `measurements/dataset-baseline/2026-11-15.json`) */
export const NOT_MODIFIED_SOCKET_BYTES = 220;

/** bytes of the first load of a seed, per collection size, for the three arms */
export type DatasetSeed = { v03: number; v04: number; native: number };

/** bytes of one update to a collection of `rows`, for the three arms; `v03Records` is the records shape with `have` */
export type DatasetUpdate = {
	rows: number;
	change: string;
	changedRows: number;
	v03: number;
	v03Records: number | null;
	v04: number;
	native: number;
};

export type DatasetFigures = {
	seeds: Record<number, DatasetSeed>;
	updates: DatasetUpdate[];
};

const at = (row: Row, key: string): Row => {
	const value = row[key];
	if (typeof value !== 'object' || value === null) throw new TypeError(`no ${key} in the row`);
	return value as Row;
};

const num = (row: Row, key: string): number => {
	const value = row[key];
	if (typeof value !== 'number') throw new TypeError(`no numeric ${key} in the row`);
	return value;
};

/** the three arms' bytes from the raw rows of a dataset-baseline reading, gate open and list shape for v0.3 */
export function datasetFigures(rows: readonly Row[]): DatasetFigures {
	const scenarios = rows.filter((r) => r.kind === 'scenario' && r.arm === 'gate open');
	const sizes = [...new Set(scenarios.map((r) => num(r, 'n')))].sort((a, b) => a - b);
	const seeds: Record<number, DatasetSeed> = {};
	const updates: DatasetUpdate[] = [];
	const find = (pick: (r: Row) => boolean): Row => {
		const found = rows.find(pick);
		if (!found) throw new RangeError('the reading has no row for this collection and change');
		return found;
	};
	for (const n of sizes) {
		for (const change of ['change-1', 'change-1pct']) {
			const list = find(
				(r) =>
					r.kind === 'scenario' &&
					r.shape === 'list' &&
					r.arm === 'gate open' &&
					r.n === n &&
					r.change === change
			);
			const records = rows.find(
				(r) =>
					r.kind === 'scenario' &&
					r.shape === 'records' &&
					r.arm === 'gate open' &&
					r.n === n &&
					r.change === change
			);
			const v04 = find((r) => r.kind === 'v04' && r.n === n && r.change === change);
			const native = find((r) => r.kind === 'native' && r.n === n && r.change === change);
			if (change === 'change-1') {
				seeds[n] = {
					v03: num(at(list, 'seed'), 'brotli'),
					v04: num(at(v04, 'seed'), 'brotli'),
					native: num(at(native, 'firstLoad'), 'socketBytes')
				};
			}
			updates.push({
				rows: n,
				change,
				changedRows: num(list, 'changedRows'),
				v03: num(at(list, 'refetchWithout'), 'brotli'),
				v03Records: records?.refetchWithHave
					? num(at(records, 'refetchWithHave'), 'brotli')
					: null,
				v04: num(at(v04, 'patch'), 'brotli'),
				native: num(at(native, 'revalidateChanged'), 'socketBytes')
			});
		}
	}
	return { seeds, updates };
}

/** a site's traffic and updates, declared per site (L3) */
export type Site = { name: string; viewsPerDay: number; updatesPerDay: number; devices: number };

export type SiteFigures = {
	/** views per device per day that a held copy answers: views per device times the return survival */
	served: number;
	/** patches or refetches per device per day, at most one per answered view */
	fetches: number;
	bytesPerDay: Record<'v03' | 'v04' | 'native', number>;
	joulesPerDay: Record<'v03' | 'v04' | 'native', number>;
	/** updates per device over one hold that repay the v0.4 seed's extra bytes against the v0.3 control */
	breakEven: number;
};

/**
 * Bytes per device per day for each arm at a site. A device holds one copy for `DATASET_DEFAULTS.holdDays`
 * and refetches the seed each time. Views that find a copy are `views x survival`; a native cache
 * revalidates on each of those views and sends the full resource when a change landed since the last one.
 */
export function siteFigures(site: Site, seed: DatasetSeed, update: DatasetUpdate): SiteFigures {
	const { survival, holdDays } = DATASET_DEFAULTS;
	const served = (site.viewsPerDay / site.devices) * survival;
	const fetches = Math.min(site.updatesPerDay, served);
	const changed = served > 0 ? 1 - Math.exp(-site.updatesPerDay / served) : 0;
	const bytesPerDay = {
		v03: seed.v03 / holdDays + fetches * update.v03,
		v04: seed.v04 / holdDays + fetches * update.v04,
		native: served * (changed * update.native + (1 - changed) * NOT_MODIFIED_SOCKET_BYTES)
	};
	const saved = update.v03 - update.v04;
	const extra = Math.max(0, seed.v04 - seed.v03);
	return {
		served,
		fetches,
		bytesPerDay,
		joulesPerDay: {
			v03: attributionalJoules(bytesPerDay.v03),
			v04: attributionalJoules(bytesPerDay.v04),
			native: attributionalJoules(bytesPerDay.native)
		},
		breakEven: saved > 0 ? extra / saved : Infinity
	};
}
