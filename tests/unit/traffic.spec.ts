import { describe, expect, it } from 'vitest';
import type { TimedView } from '../../src/protocol/index';
import {
	factors,
	factorsByEngine,
	mismatchesByRoute,
	OVERHEAD_ROUTES,
	zAnnual,
	zDaily,
	zPeakWork,
	type WorkSample
} from '../../src/report/index';

const view = (over: Partial<TimedView> = {}): TimedView => ({
	id: 'v',
	crossOriginLoads: 0,
	tier: 'network',
	reason: 'cold',
	staleSec: null,
	engine: 'chromium',
	scope: 'public',
	strategy: 'template',
	route: '/n/:id',
	mismatch: null,
	swAgeMs: 0,
	gapMs: null,
	at: 0,
	...over
});
const local = (over: Partial<TimedView> = {}) =>
	view({ tier: 'local', reason: 'fresh', staleSec: 0, ...over });
const soft = (over: Partial<TimedView> = {}) =>
	view({ tier: 'local-revalidate', reason: 'soft-sync', staleSec: 90, ...over });
const stale = (over: Partial<TimedView> = {}) =>
	view({ tier: 'fallback', reason: 'invalidated', staleSec: 30, ...over });
const principal = (over: Partial<TimedView> = {}) => view({ reason: 'principal', ...over });
const shadow = (reason: TimedView['reason'], over: Partial<TimedView> = {}) =>
	view({ tier: 'shadow', reason, ...over });

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

describe('Z_annual', () => {
	const stream = [
		...[local(), local(), view(), principal()],
		...[local({ engine: 'firefox' }), soft({ engine: 'firefox' })],
		...[stale({ engine: 'firefox' }), view({ engine: 'firefox' })],
		...[view({ engine: 'webkit' }), local({ engine: 'webkit' })],
		shadow('fresh'),
		shadow('fresh', { mismatch: true })
	];

	it('counts strict zero-network views over the views the worker answered', () => {
		expect(zAnnual(stream)).toBe(4 / 10);
	});

	it('reads shadow views on their own basis, a mismatch making a would-be local view unusable', () => {
		expect(zAnnual(stream, 'shadow')).toBe(1 / 2);
	});

	it('is null with no views on the basis', () => {
		expect(zAnnual([])).toBeNull();
		expect(
			zAnnual(
				stream.filter((v) => v.tier !== 'shadow'),
				'shadow'
			)
		).toBeNull();
	});
});

describe('cross-origin loads', () => {
	const leaky = [
		local(),
		local({ crossOriginLoads: 1 }),
		local({ crossOriginLoads: null }),
		shadow('fresh'),
		shadow('fresh', { crossOriginLoads: 4 })
	];

	it('keep a view that made no request itself from counting as zero-network', () => {
		expect(zAnnual(leaky)).toBe(1 / 3);
		expect(zAnnual(leaky, 'shadow')).toBe(1 / 2);
	});

	it('turn a leaky local view into an unusable one in the factors', () => {
		expect(factors(leaky)).toMatchObject({ views: 3, local: 1, pWarm: 1, pUsable: 1 / 3 });
		expect(factors(leaky, 'shadow')).toMatchObject({ views: 2, local: 1, pUsable: 1 / 2 });
	});

	it('count against Z_daily and Z_peak_work the same way', () => {
		const at = (n: number) => T0 + n;
		const views = [local({ at: at(1) }), local({ at: at(2), crossOriginLoads: 3 })];
		expect(zDaily(views, [])[0]).toMatchObject({ views: 2, local: 1, z: 1 / 2 });
		const samples: WorkSample[] = [
			{ start: T0, seconds: 60, busyMs: { '/n/:id': 20 }, requests: { '/n/:id': 2 } }
		];
		expect(zPeakWork(views, samples).avoided).toBe(10);
	});
});

