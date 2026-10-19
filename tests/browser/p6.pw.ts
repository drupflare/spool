import { expect, test, type Page } from '@playwright/test';
import { thirdPartyReport } from '../../src/report/index';
import { viewsOf } from '../../src/server/index';
import { startP6, type P6Fixture } from './fixture-p56';

let fx: P6Fixture;

test.afterEach(() => fx?.stop());

const own = () => fx.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');

const ask = <T>(page: Page, message: object): Promise<T> =>
	page.evaluate(
		(m) =>
			new Promise<T>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data as T);
				(navigator.serviceWorker.controller as ServiceWorker).postMessage(m, [
					channel.port2
				]);
			}),
		message
	);

const artifacts = async (page: Page) =>
	(await ask<{ artifacts: string[] }>(page, { type: 'spool:status' })).artifacts;
const beacons = async (page: Page) =>
	(await ask<{ beacons: number }>(page, { type: 'spool:status' })).beacons;

async function register(page: Page, path: string): Promise<void> {
	await page.goto(`${fx.origin}${path}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(
		() => (globalThis as unknown as { spool: { ready: Promise<unknown> } }).spool.ready
	);
}

/** a network moment: a write the worker passes through, or a navigation, the only kind Static Routing leaves in play */
const moment = async (page: Page, viaNavigation = false) => {
	if (viaNavigation) await page.goto(`${fx.origin}/moment`);
	else {
		await page.evaluate(() =>
			fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text())
		);
	}
};

const FONT_PATH = '/s/t/v1/a.woff2';
/** WebKit does not send the font a stylesheet asks for through the worker, so its requests stay */
const fontless = (browserName: string) => (browserName === 'webkit' ? [FONT_PATH] : []);
const unheld = (browserName: string) =>
	fx.other.hits.filter((h) => !fontless(browserName).includes(h.path));

test('a data route answers an API GET locally, with 0 requests on the wire', async ({ page }) => {
	fx = await startP6();
	await register(page, '/data-page');
	await page.goto(`${fx.origin}/data-page`);
	await expect(page.locator('#out')).toHaveText('Course 1');
	await expect.poll(() => artifacts(page)).toContain('/api/course/1');

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/data-page`);
	await expect(page.locator('h1')).toHaveText('data');
	await expect(page.locator('#out')).toHaveText('Course 1');
	expect(own()).toEqual([]);
	const direct = await page.evaluate(() => fetch('/api/course/1').then((r) => r.json()));
	expect(direct).toEqual({ id: '1', title: 'Course 1' });
	expect(own()).toEqual([]);
});

