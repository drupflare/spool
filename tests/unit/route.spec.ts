import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FRESHNESS,
	defineRoute,
	ProtocolError,
	serializeRoute,
	type RouteDeclaration
} from '../../src/protocol/index';

const template = (extra: Partial<RouteDeclaration> = {}): RouteDeclaration =>
	({
		strategy: 'template',
		template: { source: '<h1>{{title}}</h1>' },
		load: () => ({ title: 't' }),
		...extra
	}) as RouteDeclaration;

describe('defineRoute defaults', () => {
	it('gives a public route 15 minutes soft and offline serve', () => {
		const route = defineRoute('/a', template());
		expect(route.scope).toBe('public');
		expect(route.freshness).toEqual({ maxStale: 900, mode: 'soft' });
		expect(route.offline).toBe('serve');
		expect(route.persist).toBe(true);
		expect(route.depends({} as never)).toEqual([]);
	});

	it('gives a principal route 5 minutes hard and offline refuse', () => {
		const route = defineRoute('/a', template({ scope: 'principal' }));
		expect(route.freshness).toEqual({ maxStale: 300, mode: 'hard' });
		expect(route.offline).toBe('refuse');
		expect(DEFAULT_FRESHNESS.principal.maxStale).toBe(300);
	});

	it('lets a declaration override one field of the default and keeps the other', () => {
		const route = defineRoute('/a', template({ freshness: { mode: 'hard' }, persist: false }));
		expect(route.freshness).toEqual({ maxStale: 900, mode: 'hard' });
		expect(route.persist).toBe(false);
	});

	it('compiles the template of a template route', () => {
		const route = defineRoute('/a', template());
		expect(route.template?.nodes.length).toBeGreaterThan(0);
	});

	it('accepts projection and data routes, with a content type for data', () => {
		const projection = defineRoute('/p/:id', { strategy: 'projection', load: () => ({}) });
		expect(projection.strategy).toBe('projection');
		const data = defineRoute('/api/:id', {
			strategy: 'data',
			load: () => ({}),
			contentType: 'application/vnd.api+json'
		});
		expect(serializeRoute(data)).toMatchObject({
			strategy: 'data',
			type: 'application/vnd.api+json'
		});
		expect(serializeRoute(projection).type).toBeUndefined();
	});

	it('defaults a principal route to session retention and leaves a public one without', () => {
		const mine = defineRoute('/a', { strategy: 'data', scope: 'principal', load: () => ({}) });
		expect(serializeRoute(mine).retention).toBe('session');
		const kept = defineRoute('/b', {
			strategy: 'data',
			scope: 'principal',
			retention: 'persistent',
			load: () => ({})
		});
		expect(serializeRoute(kept).retention).toBe('persistent');
		expect(serializeRoute(defineRoute('/c', template())).retention).toBeUndefined();
	});

	it('accepts an assembly route', () => {
		const route = defineRoute('/a', { strategy: 'assembly', load: () => ({ shell: 's' }) });
		expect(route.strategy).toBe('assembly');
		expect(route.template).toBeUndefined();
	});
});

describe('defineRoute refusals', () => {
	const cases: Array<
		[string, string, Partial<RouteDeclaration> | Record<string, unknown>, RegExp]
	> = [
		['bad pattern', 'no-slash', {}, /must start with/],
		['unknown strategy', '/a', { strategy: 'graph' }, /unknown strategy/],
		['retention on a public route', '/a', { retention: 'session' }, /principal route/],
		[
			'unknown retention',
			'/a',
			{ scope: 'principal', retention: 'forever' },
			/unknown retention/
		],
		['unknown scope', '/a', { scope: 'world' }, /unknown scope/],
		['zero maxStale', '/a', { freshness: { maxStale: 0 } }, /maxStale/],
		['NaN maxStale', '/a', { freshness: { maxStale: Number.NaN } }, /maxStale/],
		['unknown mode', '/a', { freshness: { mode: 'lazy' } }, /unknown freshness mode/],
		['unknown offline', '/a', { offline: 'maybe' }, /unknown offline rule/],
		['no load', '/a', { load: undefined }, /load is required/],
		['no template', '/a', { template: undefined }, /needs a template/],
		['bad template', '/a', { template: { source: '{{#each x}}' } }, /unclosed/]
	];

	it.each(cases)('rejects %s', (_name, pattern, override, message) => {
		const declaration = template(override as Partial<RouteDeclaration>);
		expect(() => defineRoute(pattern, declaration)).toThrow(message);
		expect(() => defineRoute(pattern, declaration)).toThrow(ProtocolError);
	});
});

