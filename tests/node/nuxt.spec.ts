import { logger, runWithNuxtContext } from '@nuxt/kit';
import type { H3Event } from 'h3';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import spoolNuxt, { type SpoolNuxtOptions } from '../../src/nuxt/index';
import { flattenPages, registerPage, type PageRegistration } from '../../src/nuxt/pages';
import { spoolPlugin } from '../../src/nuxt/runtime/index';
import { createSpool, routesFromPages } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

const FIXTURE = fileURLToPath(new URL('../fixtures/frameworks/nuxt', import.meta.url));
const CATCH_ALL = 'catch-all segment: ** captures no value';
const OPTIONAL = 'optional segment: spool has no optional segment';
const ARTICLES = 'params not enumerable: declare a dataset family for /articles/:id';

type Listener = (...args: unknown[]) => unknown;

/** the parts of a Nuxt instance the module reads, with the hooks it registers recorded */
function fakeNuxt(dev = true, buildDir = `${FIXTURE}/.nuxt`) {
	const listeners = new Map<string, Listener[]>();
	return {
		_version: '4.6.4',
		options: {
			rootDir: FIXTURE,
			buildDir,
			dev,
			alias: {},
			modulesDir: [],
			experimental: {},
			_requiredModules: {},
			_serverPlugins: [] as unknown[],
			serverHandlers: [] as unknown[],
			build: { templates: [] as Array<{ filename?: string; getContents?: () => string }> },
			nitro: { virtual: {} as Record<string, () => string> }
		},
		hook(name: string, listener: Listener) {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
		},
		async call(name: string, ...args: unknown[]) {
			for (const listener of listeners.get(name) ?? []) await listener(...args);
		},
		listeners
	};
}

async function install(options: Partial<SpoolNuxtOptions> = {}, dev = true, buildDir?: string) {
	const nuxt = fakeNuxt(dev, buildDir);
	await runWithNuxtContext(nuxt as never, () =>
		spoolNuxt({ spool: './server/spool.ts', ...options }, nuxt as never)
	);
	return nuxt;
}

/** the `#spool/pages` template, parsed back from the source the module emits */
function emittedPages(nuxt: ReturnType<typeof fakeNuxt>): PageRegistration[] {
	const source = nuxt.options.nitro.virtual['#spool/pages']?.() ?? '';
	return JSON.parse(source.replace(/^export const pages = /, '').replace(/;\n$/, ''));
}

const PAGES = [
	{ path: '/', file: 'index.vue' },
	{ path: '/about', file: 'about.vue' },
	{ path: '/articles/:id()', file: 'articles/[id].vue' },
	{ path: '/:opt?', file: '[[opt]].vue' },
	{ path: '/docs/:slug(.*)*', file: 'docs/[...slug].vue' },
	{ path: '/shell', mode: 'client', file: 'shell.vue' },
	{ path: '/blog', rules: { prerender: true }, file: 'blog.vue' },
	{ path: '/news', rules: { swr: 300 }, file: 'news.vue' }
];

describe('the spool option', () => {
	it('refuses a module with no spool entry', async () => {
		await expect(install({ spool: '' })).rejects.toThrow('the spool option is required');
	});

	it('resolves the entry against the project and emits it as #spool/entry', async () => {
		const nuxt = await install();
		const source = nuxt.options.nitro.virtual['#spool/entry']?.() ?? '';
		expect(source).toContain('tests/fixtures/frameworks/nuxt/server/spool.ts');
	});
});

describe('the module setup', () => {
	it('registers the page hook and the three virtual modules', async () => {
		const nuxt = await install();
		expect([...nuxt.listeners.keys()]).toEqual(['pages:resolved', 'nitro:build:public-assets']);
		expect(Object.keys(nuxt.options.nitro.virtual).sort()).toEqual([
			'#spool/entry',
			'#spool/handler',
			'#spool/pages'
		]);
	});

	it('serves the worker script and the spool paths from the handler', async () => {
		const nuxt = await install();
		expect(nuxt.options.serverHandlers).toEqual([
			expect.objectContaining({ route: '/spool-sw.js', handler: '#spool/handler' }),
			expect.objectContaining({ route: '/.spool/**', handler: '#spool/handler' }),
			expect.objectContaining({ route: '/.spool', handler: '#spool/handler' })
		]);
	});

	it('adds the Nitro plugin, written as a file, that decorates server-rendered pages', async () => {
		const nuxt = await install();
		expect(nuxt.options._serverPlugins).toEqual([
			expect.objectContaining({ plugin: expect.stringMatching(/spool\/plugin\.mjs$/) })
		]);
	});

	it('imports the entry and the runtime into the generated handler and plugin', async () => {
		const nuxt = await install();
		const handler = nuxt.options.nitro.virtual['#spool/handler']?.() ?? '';
		const plugin = nuxt.options.build.templates
			.find((template) => template.filename === 'spool/plugin.mjs')
			?.getContents?.();
		expect(handler).toContain("import spool from '#spool/entry'");
		expect(handler).toContain('export default spoolHandler(spool)');
		expect(plugin).toContain("import spool from '#spool/entry'");
		expect(plugin).toContain('export default spoolPlugin(spool)');
	});
});

