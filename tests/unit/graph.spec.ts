import { describe, expect, it } from 'vitest';
import {
	collectRefs,
	createCollector,
	isRef,
	parseArtifact,
	parseProjectionEntry,
	parseRecordEntry,
	projectionRef,
	ProtocolError,
	recordRef,
	renderAssembly,
	resolveRefs,
	type ProjectionEntry,
	type RecordEntry,
	type RefLookup
} from '../../src/protocol/index';

const expectCode = (fn: () => unknown, code: string) => {
	try {
		fn();
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe(code);
	}
};

const lookup = (records: RecordEntry[], projections: ProjectionEntry[] = []): RefLookup => ({
	record: (id) => records.find((r) => r.id === id),
	projection: (id) => projections.find((p) => p.id === id)
});
const rec = (id: string, data: unknown): RecordEntry => ({ id, version: 1, data });

describe('references', () => {
	it('builds and recognises exactly the two reference shapes', () => {
		expect(recordRef('a')).toEqual({ $record: 'a' });
		expect(projectionRef('p')).toEqual({ $projection: 'p' });
		expect(isRef({ $record: 'a' })).toBe(true);
		expect(isRef({ $projection: 'p' })).toBe(true);
		for (const value of [
			{ $record: 1 },
			{ $record: 'a', extra: 1 },
			{ other: 'a' },
			[],
			null,
			'a'
		]) {
			expect(isRef(value)).toBe(false);
		}
	});

	it('collects every id anywhere in a tree, sorted and unique', () => {
		const tree = {
			a: recordRef('b'),
			list: [
				recordRef('a'),
				{ deep: [projectionRef('z'), projectionRef('m'), recordRef('b')] }
			],
			text: 'x',
			n: 3
		};
		expect(collectRefs(tree)).toEqual({ records: ['a', 'b'], projections: ['m', 'z'] });
		expect(collectRefs('plain')).toEqual({ records: [], projections: [] });
	});
});

describe('resolveRefs', () => {
	const records = [rec('a', 'A'), rec('b', { n: 2 })];
	const projections: ProjectionEntry[] = [
		{ id: 'p', version: 1, deps: ['a'], data: [recordRef('a'), { x: recordRef('b') }] },
		{ id: 'q', version: 1, deps: ['a'], data: { inner: projectionRef('p') } }
	];

	it('replaces records with their data and projections with their resolved trees', () => {
		const result = resolveRefs(
			{ one: recordRef('a'), two: projectionRef('q'), keep: [1, 'x', null] },
			lookup(records, projections)
		);
		expect(result).toEqual({
			ok: true,
			value: { one: 'A', two: { inner: ['A', { x: { n: 2 } }] }, keep: [1, 'x', null] }
		});
	});

	it('refuses a record or a projection that is not stored, naming it', () => {
		expect(resolveRefs(recordRef('nope'), lookup(records))).toEqual({
			ok: false,
			reason: 'record nope is not stored'
		});
		expect(resolveRefs(projectionRef('nope'), lookup(records))).toEqual({
			ok: false,
			reason: 'projection nope is not stored'
		});
	});

	it('refuses a projection that reaches itself', () => {
		const loop: ProjectionEntry[] = [
			{ id: 'x', version: 1, deps: [], data: projectionRef('y') },
			{ id: 'y', version: 1, deps: [], data: projectionRef('x') }
		];
		expect(resolveRefs(projectionRef('x'), lookup([], loop))).toEqual({
			ok: false,
			reason: 'projection x reaches itself'
		});
	});

	it('does not resolve references inside a record', () => {
		const inner = [rec('a', recordRef('b'))];
		expect(resolveRefs(recordRef('a'), lookup(inner))).toEqual({
			ok: true,
			value: { $record: 'b' }
		});
	});
});