describe('defineRoute query', () => {
	const query = {
		list: 'people',
		filter: { department: 'string', age: 'number' },
		sort: ['name', 'age'],
		pageSize: 20
	};

	it.each(['template', 'projection', 'data'] as const)(
		'puts the schema of a public %s route in the serialized route, as a copy',
		(strategy) => {
			const declaration = (
				strategy === 'template'
					? template({ query } as never)
					: { strategy, load: () => ({}), query }
			) as RouteDeclaration;
			const route = defineRoute('/people', declaration);
			expect(route.query).toEqual(query);
			const serial = serializeRoute(route);
			expect(serial.query).toEqual(query);
			expect(JSON.parse(JSON.stringify(serial))).toEqual(serial);
			serial.query!.list = 'changed';
			expect(route.query?.list).toBe('people');
		}
	);

	it('takes a list alone, and leaves the key out of the serialized route when there is none', () => {
		const route = defineRoute('/people', template({ query: { list: 'rows' } } as never));
		expect(serializeRoute(route).query).toEqual({ list: 'rows' });
		expect(serializeRoute(defineRoute('/people', template())).query).toBeUndefined();
	});

	const cases: Array<[string, Record<string, unknown>, RegExp]> = [
		['a principal route', { scope: 'principal', query }, /public route/],
		[
			'an assembly route',
			{ strategy: 'assembly', load: () => ({ shell: 's' }), query },
			/cannot declare query/
		],
		['a static route', { strategy: 'static', load: undefined, query }, /cannot declare query/],
		['a query that is not an object', { query: 'people' }, /must be an object/],
		['a null query', { query: null }, /must be an object/],
		['an array query', { query: [] }, /must be an object/],
		['an unknown option', { query: { list: 'a', limit: 5 } }, /unknown query option "limit"/],
		['no list', { query: { filter: {} } }, /query\.list/],
		['an empty list', { query: { list: '' } }, /query\.list/],
		['a list that is not a string', { query: { list: 3 } }, /query\.list/],
		['the list named proof', { query: { list: 'proof' } }, /cannot be "proof"/],
		['the list named query', { query: { list: 'query' } }, /cannot be "query"/],
		[
			'a filter that is not an object',
			{ query: { list: 'a', filter: ['x'] } },
			/query\.filter/
		],
		['a null filter', { query: { list: 'a', filter: null } }, /query\.filter/],
		[
			'a filter named sort',
			{ query: { list: 'a', filter: { sort: 'string' } } },
			/cannot name "sort"/
		],
		[
			'a filter named page',
			{ query: { list: 'a', filter: { page: 'number' } } },
			/cannot name "page"/
		],
		[
			'a filter with an empty name',
			{ query: { list: 'a', filter: { '': 'string' } } },
			/cannot name ""/
		],
		[
			'a filter of another type',
			{ query: { list: 'a', filter: { d: 'date' } } },
			/"string" or "number"/
		],
		['a sort that is not a list', { query: { list: 'a', sort: 'name' } }, /query\.sort/],
		['a sort field named page', { query: { list: 'a', sort: ['page'] } }, /cannot name "page"/],
		['a sort field named sort', { query: { list: 'a', sort: ['sort'] } }, /cannot name "sort"/],
		['an empty sort field', { query: { list: 'a', sort: [''] } }, /cannot name ""/],
		['a sort field that is not a string', { query: { list: 'a', sort: [3] } }, /cannot name 3/],
		['a zero pageSize', { query: { list: 'a', pageSize: 0 } }, /positive integer/],
		['a fractional pageSize', { query: { list: 'a', pageSize: 1.5 } }, /positive integer/],
		['a text pageSize', { query: { list: 'a', pageSize: '5' } }, /positive integer/]
	];

	it.each(cases)('rejects %s', (_name, override, message) => {
		const declaration = template(override as Partial<RouteDeclaration>);
		expect(() => defineRoute('/people', declaration)).toThrow(message);
		expect(() => defineRoute('/people', declaration)).toThrow(ProtocolError);
	});
});

describe('serializeRoute', () => {
	it('keeps the data a service worker needs and drops functions and the template', () => {
		const route = defineRoute('/a/:id', template({ freshness: { maxStale: 5, mode: 'hard' } }));
		const serial = serializeRoute(route);
		expect(serial).toEqual({
			pattern: '/a/:id',
			strategy: 'template',
			scope: 'public',
			freshness: { maxStale: 5, mode: 'hard' },
			persist: true,
			offline: 'serve',
			sync: 'background'
		});
		expect(JSON.parse(JSON.stringify(serial))).toEqual(serial);
		serial.freshness.maxStale = 99;
		expect(route.freshness.maxStale).toBe(5);
	});
});
