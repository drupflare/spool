import { expect, test, type Page } from '@playwright/test';
import { defineDataset } from '../../src/protocol/index';
import { createSpool, defineRoute, defineWrite } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { listen, type Hit } from './fixture';
import { startAuth, type AuthFixture } from './fixture-p56';

type Held = {
	partition: string | null;
	artifacts: string[];
	records: string[];
	projections: string[];
};

let fx: AuthFixture;

test.beforeEach(async () => {
	fx = await startAuth();
});

test.afterEach(() => fx.stop());

const own = () => fx.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');

/** asks the worker what its principal store holds, through a message channel as the page runtime does */
const held = (page: Page): Promise<Held> =>
	page.evaluate(
		() =>
			new Promise<Held>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data as Held);
				(navigator.serviceWorker.controller as ServiceWorker).postMessage(
					{ type: 'spool:partition' },
					[channel.port2]
				);
			})
	);

const databases = (page: Page) =>
	page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name as string).sort());

async function register(page: Page): Promise<void> {
	await page.goto(`${fx.origin}/about`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(
		() => (globalThis as unknown as { spool: { ready: Promise<unknown> } }).spool.ready
	);
}

async function signIn(page: Page, as: string, path: string | null = '/grades'): Promise<void> {
	await page.goto(`${fx.origin}/login?as=${as}`);
	const id = await fx.spool.partition(as);
	await expect.poll(async () => (await held(page)).partition).toBe(id);
	if (path === null) return;
	await page.goto(`${fx.origin}${path}`);
	await expect.poll(async () => (await held(page)).artifacts).toContain(path);
}

test('a principal page is served locally after one network view, and again after another user signs in elsewhere', async ({
	page,
	browserName
}) => {
	await register(page);
	await signIn(page, 'A');
	await expect(page.locator('main p')).toHaveText('grades of A score 91');
	await signIn(page, 'A', '/inbox');

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of A score 91');
	await page.goto(`${fx.origin}/inbox`);
	await expect(page.locator('main p')).toHaveText('inbox of A');
	expect(own()).toEqual([]);
	if (browserName !== 'webkit') expect(fx.hits).toEqual([]);
});

test('a stored principal page is ciphertext under a key the page cannot export', async ({
	page
}) => {
	await register(page);
	await signIn(page, 'A');
	const id = await fx.spool.partition('A');
	const seen = await page.evaluate(async (name) => {
		const open = (db: string) =>
			new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(db);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		const all = <T>(db: IDBDatabase, store: string) =>
			new Promise<T[]>((resolve, reject) => {
				const request = db.transaction(store).objectStore(store).getAll();
				request.onsuccess = () => resolve(request.result as T[]);
				request.onerror = () => reject(request.error);
			});
		const data = await open(name);
		const artifacts = await all<{
			artifact: Record<string, unknown>;
			sealed: { data: ArrayBuffer };
		}>(data, 'artifacts');
		const records = await all<{ sealed?: unknown; data?: unknown }>(data, 'records');
		data.close();
		const vault = await open('spool-keys');
		const keys = await all<CryptoKey>(vault, 'keys');
		vault.close();
		const exportable = await Promise.all(
			keys.map((key) =>
				crypto.subtle.exportKey('raw', key).then(
					() => true,
					() => false
				)
			)
		);
		return {
			artifactKeys: artifacts.map((a) => Object.keys(a.artifact)),
			text: artifacts.map((a) => new TextDecoder('latin1').decode(a.sealed.data)).join(''),
			sealedRecords: records.every((r) => r.sealed !== undefined && r.data === undefined),
			keys: keys.map((k) => k.extractable),
			exportable
		};
	}, `spool-p-${id}`);
	expect(seen.artifactKeys).toEqual([['id']]);
	expect(seen.text).not.toContain('grades');
	expect(seen.text).not.toContain('perm:A');
	expect(seen.sealedRecords).toBe(true);
	expect(seen.keys).toEqual([false]);
	expect(seen.exportable).toEqual([false]);
});

test("a session change wipes the previous partition and never shows one user the other's data", async ({
	page
}) => {
	await register(page);
	await signIn(page, 'A');
	const a = await fx.spool.partition('A');
	expect(await databases(page)).toContain(`spool-p-${a}`);

	await signIn(page, 'B', null);
	await expect.poll(async () => databases(page)).not.toContain(`spool-p-${a}`);
	const after = await held(page);
	expect(after.partition).toBe(await fx.spool.partition('B'));
	expect(after.artifacts).toEqual([]);
	expect(after.records).toEqual([]);

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of B score 47');
	expect(own().map((h) => h.path)).toContain('/grades');
	await expect.poll(async () => (await held(page)).records).toEqual(['mark:B']);
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of B score 47');
});

test('logout online empties every tab, and the next view of a principal page asks the network', async ({
	page,
	context
}) => {
	await register(page);
	await signIn(page, 'A');
	const other = await context.newPage();
	await other.goto(`${fx.origin}/grades`);
	await expect(other.locator('main p')).toHaveText('grades of A score 91');
	const a = await fx.spool.partition('A');
	await other.evaluate(() => {
		const seen: string[] = [];
		(window as unknown as { __cleared: string[] }).__cleared = seen;
		window.addEventListener('spool:cleared', (e) =>
			seen.push((e as CustomEvent).detail.reason)
		);
	});

	await page.click('a[href="/logout"]');
	await expect(page.locator('h1')).toHaveText('bye');
	await expect
		.poll(() => other.evaluate(() => (window as unknown as { __cleared: string[] }).__cleared))
		.toEqual(['logout']);
	await expect.poll(async () => (await held(page)).partition).toBeNull();
	expect(await databases(page)).not.toContain(`spool-p-${a}`);
	expect((await held(other)).artifacts).toEqual([]);

	fx.hits.length = 0;
	await other.goto(`${fx.origin}/grades`);
	await expect(other.locator('main p')).toHaveText('please sign in');
	expect(own().map((h) => h.path)).toContain('/grades');
});

test('logout with the network down still wipes before the request is made', async ({
	page,
	context
}) => {
	await register(page);
	await signIn(page, 'A');
	const other = await context.newPage();
	await other.goto(`${fx.origin}/about`);
	await other.waitForFunction(() => navigator.serviceWorker.controller !== null);
	const a = await fx.spool.partition('A');
	expect(await databases(other)).toContain(`spool-p-${a}`);

	await context.setOffline(true);
	await page.goto(`${fx.origin}/logout`).catch(() => undefined);
	await expect.poll(async () => (await held(other)).partition).toBeNull();
	expect((await held(other)).artifacts).toEqual([]);
	expect(await databases(other)).not.toContain(`spool-p-${a}`);

	const view = await other.goto(`${fx.origin}/grades`).catch(() => null);
	if (view) expect(await other.content()).not.toContain('grades of A');
	await context.setOffline(false);
});

test('a form submission that changes what a page reads sends the next view to the network', async ({
	page
}) => {
	await register(page);
	await signIn(page, 'A');
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of A score 91');

	await page.evaluate(() =>
		fetch('/grades/edit', { method: 'POST', body: 'x' }).then((r) => r.text())
	);
	fx.hits.length = 0;
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of A score 92');
	expect(own().map((h) => h.path)).toContain('/grades');
	await expect.poll(async () => (await held(page)).artifacts).toContain('/grades');

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of A score 92');
	expect(own()).toEqual([]);
});

test("Spool-Clear empties the store, and Clear-Site-Data is the browser's own reset beside it", async ({
	page
}, testInfo) => {
	await register(page);
	await signIn(page, 'A');
	await page.goto(`${fx.origin}/hard-reset`);
	await expect(page.locator('h1')).toHaveText('reset');
	const registrations = await page.evaluate(
		async () => (await navigator.serviceWorker.getRegistrations()).length
	);
	testInfo.annotations.push({
		type: 'clear-site-data',
		description: `service worker registrations after the header: ${registrations}`
	});
	const a = await fx.spool.partition('A');
	await expect.poll(async () => databases(page)).not.toContain(`spool-p-${a}`);
});

type SpoolWrites = {
	spool: {
		write(name: string, key: string, value: unknown, version: string): Promise<unknown>;
		flush(): Promise<unknown>;
		writes(): Promise<{ writes: Array<{ state: string; conflict?: { version: string } }> }>;
		resolve(name: string, key: string, use: 'local' | 'server'): Promise<unknown>;
	};
};

test('two queued edits leave as one request and one origin write when the page is hidden, and a stale version parks', async ({
	page,
	browserName
}) => {
	test.skip(browserName !== 'chromium', 'declared writes are checked in Chromium only');
	await fx.stop();
	const db = new Map<string, { version: number; value: unknown }>();
	let applies = 0;
	const mark = defineWrite({
		name: 'mark',
		scope: 'principal',
		path: '/grades',
		key: (ctx) => `mark:${ctx.identity.principal}`,
		read: (_ctx, key) => ({ version: String(db.get(key)?.version ?? 0) }),
		apply: (_ctx, key, value, expected) => {
			applies += 1;
			const row = db.get(key) ?? { version: 0, value: undefined };
			if (String(row.version) !== expected) {
				return { conflict: { version: String(row.version), value: row.value } };
			}
			db.set(key, { version: row.version + 1, value });
			return { version: String(row.version + 1) };
		},
		maxBytes: 1000,
		maxPending: 4
	});
	fx = await startAuth({ writes: { enabled: true, classes: [mark] } });
	const puts = () => fx.hits.filter((h) => h.method === 'PUT' && h.path === '/.spool/write');
	await register(page);
	await signIn(page, 'A');

	const first = await page.evaluate(async () => {
		const { spool } = window as unknown as SpoolWrites;
		await spool.write('mark', 'mark:A', 'one', '0');
		return spool.write('mark', 'mark:A', 'two', '0');
	});
	expect(first).toEqual({ ok: true, state: 'pending', edits: 2 });
	expect(puts()).toHaveLength(0);

	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect.poll(() => puts().length).toBe(1);
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => (window as unknown as SpoolWrites).spool.writes())) as {
					writes: unknown[];
				}
		)
		.toEqual({ ok: true, writes: [] });
	expect(applies).toBe(1);
	expect(db.get('mark:A')).toEqual({ version: 1, value: 'two' });

	await page.evaluate(() =>
		(window as unknown as SpoolWrites).spool.write('mark', 'mark:A', 'stale', '0')
	);
	const flush = await page.evaluate(() => (window as unknown as SpoolWrites).spool.flush());
	expect(flush).toEqual({ ok: true, queued: 1, flushed: 0, conflicted: 1 });
	const listed = await page.evaluate(() => (window as unknown as SpoolWrites).spool.writes());
	expect(listed.writes).toMatchObject([{ state: 'conflicted', conflict: { version: '1' } }]);
	await page.evaluate(() => (window as unknown as SpoolWrites).spool.flush());
	expect(puts()).toHaveLength(2);
	expect(applies).toBe(2);

	await page.evaluate(() =>
		(window as unknown as SpoolWrites).spool.resolve('mark', 'mark:A', 'server')
	);
	expect(
		(await page.evaluate(() => (window as unknown as SpoolWrites).spool.writes())).writes
	).toEqual([]);
	expect(db.get('mark:A')).toEqual({ version: 1, value: 'two' });
});