describe('the page registrations', () => {
	it('registers each page by its render mode and leaves the rest on the network', async () => {
		const nuxt = await install();
		await nuxt.call('pages:resolved', PAGES);
		expect(emittedPages(nuxt)).toEqual([
			{
				path: '/',
				pattern: '/',
				register: 'family',
				reason: 'server-rendered with enumerable params'
			},
			{
				path: '/about',
				pattern: '/about',
				register: 'family',
				reason: 'server-rendered with enumerable params'
			},
			{
				path: '/articles/:id()',
				pattern: '/articles/:id',
				register: 'network',
				reason: ARTICLES
			},
			{ path: '/:opt?', register: 'network', reason: OPTIONAL },
			{ path: '/docs/:slug(.*)*', register: 'network', reason: CATCH_ALL },
			{
				path: '/shell',
				pattern: '/shell',
				register: 'shell',
				reason: 'client-only: app shell plus data routes'
			},
			{
				path: '/blog',
				pattern: '/blog',
				register: 'family',
				reason: 'prerendered with enumerable params'
			},
			{
				path: '/news',
				pattern: '/news',
				register: 'family',
				maxAge: 300,
				reason: 'server-rendered with enumerable params'
			}
		]);
	});

	it('registers only the enumerable pages; a dynamic page needs a params enumerator', async () => {
		const nuxt = await install();
		await nuxt.call('pages:resolved', PAGES);
		const registered = emittedPages(nuxt)
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect(registered).toEqual(['/', '/about', '/shell', '/blog', '/news']);
	});

	it('turns the registered patterns into exactly their routes, and reports the one left out', async () => {
		const nuxt = await install();
		await nuxt.call('pages:resolved', PAGES);
		const pages = emittedPages(nuxt);
		const patterns = ['/', '/about', '/articles/:id', '/shell', '/blog', '/news'];
		const declare = (list: string[]) =>
			Object.fromEntries(
				list.map((pattern) => [pattern, { strategy: 'static', depends: () => [] } as const])
			);
		const all = routesFromPages(pages, declare(patterns));
		expect(all.routes.map((route) => route.pattern)).toEqual(patterns);
		expect(all.uncovered).toEqual([]);
		const less = routesFromPages(pages, declare(patterns.slice(0, -1)));
		expect(less.routes).toHaveLength(patterns.length - 1);
		expect(less.uncovered.map((page) => page.pattern)).toEqual(['/news']);
		expect(() => routesFromPages(pages, declare(['/:opt']))).toThrow('/:opt: the framework');
	});

	it('prints the registered and network pages in development only', async () => {
		const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
		const dev = await install({}, true);
		await dev.call('pages:resolved', PAGES);
		expect(info).toHaveBeenCalledOnce();
		expect(String(info.mock.calls[0]?.[0])).toContain(
			'spool: 5 registered, 3 left to the network, 0 uncovered GET'
		);
		info.mockClear();
		const built = await install({}, false);
		await built.call('pages:resolved', PAGES);
		expect(info).not.toHaveBeenCalled();
		info.mockRestore();
	});
});

describe('registerPage and flattenPages', () => {
	it('gives a nested child its parent path and an index child the parent path', () => {
		const flat = flattenPages([{ path: '/docs', children: [{ path: 'intro' }, { path: '' }] }]);
		expect(flat.map((page) => page.path)).toEqual(['/docs', '/docs/intro', '/docs']);
	});

	it('keeps a nested child absolute when its path starts with a slash', () => {
		const flat = flattenPages([{ path: '/a', children: [{ path: '/b' }] }]);
		expect(flat.map((page) => page.path)).toEqual(['/a', '/b']);
	});

	it('reads the route rules that set a revalidate period', () => {
		expect(registerPage({ path: '/x', rules: { isr: 60 } })).toEqual({
			path: '/x',
			pattern: '/x',
			register: 'family',
			maxAge: 60,
			reason: 'server-rendered with enumerable params'
		});
	});
});

