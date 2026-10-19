import { funnelOf, type Engine, type TimedView } from '../protocol/view.js';
import { DOCUMENT_BYTES } from './inputs.js';

/**
 * Which views a measure reads. `served` takes the views the worker answered, where `Z` is real;
 * `shadow` takes the views it only decided on, where `Z` is what serving would have been.
 */
export type Basis = 'served' | 'shadow';

/** the server's work over one interval: handler milliseconds and request counts, by route */
export type WorkSample = {
	/** epoch milliseconds the interval began */
	start: number;
	seconds: number;
	busyMs: Record<string, number>;
	requests: Record<string, number>;
};

/** the routes spool's own requests land on; their work is what spool costs the origin */
export const OVERHEAD_ROUTES: readonly string[] = [
	'/.spool/sync',
	'/.spool/artifact',
	'/.spool/beacon'
];

const DAY_MS = 86_400_000;

const inBasis = (view: TimedView, basis: Basis) =>
	basis === 'shadow' ? view.tier === 'shadow' : view.tier !== 'shadow';

const isLocal = (view: TimedView) => funnelOf(view) === 'local';

function ratio(part: number, whole: number): number | null {
	return whole === 0 ? null : part / whole;
}

/** `Z_annual` over the given window: strict zero-network views over all views, null with no views */
export function zAnnual(views: readonly TimedView[], basis: Basis = 'served'): number | null {
	const pool = views.filter((v) => inBasis(v, basis));
	return ratio(pool.filter(isLocal).length, pool.length);
}

/** the three factors of `Z` for one group of views; each is null when its denominator is zero */
export type Factors = {
	views: number;
	local: number;
	z: number | null;
	/** views on a route the worker may serve, over all views */
	pEligible: number | null;
	/** of those, views with a stored copy */
	pWarm: number | null;
	/** of those, views shown with no request */
	pUsable: number | null;
};

/** `P_eligible`, `P_warm` and `P_usable` as a chain: their product is `z` */
export function factors(views: readonly TimedView[], basis: Basis = 'served'): Factors {
	const pool = views.filter((v) => inBasis(v, basis));
	const stages = pool.map(funnelOf);
	const eligible = stages.filter((s) => s !== 'ineligible').length;
	const warm = stages.filter((s) => s === 'unusable' || s === 'local').length;
	const local = stages.filter((s) => s === 'local').length;
	return {
		views: pool.length,
		local,
		z: ratio(local, pool.length),
		pEligible: ratio(eligible, pool.length),
		pWarm: ratio(warm, eligible),
		pUsable: ratio(local, warm)
	};
}

/** {@link factors} for each engine that has views, in name order */
export function factorsByEngine(
	views: readonly TimedView[],
	basis: Basis = 'served'
): Array<Factors & { engine: Engine }> {
	const engines = [...new Set(views.filter((v) => inBasis(v, basis)).map((v) => v.engine))];
	return engines.sort().map((engine) => ({
		engine,
		...factors(
			views.filter((v) => v.engine === engine),
			basis
		)
	}));
}

/** one UTC day of {@link zDaily} */
export type DailyZ = {
	/** `YYYY-MM-DD`, UTC */
	day: string;
	views: number;
	local: number;
	/** requests to spool's own routes that day: syncs, artifact fetches and beacon flushes */
	overhead: number;
	/** local views less overhead requests, over all views; negative when spool cost more than it saved */
	z: number | null;
};

const dayOf = (ms: number) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

/**
 * `Z_daily`: each day's local views net of the requests spool itself sent the Worker, over that
 * day's views. A local view removes one request; a sync, an artifact fetch or a flush adds one.
 */
export function zDaily(
	views: readonly TimedView[],
	samples: readonly WorkSample[],
	basis: Basis = 'served'
): DailyZ[] {
	const days = new Map<string, { views: number; local: number; overhead: number }>();
	const row = (day: string) => {
		const found = days.get(day) ?? { views: 0, local: 0, overhead: 0 };
		days.set(day, found);
		return found;
	};
	for (const view of views) {
		if (!inBasis(view, basis)) continue;
		const entry = row(dayOf(view.at));
		entry.views += 1;
		if (isLocal(view)) entry.local += 1;
	}
	for (const sample of samples) {
		const entry = row(dayOf(sample.start));
		for (const route of OVERHEAD_ROUTES) entry.overhead += sample.requests[route] ?? 0;
	}
	return [...days]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([day, e]) => ({ day, ...e, z: ratio(e.local - e.overhead, e.views) }));
}