describe('createCollector', () => {
	it('returns references and collects records, projections and deps with the cursor', () => {
		const c = createCollector();
		const menu = c.projection('menu', [c.record('site', 'S'), c.record('course:1', 'C')]);
		const page = { title: c.record('course:1', 'C'), menu };
		expect(page).toEqual({
			title: { $record: 'course:1' },
			menu: { $projection: 'menu' }
		});
		c.projection('extra', ['x'], ['external:tag']);
		expect(c.collect(7)).toEqual({
			records: [
				{ id: 'course:1', version: 7, data: 'C' },
				{ id: 'site', version: 7, data: 'S' }
			],
			projections: [
				{ id: 'extra', version: 7, deps: ['external:tag'], data: ['x'] },
				{
					id: 'menu',
					version: 7,
					deps: ['course:1', 'site'],
					data: [{ $record: 'site' }, { $record: 'course:1' }]
				}
			],
			deps: ['course:1', 'external:tag', 'site']
		});
	});

	it('adds the dependencies of a nested projection to the one that references it', () => {
		const c = createCollector();
		c.projection('inner', [c.record('r', 1)]);
		c.projection('outer', { in: projectionRef('inner'), also: c.record('s', 2) });
		const { projections } = c.collect(1);
		expect(projections.map((p) => [p.id, p.deps])).toEqual([
			['inner', ['r']],
			['outer', ['r', 's']]
		]);
	});

	it('accepts an id twice with identical data and refuses different data', () => {
		const c = createCollector();
		c.record('r', { a: 1 });
		c.record('r', { a: 1 });
		c.projection('p', [c.record('r', { a: 1 })]);
		c.projection('p', [c.record('r', { a: 1 })]);
		expect(c.collect(1).records).toHaveLength(1);
		expectCode(() => c.record('r', { a: 2 }), 'bad-artifact');
		expectCode(() => c.projection('p', 'other'), 'bad-artifact');
	});

	it('refuses an empty id, data that is not JSON, an unregistered reference and a cycle', () => {
		const c = createCollector();
		expectCode(() => c.record('', 1), 'bad-artifact');
		expectCode(() => c.projection('', 1), 'bad-artifact');
		expectCode(() => c.record('u', undefined), 'bad-artifact');
		expectCode(() => c.projection('u', undefined), 'bad-artifact');

		const missingRecord = createCollector();
		missingRecord.projection('p', recordRef('ghost'));
		expectCode(() => missingRecord.collect(1), 'bad-artifact');

		const missingProjection = createCollector();
		missingProjection.projection('p', projectionRef('ghost'));
		expectCode(() => missingProjection.collect(1), 'bad-artifact');

		const cycle = createCollector();
		cycle.projection('x', projectionRef('y'));
		cycle.projection('y', projectionRef('x'));
		expectCode(() => cycle.collect(1), 'bad-artifact');
	});
});

describe('entries on the wire', () => {
	it('round-trips records and projections through an artifact', () => {
		const artifact = {
			protocol: 1,
			id: '/a',
			scope: 'public',
			deps: ['r'],
			vector: 4,
			strategy: 'template',
			body: { data: recordRef('r') },
			records: [{ id: 'r', version: 4, data: { k: 1 } }],
			projections: [{ id: 'p', version: 4, deps: ['r'], data: [recordRef('r')] }]
		};
		expect(parseArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
	});

	it('accepts a reference where an assembly fragment or slot goes and refuses other objects', () => {
		const base = {
			protocol: 1,
			id: '/a',
			scope: 'public',
			deps: [],
			vector: 0,
			strategy: 'assembly'
		};
		const ok = parseArtifact({
			...base,
			body: { shell: 's', fragments: { f: recordRef('r') }, slots: { s: projectionRef('p') } }
		});
		expect(ok.strategy === 'assembly' && ok.body.fragments).toEqual({ f: { $record: 'r' } });
		expectCode(
			() => parseArtifact({ ...base, body: { shell: 's', fragments: { f: { x: 1 } } } }),
			'bad-artifact'
		);
		expect(renderAssembly({ shell: 's', fragments: { f: recordRef('r') } })).toEqual({
			ok: false,
			reason: 'unresolved reference'
		});
	});

	it.each([
		['records not a list', { records: {} }],
		['a record that is not an object', { records: [1] }],
		['a record without an id', { records: [{ version: 1, data: 1 }] }],
		['a record without data', { records: [{ id: 'r', version: 1 }] }],
		['a record with a bad version', { records: [{ id: 'r', version: -1, data: 1 }] }],
		['a projection that is not an object', { projections: [null] }],
		['a projection without an id', { projections: [{ version: 1, deps: [], data: 1 }] }],
		[
			'a projection with bad deps',
			{ projections: [{ id: 'p', version: 1, deps: [1], data: 1 }] }
		],
		['a projection without data', { projections: [{ id: 'p', version: 1, deps: [] }] }]
	])('refuses %s', (_name, extra) => {
		expectCode(
			() =>
				parseArtifact({
					protocol: 1,
					id: '/a',
					scope: 'public',
					deps: [],
					vector: 0,
					strategy: 'template',
					body: { data: 1 },
					...extra
				}),
			'bad-artifact'
		);
	});

	it('parses entries directly', () => {
		expect(parseRecordEntry({ id: 'r', version: 0, data: null })).toEqual({
			id: 'r',
			version: 0,
			data: null
		});
		expect(parseProjectionEntry({ id: 'p', version: 2, deps: [], data: 1 }).version).toBe(2);
	});
});
