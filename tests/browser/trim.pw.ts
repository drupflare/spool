import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeListener } from '../../src/node/listener';
import { spoolProxy, type SpoolProxy } from '../../src/proxy/index';
import { memoryStore } from '../../src/stores/index';
import { buildTrimManifest, type TrimManifest } from '../../src/trim/index';

const CSS = [
	'body{margin:0;font-size:16px}',
	'.hero{color:rgb(10,20,30);background-color:rgb(250,250,250)}',
	'.button{display:inline-block;padding-left:12px}',
	'.button:hover{color:rgb(200,0,0)}',
	'.js-added{font-weight:700}',
	'.open .menu{display:block;margin-top:5px}',
	'@media (min-width:1px){.wide{margin-top:7px}.never-on-any-page{display:none}}',
	'@font-face{font-family:x;src:local(Arial)}',
	'.print-only{display:none}',
	'.unseen{color:rgb(1,2,3)}'
].join('\n');

const APP = "document.body.classList.add('js-added')";

const shell = (body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="/site.css"></head><body>${body}<script src="/app.js"></script></body></html>`;

/** the pages the manifest is built from, and one it never saw */
const CORPUS: Record<string, string> = {
	'/p/1': shell('<div class="hero"><a class="button" href="#">Apply</a></div>'),
	'/p/2': shell('<div class="open"><ul class="menu"><li>One</li></ul></div>'),
	'/p/3': shell('<p class="wide">Wide</p>')
};
const UNSEEN = shell('<p class="unseen">Unseen</p>');

type Fixture = {
	front: string;
	origin: string;
	proxy: SpoolProxy;
	originHits: string[];
	setCss(text: string): void;
	stop(): Promise<void>;
};

async function start(manifest: TrimManifest): Promise<Fixture> {
	let css = CSS;
	const originHits: string[] = [];
	const originServer: Server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		originHits.push(url.pathname + url.search);
		if (url.pathname === '/site.css') {
			res.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'public, max-age=31536000'
			});
			return res.end(css);
		}
		if (url.pathname === '/app.js') {
			res.writeHead(200, { 'content-type': 'text/javascript' });
			return res.end(APP);
		}
		const html = url.pathname === '/p/unseen' ? UNSEEN : CORPUS[url.pathname];
		if (!html) {
			res.writeHead(404);
			return res.end('not found');
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html);
	});
	await new Promise<void>((resolve) => originServer.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(originServer.address() as AddressInfo).port}`;
	const proxy = spoolProxy({ origin, spool: { store: memoryStore() }, trim: manifest });
	const frontServer: Server = createServer(toNodeListener((request) => proxy(request)));
	await new Promise<void>((resolve) => frontServer.listen(0, '127.0.0.1', resolve));
	const close = (server: Server) =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return {
		front: `http://127.0.0.1:${(frontServer.address() as AddressInfo).port}`,
		origin,
		proxy,
		originHits,
		setCss: (text) => void (css = text),
		stop: async () => {
			await close(frontServer);
			await close(originServer);
		}
	};
}

const PROPS = [
	'color',
	'background-color',
	'display',
	'font-weight',
	'margin-top',
	'padding-left',
	'width'
];

/** every element's computed values for the properties the stylesheet sets */
const computed = (page: Page) =>
	page.evaluate(
		(props) =>
			[...document.querySelectorAll('body *:not(script)')].map((el) => [
				el.tagName,
				el.className,
				...props.map((p) => getComputedStyle(el).getPropertyValue(p))
			]),
		PROPS
	);

const manifestOf = () =>
	buildTrimManifest({
		pages: Object.values(CORPUS),
		scripts: [{ url: '/app.js', text: APP }],
		styles: [{ url: '/site.css', text: CSS }]
	});

let fx: Fixture;

test.beforeEach(async () => {
	fx = await start(await manifestOf());
});
test.afterEach(() => fx.stop());

test('a trimmed stylesheet gives each corpus page the computed styles the full file gives', async ({
	browser
}) => {
	const trimmed = await (await fetch(`${fx.front}/site.css`)).text();
	expect(trimmed).toContain('.hero{');
	expect(trimmed).toContain('.button:hover{');
	expect(trimmed).toContain('@font-face{');
	expect(trimmed).not.toContain('.print-only');
	expect(trimmed).not.toContain('.never-on-any-page');
	expect(trimmed).not.toContain('.unseen');
	expect(trimmed.length).toBeLessThan(CSS.length);

	for (const path of Object.keys(CORPUS)) {
		const proxied = await browser.newPage();
		await proxied.goto(`${fx.front}${path}`);
		const direct = await browser.newPage();
		await direct.goto(`${fx.origin}${path}`);
		const [mine, full] = [await computed(proxied), await computed(direct)];
		expect(mine.length, path).toBeGreaterThan(0);
		expect(mine, path).toEqual(full);
		await proxied.close();
		await direct.close();
	}
	expect(fx.proxy.trim.served).toBeGreaterThanOrEqual(3);
	expect(fx.proxy.trim.guarded).toBe(0);
	expect(fx.proxy.trim.mismatched).toBe(0);
});

test('a page with a token no corpus page had gets the full file through spool-trim=0', async ({
	browser
}) => {
	const page = await browser.newPage();
	await page.goto(`${fx.front}/p/unseen`);
	await expect(page.locator('link[rel=stylesheet]')).toHaveAttribute(
		'href',
		'/site.css?spool-trim=0'
	);
	expect(await page.locator('.unseen').evaluate((el) => getComputedStyle(el).color)).toBe(
		'rgb(1, 2, 3)'
	);
	expect(fx.proxy.trim.guarded).toBe(1);
	expect(fx.originHits).toContain('/site.css');
	expect(fx.originHits).not.toContain('/site.css?spool-trim=0');
	await page.close();
});

test('a changed origin file is served untrimmed and counted', async ({ browser }) => {
	fx.setCss(`${CSS}\n.hero{margin-top:9px}`);
	const page = await browser.newPage();
	await page.goto(`${fx.front}/p/1`);
	expect(await page.locator('.hero').evaluate((el) => getComputedStyle(el).marginTop)).toBe(
		'9px'
	);
	expect(fx.proxy.trim.mismatched).toBe(1);
	expect(fx.proxy.trim.served).toBe(0);
	expect(await (await fetch(`${fx.front}/site.css`)).text()).toContain('.print-only');
	await page.close();
});
