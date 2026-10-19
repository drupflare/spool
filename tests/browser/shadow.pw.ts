import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { viewsOf } from '../../src/server/index';
import { VIEW_BATCH } from '../../src/sw/analytics';
import { startFixture, type Fixture } from './fixture';

const WARM = ['/n/1', '/n/2', '/div/1'];
const ROUNDS = VIEW_BATCH + 5;

type Client = { status(): Promise<{ artifacts: string[]; beacons: number }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startFixture({ mode: 'shadow' });
});

test.afterAll(() => fx.stop());

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

/** every request the server saw that is not spool's own, counted by path */
const pageRequests = (from: number) => {
	const counts: Record<string, number> = {};
	for (const hit of fx.hits.slice(from)) {
		if (hit.path.startsWith('/.spool/') || hit.path === '/spool-sw.js') continue;
		const key = `${hit.method} ${hit.path}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
};

const own = (path: string, from: number) =>
	fx.hits.slice(from).filter((hit) => hit.path === path).length;

/** each page posts its analytics twice; wait for both so the next navigation cannot cancel one */
async function load(page: Page, path: string): Promise<void> {
	const before = fx.hits.filter((h) => h.path === '/cdn-cgi/rum').length;
	await page.goto(`${fx.origin}${path}`);
	await expect
		.poll(() => fx.hits.filter((h) => h.path === '/cdn-cgi/rum').length)
		.toBe(before + 2);
}

async function walk(context: BrowserContext, withWorker: boolean): Promise<Page> {
	const page = await context.newPage();
	await load(page, WARM[0] as string);
	if (withWorker) {
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	}
	for (const path of WARM) {
		await load(page, path);
		if (withWorker)
			await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	}
	for (let i = 0; i < ROUNDS; i++) await load(page, WARM[i % WARM.length] as string);
	return page;
}

test('shadow mode makes the requests the page would make, plus only the batched flushes', async ({
	browser,
	browserName
}) => {
	const blocked = await browser.newContext({ serviceWorkers: 'block' });
	const before = fx.hits.length;
	await walk(blocked, false);
	const baseline = pageRequests(before);
	await blocked.close();

	const context = await browser.newContext();
	fx.sink.events.length = 0;
	const start = fx.hits.length;
	const page = await walk(context, true);
	await expect
		.poll(() => viewsOf(fx.sink.events).length)
		.toBeGreaterThanOrEqual(WARM.length + VIEW_BATCH);

	// WebKit fetches a page's cacheable subresources once more on the first load the worker controls
	const expected = { ...baseline };
	if (browserName === 'webkit') expected['GET /site.css'] = (expected['GET /site.css'] ?? 0) + 1;
	expect(pageRequests(start)).toEqual(expected);
	expect(own('/.spool/artifact', start)).toBe(0);
	expect(own('/.spool/sync', start)).toBe(0);
	expect(own('/.spool/beacon', start)).toBe(WARM.length + 1);
	await expect
		.poll(async () => (await status(page)).beacons)
		.toBeGreaterThanOrEqual(ROUNDS - VIEW_BATCH);
	await context.close();
});

test('a divergent route reports mismatch and a matching route never does', async ({ browser }) => {
	const context = await browser.newContext();
	fx.sink.events.length = 0;
	await walk(context, true);
	await expect
		.poll(() => viewsOf(fx.sink.events).length)
		.toBeGreaterThanOrEqual(WARM.length + VIEW_BATCH);

	const shadow = viewsOf(fx.sink.events).filter((v) => v.reason === 'fresh');
	// the batch leaves at the moment that finds VIEW_BATCH held; that navigation's own view may beat it
	expect([VIEW_BATCH, VIEW_BATCH + 1]).toContain(shadow.length);
	expect(shadow.every((v) => v.tier === 'shadow')).toBe(true);
	const rounds = Array.from({ length: shadow.length }, (_, i) => WARM[i % WARM.length] as string);
	const loads = (prefix: string) => rounds.filter((path) => path.startsWith(prefix)).length;
	const mismatches = (route: string) =>
		shadow.filter((v) => v.route === route).map((v) => v.mismatch);
	expect(mismatches('/n/:id')).toEqual(Array.from({ length: loads('/n/') }, () => false));
	expect(mismatches('/div/:id')).toEqual(Array.from({ length: loads('/div/') }, () => true));
	expect(new Set(shadow.map((v) => v.engine)).size).toBe(1);
	await context.close();
});
