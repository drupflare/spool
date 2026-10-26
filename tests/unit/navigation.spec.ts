import { describe, expect, it } from 'vitest';
import type { NavOptions } from '../../src/protocol/index';
import {
	NavModel,
	ProtocolError,
	expectedNet,
	lowerBound,
	shouldAct
} from '../../src/protocol/index';
import { JOULES_PER_BYTE, ORIGIN_JOULES, entryBreakEven } from '../../src/protocol/provision';

describe('NavModel', () => {
	it('predicts each route at its count over the total plus alpha', () => {
		const model = new NavModel({ halfLife: Infinity });
		model.observe(['/a'], '/b');
		model.observe(['/a'], '/b');
		model.observe(['/a'], '/c');
		expect(model.predict(['/a'])).toEqual([
			{ route: '/b', p: (2 + 0) / (3 + 1), weight: 3 },
			{ route: '/c', p: (1 + 0) / (3 + 1), weight: 3 }
		]);
	});

	it('pulls each row toward its prior and lists a prior-only route', () => {
		const model = new NavModel({ halfLife: Infinity, prior: { '/a': { '/b': 1, '/d': 3 } } });
		model.observe(['/a'], '/b');
		model.observe(['/a'], '/b');
		model.observe(['/a'], '/c');
		expect(model.predict(['/a'])).toEqual([
			{ route: '/b', p: (2 + 1 * (1 / 4)) / (3 + 1), weight: 7 },
			{ route: '/c', p: (1 + 0) / (3 + 1), weight: 7 },
			{ route: '/d', p: (0 + 1 * (3 / 4)) / (3 + 1), weight: 7 }
		]);
	});

	it('counts the prior toward the weight, so a prior-only row is not weightless', () => {
		const model = new NavModel({ prior: { '/a': { '/b': 30, '/c': 10 } } });
		const [top] = model.predict(['/a']);
		expect(top).toEqual({ route: '/b', p: (30 / 40) * (1 / 1), weight: 40 });
	});

	it('never predicts a route it has neither counted nor found in the prior', () => {
		const model = new NavModel({ prior: { '/a': { '/b': 1 } } });
		expect(model.predict(['/nope'])).toEqual([]);
		expect(model.predict(['/a']).map((n) => n.route)).toEqual(['/b']);
	});

	it('weighs a count by 0.5 ** (age / halfLife)', () => {
		const model = new NavModel({ halfLife: 2 });
		model.observe(['/a'], '/b');
		model.observe(['/x'], '/y');
		model.observe(['/x'], '/y');
		model.observe(['/x'], '/y');
		model.observe(['/f'], '/g');
		expect(model.predict(['/a'])[0]?.weight).toBe(0.25);
		expect(model.predict(['/f'])[0]?.weight).toBe(1);
	});

	it('backs off to the one-pattern context below the backoff count', () => {
		const model = new NavModel({ order: 2, halfLife: Infinity });
		for (let i = 0; i < 3; i++) model.observe(['/b'], '/d');
		model.observe(['/a', '/b'], '/c');
		const [top, low] = model.predict(['/a', '/b']);
		expect(top?.route).toBe('/d');
		expect(top?.p).toBeCloseTo((5 / 6) * (3 / 5), 12);
		expect(low?.route).toBe('/c');
		expect(low?.p).toBeCloseTo((1 / 6) * (1 / 2) + (5 / 6) * (1 / 5), 12);
		expect(top?.weight).toBeCloseTo((1 / 6) * 1 + (5 / 6) * 4, 12);
	});

	it('leans on the two-pattern context as its count grows', () => {
		const model = new NavModel({ order: 2, halfLife: Infinity });
		for (let i = 0; i < 3; i++) model.observe(['/b'], '/d');
		for (let i = 0; i < 5; i++) model.observe(['/a', '/b'], '/c');
		const [top, low] = model.predict(['/a', '/b']);
		expect(top?.route).toBe('/c');
		expect(top?.p).toBeCloseTo(0.5 * (5 / 6) + 0.5 * (5 / 9), 12);
		expect(low?.route).toBe('/d');
		expect(low?.p).toBeCloseTo(0.5 * (3 / 9), 12);
		expect(top?.weight).toBeCloseTo(0.5 * 5 + 0.5 * 8, 12);
	});

	it('keeps the cap sizes and drops the least recently touched context', () => {
		const model = new NavModel({ order: 2, maxContexts: 3, maxNext: 2 });
		for (let i = 0; i < 10; i++) {
			for (let j = 0; j < 5; j++) model.observe(['/x', `/c${i}`], `/r${j}`);
		}
		const snapshot = model.toJSON();
		expect(snapshot.one.map(([ctx]) => ctx[0]).sort()).toEqual(['/c7', '/c8', '/c9']);
		expect(snapshot.two.map(([ctx]) => ctx[1]).sort()).toEqual(['/c7', '/c8', '/c9']);
		expect(snapshot.one.every(([, , next]) => next.length === 2)).toBe(true);
	});

	it('records nothing for an empty context', () => {
		const model = new NavModel({ halfLife: 2 });
		expect(model.predict(['/a'])).toEqual([]);
		model.observe(['/a'], '/b');
		const before = model.toJSON();
		const predicted = model.predict(['/a']);
		model.observe([], '/z');
		model.observe([], '/z');
		expect(model.toJSON()).toEqual(before);
		expect(model.predict(['/a'])).toEqual(predicted);
		expect(model.predict([])).toEqual([]);
	});

	it('round-trips through JSON to the same predictions', () => {
		let seed = 7;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		const routes = ['/a', '/b/:id', '/c', '/d', '/e/:x', '/f'];
		for (let run = 0; run < 50; run++) {
			const options: NavOptions = {
				order: run % 2 === 0 ? 1 : 2,
				halfLife: 3 + (run % 5),
				alpha: 0.5,
				backoff: 2,
				maxContexts: 5,
				maxNext: 4,
				prior: { '/a': { '/b/:id': 2, '/c': 1 } }
			};
			const model = new NavModel(options);
			let context: string[] = [];
			for (let step = 0; step < 40; step++) {
				const route = routes[Math.floor(next() * routes.length)] ?? '/a';
				model.observe(context, route);
				context = [...context, route].slice(-2);
			}
			const copy = NavModel.fromJSON(JSON.parse(JSON.stringify(model.toJSON())), options);
			for (const a of routes) {
				for (const b of routes) {
					for (const c of [[a], [a, b]])
						expect(copy.predict(c)).toEqual(model.predict(c));
				}
			}
		}
	});

	it.each<[string, unknown]>([
		['a non-object', null],
		['an array', []],
		['a wrong version', { v: 2, t: 0, one: [], two: [] }],
		['a negative count', { v: 1, t: 1, one: [[['/a'], 1, [['/b', -1, 1]]]], two: [] }],
		[
			'a count that is not a number',
			{ v: 1, t: 1, one: [[['/a'], 1, [['/b', '1', 1]]]], two: [] }
		],
		['an unknown field', { v: 1, t: 0, one: [], two: [], extra: true }],
		['a table that is not a list', { v: 1, t: 0, one: 'x', two: [] }]
	])('refuses a snapshot with %s', (_name, snapshot) => {
		expect(() => NavModel.fromJSON(snapshot)).toThrow(ProtocolError);
	});

	it('refuses an option out of range', () => {
		expect(() => new NavModel({ halfLife: 0 })).toThrow(RangeError);
		expect(() => new NavModel({ maxNext: 0 })).toThrow(RangeError);
	});
});

