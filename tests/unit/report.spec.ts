import { describe, expect, it } from 'vitest';
import {
	TIERS,
	attributionalJoules,
	capacityMWh,
	dataCentreJoules,
	fleetFor,
	freeTierCeiling,
	joulesPerView,
	joulesPerViewWithOrigin,
	linearFit,
	median,
	onWireFigures,
	peakCut,
	phoneRun,
	powerSweep,
	quantile,
	raplRun,
	repeatBytesBySite,
	repeatNavFigures,
	saving,
	serverYearMWh,
	serversAfter,
	spread,
	swdTotal,
	viewsChannelMWh,
	zeroNetworkFigures,
	type Row
} from '../../src/report/index';

// a scale for the tables: 100 million views a year, a round number and no institution
const VIEWS = 100e6;

describe('the views channel', () => {
	it('prices bytes at the SWD v4 total of 0.194 kWh/GB', () => {
		expect(swdTotal()).toBeCloseTo(0.194, 10);
		expect(attributionalJoules(1e6)).toBeCloseTo(698.4, 6);
	});

	it('models about 12.3 J per local view, the replaced document request', () => {
		expect(joulesPerView()).toBeCloseTo(12.26, 2);
	});

	it('replaces the data-centre term and the modelled origin with a measured origin', () => {
		expect(dataCentreJoules()).toBeCloseTo(3.35, 2);
		expect(joulesPerViewWithOrigin(0)).toBeCloseTo(attributionalJoules(16_900, 0.139), 8);
		expect(joulesPerViewWithOrigin(10.9) - joulesPerViewWithOrigin(0)).toBeCloseTo(10.9, 10);
		expect(joulesPerViewWithOrigin(0.015, { bytes: 0, radioJ: 0, mobileShare: 0 })).toBe(0.015);
	});

	it('scales with the local share, tier by tier', () => {
		const mwh = Object.values(TIERS).map((z) => viewsChannelMWh(VIEWS, z));
		expect(mwh.map((v) => Number(v.toFixed(2)))).toEqual([0.1, 0.22, 0.31]);
	});
});

describe('the capacity channel, as a sensitivity model', () => {
	it('charges a retired server-year 3.80 MWh at 282 W and PUE 1.54', () => {
		expect(serverYearMWh()).toBeCloseTo(3.804, 3);
	});

	it('never goes below the floor', () => {
		expect(serversAfter(3, 0.99)).toBe(2);
		expect(serversAfter(20, 0.8, 4)).toBe(4);
		expect(capacityMWh(2, 0.81)).toBe(0);
	});

	it('finds the throughput-sized fleet each tier needs to reach a target', () => {
		const need = (target: number) =>
			Object.values(TIERS).map((z) =>
				fleetFor(target, viewsChannelMWh(VIEWS, z), peakCut(z))
			);
		expect(need(5)).toEqual([8, 4, 4]);
		expect(need(20)).toEqual([23, 11, 8]);
		expect(need(100)).toEqual([100, 47, 34]);
	});

	it('refuses a cut that frees nothing rather than looping', () => {
		expect(() => fleetFor(50, 0, 0)).toThrow(RangeError);
	});
});

describe('the free-tier ceiling', () => {
	it('moves 3.04M views a month to 4.25M, 7.95M and 20.97M across the tiers', () => {
		const ceilings = Object.values(TIERS).map((z) => freeTierCeiling(z) / 1e6);
		expect(ceilings.map((v) => Number(v.toFixed(2)))).toEqual([4.25, 7.95, 20.97]);
	});

	it('is the base allowance when nothing is served locally', () => {
		expect(freeTierCeiling(0)).toBe(3_040_000);
	});
});

describe('statistics', () => {
	it('takes the median of odd and even lists and refuses an empty one', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(() => median([])).toThrow(RangeError);
		expect(() => quantile([], 0.5)).toThrow(RangeError);
	});

	it('reports the range and the count with the median', () => {
		expect(spread([5, 1, 3])).toEqual({ median: 3, min: 1, max: 5, n: 3 });
	});

	it('interpolates quantiles between ranks', () => {
		expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
		expect(quantile([7], 0.9)).toBe(7);
	});

	it('fits a line and its R squared', () => {
		const fit = linearFit([
			[0, 1],
			[1, 3],
			[2, 5]
		]);
		expect(fit.intercept).toBeCloseTo(1, 10);
		expect(fit.slope).toBeCloseTo(2, 10);
		expect(fit.r2).toBeCloseTo(1, 10);
		expect(() => linearFit([[1, 1]])).toThrow(RangeError);
		expect(
			linearFit([
				[0, 2],
				[1, 2]
			]).r2
		).toBe(1);
	});
});

