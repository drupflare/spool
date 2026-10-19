import { expect, test, type Page } from '@playwright/test';
import { LOADS_PATH, normalise, VIEW_PATH } from '../../src/protocol/index';
import { viewsOf } from '../../src/server/index';
import { VERSION } from '../../src/version';
import { BOUND, startFixture, type Fixture } from './fixture';

const PATHS = ['/n/1', '/n/2', '/n/3', '/hard/1', '/soft/1', '/asm/about'];

type Client = {
	status(): Promise<{ artifacts: string[]; beacons: number }>;
	hello: unknown;
	track(db: { close(): void }): () => void;
};
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startFixture();
});

test.afterAll(() => fx.stop());

/** server hits that are neither the worker script (WebKit re-checks it) nor a flush: spool's batch or a held beacon replayed */
const hits = () =>
	fx.hits
		.filter(
			(h) =>
				h.path !== '/spool-sw.js' &&
				h.path !== '/.spool/beacon' &&
				h.path !== '/cdn-cgi/rum'
		)
		.map((h) => h.path);

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

async function sleepPast(seconds: number): Promise<void> {
	const until = Date.now() + seconds * 1000 + 250;
	while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

/** waits until the server has seen no new request for a moment, so a flush started by the last view has landed */
async function quiet(): Promise<void> {
	for (let last = -1; fx.hits.length !== last;) {
		last = fx.hits.length;
		await new Promise((r) => setTimeout(r, 300));
	}
}

/** registers the worker through the page runtime, then visits every fixture path so each is provisioned */
async function warm(page: Page): Promise<void> {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	for (const path of PATHS) {
		await page.goto(`${fx.origin}${path}`);
		await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	}
	await quiet();
}

test('the page runtime registers the worker with updateViaCache all and the handshake agrees', async ({
	page
}) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	const result = await page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		const registration = await navigator.serviceWorker.getRegistration();
		return { hello: (client as Client).hello, cache: registration?.updateViaCache };
	});
	expect(result.cache).toBe('all');
	expect(result.hello).toEqual({
		type: 'spool:hello',
		protocol: 1,
		version: VERSION,
		compatible: true
	});
});

test('a provisioned route makes 0 server hits per local navigation', async ({
	page,
	context,
	browserName
}) => {
	await warm(page);
	await page.goto(`${fx.origin}${PATHS[0]}`);
	fx.hits.length = 0;

	for (const path of PATHS.slice(1)) {
		await Promise.all([page.waitForURL(`**${path}`), page.click(`a[href="${path}"]`)]);
		await expect(page.locator('h1')).toContainText(path.split('/')[1] as string);
	}
	for (const path of PATHS) await page.goto(`${fx.origin}${path}`);
	const tab = await context.newPage();
	await tab.goto(`${fx.origin}${PATHS[2]}`);
	await expect(tab.locator('h1')).toHaveText('n 3');

	expect(fx.hits.filter((h) => h.path !== '/spool-sw.js')).toEqual([]);
	if (browserName !== 'webkit') expect(fx.hits).toEqual([]);
});

test('the local render equals the network render on every fixture route', async ({
	page,
	browser
}) => {
	await warm(page);
	const blocked = await browser.newContext({ serviceWorkers: 'block' });
	const network = await blocked.newPage();

	for (const path of PATHS) {
		await network.goto(`${fx.origin}${path}`);
		const expected = await network.evaluate(() => document.documentElement.outerHTML);

		fx.hits.length = 0;
		await page.goto(`${fx.origin}${path}`);
		expect(hits(), `${path} reached the server`).toEqual([]);
		const local = await page.evaluate(() => document.documentElement.outerHTML);
		expect(normalise(local), path).toBe(normalise(expected));
	}
	await blocked.close();
});

