import { describe, expect, it } from 'vitest';
import type { SerializedRoute, SwConfig } from '../../src/protocol/index';
import {
	benefit,
	DEFAULT_PRIOR,
	Ledger,
	plan,
	priorFrom,
	smoothReuse,
	weigh,
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

describe('Ledger', () => {
	it('keeps bytes, requests and views per artifact and sums them', () => {
		const ledger = new Ledger();
		expect(ledger.totals()).toEqual({ bytes: 0, requests: 0, views: 0, bytesPerView: null });
		expect(ledger.meanFetchBytes()).toBeNull();
		ledger.spend('/b', { bytes: 300, requests: 1 });
		ledger.spend('/a', { bytes: 100, requests: 1 });
		ledger.spend('/a', { bytes: 50, requests: 0 });
		for (let i = 0; i < 3; i++) ledger.serve('/a');
		ledger.serve('/c');
		expect(ledger.entries()).toEqual([
			{ id: '/a', bytes: 150, requests: 1, views: 3 },
			{ id: '/b', bytes: 300, requests: 1, views: 0 },
			{ id: '/c', bytes: 0, requests: 0, views: 1 }
		]);
		expect(ledger.totals()).toEqual({
			bytes: 450,
			requests: 2,
			views: 4,
			bytesPerView: 450 / 4
		});
		expect(ledger.meanFetchBytes()).toBe(225);
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
