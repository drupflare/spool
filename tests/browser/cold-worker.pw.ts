import { chromium, expect, firefox, test, webkit, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeListener } from '../../src/node/listener';
import { defineRoute } from '../../src/protocol/index';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled } from './fixture';

/**
 * A browser restart stops the worker. The first document after it is answered by the worker from
 * the replica it holds. Chromium routes navigations to the worker while it starts, so no document
 * reaches the server. The worker sends assets to the browser (`assets: 'passthrough'`), so WebKit
 * refetches them unless the worker's probe finds the disk cache and forwards them.
 */
const DWELL_MS = 1_500;
const PAGES = ['/n/1', '/n/2', '/n/3'];
const ENGINES = { chromium, firefox, webkit };
const NOISE = new Set(['/.spool/beacon']);
const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' };

const layout = (title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
const TEMPLATE = layout('{{title}}', '{{body}}');

type Client = { status(): Promise<{ artifacts: string[] }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let server: Server;
let origin = '';
const hits: string[] = [];

test.beforeAll(async () => {
	const spool = createSpool({
		routes: [
			defineRoute('/n/:id', {
				strategy: 'template',
				template: { source: TEMPLATE },
				depends: (ctx) => [`node:${ctx.params['id']}`],
				load: (ctx) => ({
					title: `n ${ctx.params['id']}`,
					body: `body of ${ctx.params['id']}`
				}),
				freshness: { maxStale: 3600, mode: 'soft' }
			})
		],
		store: memoryStore(),
		assets: 'passthrough'
	});
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const [, kind, id = ''] = pathname.split('/');
		if (kind === 'n' && /^\d+$/.test(id)) {
			return new Response(layout(`n ${id}`, `body of ${id}`), { headers: HTML });
		}
		if (pathname === '/site.css') {
			return new Response('main{max-width:60ch}', {
				headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
			});
		}
		return new Response('missing', { status: 404 });
	};
	const listener = toNodeListener(async (request) => {
		hits.push(new URL(request.url).pathname);
		return spool.handle(request, app);
	});
	server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isDocument = (path: string) => /^\/n\//.test(path);
const isAsset = (path: string) => !isDocument(path) && path !== '/spool-sw.js' && !NOISE.has(path);
const seen = () => hits.filter((path) => !NOISE.has(path));
const held = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (await (client as Client).status()).artifacts;
	});

/** waits until no new server hit arrives for a moment */
async function quiet(): Promise<void> {
	for (let last = -1; hits.length !== last;) {
		last = hits.length;
		await sleep(300);
	}
}

test('a restarted worker answers the first document, and a controlled page fetches no asset', async ({
	browserName
}) => {
	const engine = ENGINES[browserName];
	const profile = await mkdtemp(join(tmpdir(), 'spool-cold-'));
	let context = await engine.launchPersistentContext(profile, { headless: true });
	try {
		let page = await context.newPage();
		await page.goto(`${origin}${PAGES[0]}`);
		// a page with no ring loads the runtime from the second view, so view 1 costs the baseline
		await sleep(DWELL_MS);
		await page.goto(`${origin}${PAGES[0]}`);
		await controlled(page);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
		for (const path of PAGES) {
			await sleep(DWELL_MS);
			await page.goto(`${origin}${path}`);
			await expect.poll(() => held(page)).toContain(path);
		}
		await quiet();
		await context.close();

		await sleep(DWELL_MS);
		context = await engine.launchPersistentContext(profile, { headless: true });
		page = await context.newPage();
		hits.length = 0;
		const response = await page.goto(`${origin}${PAGES[1]}`);
		await sleep(DWELL_MS);
		const restart = {
			fromServiceWorker: response?.fromServiceWorker() ?? false,
			requests: seen()
		};

		await sleep(DWELL_MS);
		hits.length = 0;
		await page.goto(`${origin}${PAGES[2]}`);
		await sleep(DWELL_MS);
		const fetched = seen();

		await sleep(DWELL_MS);
		hits.length = 0;
		const tab = await context.newPage();
		await tab.goto(`${origin}${PAGES[0]}`);
		await sleep(DWELL_MS);
		const newTab = seen();

		console.log(JSON.stringify({ engine: browserName, restart, controlled: fetched, newTab }));
		expect(restart.fromServiceWorker).toBe(true);
		if (browserName === 'chromium') expect(restart.requests.filter(isDocument)).toEqual([]);
		if (browserName === 'webkit') {
			expect(fetched.filter(isAsset)).toEqual([]);
			expect(newTab.filter(isAsset)).toEqual([]);
		}
	} finally {
		await context.close().catch(() => undefined);
		await rm(profile, { recursive: true, force: true });
	}
});
