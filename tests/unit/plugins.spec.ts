import { describe, expect, it } from 'vitest';
import { registerMode, type Register, type RenderMode } from '../../src/plugins/mode';
import { toSpoolPattern, type Conversion, type PathSyntax } from '../../src/plugins/path';
import { formatDevReport } from '../../src/plugins/report';
import { routesFromPages, type PageLike } from '../../src/plugins/routes';
import { checkPattern } from '../../src/protocol/pattern';

const CATCH_ALL = 'catch-all segment: ** captures no value';

const ROWS: Array<[PathSyntax, string, Conversion]> = [
	['vue-router', '/', { kind: 'pattern', pattern: '/' }],
	['vue-router', '/about', { kind: 'pattern', pattern: '/about' }],
	['vue-router', '/articles/:id', { kind: 'pattern', pattern: '/articles/:id' }],
	['vue-router', '/a/:id/b/:sub', { kind: 'pattern', pattern: '/a/:id/b/:sub' }],
	[
		'vue-router',
		'/a/:id?',
		{ kind: 'network', reason: 'optional segment: spool has no optional segment' }
	],
	[
		'vue-router',
		'/a/:id+',
		{ kind: 'network', reason: 'repeatable segment: spool has no repeatable segment' }
	],
	[
		'vue-router',
		'/a/:id(\\d+)',
		{ kind: 'network', reason: 'custom regular expression in a segment' }
	],
	['vue-router', '/docs/:slug(.*)*', { kind: 'network', reason: CATCH_ALL }],
	['vue-router', '/a/:id/:id', { kind: 'network', reason: 'duplicate parameter name' }],
	['vue-router', '/a/:b-c', { kind: 'network', reason: 'parameter name is not an identifier' }],
	['vue-router', 'articles', { kind: 'network', reason: 'path must start with /' }],
	['nuxt', '/articles/:id()', { kind: 'pattern', pattern: '/articles/:id' }],
	['nuxt', '/c/:id()/:sub()', { kind: 'pattern', pattern: '/c/:id/:sub' }],
	[
		'nuxt',
		'/nested/:id?',
		{ kind: 'network', reason: 'optional segment: spool has no optional segment' }
	],
	['nuxt', '/docs/:slug(.*)*', { kind: 'network', reason: CATCH_ALL }],
	['nuxt', '/docs/:slug([^/]*)*/edit', { kind: 'network', reason: CATCH_ALL }],
	['nuxt', '/x/:rest([^/]*)*', { kind: 'network', reason: CATCH_ALL }],
	['react-router', '/products/:id', { kind: 'pattern', pattern: '/products/:id' }],
	[
		'react-router',
		'/products/:id?',
		{ kind: 'network', reason: 'optional segment: spool has no optional segment' }
	],
	['react-router', '/docs/*', { kind: 'network', reason: 'splat segment: * captures no value' }],
	[
		'react-router',
		'/files/:name.json',
		{ kind: 'network', reason: 'parameter is not a whole identifier segment' }
	],
	['react-router', '/a/(:lang)/b', { kind: 'network', reason: 'grouped segment' }],
	['next', '/blog/[slug]/page', { kind: 'pattern', pattern: '/blog/:slug' }],
	['next', '/blog/[slug]', { kind: 'pattern', pattern: '/blog/:slug' }],
	['next', '/(marketing)/about/page', { kind: 'pattern', pattern: '/about' }],
	['next', '/@modal/photo/[id]/page', { kind: 'pattern', pattern: '/photo/:id' }],
	['next', '/page', { kind: 'pattern', pattern: '/' }],
	['next', '/docs/[...slug]/page', { kind: 'network', reason: CATCH_ALL }],
	['next', '/docs/[[...slug]]', { kind: 'network', reason: CATCH_ALL }],
	[
		'next',
		'/photo/(.)modal/[id]',
		{ kind: 'network', reason: 'interception segment: (.) and (..) match another route' }
	],
	['angular', '', { kind: 'pattern', pattern: '/' }],
	['angular', 'articles/:id', { kind: 'pattern', pattern: '/articles/:id' }],
	['angular', '/articles/:id', { kind: 'pattern', pattern: '/articles/:id' }],
	['angular', '/a/**', { kind: 'network', reason: 'wildcard route: ** captures no value' }],
	['angular', '/a/:id/:id', { kind: 'network', reason: 'duplicate parameter name' }]
];

