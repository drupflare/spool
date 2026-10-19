import { describe, expect, it } from 'vitest';
import {
	engineOf,
	FROM_EXTERNAL,
	funnelOf,
	LOADS_PATH,
	loadsFromBeacon,
	loadsToBeacon,
	REASON_TIER,
	VIEW_PATH,
	viewFromBeacon,
	viewsWithLoads,
	viewToBeacon,
	type ViewEvent,
	type ViewReason
} from '../../src/protocol/index';

const VIEW: ViewEvent = {
	id: 'v1',
	crossOriginLoads: 0,
	tier: 'local',
	reason: 'fresh',
	staleSec: 0,
	engine: 'firefox',
	scope: 'public',
	strategy: 'assembly',
	route: '/p/:id',
	mismatch: null,
	swAgeMs: 10,
	gapMs: null
};

describe('view events as beacons', () => {
	it('round-trips through the queue format with the device time', () => {
		const beacon = viewToBeacon(VIEW, 1234);
		expect(beacon.path).toBe(VIEW_PATH);
		expect(beacon.contentType).toBe('application/json');
		expect(viewFromBeacon(beacon)).toEqual({ ...VIEW, at: 1234 });
	});

	it('round-trips the catalogue reason', () => {
		const catalogue: ViewEvent = { ...VIEW, reason: 'catalogue' };
		expect(viewFromBeacon(viewToBeacon(catalogue, 9))).toEqual({ ...catalogue, at: 9 });
	});

	it('keeps null for what was not measured', () => {
		const back = viewFromBeacon(
			viewToBeacon({ ...VIEW, staleSec: null, gapMs: 5, mismatch: true }, 1)
		);
		expect(back).toMatchObject({ staleSec: null, gapMs: 5, mismatch: true });
	});

	it('round-trips from, and drops an unknown or overlong one instead of failing', () => {
		for (const from of ['/p/:id', FROM_EXTERNAL]) {
			expect(viewFromBeacon(viewToBeacon({ ...VIEW, from }, 7))).toEqual({
				...VIEW,
				from,
				at: 7
			});
		}
		expect(viewFromBeacon(viewToBeacon(VIEW, 7))).not.toHaveProperty('from');
		for (const from of [1, '', `/${'r'.repeat(256)}`, null]) {
			const back = viewFromBeacon(viewToBeacon({ ...VIEW, from: from as never }, 7));
			expect(back).toEqual({ ...VIEW, at: 7 });
			expect(back).not.toHaveProperty('from');
		}
	});

	it.each([
		['another path', { ...viewToBeacon(VIEW, 1), path: '/cdn-cgi/rum' }],
		['bad JSON', { ...viewToBeacon(VIEW, 1), body: '{' }],
		['a JSON null', { ...viewToBeacon(VIEW, 1), body: 'null' }],
		['an unknown tier', { ...viewToBeacon({ ...VIEW, tier: 'x' as never }, 1) }],
		['an unknown reason', { ...viewToBeacon({ ...VIEW, reason: 'x' as never }, 1) }],
		['an unknown engine', { ...viewToBeacon({ ...VIEW, engine: 'x' as never }, 1) }],
		['an unknown scope', { ...viewToBeacon({ ...VIEW, scope: 'x' as never }, 1) }],
		['an unknown strategy', { ...viewToBeacon({ ...VIEW, strategy: 'x' as never }, 1) }],
		['a numeric route', { ...viewToBeacon({ ...VIEW, route: 1 as never }, 1) }],
		[
			'a route past the length cap',
			{ ...viewToBeacon({ ...VIEW, route: `/${'r'.repeat(256)}` }, 1) }
		],
		['a string mismatch', { ...viewToBeacon({ ...VIEW, mismatch: 'no' as never }, 1) }],
		['a string staleSec', { ...viewToBeacon({ ...VIEW, staleSec: '1' as never }, 1) }],
		['a missing swAgeMs', { ...viewToBeacon({ ...VIEW, swAgeMs: undefined as never }, 1) }]
	])('reads %s as no view', (_name, beacon) => {
		expect(viewFromBeacon(beacon)).toBeNull();
	});
});

