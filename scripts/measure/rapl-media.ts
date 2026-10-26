import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, zstdCompressSync } from 'node:zlib';

/** the pages of the idle-activity experiment, one arm each; the first three are the original arms */
export const ACTIVITY_ARMS = ['quiet', 'poll', 'raf', 'raf-off-plain', 'raf-off-hook'] as const;

export type ActivityArm = (typeof ACTIVITY_ARMS)[number];

/** the pages of the idle-activity-hidden experiment: a quiet page, and a poller with and without the pause hook, each in a tab behind another */
export const HIDDEN_ARMS = ['quiet-hidden', 'poll-hidden-plain', 'poll-hidden-hook'] as const;

export type HiddenArm = (typeof HIDDEN_ARMS)[number];

/** the decode arms: a file variant decoded by one method */
export const DECODE_VARIANTS = ['original', 'native', 'resized'] as const;
export const DECODE_METHODS = ['bitmap', 'img'] as const;

/** one image of the decode and encode set, as `image-crawl.ts set` writes it to manifest.json */
export type SetImage = {
	file: string;
	format: string;
	bytes: number;
	naturalWidth: number;
	naturalHeight: number;
	cssWidth: number;
	dpr: number;
	resizedWidth: number;
	original: string;
	webp: string;
	resized: string;
	webpBytes: number;
	resizedBytes: number;
};

export type ImageSet = { tinyimg: string; quality: number; images: SetImage[] };

export const readSet = (dir: string): ImageSet =>
	JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ImageSet;

/** the file of an image for one decode variant */
export const fileFor = (image: SetImage, variant: (typeof DECODE_VARIANTS)[number]): string =>
	variant === 'original' ? image.original : variant === 'native' ? image.webp : image.resized;

// #region compression dictionary framing (RFC 9842)

/** the 40-byte header of a `dcz` body: a Zstandard skippable frame holding the SHA-256 of the dictionary */
export function dczHeader(dictionary: Uint8Array): Buffer {
	const head = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);
	return Buffer.concat([head, createHash('sha256').update(dictionary).digest()]);
}

/** a `dcz` body: the header, then the input compressed as Zstandard with `dictionary` as a raw prefix dictionary */
export function dczBody(dictionary: Uint8Array, input: Uint8Array): Buffer {
	const stream = zstdCompressSync(input, {
		dictionary,
		params: {
			[constants.ZSTD_c_compressionLevel]: 19,
			[constants.ZSTD_c_windowLog]: 22
		}
	});
	return Buffer.concat([dczHeader(dictionary), stream]);
}

/** the structured-field form of the `Available-Dictionary` value for `dictionary`: `:<base64 sha-256>:` */
export const availableDictionary = (dictionary: Uint8Array): string =>
	`:${createHash('sha256').update(dictionary).digest('base64')}:`;

// #endregion

/** a page that fetches one file, reads its bytes without running them and sets `window.__done` */
const FETCH_SCRIPT = (path: string) =>
	`<script>window.__done=false;fetch(${JSON.stringify(path)}).then((r)=>r.arrayBuffer()).then((b)=>{window.__bytes=b.byteLength;window.__done=true})</script>`;

type Options = {
	port: number;
	images?: string;
	dictionary?: { dict: string; target: string };
	client?: Buffer;
};

const OFF_SCREEN_BOX =
	'<div id="box" style="position:absolute;top:3000px;left:0;width:80px;height:80px;background:#06c;will-change:transform"></div>';

const html = (body: string, head = '') =>
	`<!doctype html><meta charset="utf-8"><title>x</title>${head}<body>${body}</body>`;

const POLL_TICK = 'window.__count++;fetch("/ping")';

const ACTIVITY: Record<ActivityArm | HiddenArm, string> = {
	'quiet-hidden': html('<main id="m">quiet</main><script>window.__count=0</script>'),
	'poll-hidden-plain': html(
		`<main id="m">poll</main><script>window.__count=0;setInterval(()=>{${POLL_TICK}},1000)</script>`
	),
	'poll-hidden-hook': html(
		`<main id="m">poll</main><script src="/client.js"></script><script>window.__count=0;let t=0;const start=()=>{t=setInterval(()=>{${POLL_TICK}},1000)};start();window.spool.activity.register({pause(){clearInterval(t)},resume(){start()}},{hiddenAfterMs:1000})</script>`
	),
	quiet: html('<main id="m">quiet</main><script>window.__count=0</script>'),
	poll: html(
		'<main id="m">poll</main><script>window.__count=0;setInterval(()=>fetch("/ping").then((r)=>r.text()).then(()=>{window.__count++}),1000)</script>'
	),
	raf: html(
		'<div id="box" style="width:80px;height:80px;background:#06c;will-change:transform"></div><script>window.__count=0;const b=document.getElementById("box");function tick(t){window.__count++;b.style.transform="translateX("+((t/8)%300)+"px)";requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>'
	),
	'raf-off-plain': html(
		`${OFF_SCREEN_BOX}<script>window.__count=0;const b=document.getElementById("box");function tick(t){window.__count++;b.style.transform="translateX("+((t/8)%300)+"px)";requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`
	),
	'raf-off-hook': html(
		`${OFF_SCREEN_BOX}<script src="/client.js"></script><script>window.__count=0;const b=document.getElementById("box");let h=0;function tick(t){window.__count++;b.style.transform="translateX("+((t/8)%300)+"px)";h=requestAnimationFrame(tick)}h=requestAnimationFrame(tick);window.spool.activity.register({pause(){cancelAnimationFrame(h)},resume(){h=requestAnimationFrame(tick)}},{target:b})</script>`
	)
};