describe('lowerBound', () => {
	it('returns p at z = 0', () => {
		for (const p of [0, 0.01, 0.3, 0.5, 1]) {
			for (const weight of [1, 10, 1000]) expect(lowerBound(p, weight, 0)).toBe(p);
		}
	});

	it('never exceeds p', () => {
		for (const p of [0, 0.1, 0.5, 0.9, 1]) {
			for (const weight of [1, 5, 50]) expect(lowerBound(p, weight)).toBeLessThanOrEqual(p);
		}
	});

	it('grows with the weight at the same p', () => {
		for (const p of [0.1, 0.5, 0.9]) {
			const bounds = [1, 2, 5, 10, 50, 200, 1000].map((w) => lowerBound(p, w));
			for (let i = 1; i < bounds.length; i++) {
				expect(bounds[i]).toBeGreaterThan(bounds[i - 1] ?? Infinity);
			}
		}
	});

	it('returns 0 for a weight that is zero, negative, NaN or infinite', () => {
		for (const weight of [0, -3, NaN, Infinity]) expect(lowerBound(0.5, weight)).toBe(0);
	});
});

describe('shouldAct', () => {
	it('agrees with the break-even rule when only the transfer terms are set', () => {
		for (const p of [0, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1]) {
			for (const entryBytes of [100, 1000, 5000]) {
				for (const documentBytes of [1000, 17054, 100000]) {
					const input = {
						p,
						weight: 1,
						avoided: JOULES_PER_BYTE * documentBytes + ORIGIN_JOULES,
						provision: JOULES_PER_BYTE * entryBytes
					};
					expect(shouldAct(input, 0)).toBe(p > entryBreakEven(entryBytes, documentBytes));
				}
			}
		}
	});

	it('refuses a candidate at exactly its break-even', () => {
		const input = {
			p: entryBreakEven(1000, 17054),
			weight: 1,
			avoided: JOULES_PER_BYTE * 17054 + ORIGIN_JOULES,
			provision: JOULES_PER_BYTE * 1000
		};
		expect(shouldAct(input, 0)).toBe(false);
	});

	it('lets each extra cost flip a positive net negative', () => {
		const base = { p: 0.9, weight: 1000, avoided: 1, provision: 0.1 };
		expect(shouldAct(base)).toBe(true);
		expect(shouldAct({ ...base, render: 1 })).toBe(false);
		expect(shouldAct({ ...base, maintain: 1 })).toBe(false);
		expect(shouldAct({ ...base, model: 1 })).toBe(false);
	});

	it('subtracts every cost term from the avoided joules', () => {
		const base = { p: 0.9, weight: 1000, avoided: 1, provision: 0.1 };
		expect(expectedNet({ ...base, render: 0.25, maintain: 0.25, model: 0.25 }, 0)).toBe(
			0.9 - 0.1 - 0.25 - 0.25 - 0.25
		);
	});
});
