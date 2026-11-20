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
 * A held page answers from the pack the device holds. The worker script stays in the browser's cache for
 * LEASE_S, and the page keeps its own record of the last server contact. A request that leaves (a miss, a
 * network document or a write) is a contact: it resets the page's record, and a miss carries the held
 * version as Spool-Have so the answer can bring a delta. WebKit checks the script on each document
 * navigation, so its counts leave the script out, as lease.pw.ts does.
 */
const LEASE_S = 6;
const LEASE_MS = LEASE_S * 1000;
const DWELL_MS = 1_500;
const CHECK_MS = 10_000;
const ROWS = 12;
const TABLE = 'directory';
const STUB = '/spool-sw.js';
const HTML = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' };

type Row = { id: string; title: string };
type Hit = { method: string; path: string; at: number; have: string | null; mode: string | null };
type PackWindow = {
	pack: {
		createPackStore(factory: IDBFactory): {
			installPack(
				source: AsyncIterable<Uint8Array<ArrayBuffer>>
			): Promise<{ installed: boolean; version: number }>;
		};
	};
};

const PAGE_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>contact</title><script type="module">import * as pack from '/pack.js';window.pack=pack;</script></head><body></body></html>`;
// every page runs register on load, as the spool client does; that is the clock check after a lease
const PAGE_ROW = `<!doctype html><html><head><meta charset="utf-8"><title>row</title><script>navigator.serviceWorker.register('/spool-sw.js',{updateViaCache:'all'})</script></head><body><main><h1>{{params.id}}</h1><p>{{row.title}}</p></main></body></html>`;
const PAGE_SOFT = `<!doctype html><html><head><meta charset="utf-8"><title>soft</title><script>navigator.serviceWorker.register('/spool-sw.js',{updateViaCache:'all'})</script></head><body><main><h1>{{id}}</h1><p>{{text}}</p></main></body></html>`;
// the page asks for an image on the other origin, which is the same server under another host name
const PAGE_XO = `<!doctype html><html><head><meta charset="utf-8"><title>xo</title></head><body><main><p>{{note}}</p></main><script>new Image().src='http://localhost:'+location.port+'/pixel.gif'</script></body></html>`;

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

async function startSite(options: { stamped?: boolean } = {}) {
	let stamp = 1;
	let softText = 'first';
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
			}),
			defineRoute('/xo/:id', {
				strategy: 'template',
				template: { source: PAGE_XO },
				load: () => ({ note: 'other origin' })
			}),
			defineRoute('/soft/:id', {
				strategy: 'template',
				template: { source: PAGE_SOFT },
				depends: (ctx) => [`node:${ctx.params['id']}`],
				load: (ctx) => ({ id: ctx.params['id'], text: softText }),
				freshness: { maxStale: 1, mode: 'soft' }
			})
		],
		store,
		bundles,
		freshness: { maxAge: LEASE_S },
		...(options.stamped ? { stamp: () => stamp } : {})
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

	const hits: Hit[] = [];
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response(PAGE_HOME, { headers: HTML });
		if (pathname === '/pack.js') {
			return new Response(packJs, {
				headers: { 'content-type': 'text/javascript; charset=utf-8' }
			});
		}
		if (pathname === '/pixel.gif') {
			const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
			return new Response(Buffer.from(gif, 'base64'), {
				headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' }
			});
		}
		if (pathname === '/echo')
			return new Response('ok', { headers: { 'cache-control': 'no-store' } });
		const id = /^\/rows\/(.+)$/.exec(pathname)?.[1];
		if (id !== undefined) {
			const row = rows.get(id);
			if (!row) return new Response('not found', { status: 404 });
			return new Response(
				PAGE_ROW.replace('{{params.id}}', row.id).replace('{{row.title}}', row.title),
				{
					headers: HTML
				}
			);
		}
		const soft = /^\/soft\/(.+)$/.exec(pathname)?.[1];
		if (soft !== undefined) {
			return new Response(PAGE_SOFT.replace('{{id}}', soft).replace('{{text}}', softText), {
				headers: HTML
			});
		}
		if (pathname.startsWith('/xo/')) {
			return new Response(PAGE_XO.replace('{{note}}', 'other origin'), { headers: HTML });
		}
		return new Response('not found', { status: 404 });
	};
	let corrupt = false;
	const listener = toNodeListener(async (request) => {
		const { pathname } = new URL(request.url);
		if (pathname !== '/favicon.ico') {
			hits.push({
				method: request.method,
				path: pathname,
				at: Date.now(),
				have: request.headers.get('spool-have'),
				mode: request.headers.get('sec-fetch-mode')
			});
		}
		return spool.handle(request, app);
	});
	const server: Server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		hits,
		/** the stamp the stub carries from its next request on */
		setStamp: (next: number) => {
			stamp = next;
		},
		publish,
		/** changes the text of every soft page and tells the server the page's dependency moved */
		editSoft: (text: string, id: string) => {
			softText = text;
			return spool.invalidate([`node:${id}`]);
		},
		packOf: (version: number) => bundles.get(version),
		/** sets the rows in `changes` and publishes one version for them */
		change: (changes: Array<[string, string]>) => {
			for (const [id, title] of changes) rows.set(id, { id, title });
			return publish();
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

/** waits until the page's record of the last server contact is at least `at`, in epoch milliseconds */
const recordAtLeast = (page: Page, at: number) =>
	page.waitForFunction((min) => Number(localStorage.getItem('spool:contact')) >= min, at, {
		timeout: CHECK_MS
	});

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

/** installs version 1 of the pack, registers the worker and makes one network view */
async function bootstrap(page: Page, site: Site): Promise<void> {
	expect(await site.publish()).toBe(1);
	const packed = await site.packOf(1);
	if (!packed) throw new Error('no pack for version 1');
	await page.goto(`${site.origin}/`);
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
	await page.goto(`${site.origin}/`);
	await page.goto(`${site.origin}/rows/r001`);
	expect(await rowTitle(page)).toBe('Title 1');
}

test.beforeAll(() => {
	packJs = bundle('src/sw/pack/store.ts');
});

test('in-page views inside the lease make no request, and the first view after it makes one stub request', async ({
	page,
	browserName
}) => {
	test.setTimeout(120_000);
	const site = await startSite();
	const webkit = browserName === 'webkit';
	const reads = (hits: Hit[]) =>
		webkit ? hits.map((h) => h.path).filter((path) => path !== STUB) : hits.map((h) => h.path);
	const stubsSince = (from: number) =>
		site.hits.slice(from).filter((h) => h.path === STUB).length;
	try {
		await bootstrap(page, site);

		const inside = site.hits.length;
		await page.goto(`${site.origin}/rows/r002`);
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${site.origin}/rows/r003`);
		expect(await rowTitle(page)).toBe('Title 3');
		expect(Date.now() - site.stubAt()).toBeLessThan(LEASE_MS);
		expect(reads(site.hits.slice(inside))).toEqual([]);
		if (!webkit) expect(stubsSince(inside)).toBe(0);

		await untilLeaseEnds(site);
		await site.change([['r004', 'Changed One']]);
		const one = site.hits.length;
		await page.goto(`${site.origin}/rows/r004`);
		if (!webkit) await expect.poll(() => stubsSince(one), { timeout: CHECK_MS }).toBe(1);
		await page.waitForTimeout(DWELL_MS);
		expect(reads(site.hits.slice(one))).toEqual(webkit ? [] : [STUB]);
		const next = site.hits.length;
		await page.goto(`${site.origin}/rows/r004`);
		expect(await rowTitle(page)).toBe('Changed One');
		expect(reads(site.hits.slice(next))).toEqual([]);
		expect(await headOf(page)).toBe(2);
	} finally {
		await site.stop();
	}
});

