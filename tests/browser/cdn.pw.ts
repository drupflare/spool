import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileFor } from '../../scripts/cdn-manifest';
import { CLIENT_CORE } from '../../src/server/embedded';
import { viewsOf } from '../../src/server/index';
import { VERSION } from '../../src/version';
import { startFixture, type Fixture } from './fixture';

type SpoolWindow = { spool?: { ready: Promise<unknown> } };

const bytes = new TextEncoder().encode(CLIENT_CORE);
const { integrity } = fileFor(bytes);

let cdn: Server;
let cdnUrl: string;
let cdnHits: string[] = [];
let withSri: Fixture;
let withBadSri: Fixture;

test.beforeAll(async () => {
	cdn = createServer((req, res) => {
		cdnHits.push(req.url ?? '');
		res.writeHead(200, {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'public, max-age=31536000, immutable',
			'access-control-allow-origin': '*'
		});
		res.end(bytes);
	});
	await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve));
	cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/spool/${VERSION}/client.js`;
	withSri = await startFixture({ cdn: { url: cdnUrl, integrity } });
	withBadSri = await startFixture({
		cdn: { url: cdnUrl, integrity: `sha384-${'A'.repeat(64)}` }
	});
});

test.afterAll(async () => {
	await Promise.all([
		withSri.stop(),
		withBadSri.stop(),
		new Promise<void>((resolve) => {
			cdn.closeAllConnections();
			cdn.close(() => resolve());
		})
	]);
});

test.beforeEach(() => {
	cdnHits = [];
});

test('the page runtime loads from another origin with SRI, registers the worker and is not counted as a cross-origin load', async ({
	page,
	browserName
}) => {
	await page.goto(`${withSri.origin}/n/1`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	expect(
		await page.evaluate(() => (window as unknown as SpoolWindow).spool?.ready)
	).not.toBeNull();
	await expect(page.locator('script[data-spool-client]')).toHaveAttribute('integrity', integrity);
	await expect(page.locator('script[data-spool-client]')).toHaveAttribute('src', cdnUrl);

	for (const path of ['/n/2', '/n/3', '/n/1']) {
		await page.goto(`${withSri.origin}${path}`);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool?.ready);
	}
	await page.goto(`${withSri.origin}/n/2`);

	const fetches = browserName === 'webkit' ? 2 : 1;
	expect(cdnHits).toEqual(Array(fetches).fill(`/spool/${VERSION}/client.js`));
	expect(withSri.hits.some((h) => h.path.endsWith('/client.js'))).toBe(false);
	const loads = () =>
		viewsOf(withSri.sink.events)
			.filter((v) => v.route === '/n/:id')
			.map((v) => v.crossOriginLoads);
	// a loads report leaves when its page is hidden, which can be a later flush than its view
	await expect.poll(() => loads().some((count) => count === 0)).toBe(true);
	expect(loads().some((count) => count === 1)).toBe(false);
});

test('a script whose bytes do not match the integrity hash never runs', async ({ page }) => {
	await page.goto(`${withBadSri.origin}/n/1`);
	await page.waitForLoadState('load');
	expect(await page.evaluate(() => (window as unknown as SpoolWindow).spool)).toBeUndefined();
	expect(await page.locator('h1').textContent()).toBe('n 1');
});
