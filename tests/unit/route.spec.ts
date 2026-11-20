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

	it('defaults a principal route to persistent retention, keeps a declared session, and leaves a public one without', () => {
		const mine = defineRoute('/a', { strategy: 'data', scope: 'principal', load: () => ({}) });
		expect(serializeRoute(mine).retention).toBe('persistent');
		const shared = defineRoute('/b', {
			strategy: 'data',
			scope: 'principal',
			retention: 'session',
			load: () => ({})
		});
		expect(serializeRoute(shared).retention).toBe('session');
		const kept = defineRoute('/d', {
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
		['a principal route', { scope: 'principal', query }, /only with query\.dataset/],
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

describe('defineRoute family', () => {
	const family = { dataset: 'courses', key: 'id' };
	const page = (extra: Record<string, unknown> = {}) =>
		({
			strategy: 'template',
			template: { source: '<h1>{{row.title}}</h1>' },
			family,
			...extra
		}) as RouteDeclaration;

	it('takes a template route with no load and keeps the binding on the route and its serialized form', () => {
		const route = defineRoute('/courses/:id', page());
		expect(route.family).toEqual(family);
		expect(serializeRoute(route).family).toEqual(family);
		expect(serializeRoute(route)).not.toHaveProperty('load');
	});

	it('takes a projection route with a family and a query on the same dataset', () => {
		const route = defineRoute(
			'/courses/:id',
			page({
				strategy: 'projection',
				template: undefined,
				query: { list: 'items', dataset: 'courses' }
			})
		);
		expect(route.family).toEqual(family);
		expect(route.query).toEqual({ list: 'items', dataset: 'courses' });
	});

	it('leaves the family out of a route that has none', () => {
		expect(serializeRoute(defineRoute('/a', template())).family).toBeUndefined();
	});

	it.each([
		[
			'a static route',
			{ strategy: 'static', template: undefined },
			/a static route cannot declare family/
		],
		[
			'a non-string dataset',
			{ family: { dataset: 3, key: 'id' } },
			/family.dataset must be a dataset name/
		],
		[
			'a dataset with a space',
			{ family: { dataset: 'two words', key: 'id' } },
			/family.dataset/
		],
		[
			'an empty key',
			{ family: { dataset: 'courses', key: '' } },
			/family.key must be a param name/
		],
		[
			'a key that is not a param',
			{ family: { dataset: 'courses', key: 'slug' } },
			/"slug" is not a param/
		],
		[
			'the viewer key',
			{ pattern: '/account', family: { dataset: 'courses', key: 'viewer.id' } },
			/viewer.id/
		],
		[
			'a query on another dataset',
			{ query: { list: 'items', dataset: 'people' } },
			/must name the same dataset/
		],
		[
			'a query over the route itself',
			{ query: { list: 'items' } },
			/must name the same dataset/
		]
	])('refuses %s', (_name, override, message) => {
		const pattern = (override as { pattern?: string }).pattern ?? '/courses/:id';
		const declaration = page(override as Record<string, unknown>);
		expect(() => defineRoute(pattern, declaration)).toThrow(message);
		expect(() => defineRoute(pattern, declaration)).toThrow(ProtocolError);
	});

	it('still requires a load on a template route with no family', () => {
		expect(() => defineRoute('/a', page({ family: undefined }))).toThrow(/load is required/);
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

describe('defineRoute origin', () => {
	const family = { dataset: 'courses', key: 'id' };
	const data = (extra: Record<string, unknown> = {}) =>
		({ strategy: 'data', origin: 'https://api.example', family, ...extra }) as RouteDeclaration;

	it('takes a cross-origin item family with no load and keeps the origin on the serialized form', () => {
		const route = defineRoute('/v2/courses/:id', data());
		expect(route.origin).toBe('https://api.example');
		expect(serializeRoute(route).origin).toBe('https://api.example');
	});

	it('takes a cross-origin collection over a dataset with no load', () => {
		const route = defineRoute('/v2/courses', {
			strategy: 'data',
			origin: 'https://api.example',
			query: { list: 'courses', dataset: 'courses' }
		} as RouteDeclaration);
		expect(route.origin).toBe('https://api.example');
		expect(route.family).toBeUndefined();
	});

	it('leaves origin out of a route that has none', () => {
		const route = defineRoute('/v2/courses/:id', data({ origin: undefined }));
		expect(route.origin).toBeUndefined();
		expect(serializeRoute(route)).not.toHaveProperty('origin');
	});

	it('refuses an origin that is not an http or https origin with no path', () => {
		const origins = [
			'api.example',
			'ftp://api.example',
			'https://api.example/v2',
			'https://a.b/'
		];
		for (const origin of origins) {
			expect(() => defineRoute('/v2/courses/:id', data({ origin }))).toThrow(/origin/);
		}
	});

	it('refuses an origin on a route that is not a data route', () => {
		expect(() =>
			defineRoute('/courses/:id', {
				...data(),
				strategy: 'template',
				template: { source: 'x' }
			} as RouteDeclaration)
		).toThrow(/only a data route/);
	});

	it('refuses an origin with neither a family nor a query over a dataset', () => {
		expect(() =>
			defineRoute('/v2/courses', {
				strategy: 'data',
				origin: 'https://api.example',
				load: () => ({})
			})
		).toThrow(/needs a family or a query/);
	});

	it('takes a principal cross-origin family, by scope or by auth, and serializes both fields', () => {
		for (const declared of [{ scope: 'principal' }, { auth: 'principal' }]) {
			const route = defineRoute('/v2/courses/:id', data(declared));
			expect(route.scope).toBe('principal');
			expect(route.origin).toBe('https://api.example');
			expect(route.retention).toBe('persistent');
			expect(serializeRoute(route)).toMatchObject({
				scope: 'principal',
				origin: 'https://api.example',
				family
			});
		}
	});

	it('takes a principal cross-origin collection over a dataset with no load', () => {
		const route = defineRoute('/v2/courses', {
			strategy: 'data',
			scope: 'principal',
			origin: 'https://api.example',
			query: { list: 'courses', dataset: 'courses' }
		} as RouteDeclaration);
		expect(serializeRoute(route)).toMatchObject({
			scope: 'principal',
			origin: 'https://api.example'
		});
		expect(route.family).toBeUndefined();
	});

	it('still refuses a principal origin on a route that is not a data route or has no family or query', () => {
		expect(() =>
			defineRoute('/courses/:id', {
				...data({ scope: 'principal' }),
				strategy: 'template',
				template: { source: 'x' }
			} as RouteDeclaration)
		).toThrow(/only a data route/);
		expect(() =>
			defineRoute('/v2/courses', {
				strategy: 'data',
				scope: 'principal',
				origin: 'https://api.example',
				load: () => ({})
			} as RouteDeclaration)
		).toThrow(/needs a family or a query/);
		expect(() =>
			defineRoute('/v2/courses/:id', data({ scope: 'principal', origin: 'api.example' }))
		).toThrow(/origin/);
	});

	it('refuses a viewer-keyed family on a cross-origin route, since the worker holds no artifact for it', () => {
		const viewer = { dataset: 'courses', key: 'viewer.id' };
		expect(() => defineRoute('/v2/me', data({ scope: 'principal', family: viewer }))).toThrow(
			/viewer\.id/
		);
	});

	it('takes a same-origin data family with no load, and still requires a load for a plain collection', () => {
		expect(() => defineRoute('/api/courses/:id', { strategy: 'data', family })).not.toThrow();
		expect(() =>
			defineRoute('/api/courses', {
				strategy: 'data',
				query: { list: 'a', dataset: 'courses' }
			} as RouteDeclaration)
		).toThrow(/load is required/);
	});
});

describe('defineRoute auth', () => {
	it('takes auth principal as the principal scope', () => {
		const route = defineRoute('/people/:id', { ...template(), auth: 'principal' } as never);
		expect(route.scope).toBe('principal');
		expect(route.retention).toBe('persistent');
	});

	it('takes a principal family on the viewer key, and serializes it with its scope', () => {
		const route = defineRoute('/account', {
			...template(),
			auth: 'principal',
			family: { dataset: 'people', key: 'viewer.id' }
		} as never);
		expect(route.family).toEqual({ dataset: 'people', key: 'viewer.id' });
		expect(serializeRoute(route)).toMatchObject({
			scope: 'principal',
			family: { dataset: 'people', key: 'viewer.id' }
		});
	});

	it.each([
		['an auth other than principal', { auth: 'session' }, /unknown auth "session"/],
		[
			'auth principal beside scope public',
			{ auth: 'principal', scope: 'public' },
			/needs a principal scope/
		],
		[
			'the viewer key without auth principal',
			{ family: { dataset: 'people', key: 'viewer.id' } },
			/needs auth: 'principal'/
		]
	])('refuses %s', (_name, override, message) => {
		expect(() => defineRoute('/account', { ...template(), ...override } as never)).toThrow(
			message
		);
	});
});
