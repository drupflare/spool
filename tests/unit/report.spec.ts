import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIOR } from '../../src/protocol/index';
import {
	HOSTS,
	TIERS,
	attributionalJoules,
	bandwidthUsd,
	capacityMWh,
	coverageFigures,
	dataCentreJoules,
	egressUsd,
	fleetFor,
	freeTierCeiling,
	joulesPerView,
	joulesPerViewWithOrigin,
	linearFit,
	median,
	monthlyGb,
	onWireFigures,
	peakCut,
	perMillionViewsUsd,
	phoneRun,
	powerSweep,
	quantile,
	quartiles,
	raplRun,
	repeatBytesBySite,
	repeatNavFigures,
	repeatSplitBySite,
	requestUsd,
	runtimeRun,
	saving,
	serverYearMWh,
	serversAfter,
	splitRequestBytes,
	spread,
	swdTotal,
	trimFigures,
	viewsChannelMWh,
	zeroNetworkFigures,
	type Row
} from '../../src/report/index';
import { DOCUMENT_BYTES } from '../../src/report/inputs';

// a scale for the tables: 100 million views a year, a round number and no institution
const VIEWS = 100e6;

describe('the views channel', () => {
	it('prices bytes at the SWD v4 total of 0.194 kWh/GB', () => {
		expect(swdTotal()).toBeCloseTo(0.194, 10);
		expect(attributionalJoules(1e6)).toBeCloseTo(698.4, 6);
	});

	it('models about 12.4 J per local view, the replaced document request', () => {
		expect(joulesPerView()).toBeCloseTo(12.37, 2);
	});

	it("keeps the worker's provisioning prior on the measured document median", () => {
		expect(DEFAULT_PRIOR.avoidedBytes).toBe(DOCUMENT_BYTES.value);
	});

	it('replaces the data-centre term and the modelled origin with a measured origin', () => {
		expect(dataCentreJoules()).toBeCloseTo(3.38, 2);
		expect(joulesPerViewWithOrigin(0)).toBeCloseTo(attributionalJoules(17_054, 0.139), 8);
		expect(joulesPerViewWithOrigin(10.9) - joulesPerViewWithOrigin(0)).toBeCloseTo(10.9, 10);
		expect(joulesPerViewWithOrigin(0.015, { bytes: 0, radioJ: 0, mobileShare: 0 })).toBe(0.015);
	});

	it('scales with the local share, tier by tier', () => {
		const mwh = Object.values(TIERS).map((z) => viewsChannelMWh(VIEWS, z));
		expect(mwh.map((v) => Number(v.toFixed(2)))).toEqual([0.1, 0.22, 0.31]);
	});
});

