import { chromium, firefox, webkit, type BrowserType, type Page } from '@playwright/test';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import {
	MEASUREMENTS_DIR,
	isMain,
	localMachine,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';

const run = promisify(execFile);

/** how the origin caches icons, the manifest and the clip; documents always revalidate */
export type HeaderArm = { name: 'shipping' | 'optimized'; cacheControl: string; etag: boolean };

/** what answers requests in the browser: nothing, a worker that renders documents, or one that also holds the icons */
export type WorkerArm = 'none' | 'document' | 'icons';

export const HEADER_ARMS: HeaderArm[] = [
	{ name: 'shipping', cacheControl: 'max-age=0, must-revalidate', etag: true },
	{ name: 'optimized', cacheControl: 'public, max-age=31536000, immutable', etag: false }
];

export const WORKER_ARMS: WorkerArm[] = ['none', 'document', 'icons'];

/** headless Chromium requests no icons (probe, 2026-10-20), so it runs headed */
export const HEADLESS: Record<string, boolean> = { chromium: false, firefox: true, webkit: true };

const ENGINES: Array<[string, BrowserType]> = [
	['chromium', chromium],
	['firefox', firefox],
	['webkit', webkit]
];

/** assumed body sizes in bytes; the rig counts requests, a reader prices them with a real site's sizes */
export const SIZES = {
	favicon: 4096,
	icon: 4096,
	apple: 12_288,
	mask: 1024,
	tile: 8192,
	og: 102_400
};

/** every icon-like URL a declared page names, with the tag that names it */
export const DECLARED = [
	{
		tag: '<link rel="icon" type="image/png" href="/assets/icon-32.png">',
		path: '/assets/icon-32.png'
	},
	{ tag: '<link rel="apple-touch-icon" href="/assets/apple.png">', path: '/assets/apple.png' },
	{
		tag: '<link rel="mask-icon" href="/assets/mask.svg" color="#000">',
		path: '/assets/mask.svg'
	},
	{ tag: '<link rel="manifest" href="/manifest.webmanifest">', path: '/manifest.webmanifest' },
	{
		tag: '<meta name="msapplication-TileImage" content="/assets/tile.png">',
		path: '/assets/tile.png'
	},
	{ tag: '<meta property="og:image" content="/assets/og.png">', path: '/assets/og.png' }
] as const;

/** the favicon a browser asks for when a page names none */
export const FAVICON = '/favicon.ico';

export type Hit = {
	path: string;
	status: number;
	bytes: number;
	range?: string;
	conditional?: boolean;
	complete?: boolean;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc(buf: Buffer): number {
	if (typeof crc32 === 'function') return crc32(buf) >>> 0;
	let c = 0xffffffff;
	for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc(body), 8 + data.length);
	return out;
}

/** a valid 1x1 PNG padded with a text chunk to exactly `size` bytes */
export function pngOf(size: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(1, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	const head = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(Buffer.from([0, 0])))
	]);
	const end = chunk('IEND', Buffer.alloc(0));
	const fill = size - head.length - end.length - 12 - 'c\0'.length;
	if (fill < 0) throw new Error(`a PNG needs at least ${size - fill} bytes`);
	const text = chunk('tEXt', Buffer.concat([Buffer.from('c\0'), Buffer.alloc(fill, 0x61)]));
	return Buffer.concat([head, text, end]);
}

/** an SVG padded with a comment to exactly `size` bytes */
export function svgOf(size: number): Buffer {
	const open = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--';
	const close = '--></svg>';
	return Buffer.from(open + 'a'.repeat(Math.max(0, size - open.length - close.length)) + close);
}

/** the first range of a `Range: bytes=a-b` header clamped to `length`, or null */
export function rangeOf(header: string | undefined, length: number): [number, number] | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
	if (!m || (m[1] === '' && m[2] === '')) return null;
	let start = m[1] === '' ? length - Number(m[2]) : Number(m[1]);
	const end = m[1] === '' || m[2] === '' ? length - 1 : Math.min(Number(m[2]), length - 1);
	start = Math.max(0, start);
	return start > end ? null : [start, end];
}

export type PageKind = 'p' | 'b' | 'v';

