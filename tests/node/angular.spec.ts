import { afterEach, describe, expect, it, vi } from 'vitest';
import { spoolAngular } from '../../src/angular/index';
import { angularPages, type AngularRoute, type AngularServerRoute } from '../../src/angular/pages';
import { routesFromPages } from '../../src/server/index';

// the values of RenderMode in @angular/ssr
const SERVER = 0;
const CLIENT = 1;
const PRERENDER = 2;

const component = () => undefined;

const routes: AngularRoute[] = [
	{ path: '', component },
	{ path: 'about', component },
	{ path: 'shell', component },
	{ path: 'articles/:id', component },
	{ path: 'users/:id', component },
	{ path: 'docs/**', component },
	{
		path: 'blog',
		children: [
			{ path: '', component },
			{ path: ':slug', component }
		]
	},
	{ path: 'old', redirectTo: 'about' },
	{ path: 'admin', loadChildren: () => Promise.resolve([]) },
	{ path: 'custom', matcher: () => null, component },
	{ path: 'news', component }
];

const serverRoutes: AngularServerRoute[] = [
	{ path: '', renderMode: PRERENDER },
	{ path: 'about', renderMode: PRERENDER },
	{ path: 'shell', renderMode: CLIENT },
	{
		path: 'articles/:id',
		renderMode: PRERENDER,
		getPrerenderParams: () => Promise.resolve([{ id: '1' }])
	},
	{ path: 'users/:id', renderMode: SERVER },
	{ path: 'blog', renderMode: PRERENDER },
	{ path: 'blog/:slug', renderMode: SERVER },
	{ path: '**', renderMode: SERVER }
];

describe('angularPages', () => {
	it('registers the enumerable routes and leaves the rest on the network', () => {
		const pages = angularPages(routes, serverRoutes);
		expect(
			pages.filter((page) => page.register !== 'network').map((page) => page.pattern)
		).toEqual(['/', '/about', '/shell', '/articles/:id', '/blog', '/news']);
		expect(
			pages.filter((page) => page.register === 'network').map((page) => page.path)
		).toEqual(['/users/:id', '/docs/**', '/blog/:slug', '/old', '/admin', '/custom']);
	});

	it('turns the registered patterns into exactly their routes, and reports the one left out', () => {
		const pages = angularPages(routes, serverRoutes);
		const patterns = [
			'/',
			'/about',
			'/shell',
			'/articles/:id',
			'/users/:id',
			'/blog',
			'/blog/:slug',
			'/news'
		];
		const declare = (list: string[]) =>
			Object.fromEntries(
				list.map((pattern) => [pattern, { strategy: 'static', depends: () => [] } as const])
			);
		const all = routesFromPages(pages, declare(patterns));
		expect(all.routes.map((route) => route.pattern)).toEqual(patterns);
		expect(all.uncovered).toEqual([]);
		const less = routesFromPages(pages, declare(patterns.slice(1)));
		expect(less.uncovered.map((page) => page.pattern)).toEqual(['/']);
		expect(() => routesFromPages(pages, declare(['/docs/**']))).toThrow(
			'/docs/**: the framework'
		);
	});

	it('joins nested paths, reads an empty child as its parent, and adds no page for a layout', () => {
		const pages = angularPages(
			[
				{
					path: 'blog',
					children: [
						{ path: '', component },
						{ path: ':slug', component }
					]
				}
			],
			serverRoutes
		);
		expect(pages.map((page) => page.path)).toEqual(['/blog', '/blog/:slug']);
	});

	it('maps each render mode to its registration', () => {
		const pages = angularPages(routes, serverRoutes);
		const byPath = Object.fromEntries(pages.map((page) => [page.path, page]));
		expect(byPath['/shell']).toMatchObject({ register: 'shell' });
		expect(byPath['/about']).toMatchObject({ register: 'family' });
		expect(byPath['/articles/:id']).toMatchObject({
			register: 'family',
			reason: 'prerendered with enumerable params'
		});
		expect(byPath['/users/:id']).toMatchObject({
			register: 'network',
			reason: 'params not enumerable: declare a dataset family for /users/:id'
		});
	});

	it('leaves a prerendered route with params on the network when it has no enumerator', () => {
		const pages = angularPages(
			[{ path: 'tags/:tag', component }],
			[{ path: 'tags/:tag', renderMode: PRERENDER }]
		);
		expect(pages).toEqual([
			{
				path: '/tags/:tag',
				pattern: '/tags/:tag',
				register: 'network',
				reason: 'prerendered without enumerable params'
			}
		]);
	});

	it('answers a route with no exact server entry from the ** entry, and leaves it on the network without one', () => {
		expect(angularPages([{ path: 'news', component }], serverRoutes)[0]).toMatchObject({
			register: 'family'
		});
		expect(angularPages([{ path: 'news', component }], [])).toEqual([
			{
				path: '/news',
				pattern: '/news',
				register: 'network',
				reason: 'no server route declares a render mode'
			}
		]);
	});

	it('registers a route once when a parent and its empty child share a path', () => {
		const pages = angularPages(
			[{ path: '', component, children: [{ path: '', component }] }],
			serverRoutes
		);
		expect(pages.map((page) => page.path)).toEqual(['/']);
	});
});

describe('spoolAngular', () => {
	const env = process.env;

	afterEach(() => {
		process.env = env;
		vi.restoreAllMocks();
	});

	it('returns the registrations and prints the development report', () => {
		process.env = { ...env, NODE_ENV: 'development' };
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const pages = spoolAngular({ routes, serverRoutes });
		expect(pages).toEqual(angularPages(routes, serverRoutes));
		expect(info).toHaveBeenCalledTimes(1);
		const text = String(info.mock.calls[0]?.[0]);
		expect(text.split('\n')[0]).toBe('spool: 6 registered, 6 left to the network');
		expect(text).toContain('  network     /admin  lazy child routes are not enumerated');
	});

	it('prints nothing in production', () => {
		process.env = { ...env, NODE_ENV: 'production' };
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		spoolAngular({ routes, serverRoutes });
		expect(info).not.toHaveBeenCalled();
	});
});
