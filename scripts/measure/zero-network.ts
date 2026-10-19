import { chromium, firefox, webkit, type BrowserType } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import {
	MEASUREMENTS_DIR,
	isMain,
	localMachine,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';

/** how a worker is registered and served: the two settings the readings compare */
export type Arm = { name: string; cacheControl: string; updateViaCache: 'imports' | 'all' };

export const ARMS: Arm[] = [
	{ name: 'default registration', cacheControl: 'max-age=0', updateViaCache: 'imports' },
	{
		name: 'updateViaCache all, script max-age 86400',
		cacheControl: 'max-age=86400',
		updateViaCache: 'all'
	}
];

const ENGINES: Array<[string, BrowserType]> = [
	['chromium', chromium],
	['firefox', firefox],
	['webkit', webkit]
];

const PAGES = Array.from({ length: 12 }, (_, i) => `/node/${i + 1}`);
const PAD = 'x'.repeat(30_000);
const DATA = Object.fromEntries(
	PAGES.map((p, i) => [
		p,
		{ title: `Node ${i + 1}`, body: `<h1>Node ${i + 1}</h1><p>${PAD}</p>` }
	])
);

const shell = (title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/assets/site.css"><script src="/assets/site.js" defer></script></head><body><nav>${PAGES.map((p) => `<a href="${p}">${p}</a>`).join(' ')}</nav><main>${body}</main></body></html>`;

/** the worker: renders the 12 routes from an embedded map and serves assets from CacheStorage */
const WORKER = `
const V = 'zero-network-1';
const DATA = ${JSON.stringify(DATA)};
const SHELL = ${JSON.stringify(shell('__T__', '__B__'))};
self.addEventListener('install', (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(['/assets/site.css', '/assets/site.js'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
	const u = new URL(e.request.url);
	if (e.request.mode === 'navigate' && DATA[u.pathname]) {
		const d = DATA[u.pathname];
		e.respondWith(new Response(SHELL.replace('__T__', d.title).replace('__B__', d.body), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
		return;
	}
	if (u.pathname.startsWith('/assets/')) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
`;

/** an origin that logs every request path; `hits()` is what the server saw */
export async function startOrigin(
	arm: Arm
): Promise<{ origin: string; hits: string[]; stop(): Promise<void> }> {
	const hits: string[] = [];
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		if (url.pathname !== '/favicon.ico') hits.push(url.pathname);
		if (url.pathname === '/sw.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': arm.cacheControl
			});
			return void res.end(WORKER);
		}
		if (url.pathname === '/assets/site.css') {
			res.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'public, max-age=31536000, immutable'
			});
			return void res.end('body{font-family:sans-serif} main{max-width:60ch}');
		}
		if (url.pathname === '/assets/site.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'public, max-age=31536000, immutable'
			});
			return void res.end(
				`if (navigator.serviceWorker && !navigator.serviceWorker.controller && location.search.includes('install')) navigator.serviceWorker.register('/sw.js', { updateViaCache: '${arm.updateViaCache}' });`
			);
		}
		const page = DATA[url.pathname] ?? (url.pathname === '/' ? DATA['/node/1'] : undefined);
		if (page) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0, must-revalidate',
				etag: '"v1"'
			});
			return void res.end(shell(page.title, page.body));
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { origin, hits, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 6 link clicks, 6 typed navigations and a new tab in one engine against a fresh origin */
export async function walkEngine(
	name: string,
	engine: BrowserType,
	arm: Arm
): Promise<Record<string, unknown>> {
	const origin = await startOrigin(arm);
	const browser = await engine.launch();
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(`${origin.origin}/node/1?install`);
	await page
		.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 })
		.catch(() => undefined);
	await page.reload();
	await page.waitForTimeout(500);
	const controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
	const rows: Array<Record<string, unknown>> = [];
	for (const mode of ['click', 'goto'] as const) {
		for (const p of PAGES.slice(1, 7)) {
			const before = origin.hits.length;
			const t0 = Date.now();
			if (mode === 'click') {
				await Promise.all([page.waitForURL(`**${p}`), page.click(`a[href="${p}"]`)]);
			} else {
				await page.goto(origin.origin + p);
			}
			await page.waitForLoadState('load');
			await page.waitForTimeout(300);
			rows.push({ mode, p, ms: Date.now() - t0, serverHits: origin.hits.slice(before) });
		}
	}
	const second = await context.newPage();
	const before = origin.hits.length;
	await second.goto(`${origin.origin}/node/9`);
	await second.waitForTimeout(500);
	rows.push({ mode: 'new-tab', p: '/node/9', serverHits: origin.hits.slice(before) });
	const version = browser.version();
	await browser.close();
	await origin.stop();
	return {
		arm: arm.name,
		env: { SW_CC: arm.cacheControl, SW_UVC: arm.updateViaCache },
		engine: name,
		engineVersion: version,
		controlled,
		rows
	};
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		machine: values.machine,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'zero-network',
					date: utcDate(),
					arms: ARMS.map((a) => a.name),
					engines: ENGINES.map(([n]) => n),
					out: args.out
				},
				null,
				2
			)
		);
	} else {
		const rows: Array<Record<string, unknown>> = [];
		for (const arm of ARMS) {
			for (const [name, engine] of ENGINES) rows.push(await walkEngine(name, engine, arm));
		}
		const draft: Draft = {
			rig: 'zero-network',
			date: utcDate(),
			layer: 'L1',
			question:
				'server hits per service-worker-served navigation, by registration setting and engine',
			instrument:
				'request log of the in-process origin (the browser is not trusted to report fromServiceWorker)',
			machine: localMachine(args.machine),
			software: { browsers: 'Chromium, Firefox, WebKit, Playwright bundled builds' },
			method: {
				'views per engine': 13,
				modes: 'clicks, typed navigations, a new tab',
				pages: '12 synthetic 30 KB pages',
				origin: 'localhost'
			},
			exclusions: [],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