const DECODE_PAGE = html(
	'<div id="host"></div>',
	`<script>
window.prepare = async (files) => {
	window.__blobs = [];
	for (const f of files) window.__blobs.push(await (await fetch('/img/' + f.file, { cache: 'no-store' })).blob());
	return window.__blobs.reduce((n, b) => n + b.size, 0);
};
window.decodeAll = async (method, widths, passes) => {
	const host = document.getElementById('host');
	let n = 0;
	for (let p = 0; p < passes; p++) {
		for (let i = 0; i < window.__blobs.length; i++) {
			const blob = window.__blobs[i];
			if (method === 'bitmap') {
				const bitmap = await createImageBitmap(blob);
				bitmap.close();
			} else {
				const url = URL.createObjectURL(blob);
				const img = new Image();
				img.style.width = widths[i] + 'px';
				img.src = url;
				host.appendChild(img);
				await img.decode();
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				host.removeChild(img);
				URL.revokeObjectURL(url);
			}
			n++;
		}
	}
	return n;
};
</script>`
);

/**
 * One origin for the media experiments. The `ACTIVITY_ARMS` pages are the idle-activity pages, `/client.js`
 * is the page runtime when `client` is given, and `/ping` answers the pollers; `/decode` and `/img/<file>` serve the decode set; `/dict-page` links a
 * dictionary stylesheet with `Use-As-Dictionary` and `/page?n=` links a target stylesheet that is sent
 * plain brotli to a request with no dictionary and `dcz` to one that names it. `/__stats` counts what
 * it saw.
 */
export function startMediaOrigin(options: Options) {
	const stats = {
		ping: 0,
		dictRequests: 0,
		targetRequests: 0,
		withDictionaryHeader: 0,
		dcz: 0,
		brotli: 0,
		acceptEncodings: [] as string[]
	};
	let dict: Buffer | null = null;
	let dictBr: Buffer | null = null;
	let target: Buffer | null = null;
	let targetBr: Buffer | null = null;
	let targetDcz: Buffer | null = null;
	let wanted = '';
	if (options.dictionary) {
		dict = readFileSync(options.dictionary.dict);
		target = readFileSync(options.dictionary.target);
		dictBr = brotliCompressSync(dict, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
		targetBr = brotliCompressSync(target, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
		targetDcz = dczBody(dict, target);
		wanted = availableDictionary(dict);
	}
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		const path = url.pathname;
		const accept = String(req.headers['accept-encoding'] ?? '');
		if (path === '/__stats') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return void res.end(
				JSON.stringify({
					...stats,
					cpuUs: process.cpuUsage().user + process.cpuUsage().system,
					dictBytes: dict?.length ?? 0,
					targetBytes: target?.length ?? 0,
					targetBrotliBytes: targetBr?.length ?? 0,
					targetDczBytes: targetDcz?.length ?? 0
				})
			);
		}
		if (path === '/ping') {
			stats.ping++;
			res.writeHead(204, { 'cache-control': 'no-store' });
			return void res.end();
		}
		if (path === '/client.js' && options.client) {
			res.writeHead(200, {
				'content-type': 'text/javascript; charset=utf-8',
				'cache-control': 'no-store'
			});
			return void res.end(options.client);
		}
		const activity = ACTIVITY[path.slice(1) as ActivityArm];
		if (activity) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			});
			return void res.end(activity);
		}
		if (path === '/decode') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			});
			return void res.end(DECODE_PAGE);
		}
		if (path.startsWith('/img/') && options.images) {
			try {
				const file = join(options.images, path.slice(5).replace(/[^A-Za-z0-9._-]/g, ''));
				const body = readFileSync(file);
				const type = file.endsWith('.webp')
					? 'image/webp'
					: file.endsWith('.png')
						? 'image/png'
						: 'image/jpeg';
				res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
				return void res.end(body);
			} catch {
				res.writeHead(404);
				return void res.end();
			}
		}
		if (path === '/dict-page' && dict) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			});
			return void res.end(html('<p>dictionary</p>', FETCH_SCRIPT('/dl/base')));
		}
		if (path === '/page' && target) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store'
			});
			return void res.end(
				html(
					'<p>target</p>',
					FETCH_SCRIPT(`/dl/target?n=${url.searchParams.get('n') ?? '0'}`)
				)
			);
		}
		if (path === '/dl/base' && dict && dictBr) {
			stats.dictRequests++;
			res.writeHead(200, {
				'content-type': 'text/plain; charset=utf-8',
				'content-encoding': 'br',
				'cache-control': 'public, max-age=31536000, immutable',
				vary: 'accept-encoding',
				'use-as-dictionary': 'match="/dl/*"'
			});
			return void res.end(dictBr);
		}
		if (path === '/dl/target' && target && targetBr && targetDcz) {
			stats.targetRequests++;
			if (stats.acceptEncodings.length < 6) stats.acceptEncodings.push(accept);
			const available = String(req.headers['available-dictionary'] ?? '');
			if (available) stats.withDictionaryHeader++;
			const headers: Record<string, string> = {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store',
				vary: 'accept-encoding, available-dictionary'
			};
			if (available === wanted && /\bdcz\b/.test(accept)) {
				stats.dcz++;
				res.writeHead(200, { ...headers, 'content-encoding': 'dcz' });
				return void res.end(targetDcz);
			}
			stats.brotli++;
			res.writeHead(200, { ...headers, 'content-encoding': 'br' });
			return void res.end(targetBr);
		}
		res.writeHead(404);
		res.end();
	});
	server.listen(options.port, '127.0.0.1');
	return server;
}