/** a RAPL window of `ops` operations that took `seconds` and drew `watts` on average */
const window = (
	arm: string,
	round: number,
	ops: number,
	seconds: number,
	watts: number,
	extra: Row = {}
): Row => ({
	arm,
	round,
	navs: ops,
	elapsedMs: seconds * 1000,
	pkgJ: watts * seconds,
	otherContainersCpuMs: 0,
	...extra
});

describe('joules per operation above idle', () => {
	const rows: Row[] = [
		window('idle', 0, 0, 10, 20),
		window('idle', 1, 0, 10, 30),
		window('network', 0, 100, 10, 30, { originHits: { a: 200, b: 100 }, originCpuMs: 50 }),
		window('network', 1, 100, 10, 50),
		window('spool', 0, 100, 10, 25),
		window('spool', 1, 100, 10, 35)
	];

	it('subtracts the idle draw of the same round', () => {
		const run = raplRun(rows);
		expect(run.idleWatts).toEqual({ median: 25, min: 20, max: 30, n: 2 });
		expect(run.arms['network']?.joules).toEqual({ median: 1.5, min: 1, max: 2, n: 2 });
		expect(run.arms['spool']?.joules.median).toBe(0.5);
		expect(saving(run.arms['network'] as never, run.arms['spool'] as never)).toBe(1);
	});

	it('reports origin requests and CPU per operation only where the rig counted them', () => {
		const run = raplRun(rows);
		expect(run.arms['network']?.originRequests).toBe(3);
		expect(run.arms['network']?.originCpuMs).toBe(0.5);
		expect(run.arms['spool']?.originRequests).toBeUndefined();
	});

	it('uses the median idle for a round with no idle window', () => {
		const run = raplRun([window('idle', 0, 0, 10, 20), window('a', 5, 10, 10, 30)]);
		expect(run.arms['a']?.joules.median).toBe(10);
	});

	it('drops windows whose neighbours used more CPU than the limit, idle ones included', () => {
		const run = raplRun([
			window('idle', 0, 0, 10, 20),
			window('a', 0, 10, 10, 30),
			window('a', 1, 10, 10, 90, { otherContainersCpuMs: 1500 })
		]);
		expect(run.dropped).toBe(1);
		expect(run.arms['a']?.windows).toBe(1);
	});

	it('splits closed-loop joules by the server share of CPU', () => {
		const run = raplRun([
			window('idle', 0, 0, 10, 20, { n: 0 }),
			{
				...window('r', 0, 10, 10, 30),
				navs: undefined,
				n: 10,
				serverCpuMs: 30,
				clientCpuMs: 10
			}
		]);
		const arm = run.arms['r'];
		expect(arm?.serverCpuMs).toBe(3);
		expect(arm?.clientCpuMs).toBe(1);
		expect(arm?.joules.median).toBe(10);
		expect(arm?.serverJoules?.median).toBe(7.5);
	});
});

describe('the power-state sweep', () => {
	const point = (
		cond: string,
		route: string,
		mode: string,
		rate: number,
		watts: number,
		set = 'sweep'
	): Row => ({
		set,
		cond,
		route,
		mode,
		rate,
		round: 0,
		elapsedS: 10,
		pkgW: watts,
		reqs: rate * 10
	});

	it('reads watts and millijoules per request above the idle median, and fits the line', () => {
		const rows = [
			point('idle', 'none', 'none', 0, 10),
			point('cms-steady-10', 'cms', 'steady', 10, 11),
			point('cms-steady-100', 'cms', 'steady', 100, 20),
			point('cms-steady-1000', 'cms', 'steady', 1000, 110),
			point('x', 'cms', 'steady', 5, 10, 'timer')
		];
		const sweep = powerSweep(rows, 'sweep');
		expect(sweep.idleWatts.median).toBe(10);
		const hundred = sweep.conditions.find((c) => c.cond === 'cms-steady-100');
		expect(hundred?.aboveWatts.median).toBe(10);
		expect(hundred?.mjPerRequest.median).toBe(100);
		expect(sweep.conditions).toHaveLength(3);
		expect(sweep.fits['cms-steady']?.slope).toBeCloseTo(0.1, 10);
		expect(sweep.fits['cms-steady-low']?.intercept).toBeCloseTo(0, 10);
		expect(sweep.fits['cms-bursty']).toBeUndefined();
	});
});