export const PRELOADS = ['none', 'metadata', 'auto'] as const;

/** one URL per preload mode, same bytes, so one mode's cache entry cannot answer another */
export const clipPath = (preload: string) => `/media/clip-${preload}.webm`;

/** a declared page (`p`) names every icon, a bare page (`b`) names none, a video page (`v`) holds one `<video>` */
export function pageHtml(kind: PageKind, id: string): string {
	const head = kind === 'p' ? DECLARED.map((d) => d.tag).join('') : '';
	const body =
		kind === 'v'
			? `<video controls muted preload="${id}" width="320"><source src="${clipPath(id)}" type="video/webm"></video>`
			: `<h1>${kind}/${id}</h1>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${kind} ${id}</title>${head}<script src="/assets/site.js" defer></script></head><body>${body}</body></html>`;
}

/** every document the origin and the worker serve, by path */
export function pages(count: number): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 1; i <= count + 1; i++) out[`/p/${i}`] = pageHtml('p', String(i));
	for (let i = 1; i <= count; i++) out[`/b/${i}`] = pageHtml('b', String(i));
	for (const preload of PRELOADS) out[`/v/${preload}`] = pageHtml('v', preload);
	return out;
}

/** the worker: renders documents, optionally holds the icons, and logs every fetch event it receives */
export function workerSource(mode: WorkerArm, docs: Record<string, string>): string {
	return `
const V = 'link-assets-1';
const DOCS = ${JSON.stringify(docs)};
const ICONS = ${JSON.stringify([FAVICON, ...DECLARED.map((d) => d.path)])};
const MODE = ${JSON.stringify(mode)};
let n = 0;
self.addEventListener('install', (e) => e.waitUntil((async () => {
	if (MODE === 'icons') await (await caches.open(V)).addAll(ICONS);
	await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
	const u = new URL(e.request.url);
	const row = { path: u.pathname, destination: e.request.destination, mode: e.request.mode };
	e.waitUntil(caches.open('swlog').then((c) => c.put('/swlog/' + Date.now() + '-' + (n++) + '/' + encodeURIComponent(JSON.stringify(row)), new Response(''))));
	if (e.request.mode === 'navigate' && DOCS[u.pathname]) {
		e.respondWith(new Response(DOCS[u.pathname], { headers: { 'content-type': 'text/html; charset=utf-8' } }));
		return;
	}
	if (MODE === 'icons' && ICONS.includes(u.pathname)) e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
`;
}