/** the child of the cold image-encode window: loads tinyimg, encodes the set once, prints one JSON line */
async function encodeChild(setDir: string, tinyDir: string): Promise<void> {
	const t0 = performance.now();
	const root = join(tinyDir, 'node_modules/@gmitch215/tinyimg');
	const lib = await import(pathToFileURL(join(root, 'dist/index.js')).href);
	const module = await lib.TinyImgModule.loadBytes(readFileSync(join(root, 'dist/tinyimg.wasm')));
	const loadMs = performance.now() - t0;
	const set = readSet(setDir);
	let bytesIn = 0;
	let bytesOut = 0;
	const t1 = performance.now();
	for (const image of set.images) {
		const input = readFileSync(join(setDir, image.original));
		const out = await lib.transform(module, input, { format: 'webp', quality: set.quality });
		bytesIn += input.length;
		bytesOut += out.bytes().length;
	}
	console.log(
		JSON.stringify({
			loadMs,
			encodeMs: performance.now() - t1,
			images: set.images.length,
			bytesIn,
			bytesOut
		})
	);
}

/** the encode loop of the warm window, run in the parent process with the module already loaded */
export async function loadTinyimg(tinyDir: string) {
	const root = join(tinyDir, 'node_modules/@gmitch215/tinyimg');
	const lib = await import(pathToFileURL(join(root, 'dist/index.js')).href);
	const module = await lib.TinyImgModule.loadBytes(readFileSync(join(root, 'dist/tinyimg.wasm')));
	return {
		module,
		transform: lib.transform as (
			m: unknown,
			i: Uint8Array,
			o: object
		) => Promise<{ bytes(): Uint8Array }>,
		version: (module.version as number[]).join('.')
	};
}

/** runs the cold child to completion and returns its JSON line */
export function runEncodeChild(setDir: string, tinyDir: string): Promise<Record<string, number>> {
	return new Promise((resolve, reject) => {
		const child = spawn('node', [import.meta.filename, 'encode-child', setDir, tinyDir], {
			stdio: ['ignore', 'pipe', 'inherit']
		});
		let out = '';
		child.stdout.on('data', (chunk: Buffer) => (out += chunk));
		child.on('exit', (code) =>
			code === 0
				? resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}'))
				: reject(new Error(`encode child exited ${code}`))
		);
	});
}

if (process.argv[1]?.endsWith('rapl-media.ts')) {
	if (process.argv[2] === 'encode-child') {
		await encodeChild(process.argv[3] as string, process.argv[4] as string);
	} else {
		const clientFile = join(dirname(import.meta.filename), '../../dist/cdn/client.js');
		// the idle-activity rig checks /client.js itself, so the other experiments need no build
		startMediaOrigin({
			port: Number(process.env.PORT ?? 8961),
			client: existsSync(clientFile) ? readFileSync(clientFile) : undefined,
			images: process.env.IMAGES,
			dictionary: process.env.DICT_FILE
				? { dict: process.env.DICT_FILE, target: process.env.TARGET_FILE as string }
				: undefined
		});
		console.log('origin up media');
	}
}
