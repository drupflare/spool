import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
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

/** CPU seconds of every Playwright Chromium process in `ps -A -o time=,command=` output */
export function psCpuSeconds(output: string, pattern = /ms-playwright\/chromium/): number {
	let total = 0;
	for (const line of output.split('\n')) {
		if (!pattern.test(line)) continue;
		const parts = (line.trim().split(/\s+/)[0] ?? '').split(':').map(Number);
		total +=
			parts.length === 3
				? (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number)
				: (parts[0] as number) * 60 + (parts[1] as number);
	}
	return total;
}

const PAGES = Array.from({ length: 10 }, (_, i) => `/node/${i + 1}`);
const PAD = `<p>${'lorem ipsum dolor sit amet '.repeat(1200)}</p>`;
const DATA = Object.fromEntries(
	PAGES.map((p, i) => [p, { t: `Node ${i + 1}`, b: `<h1>Node ${i + 1}</h1>${PAD}` }])
);
const shell = (t: string, b: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><link rel="stylesheet" href="/a/site.css"><script src="/a/site.js" defer></script></head><body><nav>${PAGES.map((p) => `<a href="${p}">${p}</a>`).join(' ')}</nav><main>${b}</main></body></html>`;
const WORKER = `const D=${JSON.stringify(DATA)};const S=${JSON.stringify(shell('__T__', '__B__'))};
self.addEventListener('install',e=>e.waitUntil(caches.open('v').then(c=>c.addAll(['/a/site.css','/a/site.js'])).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.mode==='navigate'&&D[u.pathname]){const d=D[u.pathname];e.respondWith(new Response(S.replace('__T__',d.t).replace('__B__',d.b),{headers:{'content-type':'text/html'}}));return}if(u.pathname.startsWith('/a/'))e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** an origin that waits `rttMs` before every answer and counts what reaches it */
async function startOrigin(rttMs: number) {
	const state = { hits: 0 };
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		state.hits++;
		await sleep(rttMs);
		if (url.pathname === '/sw.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=86400'
			});
			return void res.end(WORKER);
		}
		if (url.pathname === '/a/site.css') {
			res.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'max-age=31536000, immutable'
			});
			return void res.end('body{font:16px sans-serif}main{max-width:60ch}'.repeat(200));
		}
		if (url.pathname === '/a/site.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=31536000, immutable'
			});
			return void res.end(
				`window.x=[...Array(2000).keys()].map(i=>i*i).length;if(location.search.includes('sw'))navigator.serviceWorker.register('/sw.js',{updateViaCache:'all'});`
			);
		}
		const page = DATA[url.pathname];
		if (!page) {
			res.writeHead(404);
			return void res.end();
		}
		if (req.headers['if-none-match'] === '"v1"') {
			res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=0, must-revalidate' });
			return void res.end();
		}
		res.writeHead(200, {
			'content-type': 'text/html',
			etag: '"v1"',
			'cache-control': 'max-age=0, must-revalidate'
		});
		res.end(shell(page.t, page.b));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		state,
		stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

/** one run of one arm: warm up, then `navs` navigations, with the browser tree's CPU read around them */
export async function runArm(arm: 'network' | 'spool', navs: number, rttMs: number) {
	const { origin, state, stop } = await startOrigin(rttMs);
	const browser = await chromium.launch();
	const page = await (await browser.newContext()).newPage();
	await page.goto(`${origin}/node/1${arm === 'spool' ? '?sw' : ''}`);
	if (arm === 'spool') {
		await page
			.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 })
			.catch(() => undefined);
		await page.reload();
	}
	for (const p of PAGES) await page.goto(origin + p);
	await page.waitForTimeout(1500);
	const cpu = () => psCpuSeconds(execFileSync('ps', ['-A', '-o', 'time=,command=']).toString());
	const c0 = cpu();
	const h0 = state.hits;
	const t0 = Date.now();
	for (let i = 0; i < navs; i++) {
		await page.goto(origin + PAGES[i % PAGES.length]);
		await page.waitForLoadState('load');
	}
	const wall = Date.now() - t0;
	await page.waitForTimeout(1500);
	const c1 = cpu();
	await browser.close();
	await stop();
	return {
		cpuS: Number((c1 - c0).toFixed(2)),
		wallMsPerNav: Math.round(wall / navs),
		serverHitsPerNav: Number(((state.hits - h0) / navs).toFixed(2))
	};
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			navs: { type: 'string', default: '60' },
			rtt: { type: 'string', default: '40' },
			runs: { type: 'string', default: '2' },
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		navs: Number(values.navs),
		rttMs: Number(values.rtt),
		runs: Number(values.runs),
		machine: values.machine,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(JSON.stringify({ rig: 'device-cpu', date: utcDate(), ...args }, null, 2));
	} else {
		const rows: Array<Record<string, unknown>> = [];
		for (let run = 0; run < args.runs; run++) {
			for (const arm of ['network', 'spool'] as const) {
				rows.push({ arm, run, ...(await runArm(arm, args.navs, args.rttMs)) });
			}
		}
		const draft: Draft = {
			rig: 'device-cpu',
			date: utcDate(),
			layer: 'L1',
			question:
				'browser CPU seconds per navigation: HTTP 304 revalidation vs a service-worker render',
			instrument:
				'CPU time of the Playwright Chromium process tree (ps), a proxy for device energy, not joules',
			machine: localMachine(args.machine),
			software: { browser: 'Chromium, Playwright bundled build' },
			method: {
				'emulated rtt ms': args.rttMs,
				'navigations per run': args.navs,
				'runs per arm': args.runs
			},
			exclusions: [],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