test("a projection route renders through the renderer in the site's own bundled worker, with no request", async ({
	page
}) => {
	fx = await startP6();
	await register(page, '/p/1');
	await page.goto(`${fx.origin}/p/1`);
	await expect.poll(() => artifacts(page)).toContain('/p/1');

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/p/1`);
	await expect(page.locator('h1')).toHaveText('projection 1');
	await expect(page.locator('main, body')).toContainText('label 1');
	expect(own()).toEqual([]);
	const script = await page.evaluate(() => fetch('/spool-sw.js').then((r) => r.text()));
	expect(script.startsWith('self.__SPOOL_CONFIG__=')).toBe(true);
});

async function thirdPartyFlow(
	page: Page,
	browserName: string,
	viaNavigation = false
): Promise<void> {
	await register(page, '/third/1');
	await page.goto(`${fx.origin}/third/1`);
	await page.goto(`${fx.origin}/third/2`);
	await expect
		.poll(async () => (await ask<{ third: string[] }>(page, { type: 'spool:held' })).third)
		.toEqual(
			browserName === 'webkit'
				? [`${fx.other.origin}/lib.3f9a1c2b4d.js`]
				: [`${fx.other.origin}/lib.3f9a1c2b4d.js`, `${fx.other.origin}${FONT_PATH}`]
		);
	await expect
		.poll(() => artifacts(page))
		.toEqual(expect.arrayContaining(['/third/1', '/third/2']));
	await moment(page, viaNavigation);
	// a page reports its loads when it is hidden, so a navigation leaves that one report held
	if (viaNavigation) await expect.poll(() => beacons(page)).toBeLessThanOrEqual(1);
	else await expect.poll(() => beacons(page)).toBe(0);
}

test('a versioned cross-origin font and script make 0 requests on the wire per local view, and a held collector waits for a network moment', async ({
	page,
	browserName
}) => {
	fx = await startP6();
	await thirdPartyFlow(page, browserName);
	expect(fx.other.hits.filter((h) => h.path === '/collect').length).toBeGreaterThan(0);

	fx.hits.length = 0;
	fx.other.hits.length = 0;
	fx.sink.events.length = 0;
	for (const path of ['/third/1', '/third/2', '/third/1']) {
		await page.goto(`${fx.origin}${path}`);
		await expect(page.locator('h1')).toHaveText(`third ${path.slice(-1)}`);
		expect(
			await page.evaluate(() => (window as unknown as { __third?: boolean }).__third)
		).toBe(true);
	}
	expect(own()).toEqual([]);
	if (browserName !== 'webkit') expect(fx.hits).toEqual([]);
	expect(unheld(browserName)).toEqual([]);
	expect(fx.other.hits.length).toBeLessThanOrEqual(3);
	await expect.poll(() => beacons(page)).toBeGreaterThanOrEqual(3);

	await moment(page);
	await expect.poll(() => beacons(page)).toBe(0);
	await expect.poll(() => fx.other.hits.filter((h) => h.path === '/collect').length).toBe(3);
	const collected = fx.other.hits.filter((h) => h.path === '/collect');
	expect(collected.every((h) => h.method === 'POST' && h.body === 'hit')).toBe(true);
	const params = collected.map((h) => new URLSearchParams(h.search));
	expect(params.every((p) => p.get('cid') === '7' && Number(p.get('qt')) >= 0)).toBe(true);
	expect(params.map((p) => p.get('p')).sort()).toEqual(['/third/1', '/third/1', '/third/2']);
	expect(fx.other.hits.filter((h) => h.path !== '/collect' && h.path !== FONT_PATH)).toEqual([]);
});

test('the per-site report names the origin that stops a view being zero-network', async ({
	page,
	browserName
}) => {
	fx = await startP6();
	await thirdPartyFlow(page, browserName);
	for (const path of ['/third/1', '/third/2', '/third/1']) await page.goto(`${fx.origin}${path}`);
	await page.goto(`${fx.origin}/p/1`);
	await moment(page);
	await expect.poll(() => beacons(page)).toBe(0);
	await expect
		.poll(() => thirdPartyReport(viewsOf(fx.sink.events)).rows.map((r) => r.origin))
		.toContain(fx.other.origin);
	const report = thirdPartyReport(viewsOf(fx.sink.events));
	const row = report.rows.find((r) => r.origin === fx.other.origin);
	expect(row?.views).toBeGreaterThan(0);
	expect(row?.loads).toBeGreaterThanOrEqual(2 * (row?.views ?? 0));
	expect(report.blocked).toBeGreaterThan(0);
});

test('static routing takes effect only where the browser has it, and local views still make no request', async ({
	page,
	browserName
}) => {
	fx = await startP6({ assets: 'static-routing' });
	await thirdPartyFlow(page, browserName, true);
	const assets = await ask<{ mode: string; routed: boolean }>(page, { type: 'spool:assets' });
	expect(assets.mode).toBe('static-routing');
	expect(assets.routed).toBe(browserName !== 'firefox');

	fx.hits.length = 0;
	fx.other.hits.length = 0;
	await page.goto(`${fx.origin}/third/2`);
	await expect(page.locator('h1')).toHaveText('third 2');
	expect(own()).toEqual([]);
	expect(unheld(browserName)).toEqual([]);
});

test('passthrough leaves subresources to the browser and keeps local views at 0 requests', async ({
	page,
	browserName
}) => {
	fx = await startP6({ assets: 'passthrough' });
	await thirdPartyFlow(page, browserName);
	expect(await ask(page, { type: 'spool:assets' })).toEqual({
		type: 'spool:assets',
		mode: 'passthrough',
		routed: false
	});
	fx.hits.length = 0;
	await page.goto(`${fx.origin}/third/1`);
	await expect(page.locator('h1')).toHaveText('third 1');
	expect(own()).toEqual([]);
});
