import { expect, test, type Page } from '@playwright/test';
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