/** the index of the interval holding `at`, or -1; `ordered` is sorted by start */
function locate(ordered: readonly WorkSample[], at: number): number {
	let low = 0;
	let high = ordered.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const sample = ordered[mid] as WorkSample;
		if (at < sample.start) high = mid - 1;
		else if (at >= sample.start + sample.seconds * 1000) low = mid + 1;
		else return mid;
	}
	return -1;
}

/** what {@link zPeakWork} computed, with the terms it divided */
export type PeakWork = {
	z: number | null;
	/** how many intervals were taken as the busiest */
	intervals: number;
	/** origin work the local views avoided in those intervals, in handler milliseconds */
	avoided: number;
	/** handler milliseconds spent on spool's own routes in those intervals */
	overhead: number;
	/** origin work without spool: work done on other routes plus work avoided */
	baseline: number;
	/** local views that could not be priced: outside every interval, or on a route never answered */
	unpriced: number;
};

/**
 * `Z_peak_work`: over the busiest intervals, the origin work local views avoided less the work
 * spool's own routes cost, over the work the origin would have done without spool. A local view
 * is priced at the series-wide mean handler time of its route. Intervals are ranked by baseline
 * work and `busiestShare` of them, at least one, are taken.
 */
export function zPeakWork(
	views: readonly TimedView[],
	samples: readonly WorkSample[],
	options: { basis?: Basis; busiestShare?: number } = {}
): PeakWork {
	const basis = options.basis ?? 'served';
	const share = options.busiestShare ?? 0.1;
	const ordered = [...samples].sort((a, b) => a.start - b.start);

	const busy = new Map<string, number>();
	const count = new Map<string, number>();
	for (const sample of ordered) {
		for (const [route, ms] of Object.entries(sample.busyMs)) {
			busy.set(route, (busy.get(route) ?? 0) + ms);
		}
		for (const [route, n] of Object.entries(sample.requests)) {
			count.set(route, (count.get(route) ?? 0) + n);
		}
	}

	const avoided = ordered.map(() => 0);
	let unpriced = 0;
	for (const view of views) {
		if (!inBasis(view, basis) || !isLocal(view)) continue;
		const at = locate(ordered, view.at);
		const requests = count.get(view.route) ?? 0;
		if (at < 0 || requests === 0) {
			unpriced += 1;
			continue;
		}
		avoided[at] = (avoided[at] as number) + (busy.get(view.route) as number) / requests;
	}

	const rows = ordered.map((sample, i) => {
		let overhead = 0;
		let actual = 0;
		for (const [route, ms] of Object.entries(sample.busyMs)) {
			if (OVERHEAD_ROUTES.includes(route)) overhead += ms;
			else actual += ms;
		}
		return {
			start: sample.start,
			avoided: avoided[i] as number,
			overhead,
			baseline: actual + (avoided[i] as number)
		};
	});
	const take = rows.length === 0 ? 0 : Math.max(1, Math.ceil(rows.length * share));
	const busiest = [...rows]
		.sort((a, b) => b.baseline - a.baseline || a.start - b.start)
		.slice(0, take);
	const sum = (pick: (r: (typeof rows)[number]) => number) =>
		busiest.reduce((total, r) => total + pick(r), 0);
	const baseline = sum((r) => r.baseline);
	const saved = sum((r) => r.avoided);
	const spent = sum((r) => r.overhead);
	return {
		z: ratio(saved - spent, baseline),
		intervals: take,
		avoided: saved,
		overhead: spent,
		baseline,
		unpriced
	};
}

/** shadow results for one route */
export type RouteMismatches = {
	route: string;
	shadowViews: number;
	/** views where a local render existed to compare */
	compared: number;
	mismatches: number;
};

