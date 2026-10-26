import { describe, expect, it } from 'vitest';
import type { SerializedRoute, SwConfig } from '../../src/protocol/index';
import { attributionalJoules, ORIGIN_J } from '../../src/report/index';
import {
	benefit,
	chooseEntries,
	DEFAULT_PRIOR,
	entryBreakEven,
	JOULES_PER_BYTE,
	Ledger,
	ORIGIN_JOULES,
	plan,
	priorFrom,
	smoothReuse,
	weigh,
	type EntryCandidate,
	type Opportunity
} from '../../src/sw/provision';
import { differs, modeFor, runsShadow } from '../../src/sw/shadow';

const only = (id: string, kind: Opportunity['kind'], gain: number, cost = 0): Opportunity => ({
	id,
	kind,
	reuse: 1,
	futureViews: 1,
	avoided: { bytes: gain, requests: 0 },
	provision: { bytes: cost, requests: 0 }
});

describe('the provisioning model', () => {
	it('weighs a request as requestBytes and sums the two', () => {
		expect(weigh({ bytes: 100, requests: 3 }, 2000)).toBe(6100);
		expect(weigh({ bytes: 0, requests: 0 }, 2000)).toBe(0);
	});

	it('computes P_reuse x N_future x C_avoided - C_provision - C_maintain in weighed bytes', () => {
		const o: Opportunity = {
			id: 'x',
			kind: 'route',
			avoided: { bytes: 65_000, requests: 1 },
			provision: { bytes: 20_000, requests: 1 }
		};
		expect(benefit(o)).toBe(0.5 * 2 * 67_000 - 22_000);
		expect(benefit({ ...o, maintain: { bytes: 5000, requests: 0 } })).toBe(40_000);
		expect(benefit({ ...o, reuse: 0.1, futureViews: 3 })).toBeCloseTo(0.3 * 67_000 - 22_000, 6);
		expect(benefit(o, { ...DEFAULT_PRIOR, requestBytes: 0, reuse: 1, futureViews: 1 })).toBe(
			45_000
		);
	});

	it('orders shared work first, hot routes next, expansion last, best first within a group', () => {
		const ordered = plan([
			only('expand', 'expansion', 1000),
			only('route-small', 'route', 300),
			only('layout', 'layout', 100),
			only('route-big', 'route', 500),
			only('template', 'template', 200),
			only('asset', 'asset', 150),
			only('loser', 'route', 10, 50)
		]);
		expect(ordered.map((o) => [o.id, o.benefit])).toEqual([
			['template', 200],
			['asset', 150],
			['layout', 100],
			['route-big', 500],
			['route-small', 300],
			['expand', 1000]
		]);
	});

	it('leaves out a zero benefit and breaks ties by id', () => {
		const ordered = plan([
			only('b', 'route', 5),
			only('a', 'route', 5),
			only('zero', 'route', 7, 7)
		]);
		expect(ordered.map((o) => o.id)).toEqual(['a', 'b']);
		expect(plan([])).toEqual([]);
	});

	it('merges a config over the defaults and ignores the hot list', () => {
		expect(priorFrom(undefined)).toEqual(DEFAULT_PRIOR);
		expect(priorFrom({ reuse: 0.9, hot: ['/'] })).toEqual({ ...DEFAULT_PRIOR, reuse: 0.9 });
	});

	it('smooths the revisit share toward the prior', () => {
		expect(smoothReuse(30, 10)).toBe((0.5 * 10 + 30) / (10 + 30 + 10));
		expect(smoothReuse(0, 0)).toBe(0.5);
		expect(smoothReuse(3, 1, DEFAULT_PRIOR, 0)).toBe(0.75);
		expect(smoothReuse(0, 100, { ...DEFAULT_PRIOR, reuse: 0.8 })).toBe(8 / 110);
	});
});

describe('the catalogue break-even', () => {
	const k = 6.984e-4;
	const o = 0.455;

	it('is k*E / (k*D + o)', () => {
		expect(entryBreakEven(17_054, 17_054)).toBe((k * 17_054) / (k * 17_054 + o));
		expect(entryBreakEven(17_054, 17_054)).toBeCloseTo(0.963, 3);
		expect(entryBreakEven(7603, 17_424)).toBeCloseTo(0.4206, 4);
		expect(entryBreakEven(473, 17_424)).toBeCloseTo(0.0262, 4);
		expect(entryBreakEven(0, 17_054)).toBe(0);
		expect(entryBreakEven(100_000, 100)).toBeGreaterThan(1);
	});

	it('uses the energy model constants of the report', () => {
		expect(JOULES_PER_BYTE).toBeCloseTo(attributionalJoules(1), 12);
		expect(ORIGIN_JOULES).toBe(ORIGIN_J.conventional.value);
	});
});