test('hard: past the bound nothing is displayed before a required sync, then a change is seen', async ({
	page
}) => {
	await warm(page);
	await sleepPast(BOUND);
	const before = page.url();

	fx.hits.length = 0;
	const release = fx.holdSync();
	const navigation = page.goto(`${fx.origin}/hard/1`);
	await expect.poll(() => fx.hits.some((h) => h.path === '/.spool/sync')).toBe(true);
	expect(page.url()).toBe(before);
	expect(
		await Promise.race([
			navigation.then(() => 'displayed'),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 300))
		])
	).toBe('pending');
	expect(hits()).toEqual(['/.spool/sync']);

	release();
	await navigation;
	await expect(page.locator('h1')).toHaveText('hard 1');
	expect(hits()).toEqual(['/.spool/sync']);

	fx.db.set('1', 'edited body');
	await fx.spool.invalidate(['node:1']);
	await sleepPast(BOUND);
	fx.hits.length = 0;
	await page.goto(`${fx.origin}/hard/1`);
	await expect(page.locator('main p')).toHaveText('edited body');
	await expect.poll(hits).toEqual(['/.spool/sync', '/hard/1', '/.spool/artifact']);
});

test('soft: past the bound the local page shows first and exactly one sync follows', async ({
	page
}) => {
	await warm(page);
	await sleepPast(BOUND);

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/soft/1`);
	await expect(page.locator('h1')).toHaveText('soft 1');
	await expect.poll(hits).toEqual(['/.spool/sync']);

	await page.goto(`${fx.origin}/soft/1`);
	await page.goto(`${fx.origin}/n/1`);
	await page.goto(`${fx.origin}/soft/1`);
	await expect(page.locator('h1')).toHaveText('soft 1');
	await new Promise((r) => setTimeout(r, 300));
	expect(hits()).toEqual(['/.spool/sync']);
});

test('held beacons reach their own endpoint with the bodies the page sent, after the flush', async ({
	page
}) => {
	await warm(page);
	for (let i = 0; i < 2; i++) {
		await page.evaluate(() =>
			fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text())
		);
		await expect.poll(async () => (await status(page)).beacons).toBe(0);
	}

	fx.hits.length = 0;
	fx.sink.events.length = 0;
	const walked = ['/n/1', '/n/2', '/n/3', '/n/1'];
	for (const path of walked) await page.goto(`${fx.origin}${path}`);
	let held = -1;
	await expect
		.poll(async () => {
			const now = (await status(page)).beacons;
			const stable = now === held;
			held = now;
			return stable && now > 0;
		})
		.toBe(true);
	expect(held).toBeGreaterThanOrEqual(8);
	expect(fx.hits.map((h) => h.path)).not.toContain('/cdn-cgi/rum');
	expect(fx.hits.filter((h) => h.path === '/.spool/beacon')).toEqual([]);
	expect(fx.sink.events).toEqual([]);

	await page.evaluate(() =>
		fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text())
	);
	await expect.poll(async () => (await status(page)).beacons).toBe(0);
	await expect.poll(() => fx.hits.filter((h) => h.path === '/cdn-cgi/rum').length).toBe(8);

	const rum = fx.hits.filter((h) => h.path === '/cdn-cgi/rum');
	const sent = walked
		.flatMap((path) => [1, 2].map((n) => JSON.stringify({ page: path, n })))
		.sort();
	expect(rum.map((h) => h.body).sort()).toEqual(sent);
	expect(rum.every((h) => h.method === 'POST')).toBe(true);
	expect(rum.every((h) => h.type === 'text/plain;charset=UTF-8')).toBe(true);

	expect(fx.hits.filter((h) => h.path === '/.spool/beacon')).toHaveLength(1);
	const own = [VIEW_PATH, LOADS_PATH];
	expect(fx.sink.events.every((e) => own.includes(e.path))).toBe(true);
	expect(viewsOf(fx.sink.events).length).toBeGreaterThan(0);
});

test('closing IndexedDB on pagehide makes the connection unusable', async ({ page }) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	const result = await page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('probe', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('s');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		(client as Client).track(db);
		const attempt = () => {
			try {
				db.transaction('s');
				return 'open';
			} catch (error) {
				return (error as Error).name;
			}
		};
		const before = attempt();
		window.dispatchEvent(new Event('pagehide'));
		return { before, after: attempt() };
	});
	expect(result).toEqual({ before: 'open', after: 'InvalidStateError' });
});