describe('the Nitro plugin', () => {
	const render = (
		spool: ReturnType<typeof createSpool>,
		path: string,
		response: { body: unknown; headers: Record<string, string>; statusCode: number }
	) => {
		const hooks = new Map<string, (...args: unknown[]) => Promise<void>>();
		spoolPlugin(spool)({
			hooks: { hook: (name: string, fn: never) => hooks.set(name, fn) }
		} as never);
		const event = {
			web: { request: new Request(`http://127.0.0.1${path}`) }
		} as unknown as H3Event;
		return hooks.get('render:response')?.(response, { event });
	};

	it('decorates a server-rendered page with the envelope and the tag, once', async () => {
		const spool = createSpool({ routes: [], store: memoryStore() });
		const response: Parameters<typeof render>[2] = {
			body: '<!doctype html><html><head></head><body>page</body></html>',
			headers: { 'content-type': 'text/html; charset=utf-8' },
			statusCode: 200
		};
		await render(spool, '/about', response);
		const body = String(response.body);
		expect(response.headers['spool-protocol']).toBe('1');
		expect(body.split(spool.config.clientTag)).toHaveLength(2);
		expect(body).toContain('<body>page</body>');
	});

	it('logs each fetch GET no family covers, once, outside production', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const spool = createSpool({ routes: [], store: memoryStore() });
		const hooks = new Map<string, (...args: unknown[]) => unknown>();
		spoolPlugin(spool)({
			hooks: { hook: (name: string, fn: never) => hooks.set(name, fn) }
		} as never);
		const seen = (path: string, dest: string) =>
			hooks.get('request')?.({
				web: {
					request: new Request(`http://127.0.0.1${path}`, {
						headers: { 'sec-fetch-dest': dest }
					})
				}
			});
		seen('/api/x', 'empty');
		seen('/api/x', 'empty');
		seen('/about', 'document');
		expect(info.mock.calls).toEqual([['spool: uncovered GET /api/x']]);
		info.mockRestore();
	});

	it('leaves a non-HTML body unchanged', async () => {
		const spool = createSpool({ routes: [], store: memoryStore() });
		const response = {
			body: '{"ok":true}',
			headers: { 'content-type': 'application/json' },
			statusCode: 200
		};
		await render(spool, '/api/x', response);
		expect(response.body).toBe('{"ok":true}');
	});
});

describe('the static tier at build time', () => {
	const SRC = fileURLToPath(new URL('../../src', import.meta.url));
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
		);
	});

	// the entry imports #spool/pages like a real one, and names a policy only when it got the pages
	const ENTRY = `import { pages } from '#spool/pages';
import { createSpool, memoryBundleStore } from '${SRC}/server/index.ts';
import { memoryStore } from '${SRC}/stores/index.ts';
export default createSpool({
	routes: [],
	store: memoryStore(),
	bundles: memoryBundleStore(),
	policy: { 'x-frame-options': pages.length > 0 ? 'DENY' : 'SAMEORIGIN' }
});
`;

	async function project(entry = ENTRY) {
		const root = await mkdtemp(join(tmpdir(), 'spool-nuxt-'));
		roots.push(root);
		const file = join(root, 'spool.ts');
		await writeFile(file, entry);
		await mkdir(join(root, 'public'));
		return { root, file, publicDir: join(root, 'public'), buildDir: join(root, '.nuxt') };
	}

	const publish = async (nuxt: ReturnType<typeof fakeNuxt>, publicDir: string): Promise<void> => {
		await nuxt.call('pages:resolved', PAGES);
		await nuxt.call('nitro:build:public-assets', { options: { output: { publicDir } } });
	};

	it('writes the stub, the runtime, a pack and the headers into the public directory', async () => {
		const { file, publicDir, buildDir } = await project();
		const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
		const nuxt = await install({ spool: file }, false, buildDir);
		await publish(nuxt, publicDir);
		expect(await readdir(publicDir)).toEqual(
			expect.arrayContaining(['spool-sw.js', '_headers', '.spool'])
		);
		expect(await readdir(join(publicDir, '.spool', 'bundle'))).toContain('0');
		expect(String(info.mock.calls[0]?.[0])).toMatch(/^spool: wrote \d+ static files to /);
		info.mockRestore();
	});

	it('loads the entry with #spool/pages resolved to the registered pages', async () => {
		const { file, publicDir, buildDir } = await project();
		const nuxt = await install({ spool: file }, false, buildDir);
		await publish(nuxt, publicDir);
		expect(await readFile(join(publicDir, 'spool-sw.js'), 'utf8')).toContain('"DENY"');
	});

	it('publishes nothing with static: false or in development', async () => {
		const { file, publicDir, buildDir } = await project();
		await publish(await install({ spool: file, static: false }, false, buildDir), publicDir);
		await publish(await install({ spool: file }, true, buildDir), publicDir);
		expect(await readdir(publicDir)).toEqual([]);
	});

	it('fails the build when the entry has no default Spool export', async () => {
		const { file, publicDir, buildDir } = await project('export default {};\n');
		const nuxt = await install({ spool: file }, false, buildDir);
		await expect(publish(nuxt, publicDir)).rejects.toThrow(
			'has no default export that is a Spool'
		);
	});

	it('takes an explicit static.policy over the policy of the entry', async () => {
		const { file, publicDir, buildDir } = await project();
		const nuxt = await install(
			{ spool: file, static: { policy: { 'referrer-policy': 'no-referrer' } } },
			false,
			buildDir
		);
		await publish(nuxt, publicDir);
		expect(await readFile(join(publicDir, 'spool-sw.js'), 'utf8')).toContain('no-referrer');
	});
});