describe('bandwidth and request dollars', () => {
	const host = (name: string) => {
		const found = HOSTS.find((h) => h.name.startsWith(name));
		if (!found) throw new Error(`no host ${name}`);
		return found;
	};

	it('prices a million local views at each host list price', () => {
		expect(egressUsd(1e6, host('Cloudflare'))).toBe(0);
		expect(requestUsd(1e6, host('Cloudflare'))).toBeCloseTo(0.3, 10);
		expect(bandwidthUsd(1e6, host('AWS'))).toBeCloseTo(17.054 * 0.085 + 1, 8);
		expect(bandwidthUsd(1e6, host('Microsoft'))).toBeCloseTo(17.054 * 0.087, 8);
		expect(bandwidthUsd(1e6, host('Google'))).toBeCloseTo((17_054e6 / 2 ** 30) * 0.12, 8);
	});

	it('bills no request where none was read, and scales linearly with views', () => {
		expect(requestUsd(5e6, host('Microsoft'))).toBe(0);
		expect(bandwidthUsd(3e6, host('AWS'))).toBeCloseTo(3 * bandwidthUsd(1e6, host('AWS')), 10);
		expect(bandwidthUsd(0, host('AWS'))).toBe(0);
	});

	it('counts the GB a month the local views no longer move', () => {
		expect(monthlyGb(90e6)).toBeCloseTo((90e6 * 17_054) / 12 / 1e9, 8);
	});

	it('gives every price an L0 or L2 label, a source and the date read', () => {
		for (const h of HOSTS) {
			for (const input of [h.egress, h.requests, h.freeAllowance]) {
				if (!input) continue;
				expect(['L0', 'L2']).toContain(input.layer);
				expect(input.source).toContain('2026-10-19');
			}
		}
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

describe('a runtimes reading', () => {
	const window = (arm: string, round: number, views: number, joules: number, bytes: number) => ({
		runtime: 'node',
		arm,
		round,
		views,
		discarded: null,
		windowS: 60,
		pkgJ: joules,
		tailscaleRxB: bytes,
		tailscaleTxB: 0,
		wlanRxB: 2 * bytes,
		wlanTxB: 0,
		originNet: { requests: arm === 'idle' ? 0 : views },
		originSpool: { requests: 0 }
	});

	it('takes each window above the idle window of its round, per view', () => {
		const run = runtimeRun([
			window('idle', 0, 0, 1200, 600),
			window('network', 0, 60, 1260, 60_600),
			{ ...window('network', 1, 60, 9999, 1), discarded: '2 view errors' },
			window('idle', 1, 0, 1200, 600)
		]);
		const net = run['node']?.['network'];
		expect(net?.windows).toBe(1);
		expect(net?.joules.median).toBe(1);
		expect(net?.overlayBytes.median).toBe(1000);
		expect(net?.wireBytes.median).toBe(2000);
		expect(net?.originRequests.median).toBe(1);
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

	it('splits a repeat view into document, same-origin static and dynamic, and third-party by class', () => {
		const req = (
			type: string,
			bytes: number,
			url: string,
			sameOrigin: boolean,
			extra = {}
		) => ({
			type,
			bytes,
			url,
			host: new URL(url).hostname,
			sameOrigin,
			fromCache: false,
			...extra
		});
		const requests = [
			req('Document', 100, 'https://a.test/', true),
			req('Script', 10, 'https://a.test/a.js', true),
			req('Image', 20, 'https://a.test/a.png', true),
			req('Fetch', 5, 'https://a.test/api', true),
			req('Other', 1, 'https://a.test/x', true),
			req('Script', 7, 'https://www.googletagmanager.com/gtm.js', false),
			req('Font', 3, 'https://fonts.gstatic.com/f.woff2', false),
			req('XHR', 2, 'https://unknown.example/collect', false),
			req('Document', 4, 'https://a.test/frame', true),
			req('Script', 999, 'https://a.test/cached.js', true, { fromCache: true })
		];
		const split = splitRequestBytes(requests);
		expect(split).toEqual({
			document: 100,
			sameOriginStatic: 30,
			sameOriginDynamic: 10,
			thirdParty: { analytics: 7, fonts: 3, unknown: 2 },
			thirdPartyTotal: 12,
			thirdPartyHosts: {
				'www.googletagmanager.com': 7,
				'fonts.gstatic.com': 3,
				'unknown.example': 2
			},
			total: 152
		});
		expect(split.document + split.sameOriginStatic + split.sameOriginDynamic).toBe(
			split.total - split.thirdPartyTotal
		);
		const nav = (kind: string, ok: true | string, list?: unknown) => ({
			kind,
			ok,
			bytes: 1,
			...(list ? { requestList: list } : {})
		});
		const bySite = repeatSplitBySite([
			{
				site: 'a',
				navs: [nav('cold-home', true, requests), nav('warm-home-repeat', true, requests)]
			},
			{ site: 'b', navs: [nav('warm-home-repeat', true)] },
			{ site: 'c', navs: [nav('warm-home-repeat', 'timeout', requests)] },
			{ site: 'd' }
		]);
		expect([...bySite.keys()]).toEqual(['a']);
		expect(splitRequestBytes([]).total).toBe(0);
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

describe('trim figures', () => {
	const px = (differing: number) => ({ differing, compared: 1000 });
	const page = (kind: string, saved: number, rest: Record<string, unknown> = {}) => ({
		kind,
		saved: { br5Saved: saved },
		guard: { fired: false },
		oracleA: { used: 10, falseRemovals: 0, lost: [] },
		oracleB: null,
		leaveOneOut: null,
		...rest
	});
	const file = { trimmed: true, raw: 1000, br5: 400, trimmedRaw: 300, trimmedBr5: 100 };
	const rows: Row[] = [
		{
			site: 'https://a.test/',
			files: [file],
			pages: [
				page('home', 1000, { oracleB: { control: px(0), trimmed: px(0), fulfilled: 2 } }),
				page('internal', 400, {
					oracleB: { control: px(0), trimmed: px(9), fulfilled: 2 },
					leaveOneOut: { trimmedFiles: 1, guardFired: true, oracleA: null }
				}),
				page('internal', 0, {
					leaveOneOut: {
						trimmedFiles: 1,
						guardFired: false,
						oracleA: { used: 4, falseRemovals: 1 }
					}
				})
			]
		},
		{
			site: 'https://b.test/',
			files: [file, file],
			pages: [
				page('home', 3000, { oracleB: { error: 'timeout' } }),
				page('internal', 2000, {
					oracleA: {
						used: 7,
						falseRemovals: 1,
						lost: [{ file: '/a.css', selector: '.x' }]
					},
					leaveOneOut: { trimmedFiles: 0, guardFired: false, oracleA: null }
				})
			]
		}
	];

	it('takes quartiles with linear interpolation and the mean, and null for nothing', () => {
		expect(quartiles([0, 400, 2000])).toEqual({
			n: 3,
			p25: 200,
			median: 400,
			p75: 1200,
			mean: 800
		});
		expect(quartiles([])).toBeNull();
	});

	it('saves bytes per cold and first view, with the joules of those bytes at the SWD rate', () => {
		const figures = trimFigures(rows);
		expect(figures.cold.bytes).toEqual({
			n: 2,
			p25: 1500,
			median: 2000,
			p75: 2500,
			mean: 2000
		});
		expect(figures.first.bytes).toEqual({ n: 3, p25: 200, median: 400, p75: 1200, mean: 800 });
		expect(figures.first.joules.median).toBeCloseTo(attributionalJoules(400), 12);
		expect(figures.first.joules.mean).toBeCloseTo(attributionalJoules(800), 12);
		expect(figures.sites.map((s) => [s.site, s.cold?.bytes.median, s.first?.bytes.n])).toEqual([
			['https://a.test/', 1000, 2],
			['https://b.test/', 3000, 1]
		]);
		expect(figures.sites.map((s) => s.fileShare)).toEqual([0.75, 0.75]);
		expect(figures.files).toEqual({ count: 3, trimmed: 3, br5: 1200, trimmedBr5: 300 });
	});

	it('counts the false removals of Oracle A and names the offenders', () => {
		expect(trimFigures(rows).rules).toEqual({
			pages: 5,
			used: 47,
			falseRemovals: 1,
			offenders: ['/a.css .x']
		});
	});

	it('compares the trimmed arm with the control and counts the failed screenshots', () => {
		expect(trimFigures(rows).render).toEqual({
			pages: 2,
			errors: 1,
			identical: 1,
			controlIdentical: 2,
			beyondControl: 1,
			trimmedOnly: 1,
			maxTrimmed: 9,
			maxControl: 0
		});
	});

	it('counts the guard and Oracle A of leave-one-out over the pages that have one', () => {
		expect(trimFigures(rows).leaveOneOut).toEqual({
			pages: 3,
			guardFired: 1,
			unguarded: 1,
			unguardedRules: 4,
			falseRemovals: 1,
			pagesWithFalseRemovals: 1
		});
	});

	it('refuses a reading with no home page or no internal page', () => {
		expect(() => trimFigures([])).toThrow(RangeError);
	});

	it('reads coverage shares of same-origin files over the pages that loaded', () => {
		const files = (css: number, js: number) => [
			{ kind: 'css', origin: 'same', raw: 100, usedLoad: css, usedScroll: css },
			{ kind: 'js', origin: 'same', raw: 100, usedLoad: js, usedScroll: js + 10 },
			{ kind: 'js', origin: 'third', raw: 100, usedLoad: 100, usedScroll: 100 }
		];
		const figures = coverageFigures([
			{
				pages: [
					{ ok: true, files: files(10, 20) },
					{ ok: 'timeout', files: files(99, 99) }
				]
			},
			{
				pages: [
					{ ok: true, files: files(30, 40) },
					{ ok: true, files: [] }
				]
			}
		]);
		expect(figures.pages).toBe(3);
		expect(figures.cssLoad?.median).toBeCloseTo(0.2, 12);
		expect(figures.jsLoad?.median).toBeCloseTo(0.3, 12);
		expect(figures.jsScroll?.median).toBeCloseTo(0.4, 12);
		expect(figures.cssLoad?.n).toBe(2);
	});

	it('prices a share of views at the host egress rate, with no request term', () => {
		const aws = HOSTS.find((h) => h.name.startsWith('AWS')) as (typeof HOSTS)[number];
		expect(perMillionViewsUsd(10_000, 1, aws)).toBeCloseTo(0.85, 10);
		expect(perMillionViewsUsd(10_000, 0.5, aws)).toBeCloseTo(0.425, 10);
		expect(perMillionViewsUsd(10_000, 1, HOSTS[0] as (typeof HOSTS)[number])).toBe(0);
	});
});