test('a soft page that waited a lease syncs once from a local view, and the next page shows the change', async ({
	page
}) => {
	test.setTimeout(120_000);
	const site = await startSite();
	const syncsSince = (from: number) =>
		site.hits.slice(from).filter((h) => h.path === '/.spool/sync').length;
	try {
		await bootstrap(page, site);
		await page.goto(`${site.origin}/soft/s1`);
		const provisioned = Date.now();
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${site.origin}/soft/s1`);
		expect(await page.textContent('main p')).toBe('first');
		await site.editSoft('second', 's1');

		// past the bound and inside the lease the local view still queues and sends nothing
		await page.waitForTimeout(DWELL_MS);
		const inside = site.hits.length;
		await page.goto(`${site.origin}/soft/s1`);
		expect(await page.textContent('main p')).toBe('first');
		await page.waitForTimeout(DWELL_MS);
		expect(syncsSince(inside)).toBe(0);

		const wait = provisioned + LEASE_MS + DWELL_MS - Date.now();
		if (wait > 0) await page.waitForTimeout(wait);
		const after = site.hits.length;
		await page.goto(`${site.origin}/soft/s1`);
		expect(await page.textContent('main p')).toBe('first');
		await expect.poll(() => syncsSince(after), { timeout: CHECK_MS }).toBe(1);

		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${site.origin}/soft/s1`);
		expect(await page.textContent('main p')).toBe('second');
		await page.waitForTimeout(DWELL_MS);
		expect(syncsSince(after)).toBe(1);
	} finally {
		await site.stop();
	}
});

/**
 * A contact inside the lease resets the page's record. The browser's copy of the script still runs
 * out at the old deadline, so the view after it sits past that deadline and inside the new one.
 */
