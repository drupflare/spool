import { expect, test, type Page } from '@playwright/test';
import { defineDataset } from '../../src/protocol/index';
import { createSpool, defineRoute, defineWrite } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled, listen, type Hit } from './fixture';
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
	// a page with no ring loads the runtime from the second view, so view 1 costs the baseline
	await page.waitForTimeout(1600);
	await page.goto(`${fx.origin}/about`);
	await controlled(page);
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
	await controlled(other);
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
	page
}) => {
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

test('a class with maxDelayMs sends nothing before its deadline and one request at it, and a page hide flushes before it', async ({
	page
}) => {
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
		maxPending: 4,
		maxDelayMs: 4000
	});
	fx = await startAuth({ writes: { enabled: true, classes: [mark] } });
	const puts = () => fx.hits.filter((h) => h.method === 'PUT' && h.path === '/.spool/write');
	await register(page);
	await signIn(page, 'A');

	await page.evaluate(async () => {
		const { spool } = window as unknown as SpoolWrites;
		const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));
		await spool.write('mark', 'mark:A', 'one', '0');
		await pause();
		await spool.write('mark', 'mark:A', 'two', '0');
		await pause();
		await spool.write('mark', 'mark:A', 'three', '0');
	});
	expect(puts()).toHaveLength(0);
	await expect.poll(() => puts().length, { timeout: 8000 }).toBe(1);
	expect(applies).toBe(1);
	expect(db.get('mark:A')).toEqual({ version: 1, value: 'three' });

	await page.evaluate(() =>
		(window as unknown as SpoolWrites).spool.write('mark', 'mark:A', 'four', '1')
	);
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect.poll(() => puts().length).toBe(2);
	await page.waitForTimeout(4500);
	expect(puts()).toHaveLength(2);
	expect(applies).toBe(2);
	expect(db.get('mark:A')).toEqual({ version: 2, value: 'four' });
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
		bootstrap: 'first-view',
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
	page
}) => {
	const site = await startOrders();
	try {
		await page.goto(`${site.origin}/about`);
		await page.waitForTimeout(1600);
		await page.goto(`${site.origin}/about`);
		await controlled(page);
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

// #region authenticated families

type Person = { id: string; name: string; email: string };

const PEOPLE: Person[] = [
	{ id: 'ada', name: 'Ada', email: 'ada@secret.test' },
	{ id: 'bob', name: 'Bob', email: 'bob@secret.test' }
];

/** the fields a viewer may hold: the owner's whole row, another person's public fields */
const viewerFields = (viewer: { principal: string } | null, row: Person) =>
	viewer?.principal === row.id ? ['id', 'name', 'email'] : ['id', 'name'];

const PERSON_SOURCE =
	'<!doctype html><html><head><meta charset="utf-8"><title>person</title></head><body><main><p>{{row.id}} {{row.name}} {{row.email}}</p></main></body></html>';

/** waits past the 1.5 s between document navigations the browser suite keeps (WebKit coalesces its script check) */
const dwell = () => new Promise<void>((resolve) => setTimeout(resolve, 1500));

async function startFamilies() {
	const hits: Hit[] = [];
	const cookieUser = (request: Request) =>
		/(?:^|;\s*)user=([A-Za-z0-9]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
	const rows = new Map(PEOPLE.map((p) => [p.id, p]));
	const layout = (title: string, body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><p>${body}</p></main></body></html>`;
	const html = (text: string, headers: Record<string, string> = {}, status = 200) =>
		new Response(text, {
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0',
				...headers
			}
		});
	const people = defineDataset<Person>(
		'people',
		{
			scope: 'principal',
			maxStaleMs: 3_600_000,
			schema: 'v1',
			maxRows: 100,
			maxBytes: 100_000,
			key: (row) => row.id,
			seed: () => [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
			read: (ids) => ids.flatMap((id) => rows.get(id) ?? []),
			changes: () => 'reset',
			horizon: () => 0,
			head: () => ({ cursor: 0 }),
			fields: viewerFields
		},
		{ principalDatasets: true }
	);
	const spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/account', {
				strategy: 'template',
				auth: 'principal',
				family: { dataset: 'people', key: 'viewer.id' },
				template: { source: PERSON_SOURCE }
			} as never),
			defineRoute('/people/:id', {
				strategy: 'template',
				scope: 'principal',
				family: { dataset: 'people', key: 'id' },
				template: { source: PERSON_SOURCE }
			} as never),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: layout('about', 'about this site') },
				load: () => ({})
			})
		],
		store: memoryStore(),
		datasets: [people],
		principalDatasets: true,
		logout: ['/logout'],
		identity: {
			secret: 'fixture-secret',
			resolve: (request) => {
				const user = cookieUser(request);
				return user ? { principal: user } : null;
			}
		}
	});
	const app = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const user = cookieUser(request);
		if (url.pathname === '/login') {
			const as = url.searchParams.get('as') as string;
			return html(layout('welcome', `signed in as ${as}`), {
				'set-cookie': `user=${as}; Path=/`,
				'spool-partition': await spool.partition(as)
			});
		}
		if (url.pathname === '/logout') {
			return html(layout('bye', 'signed out'), { 'set-cookie': 'user=; Path=/; Max-Age=0' });
		}
		if (url.pathname === '/about') return html(layout('about', 'about this site'));
		if (url.pathname === '/account' || url.pathname.startsWith('/people/')) {
			if (!user) return html(layout('sign in', 'please sign in'), {}, 401);
			const row = rows.get(url.pathname === '/account' ? user : url.pathname.slice(8));
			if (!row) return new Response('no row', { status: 404 });
			const shown = viewerFields({ principal: user }, row);
			const email = shown.includes('email') ? ` ${row.email}` : '';
			return html(layout(row.id, `${row.id} ${row.name}${email}`));
		}
		return new Response('not found', { status: 404 });
	};
	const base = await listen(hits, spool, app);
	return { ...base, hits, spool };
}

const familyVisible = (site: Awaited<ReturnType<typeof startFamilies>>) =>
	site.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');

/** registers the worker, signs in and waits until the partition is held */
async function familySignIn(
	page: Page,
	site: Awaited<ReturnType<typeof startFamilies>>,
	who: string
) {
	await page.goto(`${site.origin}/about`);
	await page.waitForTimeout(1600);
	await page.goto(`${site.origin}/about`);
	await controlled(page);
	await page.evaluate(
		() => (globalThis as unknown as { spool: { ready: Promise<unknown> } }).spool.ready
	);
	await page.goto(`${site.origin}/login?as=${who}`);
	const id = await site.spool.partition(who);
	await expect.poll(async () => (await heldDatasets(page)).partition).toBe(id);
	return id;
}

/** holds the signed-in person's /account page and the people rows, then the other person's profile */
async function holdFamilies(
	page: Page,
	site: Awaited<ReturnType<typeof startFamilies>>,
	me: Person
) {
	const other = PEOPLE.find((p) => p.id !== me.id) as Person;
	await page.goto(`${site.origin}/account`);
	await expect(page.locator('main p')).toContainText(`${me.id} ${me.name} ${me.email}`);
	await expect.poll(async () => (await held(page)).artifacts).toContain('/account');
	await dwell();
	await page.goto(`${site.origin}/account`);
	await expect
		.poll(async () => (await heldDatasets(page)).datasets)
		.toMatchObject([{ name: 'people', count: 2 }]);
	await dwell();
	await page.goto(`${site.origin}/people/${other.id}`);
	await expect(page.locator('main p')).toContainText(`${other.id} ${other.name}`);
}

test('a principal /account renders every field its fields grant, /people/:id only the public fields, and reading makes no request after bootstrap', async ({
	page
}) => {
	const site = await startFamilies();
	try {
		await familySignIn(page, site, 'ada');
		await holdFamilies(page, site, PEOPLE[0] as Person);

		site.hits.length = 0;
		await dwell();
		await page.goto(`${site.origin}/account`);
		await expect(page.locator('main p')).toContainText('ada Ada ada@secret.test');
		await dwell();
		await page.goto(`${site.origin}/people/bob`);
		await expect(page.locator('main p')).toContainText('bob Bob');
		expect(await page.locator('main p').innerText()).not.toContain('bob@secret.test');
		expect(familyVisible(site)).toEqual([]);
	} finally {
		await site.stop();
	}
});

test('a second principal after logout holds none of the first one rows', async ({ page }) => {
	const site = await startFamilies();
	try {
		const a = await familySignIn(page, site, 'ada');
		await holdFamilies(page, site, PEOPLE[0] as Person);
		expect(await datasetStore(page)).toEqual([a, a]);

		await dwell();
		await page.goto(`${site.origin}/logout`);
		await expect(page.locator('main p')).toHaveText('signed out');
		await expect.poll(async () => (await heldDatasets(page)).partition).toBeNull();
		await expect.poll(async () => (await datasetStore(page)) ?? []).not.toContain(a);

		await dwell();
		const b = await familySignIn(page, site, 'bob');
		await holdFamilies(page, site, PEOPLE[1] as Person);
		await page.goto(`${site.origin}/account`);
		await expect(page.locator('main p')).toContainText('bob Bob bob@secret.test');
		const stored = (await datasetStore(page)) ?? [];
		expect(stored).not.toContain(a);
		expect(stored.every((partition) => partition === b)).toBe(true);
	} finally {
		await site.stop();
	}
});

test('a stale tab shows the current principal after its next contact, never a mix', async ({
	page,
	context
}) => {
	const site = await startFamilies();
	try {
		await familySignIn(page, site, 'ada');
		await holdFamilies(page, site, PEOPLE[0] as Person);

		const other = await context.newPage();
		await dwell();
		await other.goto(`${site.origin}/logout`);
		await dwell();
		await other.goto(`${site.origin}/login?as=bob`);
		const b = await site.spool.partition('bob');
		await expect.poll(async () => (await heldDatasets(other)).partition).toBe(b);

		await dwell();
		await page.goto(`${site.origin}/account`);
		await expect(page.locator('main p')).toContainText('bob Bob bob@secret.test');
		expect(await page.locator('main p').innerText()).not.toContain('ada');
	} finally {
		await site.stop();
	}
});

test('a sign-in the worker does not see leaves the held page answering until the next contact, which is measured', async ({
	page,
	context
}, testInfo) => {
	const site = await startFamilies();
	try {
		await familySignIn(page, site, 'ada');
		await holdFamilies(page, site, PEOPLE[0] as Person);

		await dwell();
		const switched = Date.now();
		await context.addCookies([{ name: 'user', value: 'bob', url: site.origin }]);
		site.hits.length = 0;
		await page.goto(`${site.origin}/account`);
		await expect(page.locator('main p')).toContainText('ada Ada ada@secret.test');
		expect(familyVisible(site)).toEqual([]);
		await dwell();
		await page.goto(`${site.origin}/about?contact=1`);
		const corrected = Date.now();
		await dwell();
		await page.goto(`${site.origin}/account`);
		await expect(page.locator('main p')).toContainText('bob Bob bob@secret.test');
		testInfo.annotations.push({
			type: 'stale-window',
			description: `cookie switch to next contact: ${corrected - switched} ms, including the 1.5 s dwell before the contact; one stale view with 0 requests`
		});
	} finally {
		await site.stop();
	}
});

// #endregion