describe('P_eligible, P_warm and P_usable', () => {
	const stream = [
		...[local(), local(), view(), principal()],
		...[local({ engine: 'firefox' }), soft({ engine: 'firefox' })],
		...[stale({ engine: 'firefox' }), view({ engine: 'firefox' })],
		...[view({ engine: 'webkit' }), local({ engine: 'webkit' })]
	];

	it('chains per engine and multiplies back to Z', () => {
		const byEngine = factorsByEngine(stream);
		expect(byEngine.map((f) => f.engine)).toEqual(['chromium', 'firefox', 'webkit']);

		const [chromium, firefox, webkit] = byEngine;
		expect(chromium).toEqual({
			engine: 'chromium',
			views: 4,
			local: 2,
			z: 2 / 4,
			pEligible: 3 / 4,
			pWarm: 2 / 3,
			pUsable: 2 / 2
		});
		expect(firefox).toEqual({
			engine: 'firefox',
			views: 4,
			local: 1,
			z: 1 / 4,
			pEligible: 4 / 4,
			pWarm: 3 / 4,
			pUsable: 1 / 3
		});
		expect(webkit).toEqual({
			engine: 'webkit',
			views: 2,
			local: 1,
			z: 1 / 2,
			pEligible: 2 / 2,
			pWarm: 1 / 2,
			pUsable: 1 / 1
		});
		for (const f of byEngine) {
			expect((f.pEligible ?? 0) * (f.pWarm ?? 0) * (f.pUsable ?? 0)).toBeCloseTo(
				f.z ?? 0,
				12
			);
		}
	});

	it('leaves a factor null when its denominator is zero', () => {
		expect(factors([principal(), principal()])).toMatchObject({
			views: 2,
			z: 0,
			pEligible: 0,
			pWarm: null,
			pUsable: null
		});
		expect(factors([])).toEqual({
			views: 0,
			local: 0,
			z: null,
			pEligible: null,
			pWarm: null,
			pUsable: null
		});
	});

	it('takes shadow views only on the shadow basis', () => {
		const views = [
			shadow('cold'),
			shadow('fresh'),
			shadow('fresh', { mismatch: true }),
			local()
		];
		expect(factors(views, 'shadow')).toMatchObject({
			views: 3,
			local: 1,
			pWarm: 2 / 3,
			pUsable: 1 / 2
		});
	});
});

describe('Z_daily', () => {
	const day1 = [
		...Array.from({ length: 6 }, (_, i) => local({ at: T0 + 1000 * i })),
		...Array.from({ length: 4 }, (_, i) => view({ at: T0 + 10_000 + i }))
	];
	const day2 = [
		...Array.from({ length: 4 }, (_, i) => local({ at: T0 + DAY + i })),
		view({ at: T0 + DAY + 99 })
	];
	const sample = (start: number, requests: Record<string, number>): WorkSample => ({
		start,
		seconds: 60,
		busyMs: {},
		requests
	});

	it('is local views over views when spool sent nothing', () => {
		expect(zDaily([...day1, ...day2], []).map((d) => [d.day, d.views, d.local, d.z])).toEqual([
			['2026-10-01', 10, 6, 6 / 10],
			['2026-10-02', 5, 4, 4 / 5]
		]);
	});

	it('nets out the syncs, artifact fetches and flushes that day', () => {
		const samples = [
			sample(T0, { '/.spool/sync': 1, '/n/:id': 40 }),
			sample(T0 + 60_000, { '/.spool/artifact': 2, '/.spool/beacon': 1 })
		];
		const days = zDaily([...day1, ...day2], samples);
		expect(days).toEqual([
			{ day: '2026-10-01', views: 10, local: 6, overhead: 4, z: (6 - 4) / 10 },
			{ day: '2026-10-02', views: 5, local: 4, overhead: 0, z: 4 / 5 }
		]);
		expect(OVERHEAD_ROUTES).toEqual(['/.spool/sync', '/.spool/artifact', '/.spool/beacon']);
	});

	it('goes negative when spool cost more than it saved, and is null with overhead but no views', () => {
		const days = zDaily(
			[local({ at: T0 })],
			[sample(T0, { '/.spool/sync': 3 }), sample(T0 + 2 * DAY, { '/.spool/sync': 1 })]
		);
		expect(days).toEqual([
			{ day: '2026-10-01', views: 1, local: 1, overhead: 3, z: -2 },
			{ day: '2026-10-03', views: 0, local: 0, overhead: 1, z: null }
		]);
	});
});