// #region principal datasets

type Order = { id: string; dept: string };

async function startOrders() {
	const hits: Hit[] = [];
	const calls: string[] = [];
	const rows: Record<string, Order[]> = {
		A: [
			{ id: 'A1', dept: 'x' },
			{ id: 'A2', dept: 'x' }
		],
		B: [
			{ id: 'B1', dept: 'x' },
			{ id: 'B2', dept: 'x' },
			{ id: 'B3', dept: 'x' }
		]
	};
	const cookieUser = (request: Request) =>
		/(?:^|;\s*)user=([A-Za-z0-9]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
	const layout = (body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>orders</title></head><body><main><p>${body}</p></main></body></html>`;
	const spool = createSpool({
		routes: [
			defineRoute('/orders', {
				strategy: 'template',
				scope: 'principal',
				retention: 'persistent',
				freshness: { maxStale: 3600, mode: 'soft' },
				template: { source: layout('{{#each items}}{{id}} {{/each}}') },
				query: {
					list: 'items',
					dataset: 'orders',
					filter: { dept: 'string' },
					pageSize: 10
				},
				load: () => ({})
			}),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: layout('about') },
				load: () => ({})
			})
		],
		store: memoryStore(),
		datasets: [
			defineDataset<Order>(
				'orders',
				{
					scope: 'principal',
					maxStaleMs: 3_600_000,
					schema: 'v1',
					maxRows: 100,
					maxBytes: 100_000,
					key: (row) => row.id,
					seed: (ctx) => {
						calls.push(`${ctx.principal?.principal} seed`);
						return rows[ctx.principal?.principal as string] ?? [];
					},
					read: () => [],
					changes: () => 'reset',
					horizon: () => 0,
					head: (ctx) => {
						calls.push(`${ctx.principal?.principal} head`);
						return { cursor: 1 };
					}
				},
				{ principalDatasets: true }
			)
		],
		principalDatasets: true,
		identity: {
			secret: 'fixture-secret',
			resolve: (request) => {
				const user = cookieUser(request);
				return user ? { principal: user } : null;
			}
		}
	});
	const html = (text: string, headers: Record<string, string> = {}) =>
		new Response(text, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0',
				...headers
			}
		});
	const app = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const user = cookieUser(request);
		if (url.pathname === '/login') {
			const as = url.searchParams.get('as') as string;
			return html(layout(`signed in as ${as}`), {
				'set-cookie': `user=${as}; Path=/`,
				'spool-partition': await spool.partition(as)
			});
		}
		if (url.pathname === '/orders') {
			const mine = user ? (rows[user] ?? []) : [];
			return html(layout(mine.map((r) => `${r.id} `).join('')));
		}
		if (url.pathname === '/about') return html(layout('about'));
		return new Response('not found', { status: 404 });
	};
	const base = await listen(hits, spool, app);
	return { ...base, hits, spool, calls };
}

const datasetStore = (page: Page) =>
	page.evaluate(async () => {
		const listed = await indexedDB.databases();
		if (!listed.some((d) => d.name === 'spool-principal-datasets')) return null;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('spool-principal-datasets');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const all = await new Promise<Array<{ partition: string }>>((resolve, reject) => {
			const request = db.transaction('rows').objectStore('rows').getAll();
			request.onsuccess = () => resolve(request.result as Array<{ partition: string }>);
			request.onerror = () => reject(request.error);
		});
		db.close();
		return all.map((r) => r.partition);
	});

const heldDatasets = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<{
				partition: string | null;
				datasets: Array<{ name: string; count: number }>;
			}>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data);
				(navigator.serviceWorker.controller as ServiceWorker).postMessage(
					{ type: 'spool:partition' },
					[channel.port2]
				);
			})
	);

test('a held principal query makes no request, and the next user sees only their own rows', async ({
	page,
	browserName
}) => {
	test.skip(browserName !== 'chromium', 'the counted case runs in Chromium');
	const site = await startOrders();
	try {
		await page.goto(`${site.origin}/about`);
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
		await page.evaluate(
			() => (globalThis as unknown as { spool: { ready: Promise<unknown> } }).spool.ready
		);
		const visible = () =>
			site.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');

		await page.goto(`${site.origin}/login?as=A`);
		const a = await site.spool.partition('A');
		await expect.poll(async () => (await heldDatasets(page)).partition).toBe(a);
		await page.goto(`${site.origin}/orders`);
		await expect(page.locator('main p')).toHaveText('A1 A2');
		await expect.poll(async () => (await held(page)).artifacts).toContain('/orders');
		await page.goto(`${site.origin}/orders`);
		await expect
			.poll(async () => (await heldDatasets(page)).datasets)
			.toMatchObject([{ name: 'orders', count: 2 }]);

		site.hits.length = 0;
		await page.goto(`${site.origin}/orders`);
		await expect(page.locator('main p')).toHaveText('A1 A2');
		expect(visible()).toEqual([]);
		expect(await datasetStore(page)).toEqual([a, a]);

		await page.goto(`${site.origin}/login?as=B`);
		const b = await site.spool.partition('B');
		await expect.poll(async () => (await heldDatasets(page)).partition).toBe(b);
		await expect.poll(() => datasetStore(page)).toEqual([]);
		await page.goto(`${site.origin}/orders`);
		await expect(page.locator('main p')).toHaveText('B1 B2 B3');
		await expect.poll(async () => (await held(page)).artifacts).toContain('/orders');
		await page.goto(`${site.origin}/orders`);
		await expect
			.poll(async () => (await heldDatasets(page)).datasets)
			.toMatchObject([{ name: 'orders', count: 3 }]);

		site.hits.length = 0;
		await page.goto(`${site.origin}/orders`);
		await expect(page.locator('main p')).toHaveText('B1 B2 B3');
		expect(visible()).toEqual([]);
		expect(await datasetStore(page)).toEqual([b, b, b]);
		expect(site.calls).toEqual(['A head', 'A seed', 'B head', 'B seed']);
	} finally {
		await site.stop();
	}
});

// #endregion