describe('phone windows', () => {
	const read = (
		arm: string,
		round: number,
		navs: number,
		joules: number,
		charging = false
	): Row => ({
		arm,
		round,
		navs,
		seconds: 100,
		energy_j: joules,
		charging: [false, charging]
	});

	it('subtracts the idle window of the round and drops charging windows', () => {
		const run = phoneRun([
			read('idle', 0, 0, 100),
			read('net', 0, 100, 150),
			read('idle', 1, 0, 100, true),
			read('net', 1, 100, 900),
			read('net', 2, 100, 400)
		]);
		expect(run.dropped).toBe(1);
		expect(run.arms['net']?.windows).toBe(1);
		expect(run.arms['net']?.joules.median).toBe(0.5);
		expect(run.idle.joules.median).toBe(100);
		expect(run.arms['net']?.secondsPerView).toBe(1);
	});

	it('leaves out an arm with no usable idle window', () => {
		const run = phoneRun([read('idle', 0, 0, 100), read('net', 1, 10, 200)]);
		expect(run.arms['net']).toBeUndefined();
	});
});

describe('navigation figures', () => {
	const nav = (kind: string, bytes: number, requests: number, ok: true | string = true) => ({
		kind,
		ok,
		bytes,
		networkRequests: requests,
		docBytes: 10
	});

	it('groups loaded navigations by kind and counts the sites', () => {
		const figures = repeatNavFigures([
			{
				site: 'a',
				navs: [
					nav('cold-home', 100, 10),
					nav('warm-internal', 10, 4),
					nav('warm-internal', 30, 6)
				]
			},
			{
				site: 'b',
				navs: [nav('warm-internal', 20, 5), nav('warm-internal', 1_000_000, 99, 'timeout')]
			}
		]);
		expect(figures['warm-internal']).toMatchObject({
			navs: 3,
			sites: 2,
			medianBytes: 20,
			meanBytes: 20,
			medianRequests: 5,
			medianDocBytes: 10
		});
		expect(figures['cold-home']?.p75Bytes).toBe(100);
	});

	it('maps each site to the bytes and document bytes of its loaded home-page repeat only', () => {
		const { docBytes: _, ...cached } = nav('warm-home-repeat', 7, 2);
		const bySite = repeatBytesBySite([
			{ site: 'a', navs: [nav('cold-home', 100, 10), nav('warm-home-repeat', 40, 3)] },
			{ site: 'b', navs: [nav('warm-home-repeat', 9, 1, 'timeout')] },
			{ site: 'c' },
			{ site: 'd', navs: [cached] },
			{ site: 'e', navs: [{ ...nav('warm-home-repeat', 5, 1), docStatus: 403 }] }
		]);
		expect([...bySite]).toEqual([
			['a', { bytes: 40, document: 10 }],
			['d', { bytes: 7, document: 0 }]
		]);
	});

	it('counts the views and the paths a zero-network run leaked', () => {
		const [row] = zeroNetworkFigures([
			{
				arm: 'a',
				engine: 'webkit',
				rows: [
					{ serverHits: ['/sw.js'] },
					{ serverHits: [] },
					{ serverHits: ['/sw.js', '/x'] }
				]
			}
		]);
		expect(row).toEqual({
			arm: 'a',
			engine: 'webkit',
			views: 3,
			viewsWithHits: 2,
			hits: { '/sw.js': 2, '/x': 1 }
		});
	});
});

describe('browser and proxy counts', () => {
	const nav = (
		kind: string,
		browser: number,
		wire: number,
		third: number,
		ok: true | string = true
	) => ({
		kind,
		ok,
		networkRequests: browser,
		bytes: 100,
		wire: { requests: wire, responseBytes: 90, thirdParty: third }
	});

	it('sets the two counts side by side and shares out the other-host requests', () => {
		const figures = onWireFigures([
			{ navs: [nav('warm-home-repeat', 50, 10, 6), nav('warm-home-repeat', 20, 20, 0)] },
			{
				navs: [
					nav('warm-home-repeat', 30, 10, 4),
					nav('warm-home-repeat', 99, 99, 99, 'timeout'),
					{ kind: 'cold-home', ok: true }
				]
			}
		]);
		expect(Object.keys(figures)).toEqual(['warm-home-repeat']);
		expect(figures['warm-home-repeat']).toEqual({
			navs: 3,
			browserRequests: 30,
			wireRequests: 10,
			browserBytes: 100,
			wireResponseBytes: 90,
			equal: 1,
			thirdPartyShare: 10 / 40,
			thirdPartyRequests: 4
		});
	});
});
