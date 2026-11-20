import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeListener } from '../../src/node/listener';
import { buildPack, type BundleRows } from '../../src/protocol/index';
import { createSpool, defineRoute, memoryBundleStore } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled } from './fixture';

/**
 * The worker script lives in the browser's cache for LEASE_MS. Inside that lease a family page is
 * answered from the pack the device holds, with no request. After it, a page's own register call
 * checks the script; the stub carries the version and the deltas that bring the pack up to date.
 * Chromium defers that check by a few seconds, so the test waits for the stub before it counts.
 */
const LEASE_MS = 6_000;
const DWELL_MS = 1_500;
const CHECK_MS = 10_000;
const ROWS = 12;
const TABLE = 'directory';
const STUB = '/spool-sw.js';
const HTML = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' };

type Row = { id: string; title: string };
type Hit = { method: string; path: string; at: number };
type PackWindow = {
	pack: {
		createPackStore(factory: IDBFactory): {
			installPack(
				source: AsyncIterable<Uint8Array<ArrayBuffer>>
			): Promise<{ installed: boolean; version: number }>;
		};
	};
};

const PAGE_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>lease</title><script type="module">import * as pack from '/pack.js';window.pack=pack;</script></head><body></body></html>`;
// every page runs register on load, as the spool client does; that is the script check after a lease
const PAGE_ROW = `<!doctype html><html><head><meta charset="utf-8"><title>row</title><script>navigator.serviceWorker.register('/spool-sw.js',{updateViaCache:'all'})</script></head><body><main><h1>{{params.id}}</h1><p>{{row.title}}</p></main></body></html>`;

let packJs = '';

/** the pack store as one browser module, bundled from the working tree by bun */
function bundle(entry: string): string {
	const built = spawnSync('bun', ['build', entry, '--target', 'browser', '--format', 'esm'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
	return built.stdout;
}

/** the stub with the digest of its first inline delta replaced, so the device refuses that delta */
async function corruptStub(response: Response): Promise<Response> {
	const text = await response.text();
	const marker = 'self.__SPOOL_CONFIG__=';
	const end = text.indexOf(';\n');
	const config = JSON.parse(text.slice(marker.length, end)) as {
		pack?: { deltas: Array<{ digest: string }> };
	};
	const delta = config.pack?.deltas[0];
	if (!delta) throw new Error('the stub carries no inline delta to corrupt');
	delta.digest = '0'.repeat(64);
	return new Response(`${marker}${JSON.stringify(config)}${text.slice(end)}`, {
		headers: response.headers
	});
}

async function startSite() {
	const rows = new Map<string, Row>(
		Array.from({ length: ROWS }, (_, i): [string, Row] => {
			const id = `r${String(i + 1).padStart(3, '0')}`;
			return [id, { id, title: `Title ${i + 1}` }];
		})
	);
	const store = memoryStore();
	const bundles = memoryBundleStore();
	const family = { dataset: TABLE, key: 'id' };
	const spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/rows/:id', {
				strategy: 'template',
				template: { source: PAGE_ROW },
				family,
				load: (ctx) => rows.get(ctx.params['id'] as string)
			}),
			defineRoute('/api/rows/:id', {
				strategy: 'data',
				family,
				load: (ctx) => rows.get(ctx.params['id'] as string)
			})
		],
		store,
		bundles,
		freshness: { maxAge: LEASE_MS / 1000 }
	});

	/** bumps the store cursor and keeps the pack of that version, which the stub reads */
	const publish = async (): Promise<number> => {
		const version = await store.bump([TABLE]);
		const sortedRows = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
		const tables: Record<string, BundleRows> = {
			[TABLE]: sortedRows.map((row): [string, Row] => [row.id, row])
		};
		await bundles.put(version, (await buildPack({ version, tables })).bytes);
		return version;
	};

	let corrupt = false;
	const hits: Hit[] = [];
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response(PAGE_HOME, { headers: HTML });
		if (pathname === '/pack.js') {
			return new Response(packJs, {
				headers: { 'content-type': 'text/javascript; charset=utf-8' }
			});
		}
		return new Response('not found', { status: 404 });
	};
	const listener = toNodeListener(async (request) => {
		const { pathname } = new URL(request.url);
		hits.push({ method: request.method, path: pathname, at: Date.now() });
		const response = await spool.handle(request, app);
		return pathname === STUB && corrupt ? corruptStub(response) : response;
	});
	const server: Server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		hits,
		publish,
		packOf: (version: number) => bundles.get(version),
		edit: (id: string, title: string) => {
			rows.set(id, { id, title });
			return publish();
		},
		setCorrupt: (on: boolean) => {
			corrupt = on;
		},
		/** when the browser last asked for the worker script, epoch milliseconds */
		stubAt: () => hits.filter((hit) => hit.path === STUB).at(-1)?.at ?? 0,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

type Site = Awaited<ReturnType<typeof startSite>>;

/** waits until the lease of the last worker script request has run out, with a margin */
async function untilLeaseEnds(site: Site): Promise<void> {
	const wait = site.stubAt() + LEASE_MS + 300 - Date.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

const rowTitle = (page: Page) => page.textContent('main p');

/** the version the device's pack store holds, read from IndexedDB without loading the module */
const headOf = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number | null>((resolve) => {
				const open = indexedDB.open('spool-bundle');
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('head').objectStore('head').get('active');
					get.onerror = () => resolve(null);
					get.onsuccess = () => {
						db.close();
						resolve((get.result as { version: number } | undefined)?.version ?? null);
					};
				};
			})
	);

test.beforeAll(() => {
	packJs = bundle('src/sw/pack/store.ts');
});

test('a family page answers inside the lease, and the stub carries each change after it', async ({
	page,
	browserName
}) => {
	test.setTimeout(240_000);
	const site = await startSite();
	const { origin } = site;
	const webkit = browserName === 'webkit';
	/** the requests a view made, as paths; WebKit leaves the script check out, as the spec asks */
	const reads = (hits: Hit[]) =>
		webkit ? hits.map((h) => h.path).filter((path) => path !== STUB) : hits.map((h) => h.path);
	const stubsSince = (from: number) =>
		site.hits.slice(from).filter((h) => h.path === STUB).length;
	/** the script checks each step made, for the WebKit reading; printed at the end */
	const checks: Record<string, number> = {};
	const count = (label: string, from: number) => {
		checks[label] = stubsSince(from);
	};

	try {
		expect(await site.publish()).toBe(1);
		const packed = await site.packOf(1);
		if (!packed) throw new Error('no pack for version 1');

		await page.goto(`${origin}/`);
		await page.waitForFunction(() => 'pack' in window);
		const installed = await page.evaluate(async (bytes: number[]) => {
			const { pack } = window as unknown as PackWindow;
			async function* once() {
				yield new Uint8Array(bytes);
			}
			return pack.createPackStore(indexedDB).installPack(once());
		}, Array.from(packed));
		expect(installed).toMatchObject({ installed: true, version: 1 });

		await page.evaluate(() =>
			navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
		);
		await controlled(page);
		// a network view first, so the site's security headers are kept for the local pages
		await page.goto(`${origin}/`);
		await page.goto(`${origin}/rows/r001`);
		expect(await rowTitle(page)).toBe('Title 1');

		// inside the lease: two document navigations with the dwell between them
		const inside = site.hits.length;
		await page.goto(`${origin}/rows/r002`);
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${origin}/rows/r003`);
		await page.waitForTimeout(DWELL_MS);
		expect(await rowTitle(page)).toBe('Title 3');
		expect(Date.now() - site.stubAt()).toBeLessThan(LEASE_MS);
		expect(reads(site.hits.slice(inside))).toEqual([]);
		count('inside', inside);

		// one missed version: the first navigation after the lease makes the script check, once
		await untilLeaseEnds(site);
		await site.edit('r004', 'Changed One');
		const one = site.hits.length;
		await page.goto(`${origin}/rows/r004`);
		if (!webkit) await expect.poll(() => stubsSince(one), { timeout: CHECK_MS }).toBe(1);
		await page.waitForTimeout(DWELL_MS);
		expect(reads(site.hits.slice(one))).toEqual(webkit ? [] : [STUB]);
		count('one-version-navigation', one);
		const oneNext = site.hits.length;
		await page.goto(`${origin}/rows/r004`);
		expect(await rowTitle(page)).toBe('Changed One');
		expect(reads(site.hits.slice(oneNext))).toEqual([]);
		count('one-version-next', oneNext);

		// several missed versions: one stub carries both, from the version the device holds
		await untilLeaseEnds(site);
		await site.edit('r006', 'Changed Three');
		await site.edit('r008', 'Changed Four');
		const several = site.hits.length;
		await page.goto(`${origin}/rows/r006`);
		if (!webkit) await expect.poll(() => stubsSince(several), { timeout: CHECK_MS }).toBe(1);
		await page.waitForTimeout(DWELL_MS);
		expect(reads(site.hits.slice(several))).toEqual(webkit ? [] : [STUB]);
		count('several-versions-navigation', several);
		await page.goto(`${origin}/rows/r008`);
		expect(await rowTitle(page)).toBe('Changed Four');
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${origin}/rows/r006`);
		expect(await rowTitle(page)).toBe('Changed Three');
		expect(Date.now() - site.stubAt()).toBeLessThan(LEASE_MS);
		await expect.poll(() => headOf(page)).toBe(4);

		// an in-page fetch after the lease reads the held row with no request
		await untilLeaseEnds(site);
		const fetched = site.hits.length;
		const title = await page.evaluate(async () => {
			const row = (await (await fetch('/api/rows/r006')).json()) as { title: string };
			return row.title;
		});
		expect(title).toBe('Changed Three');
		expect(reads(site.hits.slice(fetched))).toEqual([]);

		// a stub whose delta digest is wrong: the install is refused and the held pack answers
		await untilLeaseEnds(site);
		site.setCorrupt(true);
		await site.edit('r010', 'Changed Five');
		const bad = site.hits.length;
		await page.goto(`${origin}/rows/r010`);
		if (!webkit) await expect.poll(() => stubsSince(bad), { timeout: CHECK_MS }).toBe(1);
		await page.waitForTimeout(DWELL_MS);
		expect(await rowTitle(page)).toBe('Title 10');
		expect(reads(site.hits.slice(bad))).toEqual(webkit ? [] : [STUB]);
		count('corrupt-navigation', bad);
		site.setCorrupt(false);
		const held = site.hits.length;
		await page.goto(`${origin}/rows/r010`);
		expect(await rowTitle(page)).toBe('Title 10');
		expect(reads(site.hits.slice(held))).toEqual([]);
		expect(await headOf(page)).toBe(4);
	} finally {
		console.log(JSON.stringify({ engine: browserName, scriptChecks: checks }));
		await site.stop();
	}
});