for (const kind of ['a network document', 'a write'] as const) {
	test(`${kind} inside the lease resets the clock: a view after the old deadline makes no request`, async ({
		page,
		browserName
	}) => {
		test.skip(
			browserName === 'webkit' && kind === 'a network document',
			'WebKit bug 332455: a network document inside the lease triggers script and pack requests a held view should not send'
		);
		test.setTimeout(120_000);
		const site = await startSite();
		const webkit = browserName === 'webkit';
		try {
			await bootstrap(page, site);
			await site.change([['r013', 'Thirteen']]);
			await page.waitForTimeout(DWELL_MS);
			const contact = site.hits.length;
			if (kind === 'a write') {
				await page.evaluate(async () => {
					await fetch('/echo', { method: 'POST', body: 'x' });
				});
			} else {
				await page.goto(`${site.origin}/xo/x1`);
			}
			const path = kind === 'a write' ? '/echo' : '/xo/x1';
			const at = site.hits.slice(contact).find((h) => h.path === path)?.at ?? 0;
			expect(at).toBeGreaterThan(0);
			await recordAtLeast(page, at);

			await untilLeaseEnds(site);
			// the view sits past the browser's copy and before the page's record runs out
			expect(Date.now()).toBeLessThan(at + LEASE_MS);
			const viewed = site.hits.length;
			await page.goto(`${site.origin}/rows/r002`);
			expect(await rowTitle(page)).toBe('Title 2');
			const reads = webkit
				? site.hits
						.slice(viewed)
						.map((h) => h.path)
						.filter((p) => p !== STUB && !p.endsWith('/navigate.js'))
				: site.hits.slice(viewed).map((h) => h.path);
			expect(reads).toEqual([]);
			if (!webkit) expect(site.hits.slice(viewed).filter((h) => h.path === STUB)).toEqual([]);
		} finally {
			await site.stop();
		}
	});
}