describe('choosing catalogue entries', () => {
	const entry = (path: string, p: number, entryBytes: number, documentBytes = 17_054) =>
		({ path, p, entryBytes, documentBytes }) satisfies EntryCandidate;
	const paths = (list: EntryCandidate[]) => list.map((c) => c.path);

	it('keeps an entry at its break-even and drops one just below it', () => {
		const at = entryBreakEven(5000, 17_054);
		expect(paths(chooseEntries([entry('/at', at, 5000)], { capBytes: 1e6 }))).toEqual(['/at']);
		const below = at - 1e-12;
		expect(chooseEntries([entry('/below', below, 5000)], { capBytes: 1e6 })).toEqual([]);
		expect(chooseEntries([entry('/zero', 0, 5000)], { capBytes: 1e6 })).toEqual([]);
	});

	it('judges a candidate with a weight on the lower confidence bound of its share', () => {
		// break-even for a 5000 B entry replacing 17,054 B is about 0.282; p 0.35 clears it as a point estimate
		const seen = (path: string, weight: number) => ({ ...entry(path, 0.35, 5000), weight });
		const options = { capBytes: 1e6, z: 1.28 };
		expect(paths(chooseEntries([seen('/few', 20)], options))).toEqual([]);
		expect(paths(chooseEntries([seen('/many', 2000)], options))).toEqual(['/many']);
		expect(paths(chooseEntries([seen('/few', 20)], { capBytes: 1e6 }))).toEqual(['/few']);
		expect(paths(chooseEntries([seen('/few', 20)], { capBytes: 1e6, z: 0 }))).toEqual(['/few']);
		expect(paths(chooseEntries([entry('/bare', 0.35, 5000)], options))).toEqual(['/bare']);
	});

	it('orders weighted candidates by the net at their bound', () => {
		const a = { ...entry('/a', 0.6, 4000), weight: 5 };
		const b = { ...entry('/b', 0.5, 4000), weight: 5000 };
		expect(paths(chooseEntries([a, b], { capBytes: 1e6 }))).toEqual(['/a', '/b']);
		expect(paths(chooseEntries([a, b], { capBytes: 1e6, z: 1.28 }))).toEqual(['/b', '/a']);
	});

	it('never chooses an entry that cannot pay, at any size, document or share', () => {
		const sizes = [0, 1, 80, 473, 2000, 7603, 17_054, 60_000];
		const shares = [0, 0.01, 0.05, 0.226, 0.5, 0.96, 0.99, 1];
		for (const e of sizes) {
			for (const d of [0, 500, 4000, 17_054, 60_000]) {
				for (const p of shares) {
					const chosen = chooseEntries([entry('/x', p, e, d)], { capBytes: 1e9 });
					expect(chosen.length === 1, `E ${e} D ${d} p ${p}`).toBe(
						p >= entryBreakEven(e, d)
					);
				}
			}
		}
	});

	it('orders by expected net joules, then path, and counts a path once', () => {
		const chosen = chooseEntries(
			[
				entry('/b', 0.9, 4000),
				entry('/a', 0.9, 4000),
				entry('/big', 0.95, 9000),
				entry('/small', 0.5, 100),
				entry('/a', 0.6, 4000)
			],
			{ capBytes: 1e6 }
		);
		expect(paths(chosen)).toEqual(['/a', '/b', '/small', '/big']);
		expect(chosen[0]?.p).toBe(0.9);
	});

	it('stays under the cap, skips what does not fit and takes a smaller one that does', () => {
		const list = [entry('/a', 0.9, 6000), entry('/b', 0.9, 5000), entry('/c', 0.5, 800)];
		expect(paths(chooseEntries(list, { capBytes: 11_800 }))).toEqual(['/b', '/a', '/c']);
		expect(paths(chooseEntries(list, { capBytes: 11_799 }))).toEqual(['/b', '/a']);
		expect(paths(chooseEntries(list, { capBytes: 6000 }))).toEqual(['/b', '/c']);
		expect(paths(chooseEntries(list, { capBytes: 5000 }))).toEqual(['/b']);
		expect(paths(chooseEntries(list, { capBytes: 4999 }))).toEqual(['/c']);
		expect(paths(chooseEntries(list, { capBytes: 799 }))).toEqual([]);
		expect(chooseEntries(list, { capBytes: 0 })).toEqual([]);
		expect(chooseEntries(list, { capBytes: -5 })).toEqual([]);
	});

	it('holds the cap for every cap over a pool of mixed entries', () => {
		let seed = 7;
		const next = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
		const pool = Array.from({ length: 60 }, (_, i) =>
			entry(`/e${i}`, next(), Math.floor(next() * 12_000), 2000 + Math.floor(next() * 30_000))
		);
		for (const cap of [0, 500, 4000, 12_000, 32_768, 1e9]) {
			const chosen = chooseEntries(pool, { capBytes: cap });
			expect(chosen.reduce((sum, c) => sum + c.entryBytes, 0)).toBeLessThanOrEqual(cap);
			for (const c of chosen) {
				expect(c.p).toBeGreaterThanOrEqual(entryBreakEven(c.entryBytes, c.documentBytes));
			}
		}
	});

	it('refuses a share outside 0 to 1 and a size that is negative or not a number', () => {
		const list = [
			entry('/over', 1.5, 100),
			entry('/neg', -0.1, 100),
			entry('/nan', Number.NaN, 100),
			entry('/size', 0.9, -1),
			entry('/size-nan', 0.9, Number.NaN),
			entry('/doc', 0.9, 100, Number.NaN),
			entry('/doc-inf', 0.9, 100, Infinity),
			entry('/ok', 0.9, 100)
		];
		expect(paths(chooseEntries(list, { capBytes: 1e6 }))).toEqual(['/ok']);
	});
});

