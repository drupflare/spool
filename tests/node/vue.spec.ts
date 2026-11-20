import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpool, memoryBundleStore, routesFromPages } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { spoolVue, vuePages, type SpoolVueOptions, type VueRouter } from '../../src/vue/index';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const SHELL = 'client-only: app shell plus data routes';

/** a router with a static, a dynamic, an optional and a catch-all route, as vue-router lists them */
const router: VueRouter = {
	getRoutes: () => [
		{ path: '/' },
		{ path: '/about' },
		{ path: '/articles/:id' },
		{ path: '/:opt?' },
		{ path: '/docs/:slug(.*)*' }
	]
};

function setup() {
	const spool = createSpool({ routes: [], store: memoryStore() });
	const plugin = spoolVue({ spool, router });
	const uses: unknown[] = [];
	const server = {
		middlewares: { use: (handler: unknown) => uses.push(handler) }
	} as unknown as ViteDevServer;
	(plugin.configureServer as (server: ViteDevServer) => void)(server);
	const transform = plugin.transformIndexHtml as (html: string) => string;
	return { spool, plugin, uses, transform };
}

describe('vuePages', () => {
	it('registers every convertible route as the app shell and leaves the rest on the network', () => {
		expect(vuePages(router)).toEqual([
			{ path: '/', pattern: '/', register: 'shell', reason: SHELL },
			{ path: '/about', pattern: '/about', register: 'shell', reason: SHELL },
			{ path: '/articles/:id', pattern: '/articles/:id', register: 'shell', reason: SHELL },
			{
				path: '/:opt?',
				register: 'network',
				reason: 'optional segment: spool has no optional segment'
			},
			{
				path: '/docs/:slug(.*)*',
				register: 'network',
				reason: 'catch-all segment: ** captures no value'
			}
		]);
	});

	it('gives the registered patterns exactly the convertible paths', () => {
		const pages = vuePages(router);
		expect(pages.flatMap((page) => (page.pattern ? [page.pattern] : []))).toEqual([
			'/',
			'/about',
			'/articles/:id'
		]);
	});
});

describe('vuePages through routesFromPages', () => {
	it('turns the registered patterns into exactly their routes, and reports the one left out', () => {
		const pages = vuePages(router);
		const patterns = ['/', '/about', '/articles/:id'];
		const declare = (list: string[]) =>
			Object.fromEntries(
				list.map((pattern) => [pattern, { strategy: 'static', depends: () => [] } as const])
			);
		const all = routesFromPages(pages, declare(patterns));
		expect(all.routes.map((route) => route.pattern)).toEqual(patterns);
		expect(all.uncovered).toEqual([]);
		const less = routesFromPages(pages, declare(['/', '/about']));
		expect(less.uncovered.map((page) => page.pattern)).toEqual(['/articles/:id']);
		expect(() => routesFromPages(pages, declare(['/:opt']))).toThrow('/:opt: the framework');
	});
});

describe('spoolVue', () => {
	it('keeps the spoolVite hooks', () => {
		const { plugin, uses } = setup();
		expect(plugin.name).toBe('@drupflare/spool/vue');
		expect(uses).toHaveLength(2);
	});

	it('injects the registration tag once', () => {
		const { spool, transform } = setup();
		const once = transform('<html><head></head><body></body></html>');
		expect(once).toContain(spool.config.clientTag);
		expect(transform(once)).toBe(once);
	});

	it('logs the development report once the config is resolved', () => {
		const { plugin } = setup();
		const info = vi.fn();
		(plugin.configResolved as (config: unknown) => void)({
			command: 'serve',
			logger: { info }
		});
		expect(info).toHaveBeenCalledOnce();
		expect(info.mock.calls[0]?.[0]).toBe(
			[
				'spool: 3 registered, 2 left to the network, 0 uncovered GET',
				'  registered  /  shell',
				'  registered  /about  shell',
				'  registered  /articles/:id  shell',
				'  network     /:opt?  optional segment: spool has no optional segment',
				'  network     /docs/:slug(.*)*  catch-all segment: ** captures no value'
			].join('\n')
		);
	});

	describe('in a client build', () => {
		const buildWith = async (options: Partial<SpoolVueOptions> = {}) => {
			const root = await mkdtemp(join(tmpdir(), 'spool-vue-'));
			roots.push(root);
			await mkdir(join(root, 'dist'));
			const info = vi.fn();
			const plugin = spoolVue({
				spool: createSpool({
					routes: [],
					store: memoryStore(),
					bundles: memoryBundleStore()
				}),
				router,
				...options
			});
			(plugin.configResolved as (config: unknown) => void)({
				command: 'build',
				root,
				build: { outDir: 'dist', ssr: false },
				logger: { info }
			});
			await (plugin.closeBundle as (this: unknown) => Promise<void>).call({});
			return { dist: join(root, 'dist'), info };
		};

		it('publishes the static tier by default and prints no route report', async () => {
			const { dist, info } = await buildWith();
			expect(await readdir(dist)).toEqual(
				expect.arrayContaining(['spool-sw.js', '_headers'])
			);
			expect(info.mock.calls.map((call) => String(call[0]))).not.toContainEqual(
				expect.stringContaining('registered')
			);
		});

		it('writes nothing with static: false', async () => {
			const { dist } = await buildWith({ static: false });
			expect(await readdir(dist)).toEqual([]);
		});
	});
});