/** an origin that logs every request, answers conditional requests and ranges, and serves the synthetic assets */
export async function startOrigin(
	arm: HeaderArm,
	worker: WorkerArm,
	clip: Buffer,
	count = 4
): Promise<{ origin: string; hits: Hit[]; stop(): Promise<void> }> {
	const hits: Hit[] = [];
	const docs = pages(count);
	const manifest = Buffer.from(
		JSON.stringify({
			name: 'rig',
			icons: [{ src: '/assets/icon-32.png', sizes: '32x32', type: 'image/png' }]
		})
	);
	const assets = new Map<string, { type: string; body: Buffer }>([
		[FAVICON, { type: 'image/png', body: pngOf(SIZES.favicon) }],
		['/assets/icon-32.png', { type: 'image/png', body: pngOf(SIZES.icon) }],
		['/assets/apple.png', { type: 'image/png', body: pngOf(SIZES.apple) }],
		['/assets/mask.svg', { type: 'image/svg+xml', body: svgOf(SIZES.mask) }],
		['/assets/tile.png', { type: 'image/png', body: pngOf(SIZES.tile) }],
		['/assets/og.png', { type: 'image/png', body: pngOf(SIZES.og) }],
		['/manifest.webmanifest', { type: 'application/manifest+json', body: manifest }],
		...PRELOADS.map((p): [string, { type: string; body: Buffer }] => [
			clipPath(p),
			{ type: 'video/webm', body: clip }
		])
	]);
	const siteJs =
		worker === 'none'
			? ''
			: `if (navigator.serviceWorker && !navigator.serviceWorker.controller && location.search.includes('install')) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'all' });`;
	const server: Server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const hit: Hit = { path, status: 404, bytes: 0 };
		const range = req.headers.range;
		if (range) hit.range = range;
		if (req.headers['if-none-match']) hit.conditional = true;
		hits.push(hit);
		res.on('close', () => (hit.complete = res.writableFinished));
		const send = (status: number, headers: Record<string, string | number>, body?: Buffer) => {
			hit.status = status;
			hit.bytes = body?.length ?? 0;
			res.writeHead(status, headers);
			res.end(body);
		};
		if (path === '/sw.js') {
			return send(
				200,
				{ 'content-type': 'text/javascript', 'cache-control': 'max-age=86400' },
				Buffer.from(workerSource(worker, docs))
			);
		}
		if (path === '/assets/site.js') {
			return send(
				200,
				{
					'content-type': 'text/javascript',
					'cache-control': 'public, max-age=31536000, immutable'
				},
				Buffer.from(siteJs)
			);
		}
		const doc = docs[path];
		const asset = assets.get(path);
		const body = doc ? Buffer.from(doc) : asset?.body;
		if (!body) return send(404, {});
		const etag = `"${path}-${body.length}"`;
		const headers: Record<string, string | number> = doc
			? {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'max-age=0, must-revalidate',
					etag
				}
			: {
					'content-type': asset!.type,
					'cache-control': arm.cacheControl,
					'accept-ranges': 'bytes'
				};
		if (!doc && arm.etag) headers.etag = etag;
		if (headers.etag && req.headers['if-none-match'] === headers.etag)
			return send(304, headers);
		const slice = rangeOf(range, body.length);
		if (slice) {
			headers['content-range'] = `bytes ${slice[0]}-${slice[1]}/${body.length}`;
			return send(206, headers, body.subarray(slice[0], slice[1] + 1));
		}
		send(200, headers, body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { origin, hits, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** a short VP8 clip from ffmpeg's test source, with the ffmpeg version line it came from */
export async function makeClip(seconds: number): Promise<{ bytes: Buffer; ffmpeg: string }> {
	const dir = mkdtempSync(join(tmpdir(), 'link-assets-'));
	const file = join(dir, 'clip.webm');
	const version = (await run('ffmpeg', ['-version'])).stdout.split('\n')[0] ?? 'unknown';
	await run('ffmpeg', [
		...['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15'],
		...['-t', String(seconds), '-c:v', 'libvpx', '-b:v', '300k', '-an', file]
	]);
	return { bytes: readFileSync(file), ffmpeg: version };
}

const swLog = (page: Page) =>
	page.evaluate(async () => {
		const keys = await (await caches.open('swlog')).keys();
		return keys
			.map((k) => k.url.split('/swlog/')[1] as string)
			.sort(
				(a, b) =>
					Number(a.split('-')[0]) - Number(b.split('-')[0]) ||
					parseInt(a.split('-')[1] as string) - parseInt(b.split('-')[1] as string)
			)
			.map(
				(s) =>
					JSON.parse(decodeURIComponent(s.split('/')[1] as string)) as Record<
						string,
						string
					>
			);
	});

type Wait = { ms: number };

/** one engine against one arm: a prime view, declared and bare pages, then each preload mode played and replayed */
export async function walkEngine(
	name: string,
	engine: BrowserType,
	headers: HeaderArm,
	worker: WorkerArm,
	clip: Buffer,
	navs: number,
	wait: Wait
): Promise<Record<string, unknown>> {
	const origin = await startOrigin(headers, worker, clip, navs);
	const headless = HEADLESS[name] ?? true;
	const browser = await engine.launch({ headless });
	const context = await browser.newContext();
	const page = await context.newPage();
	const mark = { hits: 0, log: 0 };
	const take = async () => {
		await page.waitForTimeout(wait.ms);
		const hits = origin.hits.slice(mark.hits);
		mark.hits = origin.hits.length;
		if (worker === 'none') return { hits, swSeen: null };
		const log = await swLog(page).catch(() => []);
		const swSeen = log.slice(mark.log);
		mark.log = log.length;
		return { hits, swSeen };
	};
	await page.goto(`${origin.origin}/p/1?install`);
	let controlled = false;
	if (worker !== 'none') {
		await page
			.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 })
			.catch(() => undefined);
		await page.reload();
		controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
	}
	const prime = await take();
	const rows: Array<Record<string, unknown>> = [];
	const visit = async (kind: PageKind, path: string) => {
		await page.goto(origin.origin + path);
		rows.push({ kind, path, ...(await take()) });
	};
	for (let i = 2; i <= navs + 1; i++) await visit('p', `/p/${i}`);
	for (let i = 1; i <= navs; i++) await visit('b', `/b/${i}`);
	const video: Array<Record<string, unknown>> = [];
	for (const preload of PRELOADS) {
		const play = () =>
			page.evaluate(() => {
				const v = document.querySelector('video') as HTMLVideoElement;
				v.muted = true;
				return v.play().then(
					() => 'played',
					(e: Error) => e.name
				);
			});
		await page.goto(`${origin.origin}/v/${preload}`);
		const load = await take();
		const played = await play();
		const afterPlay = await take();
		await page.reload();
		const reload = await take();
		const replayed = await play();
		const afterReplay = await take();
		video.push({ preload, load, played, afterPlay, reload, replayed, afterReplay });
	}
	const engineVersion = browser.version();
	await browser.close();
	await origin.stop();
	return {
		headers: headers.name,
		worker,
		engine: name,
		engineVersion,
		headless,
		controlled,
		prime,
		navs: rows,
		video
	};
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			navs: { type: 'string', default: '4' },
			wait: { type: 'string', default: '1200' },
			clip: { type: 'string', default: '8' },
			engine: { type: 'string', multiple: true },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		machine: values.machine,
		out: values.out as string,
		navs: Number(values.navs),
		waitMs: Number(values.wait),
		clipSeconds: Number(values.clip),
		engines: (values.engine as string[] | undefined) ?? ENGINES.map(([n]) => n),
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
					rig: 'link-assets',
					date: utcDate(),
					arms: HEADER_ARMS.flatMap((h) => WORKER_ARMS.map((w) => `${h.name} + ${w}`)),
					engines: args.engines,
					headless: HEADLESS,
					navs: args.navs,
					waitMs: args.waitMs,
					clipSeconds: args.clipSeconds,
					ffmpeg: spawnSync('ffmpeg', ['-version']).status === 0 ? 'found' : 'missing',
					out: args.out
				},
				null,
				2
			)
		);
	} else {
		const clip = await makeClip(args.clipSeconds);
		const rows: Array<Record<string, unknown>> = [];
		for (const headers of HEADER_ARMS) {
			for (const worker of WORKER_ARMS) {
				for (const [name, engine] of ENGINES.filter(([n]) => args.engines.includes(n))) {
					rows.push(
						await walkEngine(name, engine, headers, worker, clip.bytes, args.navs, {
							ms: args.waitMs
						})
					);
				}
			}
		}
		const draft: Draft = {
			rig: 'link-assets',
			date: utcDate(),
			layer: 'L1',
			question:
				'which icon, manifest, tile and video requests reach the origin on each navigation, by cache headers, worker and engine, and whether a worker sees them',
			instrument:
				"request log of the in-process origin, plus the worker's own log of the fetch events it received",
			machine: localMachine(args.machine),
			software: {
				browsers: 'Chromium, Firefox, WebKit, Playwright bundled builds',
				ffmpeg: clip.ffmpeg
			},
			method: {
				arms: 'cache headers (shipping: max-age=0 with an ETag; optimized: one year immutable) by worker (none, document, icons)',
				'first view':
					'a prime navigation to /p/1, then a reload once a worker controls the page',
				navigations: `${args.navs} declared pages (every icon tag), then ${args.navs} bare pages (no icon tag), typed navigations`,
				video: 'one page per preload mode: load, play, reload, play again',
				'settle ms': args.waitMs,
				headless: HEADLESS,
				'asset bytes (assumed)': SIZES,
				clip: {
					bytes: clip.bytes.length,
					sha256: createHash('sha256').update(clip.bytes).digest('hex'),
					seconds: args.clipSeconds
				},
				origin: 'localhost'
			},
			exclusions: [
				'rows in a worker arm with controlled false, the worker never took control',
				'rows from headless Chromium, which requests no icons'
			],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