describe('Ledger', () => {
	it('keeps bytes, requests and views per artifact and sums them', () => {
		const ledger = new Ledger();
		expect(ledger.totals()).toEqual({
			bytes: 0,
			requests: 0,
			views: 0,
			bytesPerView: null,
			catalogueBytes: 0,
			catalogueViews: 0
		});
		expect(ledger.meanFetchBytes()).toBeNull();
		ledger.spend('/b', { bytes: 300, requests: 1 });
		ledger.spend('/a', { bytes: 100, requests: 1 });
		ledger.spend('/a', { bytes: 50, requests: 0 });
		for (let i = 0; i < 3; i++) ledger.serve('/a');
		ledger.serve('/c');
		const zero = { catalogueBytes: 0, catalogueViews: 0 };
		expect(ledger.entries()).toEqual([
			{ id: '/a', bytes: 150, requests: 1, views: 3, ...zero },
			{ id: '/b', bytes: 300, requests: 1, views: 0, ...zero },
			{ id: '/c', bytes: 0, requests: 0, views: 1, ...zero }
		]);
		expect(ledger.totals()).toEqual({
			bytes: 450,
			requests: 2,
			views: 4,
			bytesPerView: 450 / 4,
			...zero
		});
		expect(ledger.meanFetchBytes()).toBe(225);
	});

	it('counts catalogue bytes and the first open of an entry apart, and keeps them out of the mean fetch', () => {
		const ledger = new Ledger();
		ledger.spend('/a', { bytes: 100, requests: 1 });
		ledger.spend('/e', { bytes: 40, requests: 0 }, true);
		ledger.spend('/e', { bytes: 10, requests: 0 }, true);
		ledger.serve('/e', true);
		ledger.serve('/e');
		expect(ledger.entries().find((e) => e.id === '/e')).toEqual({
			id: '/e',
			bytes: 50,
			requests: 0,
			views: 2,
			catalogueBytes: 50,
			catalogueViews: 1
		});
		expect(ledger.totals()).toMatchObject({
			bytes: 150,
			views: 2,
			catalogueBytes: 50,
			catalogueViews: 1
		});
		expect(ledger.meanFetchBytes()).toBe(100);
	});

	it('hands out copies', () => {
		const ledger = new Ledger();
		ledger.spend('/a', { bytes: 1, requests: 1 });
		(ledger.entries()[0] as { bytes: number }).bytes = 99;
		expect(ledger.entries()[0]?.bytes).toBe(1);
	});
});

describe('shadow decisions', () => {
	const route = (over: Partial<SerializedRoute> = {}): SerializedRoute => ({
		pattern: '/a',
		strategy: 'template',
		scope: 'public',
		freshness: { maxStale: 1, mode: 'soft' },
		persist: true,
		offline: 'serve',
		sync: 'background',
		...over
	});
	const config = (over: Partial<SwConfig> = {}): SwConfig => ({
		protocol: 1,
		version: 'v',
		routes: [],
		templates: {},
		beacons: [],
		clientTag: '',
		...over
	});

	it('takes the route mode, else the server mode, else serve', () => {
		expect(modeFor(config(), route())).toBe('serve');
		expect(modeFor(config({ mode: 'shadow' }), route())).toBe('shadow');
		expect(modeFor(config({ mode: 'shadow' }), route({ mode: 'serve' }))).toBe('serve');
		expect(modeFor(config(), route({ mode: 'shadow' }))).toBe('shadow');
	});

	it('shadows every view of a shadow route without drawing, and a sample of the rest', () => {
		const never = () => {
			throw new Error('should not draw');
		};
		expect(runsShadow(config({ mode: 'shadow' }), route(), never)).toBe(true);
		expect(runsShadow(config(), route({ mode: 'shadow' }), never)).toBe(true);
		expect(runsShadow(config(), route(), never)).toBe(false);
		expect(runsShadow(config({ shadowSample: 0 }), route(), never)).toBe(false);
		expect(runsShadow(config({ shadowSample: 0.5 }), route(), () => 0.49)).toBe(true);
		expect(runsShadow(config({ shadowSample: 0.5 }), route(), () => 0.5)).toBe(false);
		expect(runsShadow(config({ shadowSample: 1 }), route(), () => 0.999)).toBe(true);
	});

	it('compares after normalising, and counts any status but 200 as a difference', async () => {
		const html = (text: string, status = 200) => new Response(text, { status });
		expect(await differs('<p>a</p>', html('<p>a</p>'))).toBe(false);
		expect(await differs('<p>a</p>', html('<!-- x -->\n<p>a</p>\n'))).toBe(false);
		expect(await differs('<p>a</p>', html('<p>b</p>'))).toBe(true);
		expect(await differs('<p>a</p>', html('<p>a</p>', 404))).toBe(true);
		expect(await differs('<p>a</p>', html('', 500))).toBe(true);
	});
});