describe('toSpoolPattern', () => {
	it.each(ROWS)('%s %j converts as declared', (syntax, path, expected) => {
		expect(toSpoolPattern(syntax, path)).toEqual(expected);
	});

	it.each(ROWS.filter(([, , out]) => out.kind === 'pattern'))(
		'%s %j yields a pattern spool accepts',
		(syntax, path) => {
			const out = toSpoolPattern(syntax, path);
			if (out.kind !== 'pattern') throw new Error('expected a pattern');
			expect(() => checkPattern(out.pattern)).not.toThrow();
		}
	);
});

describe('registerMode', () => {
	const cases: Array<[string, RenderMode, unknown]> = [
		[
			'prerendered with enumerable params',
			{ rendering: 'prerender', enumerable: true },
			{ register: 'family', reason: 'prerendered with enumerable params' }
		],
		[
			'prerendered without enumerable params',
			{ rendering: 'prerender', enumerable: false },
			{ register: 'network', reason: 'prerendered without enumerable params' }
		],
		[
			'server-rendered with a dataset',
			{ rendering: 'server', enumerable: true },
			{ register: 'family', reason: 'server-rendered with enumerable params' }
		],
		[
			'server-rendered with no enumerable params',
			{ rendering: 'server', enumerable: false },
			{ register: 'network', reason: 'server-rendered without enumerable params' }
		],
		[
			'revalidating page keeps the family and sets maxAge',
			{ rendering: 'server', enumerable: true, revalidate: 300 },
			{ register: 'family', maxAge: 300, reason: 'server-rendered with enumerable params' }
		],
		[
			'client-only is the shell',
			{ rendering: 'client', enumerable: false },
			{ register: 'shell', reason: 'client-only: app shell plus data routes' }
		],
		[
			'streaming stays on the network',
			{ rendering: 'streaming', enumerable: true },
			{
				register: 'network',
				reason: 'streaming or server components: payload not captured per param'
			}
		]
	];

	it.each(cases)('%s', (_name, mode, expected) => {
		expect(registerMode(mode)).toEqual(expected);
	});
});