describe('loads reports', () => {
	it('round-trip and join to their view, the last one winning', () => {
		const beacon = loadsToBeacon('v1', 5, 77);
		expect(beacon.path).toBe(LOADS_PATH);
		expect(loadsFromBeacon(beacon)).toEqual({ view: 'v1', count: 5, at: 77 });
		const events = [
			viewToBeacon({ ...VIEW, crossOriginLoads: null }, 1),
			beacon,
			loadsToBeacon('v1', 6, 78),
			loadsToBeacon('other', 9, 79),
			viewToBeacon({ ...VIEW, id: 'v2', crossOriginLoads: null }, 2)
		];
		expect(viewsWithLoads(events).map((v) => [v.id, v.crossOriginLoads])).toEqual([
			['v1', 6],
			['v2', null]
		]);
	});

	it.each([
		['another path', { ...loadsToBeacon('v', 1, 1), path: '/x' }],
		['bad JSON', { ...loadsToBeacon('v', 1, 1), body: '{' }],
		['an empty view', loadsToBeacon('', 1, 1)],
		['a long view id', loadsToBeacon('x'.repeat(65), 1, 1)],
		['a negative count', loadsToBeacon('v', -1, 1)],
		['a fractional count', loadsToBeacon('v', 1.5, 1)],
		['a string count', { ...loadsToBeacon('v', 1, 1), body: '{"view":"v","count":"1"}' }]
	])('read %s as no report', (_name, beacon) => {
		expect(loadsFromBeacon(beacon)).toBeNull();
	});

	it('are refused on a view with a bad id or count', () => {
		expect(viewFromBeacon(viewToBeacon({ ...VIEW, id: '' }, 1))).toBeNull();
		expect(viewFromBeacon(viewToBeacon({ ...VIEW, id: 'x'.repeat(65) }, 1))).toBeNull();
		expect(viewFromBeacon(viewToBeacon({ ...VIEW, crossOriginLoads: -1 }, 1))).toBeNull();
		expect(viewFromBeacon(viewToBeacon({ ...VIEW, crossOriginLoads: 1.5 }, 1))).toBeNull();
	});
});

describe('engineOf', () => {
	it.each([
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
			'chromium'
		],
		[
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
			'chromium'
		],
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
			'firefox'
		],
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
			'webkit'
		],
		[
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
			'webkit'
		],
		[
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15',
			'webkit'
		],
		['Node.js/24', 'other'],
		['', 'other']
	])('names the engine behind %s', (agent, engine) => {
		expect(engineOf(agent)).toBe(engine);
	});
});

describe('the reason table', () => {
	const reasons = Object.keys(REASON_TIER) as ViewReason[];

	it('lists twelve reasons and gives each a serve tier', () => {
		expect(reasons).toHaveLength(12);
		expect(REASON_TIER.fresh).toBe('local');
		expect(REASON_TIER.catalogue).toBe('local');
		expect(REASON_TIER['soft-deferred']).toBe('local');
		expect(REASON_TIER['soft-sync']).toBe('local-revalidate');
		expect(REASON_TIER.invalidated).toBe('fallback');
		expect(REASON_TIER.cold).toBe('network');
	});

	it('puts every reason in one funnel stage; only a tier-local reason without a mismatch is local', () => {
		const stage = (
			reason: ViewReason,
			mismatch: boolean | null = null,
			loads: number | null = 0
		) => funnelOf({ reason, mismatch, crossOriginLoads: loads });
		expect(stage('principal')).toBe('ineligible');
		expect(stage('cold')).toBe('cold');
		expect(stage('fresh')).toBe('local');
		expect(stage('catalogue')).toBe('local');
		expect(stage('catalogue', null, 1)).toBe('unusable');
		expect(stage('soft-deferred')).toBe('local');
		expect(stage('fresh', true)).toBe('unusable');
		expect(stage('fresh', null, 1)).toBe('unusable');
		expect(stage('fresh', null, null)).toBe('unusable');
		expect(stage('cold', null, 3)).toBe('cold');
		for (const reason of reasons.filter(
			(r) => !['principal', 'cold', 'fresh', 'catalogue', 'soft-deferred'].includes(r)
		)) {
			expect(stage(reason), reason).toBe('unusable');
		}
	});
});
