import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLIENT_CORE, SW_CORE } from '../../src/server/embedded';

/**
 * A site that is only files: pages, assets, `spool-sw.js`, `client.js` and `spool.json`, with no
 * spool code on the server. The server log is the arbiter of what reached it.
 */

type File = { body: string | Buffer; type: string };

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TAG = '<script src="/client.js" defer data-spool-client></script>';

const page = (title: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/css/site.css"><script src="/js/app.js" defer></script>${TAG}</head><body><nav><a href="/">home</a> <a href="/about">about</a> <a href="/contact">contact</a></nav><h1>${title}</h1><p id="js">no script</p><img id="dot" src="/img/dot.gif"></body></html>`;

const HARD = 2;

let server: Server;
let origin = '';
let hits: string[] = [];
const files = new Map<string, File>();

const sha = (body: string | Buffer) =>
	`sha256-${createHash('sha256').update(body).digest('base64')}`;

function manifest(): string {
	const routes = [...files.entries()]
		.filter(([path]) => path !== '/spool.json' && path !== '/spool-sw.js')
		.map(([path, file]) => ({
			pattern: path,
			strategy: 'static',
			version: path.endsWith('.css') ? 'css-1' : sha(file.body),
			...(path === '/changing' ? { freshness: { maxStale: HARD, mode: 'hard' } } : {})
		}));
	return JSON.stringify({ schema: 1, routes });
}

function reset(): void {
	files.clear();
	files.set('/', { body: page('home'), type: 'text/html; charset=utf-8' });
	files.set('/about', { body: page('about'), type: 'text/html; charset=utf-8' });
	files.set('/contact', { body: page('contact'), type: 'text/html; charset=utf-8' });
	files.set('/changing', { body: page('changing 1'), type: 'text/html; charset=utf-8' });
	files.set('/css/site.css', { body: 'h1{color:#036}', type: 'text/css' });
	files.set('/js/app.js', {
		body: "document.getElementById('js').textContent='js ok'",
		type: 'text/javascript'
	});
	files.set('/img/dot.gif', { body: GIF, type: 'image/gif' });
	files.set('/client.js', { body: CLIENT_CORE, type: 'text/javascript; charset=utf-8' });
}

test.beforeAll(async () => {
	reset();
	server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		hits.push(path);
		if (path === '/spool.json') {
			res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
			return res.end(manifest());
		}
		if (path === '/spool-sw.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=86400'
			});
			return res.end(SW_CORE);
		}
		const file = files.get(path);
		if (!file) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache' });
		res.end(file.body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Client = { status(): Promise<{ artifacts: string[] }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

const stored = (target: Page) =>
	target.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (await (client as Client).status()).artifacts;
	});

/** registers the worker, then loads every page twice so the second load, controlled, stores it */
async function warm(target: Page, paths: string[]): Promise<void> {
	await target.goto(`${origin}/`);
	await target.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await target.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	for (const path of paths) {
		await target.goto(`${origin}${path}`);
		await expect
			.poll(async () => await stored(target), { timeout: 15_000 })
			.toEqual(expect.arrayContaining([path, '/css/site.css', '/js/app.js', '/img/dot.gif']));
	}
}

test('a static site makes 0 server hits per local view, assets included', async ({
	page: tab,
	context,
	browserName
}) => {
	reset();
	await warm(tab, ['/', '/about', '/contact']);
	await tab.goto(`${origin}/`);
	hits = [];

	for (const path of ['/about', '/contact', '/']) {
		await Promise.all([tab.waitForURL(`**${path}`), tab.click(`a[href="${path}"]`)]);
		await expect(tab.locator('#js')).toHaveText('js ok');
		await expect(tab.locator('#dot')).toHaveJSProperty('naturalWidth', 1);
	}
	for (const path of ['/about', '/contact', '/']) await tab.goto(`${origin}${path}`);
	const other = await context.newPage();
	await other.goto(`${origin}/about`);
	await expect(other.locator('h1')).toHaveText('about');
	await expect(other.locator('#js')).toHaveText('js ok');

	expect(hits.filter((path) => path !== '/spool-sw.js')).toEqual([]);
	if (browserName !== 'webkit') expect(hits).toEqual([]);
});

test('a changed file is picked up after spool.json changes', async ({ page: tab }) => {
	reset();
	await warm(tab, ['/', '/changing']);
	await tab.goto(`${origin}/changing`);
	await expect(tab.locator('h1')).toHaveText('changing 1');

	files.set('/changing', { body: page('changing 2'), type: 'text/html; charset=utf-8' });
	await new Promise((resolve) => setTimeout(resolve, (HARD + 0.5) * 1000));
	hits = [];
	await tab.goto(`${origin}/changing`);
	await expect(tab.locator('h1')).toHaveText('changing 2');
	expect(hits).toContain('/spool.json');
	expect(hits).toContain('/changing');
	expect(hits.filter((path) => path.startsWith('/.spool'))).toEqual([]);

	await expect.poll(async () => await stored(tab)).toContain('/changing');
	hits = [];
	await tab.goto(`${origin}/changing`);
	await expect(tab.locator('h1')).toHaveText('changing 2');
	expect(hits.filter((path) => path !== '/spool-sw.js')).toEqual([]);
});