test('a miss carries Spool-Have, its answer brings the delta, and the moved rows then read locally', async ({
	page,
	browserName
}) => {
	test.setTimeout(120_000);
	const site = await startSite();
	const webkit = browserName === 'webkit';
	try {
		await bootstrap(page, site);
		await site.change([
			['r004', 'Changed One'],
			['r013', 'Thirteen']
		]);
		await page.waitForTimeout(DWELL_MS);

		const miss = site.hits.length;
		await page.goto(`${site.origin}/rows/r013`);
		expect(await rowTitle(page)).toBe('Thirteen');
		await expect.poll(() => headOf(page), { timeout: CHECK_MS }).toBe(2);
		if (webkit) {
			// WebKit checks the script before it answers the navigation, and that check brings the change
			expect(site.hits.slice(miss).filter((h) => h.path === '/rows/r013')).toEqual([]);
		} else {
			expect(site.hits.slice(miss).find((h) => h.path === '/rows/r013')?.have).toBe('1');
			expect(site.hits.slice(miss).filter((h) => h.path === STUB)).toEqual([]);
		}

		await page.waitForTimeout(DWELL_MS);
		const held = site.hits.length;
		await page.goto(`${site.origin}/rows/r004`);
		expect(await rowTitle(page)).toBe('Changed One');
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${site.origin}/rows/r013`);
		expect(await rowTitle(page)).toBe('Thirteen');
		const reads = webkit
			? site.hits
					.slice(held)
					.map((h) => h.path)
					.filter((p) => p !== STUB && !p.endsWith('/navigate.js'))
			: site.hits.slice(held).map((h) => h.path);
		expect(reads).toEqual([]);

		// a navigation the pack does not answer carries the version the device holds, in every engine
		const heldNow = await headOf(page);
		expect(heldNow).toBe(2);
		await page.waitForTimeout(DWELL_MS);
		const xo = site.hits.length;
		await page.goto(`${site.origin}/xo/x2`);
		expect(site.hits.slice(xo).find((h) => h.path === '/xo/x2')?.have).toBe(String(heldNow));
	} finally {
		await site.stop();
	}
});

test('a request to another origin from a held page carries no Spool-Have', async ({ page }) => {
	test.setTimeout(120_000);
	const site = await startSite();
	try {
		await bootstrap(page, site);
		const before = site.hits.length;
		await page.goto(`${site.origin}/xo/x1`);
		await page.waitForTimeout(DWELL_MS);
		const pixels = site.hits.slice(before).filter((h) => h.path === '/pixel.gif');
		expect(pixels).toHaveLength(1);
		expect(pixels[0]?.have).toBeNull();
	} finally {
		await site.stop();
	}
});

/** the contact the worker reports in its handshake, epoch milliseconds, or undefined before it has one */
const workerContact = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number | undefined>((resolve) => {
				const controller = navigator.serviceWorker.controller;
				if (!controller) return resolve(undefined);
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) =>
					resolve((event.data as { contact?: number }).contact);
				controller.postMessage({ type: 'spool:hello', protocol: 1 }, [channel.port2]);
			})
	);

/**
 * The first document view after the lease is the browser's forced check of the stub. With a stamp that
 * advanced, the check brings new bytes, the worker installs them, and the install is the contact. With no
 * stamp the check finds the same bytes and the worker records nothing. Counts are exact per engine.
 */
for (const stamped of [true, false] as const) {
	test(`a forced check after the lease ${stamped ? 'with a new stamp installs the script and records the contact' : 'with no stamp finds the same script and records no contact'}`, async ({
		page,
		browserName
	}) => {
		test.skip(
			browserName === 'webkit',
			'WebKit bug 332455: the forced check of the worker script after the lease sends no origin request, where the case expects one'
		);
		test.setTimeout(120_000);
		const site = await startSite({ stamped });
		const stubsSince = (from: number) =>
			site.hits.slice(from).filter((h) => h.path === STUB).length;
		try {
			await bootstrap(page, site);
			const inside = site.hits.length;
			await page.waitForTimeout(DWELL_MS);
			await page.goto(`${site.origin}/rows/r002`);
			expect(await rowTitle(page)).toBe('Title 2');
			expect(Date.now() - site.stubAt()).toBeLessThan(LEASE_MS);
			expect(site.hits.slice(inside).filter((h) => h.path !== '/rows/r002')).toEqual([]);
			expect(stubsSince(inside)).toBe(0);

			await untilLeaseEnds(site);
			if (stamped) site.setStamp(2);
			const forced = site.hits.length;
			await page.waitForTimeout(DWELL_MS);
			await page.goto(`${site.origin}/rows/r003`);
			expect(await rowTitle(page)).toBe('Title 3');
			await expect.poll(() => stubsSince(forced), { timeout: CHECK_MS }).toBe(1);
			const forcedAt = site.hits.slice(forced).find((h) => h.path === STUB)?.at ?? 0;
			console.log(
				JSON.stringify({
					engine: browserName,
					stamped,
					forcedView: site.hits.slice(forced).map((h) => h.path),
					contact: await workerContact(page)
				})
			);
			expect(forcedAt).toBeGreaterThan(0);
			// nothing else leaves in the forced view: no sync, no epoch, no second check
			const others = site.hits
				.slice(forced)
				.filter((h) => h.path !== STUB && h.path !== '/rows/r003');
			expect(others.map((h) => h.path)).toEqual([]);
			if (stamped) {
				await expect
					.poll(() => workerContact(page), { timeout: CHECK_MS })
					.toBeGreaterThanOrEqual(forcedAt);
			} else {
				await page.waitForTimeout(DWELL_MS);
				expect((await workerContact(page)) ?? 0).toBeLessThan(forcedAt);
			}

			await page.waitForTimeout(DWELL_MS);
			const next = site.hits.length;
			await page.goto(`${site.origin}/rows/r004`);
			expect(await rowTitle(page)).toBe('Title 4');
			expect(site.hits.slice(next).map((h) => h.path)).toEqual([]);
			expect(stubsSince(next)).toBe(0);
		} finally {
			await site.stop();
		}
	});
}

/**
 * Measures the page's record against the browser's copy of the script. The contact is a network document
 * at C, which resets the page's record to C. The browser's copy is still the one fetched at S, so the page's record
 * outlives it by C - S. Nothing is asserted about the size; the numbers are printed for the results file.
 */
test('measures how far the page record outlives the browser copy of the worker script', async ({
	page,
	browserName
}) => {
	test.setTimeout(120_000);
	const site = await startSite();
	try {
		await bootstrap(page, site);
		const stubAt = site.stubAt();
		await site.change([['r013', 'Thirteen']]);
		await page.waitForTimeout(DWELL_MS);
		await page.goto(`${site.origin}/xo/x1`);
		const contactAt = site.hits.find((h) => h.path === '/xo/x1' && h.at >= stubAt)?.at ?? 0;
		await recordAtLeast(page, contactAt);
		const recorded = await page.evaluate(() => localStorage.getItem('spool:contact'));
		await untilLeaseEnds(site);
		const windowFrom = site.hits.length;
		await page.goto(`${site.origin}/rows/r002`);
		await page.waitForTimeout(DWELL_MS);
		const stubsInWindow = site.hits.slice(windowFrom).filter((h) => h.path === STUB).length;
		console.log(
			JSON.stringify({
				engine: browserName,
				leaseMs: LEASE_MS,
				stubAt,
				contactAt,
				recordedMark: Number(recorded),
				recordMinusStubMs: Number(recorded) - stubAt,
				stubRequestsAfterBrowserLease: stubsInWindow
			})
		);
		expect(recorded).not.toBeNull();
		expect(contactAt).toBeGreaterThan(0);
	} finally {
		await site.stop();
	}
});
