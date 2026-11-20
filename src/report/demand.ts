import { CF_FREE_REQUESTS_PER_DAY, paidRequestsUsd } from './economics.js';

/** days in the month a daily count is scaled to (L3, a scenario convention) */
export const DAYS_PER_MONTH = 30;

/**
 * The layer of each figure in {@link DemandSaving}. A derived figure keeps the label of the figure it
 * came from; the one L3 input, views a day, sits beside the counts.
 */
export const DEMAND_LAYERS = {
	avoidedPerView: 'L2',
	avoidedShare: 'L2',
	baselinePerDay: 'L3',
	spoolPerDay: 'L3',
	avoidedPerDay: 'L3',
	freePlanShareBaseline: 'L3',
	freePlanShareSpool: 'L3',
	paidMonthlyUsdBaseline: 'L3',
	paidMonthlyUsdSpool: 'L3'
} as const;

/** origin requests one reader model made over `views` views, with and without spool (L1) */
export type DemandCount = {
	scenario: string;
	engine: string;
	views: number;
	/** origin requests with no spool */
	baseline: number;
	/** origin requests with spool */
	spool: number;
};

/** one scenario's figures; {@link DEMAND_LAYERS} gives the layer of each */
export type DemandSaving = {
	scenario: string;
	engine: string;
	avoidedPerView: number;
	avoidedShare: number;
	baselinePerDay: number;
	spoolPerDay: number;
	avoidedPerDay: number;
	/** share of the Free plan's daily request allowance the no-spool arm uses */
	freePlanShareBaseline: number;
	freePlanShareSpool: number;
	/** the paid plan's overage in USD a month, above the included requests */
	paidMonthlyUsdBaseline: number;
	paidMonthlyUsdSpool: number;
};

/**
 * Origin requests avoided for each measured reader model, scaled to `viewsPerDay` views a day. A
 * negative `avoidedPerView` is a result: spool adds requests where a bootstrap costs more than the
 * views it serves. Throws a RangeError on a count that is not a whole number of requests.
 */
export function demandSavings(counts: readonly DemandCount[], viewsPerDay: number): DemandSaving[] {
	if (!Number.isFinite(viewsPerDay) || viewsPerDay < 0) {
		throw new RangeError(`viewsPerDay must be a non-negative number, got ${viewsPerDay}`);
	}
	return counts.map((count) => {
		const { scenario, engine, views, baseline, spool } = count;
		for (const [name, value] of [
			['views', views],
			['baseline', baseline],
			['spool', spool]
		] as const) {
			if (!Number.isInteger(value) || value < 0) {
				throw new RangeError(
					`${scenario} ${engine}: ${name} must be a whole number, got ${value}`
				);
			}
		}
		if (views < 1 || baseline < 1) {
			throw new RangeError(`${scenario} ${engine}: views and baseline must be at least 1`);
		}
		const baselinePerView = baseline / views;
		const spoolPerView = spool / views;
		const baselinePerDay = baselinePerView * viewsPerDay;
		const spoolPerDay = spoolPerView * viewsPerDay;
		return {
			scenario,
			engine,
			avoidedPerView: baselinePerView - spoolPerView,
			avoidedShare: (baseline - spool) / baseline,
			baselinePerDay,
			spoolPerDay,
			avoidedPerDay: baselinePerDay - spoolPerDay,
			freePlanShareBaseline: baselinePerDay / CF_FREE_REQUESTS_PER_DAY.value,
			freePlanShareSpool: spoolPerDay / CF_FREE_REQUESTS_PER_DAY.value,
			paidMonthlyUsdBaseline: paidRequestsUsd(baselinePerDay * DAYS_PER_MONTH),
			paidMonthlyUsdSpool: paidRequestsUsd(spoolPerDay * DAYS_PER_MONTH)
		};
	});
}