/** shadow views, comparisons and mismatches per route, in route order */
export function mismatchesByRoute(views: readonly TimedView[]): RouteMismatches[] {
	const routes = new Map<string, RouteMismatches>();
	for (const view of views) {
		if (view.tier !== 'shadow') continue;
		const entry = routes.get(view.route) ?? {
			route: view.route,
			shadowViews: 0,
			compared: 0,
			mismatches: 0
		};
		entry.shadowViews += 1;
		if (view.mismatch !== null) entry.compared += 1;
		if (view.mismatch === true) entry.mismatches += 1;
		routes.set(view.route, entry);
	}
	return [...routes.values()].sort((a, b) => (a.route < b.route ? -1 : 1));
}

/** what the worker's ledger holds per entry that the catalogue figures read */
export type CatalogueLedgerRow = { id: string; catalogueBytes: number; catalogueViews: number };

/** what a catalogue sent, what a view used and what the views saved */
export type CatalogueFigures = {
	/** entries the worker received in catalogue bundles */
	sent: number;
	/** entries that served a view with no request */
	used: number;
	/** views the catalogue answered locally */
	hits: number;
	/** views in the basis */
	views: number;
	/** `hits` over `views`; null with no views */
	hitShare: number | null;
	/** JSON bytes of the entries received, as the ledger counts them */
	bytesSent: number;
	/** `hits` times `documentBytes` */
	bytesSaved: number;
	/** `bytesSaved` less `bytesSent`; negative when the catalogue moved more than it kept off the wire */
	bytesNet: number;
};

/**
 * Catalogue figures from the views the sink holds and the worker's ledger entries. A view is a hit
 * when its reason is `catalogue`; the ledger says how many entries arrived, how many served a view
 * and what they weighed. `documentBytes` is what a hit keeps off the wire, `DOCUMENT_BYTES` (L1)
 * unless the site knows its own, so `bytesSaved` is a scenario figure (L3) until shadow views
 * measure the use share. The ledger counts uncompressed JSON text and a document is counted on
 * the wire, so `bytesNet` compares unlike units.
 */
export function catalogueFigures(
	views: readonly TimedView[],
	ledger: { entries: readonly CatalogueLedgerRow[] },
	options: { basis?: Basis; documentBytes?: number } = {}
): CatalogueFigures {
	const pool = views.filter((v) => inBasis(v, options.basis ?? 'served'));
	const hits = pool.filter((v) => v.reason === 'catalogue').length;
	const sent = ledger.entries.filter((e) => e.catalogueBytes > 0);
	const bytesSent = sent.reduce((total, e) => total + e.catalogueBytes, 0);
	const bytesSaved = hits * (options.documentBytes ?? DOCUMENT_BYTES.value);
	return {
		sent: sent.length,
		used: ledger.entries.filter((e) => e.catalogueViews > 0).length,
		hits,
		views: pool.length,
		hitShare: ratio(hits, pool.length),
		bytesSent,
		bytesSaved,
		bytesNet: bytesSaved - bytesSent
	};
}

/** views that came from `from` and went to `route` */
export type Transition = { from: string; route: string; views: number };

/** how many views came from each referrer, and the pairs; `from` may be a route pattern or `external` */
export type Transitions = {
	pairs: Transition[];
	byFrom: Record<string, number>;
};

/** counts per `(from, route)` pair and per `from`; a view with no `from` counts in neither */
export function transitions(views: readonly TimedView[]): Transitions {
	const pairs = new Map<string, Transition>();
	const byFrom: Record<string, number> = Object.create(null);
	for (const view of views) {
		if (view.from === undefined) continue;
		const key = JSON.stringify([view.from, view.route]);
		const entry = pairs.get(key) ?? { from: view.from, route: view.route, views: 0 };
		entry.views += 1;
		pairs.set(key, entry);
		byFrom[view.from] = (byFrom[view.from] ?? 0) + 1;
	}
	const sorted = [...pairs.values()].sort((a, b) =>
		a.from === b.from ? (a.route < b.route ? -1 : 1) : a.from < b.from ? -1 : 1
	);
	return { pairs: sorted, byFrom };
}

/** the share of views from `from` that went to each route, in route order; empty when none came from it */
export function nextShare(views: readonly TimedView[], from: string): Record<string, number> {
	const { pairs, byFrom } = transitions(views);
	const total = byFrom[from];
	const out: Record<string, number> = {};
	if (!total) return out;
	for (const pair of pairs) if (pair.from === from) out[pair.route] = pair.views / total;
	return out;
}
