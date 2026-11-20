import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	flattenRoutes,
	reactRouterPages,
	spoolReactRouter,
	type RouteEntryInput,
	type SpoolReactRouterOptions
} from '../../src/react-router/index';
import {
	createSpool,
	memoryBundleStore,
	routesFromPages,
	type Spool
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// the route array of tests/fixtures/frameworks/react-router/app/routes.ts, as plain entries
const routes: RouteEntryInput[] = [
	{ index: true, file: 'routes/home.tsx' },
	{ path: 'about', file: 'routes/about.tsx' },
	{ path: 'articles/:id', file: 'routes/article.tsx' },
	{ path: 'docs/*', file: 'routes/docs.tsx' },
	{ path: 'opt/:id?', file: 'routes/opt.tsx' },
	{
		path: 'blog',
		file: 'routes/blog.tsx',
		children: [
			{ index: true, file: 'routes/blog-index.tsx' },
			{ path: ':slug', file: 'routes/blog-post.tsx' }
		]
	},
	{
		file: 'routes/layout.tsx',
		children: [{ path: 'news', file: 'routes/news.tsx' }]
	}
];

const summary = (entries: RouteEntryInput[], settings = {}) =>
	reactRouterPages(entries, settings).map((page) => [
		page.path,
		page.register,
		page.register === 'network' ? page.reason : page.pattern
	]);

describe('flattenRoutes', () => {
	it('joins nested paths, index routes take the parent path, layouts add none', () => {
		expect(flattenRoutes(routes)).toEqual([
			'/',
			'/about',
			'/articles/:id',
			'/docs/*',
			'/opt/:id?',
			'/blog',
			'/blog',
			'/blog/:slug',
			'/news'
		]);
	});

	it('keeps an absolute child path as written', () => {
		expect(flattenRoutes([{ path: 'a', children: [{ path: '/b' }] }])).toEqual(['/a', '/b']);
	});
});

describe('reactRouterPages', () => {
	it('registers the enumerable routes and leaves the dynamic ones on the network', () => {
		expect(summary(routes)).toEqual([
			['/', 'family', '/'],
			['/about', 'family', '/about'],
			[
				'/articles/:id',
				'network',
				'params not enumerable: declare a dataset family for /articles/:id'
			],
			['/docs/*', 'network', 'splat segment: * captures no value'],
			['/opt/:id?', 'network', 'optional segment: spool has no optional segment'],
			['/blog', 'family', '/blog'],
			[
				'/blog/:slug',
				'network',
				'params not enumerable: declare a dataset family for /blog/:slug'
			],
			['/news', 'family', '/news']
		]);
	});

	it('turns the registered patterns into exactly their routes, and reports the one left out', () => {
		const pages = reactRouterPages(routes);
		const patterns = ['/', '/about', '/articles/:id', '/blog', '/blog/:slug', '/news'];
		const declare = (list: string[]) =>
			Object.fromEntries(
				list.map((pattern) => [pattern, { strategy: 'static', depends: () => [] } as const])
			);
		const all = routesFromPages(pages, declare(patterns));
		expect(all.routes.map((route) => route.pattern)).toEqual(patterns);
		expect(all.uncovered).toEqual([]);
		const less = routesFromPages(pages, declare(patterns.slice(0, 5)));
		expect(less.uncovered.map((page) => page.pattern)).toEqual(['/news']);
		expect(() => routesFromPages(pages, declare(['/docs/:rest']))).toThrow(
			'/docs/:rest: the framework'
		);
	});

	it('registers every route as a client shell when ssr is off', () => {
		expect(summary([{ path: 'about' }, { path: 'articles/:id' }], { ssr: false })).toEqual([
			['/about', 'shell', '/about'],
			['/articles/:id', 'shell', '/articles/:id']
		]);
	});

	it('prerenders a static route only when the prerender list names it', () => {
		const entries = [{ path: 'about' }, { path: 'news' }];
		const modeOf = (settings: object) => reactRouterPages(entries, settings)[0]?.reason;
		expect(modeOf({ prerender: ['/about'] })).toBe('prerendered with enumerable params');
		expect(modeOf({ prerender: { paths: true, concurrency: 2 } })).toBe(
			'prerendered with enumerable params'
		);
		expect(modeOf({ prerender: ['/news'] })).toBe('server-rendered with enumerable params');
	});

	it('leaves every route on the network when the prerender paths are a function', () => {
		expect(summary([{ path: 'about' }], { prerender: () => ['/about'] })).toEqual([
			['/about', 'network', 'prerender function is not evaluated']
		]);
	});

	it('leaves every route on the network for the React Router 8 api-only ssr value', () => {
		expect(summary([{ path: 'about' }], { ssr: 'unstable_api-only' })).toEqual([
			['/about', 'network', 'ssr unstable_api-only is not mapped']
		]);
	});
});

describe('spoolReactRouter', () => {
	const fixtureRoot = fileURLToPath(
		new URL('../fixtures/frameworks/react-router/', import.meta.url)
	);

	it('returns the spool vite plugin and the dev report plugin, serve only', () => {
		const plugins = spoolReactRouter({ spool: {} as Spool });
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'@drupflare/spool',
			'@drupflare/spool/react-router:report'
		]);
		expect(plugins[1]?.apply).toBe('serve');
	});

	describe('in a build', () => {
		const buildWith = async (
			consumer: string,
			options: Partial<SpoolReactRouterOptions> = {}
		) => {
			const root = await mkdtemp(join(tmpdir(), 'spool-rr-'));
			roots.push(root);
			await mkdir(join(root, 'build', 'client'), { recursive: true });
			const spool = createSpool({
				routes: [],
				store: memoryStore(),
				bundles: memoryBundleStore()
			});
			const plugin = spoolReactRouter({ spool, ...options })[0]!;
			(plugin.configResolved as (config: unknown) => void)({
				command: 'build',
				root,
				build: { outDir: 'build/server', ssr: true },
				logger: { info: vi.fn() }
			});
			const environment = { config: { consumer, build: { outDir: 'build/client' } } };
			await (plugin.closeBundle as (this: unknown) => Promise<void>).call({ environment });
			return readdir(join(root, 'build', 'client'));
		};

		it('publishes into the client build directory by default', async () => {
			expect(await buildWith('client')).toEqual(
				expect.arrayContaining(['spool-sw.js', '_headers'])
			);
		});

		it('leaves the server build alone and honours static: false', async () => {
			expect(await buildWith('server')).toEqual([]);
			expect(await buildWith('client', { static: false })).toEqual([]);
		});
	});

	it('prints the registered routes and the network routes once the server starts', async () => {
		const info = vi.fn();
		const ssrLoadModule = vi.fn(async (file: string) =>
			file.endsWith('routes.ts') ? { default: routes } : { default: { ssr: true } }
		);
		const server = {
			config: { root: fixtureRoot, logger: { info, error: vi.fn() } },
			middlewares: { use: vi.fn() },
			ssrLoadModule
		};
		const report = spoolReactRouter({ spool: {} as Spool })[1];
		const hook = (report?.configureServer as (s: unknown) => () => void)(server);
		hook();
		await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
		expect(info.mock.calls[0]?.[0]).toContain(
			'spool: 4 registered, 4 left to the network, 0 uncovered GET'
		);
		expect(info.mock.calls[0]?.[0]).toContain(
			'network     /docs/*  splat segment: * captures no value'
		);
	});
});
