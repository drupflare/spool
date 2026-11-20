import { describe, expect, it } from 'vitest';
import {
	CF_FREE_REQUESTS_PER_DAY,
	CF_PAID_INCLUDED,
	CF_PAID_PER_MILLION,
	DAYS_PER_MONTH,
	DEMAND_LAYERS,
	HISTORY,
	demandSavings,
	type DemandCount
} from '../../src/report/index';

const fiveViews: DemandCount = {
	scenario: 'Five views',
	engine: 'chromium',
	views: 5,
	baseline: 5,
	spool: 3
};
const twoViews: DemandCount = {
	scenario: 'Two views',
	engine: 'chromium',
	views: 2,
	baseline: 2,
	spool: 3
};

describe('demandSavings', () => {
	it('gives the requests avoided per view and as a share of the no-spool total', () => {
		const [saving] = demandSavings([fiveViews], 5);
		expect(saving!.avoidedPerView).toBeCloseTo(0.4, 12);
		expect(saving!.avoidedShare).toBeCloseTo(0.4, 12);
	});

	it('keeps avoided and remaining requests summing to the no-spool total', () => {
		const [saving] = demandSavings([fiveViews], 1000);
		expect(saving!.avoidedPerDay + saving!.spoolPerDay).toBeCloseTo(saving!.baselinePerDay, 9);
		expect(saving!.baselinePerDay).toBeCloseTo(1000, 9);
	});

	it('is non-negative where spool sends no more requests than no spool', () => {
		for (const saving of demandSavings([fiveViews], 250)) {
			expect(saving.avoidedPerView).toBeGreaterThanOrEqual(0);
			expect(saving.avoidedPerDay).toBeGreaterThanOrEqual(0);
			expect(saving.spoolPerDay).toBeGreaterThanOrEqual(0);
		}
	});

	it('reports a negative saving when a bootstrap costs more than the views it serves', () => {
		const [saving] = demandSavings([twoViews], 10);
		expect(saving!.avoidedPerView).toBeCloseTo(-0.5, 12);
		expect(saving!.avoidedPerDay).toBeCloseTo(-5, 12);
	});

	it('gives the Free plan share of the daily allowance the no-spool arm uses', () => {
		const [saving] = demandSavings(
			[{ scenario: 'One view', engine: 'firefox', views: 1, baseline: 1, spool: 1 }],
			CF_FREE_REQUESTS_PER_DAY.value
		);
		expect(saving!.freePlanShareBaseline).toBeCloseTo(1, 12);
		expect(saving!.freePlanShareSpool).toBeCloseTo(1, 12);
	});

	it('gives the paid plan overage above the included requests, scaled to a month', () => {
		const [saving] = demandSavings(
			[{ scenario: 'One view', engine: 'firefox', views: 1, baseline: 1, spool: 1 }],
			1_000_000
		);
		const overage = (DAYS_PER_MONTH * 1_000_000 - CF_PAID_INCLUDED.value) / 1e6;
		expect(saving!.paidMonthlyUsdBaseline).toBeCloseTo(overage * CF_PAID_PER_MILLION.value, 9);
		expect(saving!.paidMonthlyUsdSpool).toBeCloseTo(saving!.paidMonthlyUsdBaseline, 9);
	});

	it('labels every figure with a layer', () => {
		const [saving] = demandSavings([fiveViews], 5);
		const figures = Object.keys(saving!).filter(
			(key) => key !== 'scenario' && key !== 'engine'
		);
		expect(Object.keys(DEMAND_LAYERS).sort()).toEqual([...figures].sort());
		for (const layer of Object.values(DEMAND_LAYERS))
			expect(['L0', 'L1', 'L2', 'L3']).toContain(layer);
	});

	it('refuses counts and rates that are not whole requests or not positive', () => {
		expect(() => demandSavings([{ ...fiveViews, views: 0 }], 5)).toThrow(RangeError);
		expect(() => demandSavings([{ ...fiveViews, spool: 2.5 }], 5)).toThrow(RangeError);
		expect(() => demandSavings([{ ...fiveViews, baseline: 0 }], 5)).toThrow(RangeError);
		expect(() => demandSavings([fiveViews], -1)).toThrow(RangeError);
	});
});

describe('the superseded readings', () => {
	it('keeps the earlier daily-reader count listed as superseded', () => {
		const old = HISTORY.filter((s) => s.source.includes('2026-11-20-days.json'));
		expect(old.length).toBeGreaterThan(0);
		for (const s of old) expect(s.status).toBe('superseded');
	});
});
