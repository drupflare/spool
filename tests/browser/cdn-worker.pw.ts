import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { fileFor } from '../../scripts/cdn-manifest';
import { cdnWorkerUrl } from '../../src/cdn/location';
import { shellHash } from '../../src/protocol/index';
import { CLIENT_CORE, SW_CORE } from '../../src/server/embedded';
import { VERSION } from '../../src/version';
import { controlled, startFixture, type Fixture } from './fixture';

/**
 * `cdn.worker`: the stub is the config and one `importScripts` line, and the worker core comes from
 * another origin. The same page makes the same zero-request local views as with the core inline.
 */

const PATHS = ['/n/1', '/n/2', '/n/3', '/hard/1', '/soft/1', '/asm/about'];
const STUB_LIMIT = 32_768;
const PORT = 7021;
const CDN = `http://127.0.0.1:${PORT}`;
const CLIENT_URL = `${CDN}/spool/${VERSION}/client.js`;

type SpoolWindow = { spool: { ready: Promise<{ status(): Promise<{ artifacts: string[] }> }> } };

let cdn: Server;
let cdnHits: string[] = [];
let fx: Fixture;
let coreUrl = '';

test.beforeAll(async () => {
	coreUrl = new URL(cdnWorkerUrl(VERSION, await shellHash(SW_CORE))).pathname;
	const { integrity } = fileFor(new TextEncoder().encode(CLIENT_CORE));
	cdn = createServer((req, res) => {
		cdnHits.push(req.url ?? '');
		const path = new URL(req.url ?? '/', CDN).pathname;
		const body = path.endsWith('/spool-sw.js') ? SW_CORE : CLIENT_CORE;
		res.writeHead(200, {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'public, max-age=31536000, immutable',
			'access-control-allow-origin': '*'
		});
		res.end(body);
	});
	await new Promise<void>((resolve) => cdn.listen(PORT, '127.0.0.1', resolve));
	fx = await startFixture({
		cdn: {
			url: CLIENT_URL,
			integrity,
			worker: { url: `${CDN}${coreUrl}?h=${await shellHash(SW_CORE)}` }
		}
	});
});

test.afterAll(async () => {
	await fx.stop();
	await new Promise<void>((resolve) => {
		cdn.closeAllConnections();
		cdn.close(() => resolve());
	});
});

test.beforeEach(() => {
	cdnHits = [];
});

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return client.status();
	});

/** waits until the server has seen no new request for a moment, so a flush started by the last view has landed */
async function quiet(): Promise<void> {
	for (let last = -1; fx.hits.length !== last;) {
		last = fx.hits.length;
		await new Promise((r) => setTimeout(r, 300));
	}
}

test('the stub holds the config and one importScripts line, and the core comes from the CDN origin', async ({
	page
}) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await controlled(page);
	const stub = await (await fetch(`${fx.origin}/spool-sw.js`)).text();
	expect(Buffer.byteLength(stub)).toBeLessThan(STUB_LIMIT);
	expect(stub).not.toContain(SW_CORE.slice(0, 200));
	expect(stub.slice(stub.indexOf('\n') + 1)).toMatch(
		/^importScripts\("http:\/\/127\.0\.0\.1:7021\/spool\/[^"]+\/spool-sw\.js\?h=[\w-]+"\);$/
	);
	expect(fx.hits.some((h) => h.path.endsWith('/spool-sw.js') && h.path !== '/spool-sw.js')).toBe(
		false
	);
	const core = cdnHits.filter((url) => url.includes('/spool-sw.js'));
	expect(core.length).toBeGreaterThanOrEqual(1);
	expect(new Set(core).size).toBe(1);
	expect(core[0]).toBe(`${coreUrl}?h=${await shellHash(SW_CORE)}`);
});

test('a provisioned route makes 0 server hits and 0 CDN hits per local navigation', async ({
	page,
	context,
	browserName
}) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await controlled(page);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	for (const path of PATHS) {
		await page.goto(`${fx.origin}${path}`);
		await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	}
	await quiet();
	await page.goto(`${fx.origin}${PATHS[0]}`);
	fx.hits.length = 0;
	cdnHits = [];

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
	if (browserName !== 'webkit')
		expect(cdnHits.filter((url) => url.includes('/spool-sw.js'))).toEqual([]);
});
