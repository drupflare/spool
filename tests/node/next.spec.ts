import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import adapter, {
	nextPages,
	SPOOL_PAGES_FILE,
	spoolRouteHandler,
	spoolTag
} from '../../src/next/index';
import { createSpool, memoryBundleStore, routesFromPages } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

// the app pages of tests/fixtures/frameworks/next, with the paths Next prerenders for them
const pages = [
	'/',
	'/about',
	'/(shop)/cart',
	'/articles/[id]',
	'/blog/[slug]',
	'/docs/[...slug]',
	'/opt/[[...id]]',
	'/shop/[id]/edit'
];
const prerendered = ['/', '/about', '/articles/1', '/articles/2'];

function summary(input: Parameters<typeof nextPages>[0]) {
	return nextPages(input).map((page) => [page.path, page.register, page.pattern, page.reason]);
}

describe('nextPages', () => {
	it('registers the prerendered and static pages, and leaves the rest on the network', () => {
		expect(summary({ pages, prerendered })).toEqual([
			['/', 'family', '/', 'prerendered with enumerable params'],
			['/about', 'family', '/about', 'prerendered with enumerable params'],
			['/(shop)/cart', 'family', '/cart', 'server-rendered with enumerable params'],
			['/articles/[id]', 'family', '/articles/:id', 'prerendered with enumerable params'],
			[
				'/blog/[slug]',
				'network',
				'/blog/:slug',
				'params not enumerable: declare a dataset family for /blog/:slug'
			],
			['/docs/[...slug]', 'network', undefined, 'catch-all segment: ** captures no value'],
			['/opt/[[...id]]', 'network', undefined, 'catch-all segment: ** captures no value'],
			[
				'/shop/[id]/edit',
				'network',
				'/shop/:id/edit',
				'params not enumerable: declare a dataset family for /shop/:id/edit'
			]
		]);
	});

	it('turns the registered patterns into exactly their routes, and reports the one left out', () => {
		const registered = nextPages({ pages, prerendered });
		const patterns = ['/', '/about', '/cart', '/articles/:id', '/blog/:slug', '/shop/:id/edit'];
		const declare = (list: string[]) =>
			Object.fromEntries(
				list.map((pattern) => [pattern, { strategy: 'static', depends: () => [] } as const])
			);
		const all = routesFromPages(registered, declare(patterns));
		expect(all.routes.map((route) => route.pattern)).toEqual(patterns);
		expect(all.uncovered).toEqual([]);
		const less = routesFromPages(registered, declare(patterns.slice(0, -1)));
		expect(less.uncovered.map((page) => [page.path, page.pattern])).toEqual([
			['/shop/[id]/edit', '/shop/:id/edit']
		]);
		expect(() => routesFromPages(registered, declare(['/docs/:slug']))).toThrow(
			'/docs/:slug: the framework'
		);
	});

	it('lists the prerendered paths under the page that matches them', () => {
		const registered = nextPages({ pages, prerendered });
		expect(registered.find((page) => page.path === '/articles/[id]')?.prerendered).toEqual([
			'/articles/1',
			'/articles/2'
		]);
		expect(registered.find((page) => page.path === '/blog/[slug]')?.prerendered).toEqual([]);
	});

	it('does not take a dynamic page fallback shell for a prerendered param set', () => {
		const registered = nextPages({
			pages: ['/blog/[slug]', '/articles/[id]'],
			prerendered: ['/blog/[slug]', '/articles/[id]', '/articles/1']
		});
		expect(registered.map((page) => [page.register, page.prerendered])).toEqual([
			['network', []],
			['family', ['/articles/1']]
		]);
	});

	it('leaves every page on the network when Cache Components is on', () => {
		const registered = nextPages({
			pages: ['/', '/articles/[id]'],
			prerendered,
			cacheComponents: true
		});
		expect(registered.map((page) => [page.register, page.reason])).toEqual([
			['network', 'streaming or server components: payload not captured per param'],
			['network', 'streaming or server components: payload not captured per param']
		]);
	});
});

describe('the Next adapter', () => {
	let dir = '';

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'spool-next-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('writes the registrations next to the build and prints the report', () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		adapter.onBuildComplete({
			distDir: dir,
			config: {},
			outputs: {
				appPages: [
					{ pathname: '/' },
					{ pathname: '/index.rsc' },
					{ pathname: '/_not-found' },
					{ pathname: '/blog/[slug]' },
					{ pathname: '/blog/[slug].rsc' }
				],
				prerenders: [{ pathname: '/' }, { pathname: '/index.rsc' }]
			}
		});
		const written = JSON.parse(readFileSync(join(dir, SPOOL_PAGES_FILE), 'utf8'));
		expect(written).toEqual(nextPages({ pages: ['/', '/blog/[slug]'], prerendered: ['/'] }));
		expect(info).toHaveBeenCalledWith(
			[
				'spool: 1 registered, 1 left to the network',
				'  registered  /  family',
				'  network     /blog/[slug]  params not enumerable: declare a dataset family for /blog/:slug'
			].join('\n')
		);
	});
});

describe('the route handler and tag', () => {
	const spool = createSpool({ routes: [], store: memoryStore(), bundles: memoryBundleStore() });

	it('answers the worker script and spool paths, and 404s anything else', async () => {
		const handler = spoolRouteHandler(spool);
		const worker = await handler(new Request('http://127.0.0.1/spool-sw.js'));
		expect(worker.status).toBe(200);
		expect(await worker.text()).toBe(await spool.stub().text());
		const sync = await handler(new Request('http://127.0.0.1/.spool/sync?from=0'));
		expect(sync.status).toBe(200);
		const other = await handler(new Request('http://127.0.0.1/about'));
		expect(other.status).toBe(404);
		expect(await other.text()).toBe('not found');
	});

	it('gives the page runtime tag of the instance', () => {
		expect(spoolTag(spool)).toBe(spool.config.clientTag);
		expect(spoolTag(spool)).toContain('data-spool-gate');
	});
});