describe('Z_peak_work', () => {
	const sample = (
		n: number,
		busyMs: Record<string, number>,
		requests: Record<string, number>
	): WorkSample => ({ start: n * 60_000, seconds: 60, busyMs, requests });
	const samples = [
		sample(0, { '/n/:id': 100, '/.spool/sync': 10 }, { '/n/:id': 10, '/.spool/sync': 1 }),
		sample(
			1,
			{ '/n/:id': 300, '/.spool/artifact': 20, '/.spool/beacon': 10 },
			{ '/n/:id': 30, '/.spool/artifact': 2, '/.spool/beacon': 1 }
		),
		sample(2, { '/n/:id': 100 }, { '/n/:id': 10 })
	];
	const locals = [
		...Array.from({ length: 5 }, (_, i) => local({ at: 1000 + i })),
		...Array.from({ length: 20 }, (_, i) => local({ at: 61_000 + i }))
	];

	it('prices local views at the route mean and ranks intervals by work without spool', () => {
		const peak = zPeakWork(locals, samples);
		expect(peak).toEqual({
			z: (200 - 30) / 500,
			intervals: 1,
			avoided: 200,
			overhead: 30,
			baseline: 500,
			unpriced: 0
		});
	});

	it('takes more intervals when asked', () => {
		const peak = zPeakWork(locals, samples, { busiestShare: 0.34 });
		expect(peak).toEqual({
			z: (250 - 40) / 650,
			intervals: 2,
			avoided: 250,
			overhead: 40,
			baseline: 650,
			unpriced: 0
		});
	});

	it('does not price a local view outside every interval or on a route never answered', () => {
		const peak = zPeakWork(
			[...locals, local({ at: 999_999 }), local({ at: 61_000, route: '/never' })],
			samples
		);
		expect(peak.unpriced).toBe(2);
		expect(peak.avoided).toBe(200);
	});

	it('finds the interval of a view at either edge and across a gap between intervals', () => {
		const gapped = [
			sample(0, { '/n/:id': 10 }, { '/n/:id': 1 }),
			sample(5, { '/n/:id': 30 }, { '/n/:id': 3 })
		];
		const at = [0, 59_999, 60_000, 5 * 60_000, 6 * 60_000 - 1];
		const peak = zPeakWork(
			at.map((time) => local({ at: time })),
			gapped,
			{ busiestShare: 1 }
		);
		expect(peak.unpriced).toBe(1);
		expect(peak.avoided).toBe(4 * 10);
	});

	it('reads shadow views on the shadow basis and is null with no work', () => {
		const views = [shadow('fresh', { at: 61_000 }), shadow('fresh', { at: 61_001 })];
		expect(zPeakWork(views, samples, { basis: 'shadow' }).avoided).toBe(20);
		expect(zPeakWork(locals, [])).toEqual({
			z: null,
			intervals: 0,
			avoided: 0,
			overhead: 0,
			baseline: 0,
			unpriced: 25
		});
	});
});

describe('mismatchesByRoute', () => {
	it('counts shadow views, comparisons and mismatches per route', () => {
		const views = [
			shadow('fresh', { route: '/b', mismatch: true }),
			shadow('fresh', { route: '/b', mismatch: false }),
			shadow('cold', { route: '/b' }),
			shadow('fresh', { route: '/a', mismatch: false }),
			local({ route: '/a' })
		];
		expect(mismatchesByRoute(views)).toEqual([
			{ route: '/a', shadowViews: 1, compared: 1, mismatches: 0 },
			{ route: '/b', shadowViews: 3, compared: 2, mismatches: 1 }
		]);
	});
});