describe('routesFromPages', () => {
	const page = (path: string, pattern?: string, register: Register = 'family'): PageLike => ({
		path,
		...(pattern === undefined ? {} : { pattern }),
		register,
		reason: pattern === undefined ? 'rejected' : 'registered'
	});
	const pages = [
		page('/', '/'),
		page('/articles/[id]', '/articles/:id', 'network'),
		page('/docs/[...slug]'),
		page('/about', '/about')
	];
	const shell = (source: string) =>
		({
			strategy: 'template',
			template: { source },
			scope: 'public',
			load: () => ({})
		}) as const;

	it('makes a route for each declared pattern, in the framework order', () => {
		const { routes, uncovered } = routesFromPages(pages, {
			'/about': shell('<h1>About</h1>'),
			'/articles/:id': shell('<h1>{{row.title}}</h1>')
		});
		expect(routes.map((route) => route.pattern)).toEqual(['/articles/:id', '/about']);
		expect(uncovered).toEqual([
			{ path: '/', pattern: '/', register: 'family', reason: 'registered' }
		]);
	});

	it('reports a registered pattern with no declaration, and never holds it', () => {
		const { routes, uncovered } = routesFromPages(pages, {});
		expect(routes).toEqual([]);
		expect(uncovered.map((entry) => [entry.path, entry.register])).toEqual([
			['/', 'family'],
			['/articles/[id]', 'network'],
			['/about', 'family']
		]);
	});

	it('does not list a page whose path did not convert, and cannot declare it', () => {
		expect(routesFromPages(pages, {}).uncovered.map((entry) => entry.path)).not.toContain(
			'/docs/[...slug]'
		);
		expect(() => routesFromPages(pages, { '/docs/:slug': shell('<p>{{slug}}</p>') })).toThrow(
			'/docs/:slug: the framework registered no such route'
		);
	});

	it('throws for a declaration the framework did not register, naming every one', () => {
		expect(() =>
			routesFromPages(pages, {
				'/aboot': shell('<h1>About</h1>'),
				'/articles/:slug': shell('<h1>{{row.title}}</h1>')
			})
		).toThrow('/aboot, /articles/:slug: the framework registered no such route');
	});

	it('lists the registered patterns in the error so a typo is easy to see', () => {
		expect(() => routesFromPages(pages, { '/aboot': shell('<h1>About</h1>') })).toThrow(
			'(registered: /, /articles/:id, /about)'
		);
		expect(() => routesFromPages([], { '/x': shell('<h1>x</h1>') })).toThrow(
			'(registered: none)'
		);
	});

	it('makes one route for a pattern the framework lists twice', () => {
		const twice = [page('/a', '/a'), page('/a/', '/a')];
		const { routes } = routesFromPages(twice, { '/a': shell('<h1>a</h1>') });
		expect(routes).toHaveLength(1);
	});

	it('refuses a declaration that reads a dataset without a declared scope', () => {
		const family = {
			strategy: 'template',
			template: { source: '<h1>{{row.title}}</h1>' },
			family: { dataset: 'articles', key: 'id' }
		} as const;
		expect(() => routesFromPages(pages, { '/articles/:id': family })).toThrow(
			'/articles/:id: a route that reads a dataset must declare its scope'
		);
		expect(() =>
			routesFromPages(pages, { '/articles/:id': { ...family, scope: 'public' } })
		).not.toThrow();
		expect(() =>
			routesFromPages(pages, { '/articles/:id': { ...family, auth: 'principal' } })
		).not.toThrow();
		const query = {
			strategy: 'template',
			template: { source: '<ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>' },
			query: { list: 'items', dataset: 'articles' },
			load: () => ({})
		} as const;
		expect(() => routesFromPages(pages, { '/about': query })).toThrow(
			'/about: a route that reads a dataset must declare its scope'
		);
	});

	it('leaves a route that reads no dataset on the default scope', () => {
		const { routes } = routesFromPages(pages, {
			'/about': { strategy: 'static', depends: () => [] }
		});
		expect(routes.map((route) => route.scope)).toEqual(['public']);
	});

	it('throws the typed error the rest of the protocol uses', () => {
		expect(() => routesFromPages(pages, { '/nope': shell('<h1>x</h1>') })).toThrow(
			expect.objectContaining({ code: 'bad-route' })
		);
	});
});

describe('formatDevReport', () => {
	it('prints no count of uncovered GETs when the report has none to give', () => {
		expect(
			formatDevReport({
				registered: [{ pattern: '/', register: 'family' }],
				network: []
			})
		).toBe(
			['spool: 1 registered, 0 left to the network', '  registered  /  family'].join('\n')
		);
	});

	it('prints the counts, then each registered route, network page and uncovered GET', () => {
		const text = formatDevReport({
			registered: [
				{ pattern: '/articles/:id', register: 'family', maxAge: 300 },
				{ pattern: '/about', register: 'shell' }
			],
			network: [{ path: '/docs/:slug(.*)*', reason: CATCH_ALL }],
			uncovered: ['/v2/articles']
		});
		expect(text).toBe(
			[
				'spool: 2 registered, 1 left to the network, 1 uncovered GET',
				'  registered  /articles/:id  family  maxAge 300s',
				'  registered  /about  shell',
				`  network     /docs/:slug(.*)*  ${CATCH_ALL}`,
				'  uncovered   GET /v2/articles'
			].join('\n')
		);
	});
});
