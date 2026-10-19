import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The contract spool rests on: once a service worker controls the page, a navigation it answers
 * never reaches the server. Registered with `updateViaCache: 'all'` and the script cached for a
 * day, Chromium and Firefox make no request at all; WebKit still re-checks the script.
 */

const PAGES = Array.from({ length: 7 }, (_, i) => `/node/${i + 1}`);
const shell = (title: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body><nav>${PAGES.map((p) => `<a href="${p}">${p}</a>`).join(' ')}</nav><main><h1>${title}</h1></main></body></html>`;
const SW = `const PAGES=${JSON.stringify(PAGES)};const SHELL=${JSON.stringify(shell('__T__'))};
self.addEventListener('install',e=>e.waitUntil(caches.open('v').then(c=>c.add('/site.css')).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.mode==='navigate'&&PAGES.includes(u.pathname)){e.respondWith(new Response(SHELL.split('__T__').join(u.pathname),{headers:{'content-type':'text/html'}}));return}if(u.pathname==='/site.css')e.respondWith(caches.match('/site.css'))});`;

let server: Server;
let origin = '';
const hits: string[] = [];

test.beforeAll(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		hits.push(path);
		if (path === '/spool-sw.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=86400'
			});
			return res.end(SW);
		}
		if (path === '/site.css') {
			res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=31536000' });
			return res.end('main{max-width:60ch}');
		}
		if (PAGES.includes(path)) {
			res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=0' });
			return res.end(shell(path));
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('a controlled navigation never reaches the server', async ({ page, context, browserName }) => {
	await page.goto(`${origin}${PAGES[0]}`);
	await page.evaluate(() =>
		navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
	);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.reload();

	hits.length = 0;
	for (const path of PAGES.slice(1)) {
		await Promise.all([page.waitForURL(`**${path}`), page.click(`a[href="${path}"]`)]);
		await expect(page.locator('h1')).toHaveText(path);
	}
	for (const path of PAGES.slice(1)) await page.goto(`${origin}${path}`);
	const tab = await context.newPage();
	await tab.goto(`${origin}${PAGES[6]}`);
	await expect(tab.locator('h1')).toHaveText(PAGES[6] as string);

	expect(hits.filter((path) => path !== '/spool-sw.js')).toEqual([]);
	if (browserName !== 'webkit') expect(hits).toEqual([]);
});
