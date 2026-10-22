import {
	chromium,
	devices,
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rewriteEmbeds } from '../../src/media/embeds.ts';
import { rewriteLazy } from '../../src/media/lazy.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';
import { internalLinks, median, pickPages, quantile } from './payload';
import { SITES } from './repeat-nav';

const HELP = `Usage: bun scripts/measure/image-crawl.ts [--machine NAME] [--experiment NAME] [--out DIR]
       [--force] [--dry-run] [--sites SUBSTRING[,SUBSTRING]] [--profiles desktop,phone]
       [--pages N] [--lazy-pages N] [--skip N] [--tinyimg DIR] [--save DIR] [--no-convert] [--no-embeds]
   or: bun scripts/measure/image-crawl.ts set --from DIR --reading FILE --to DIR [--count N] [--max-mb N] [--tinyimg DIR]

Crawls the 16 sites of the repeat-nav reading in Chromium, desktop and Pixel 7 profiles, each page
with an empty cache, scrolled and unscrolled. Per first-seen image: bytes, kind, rendered size and,
for JPEG and PNG, the WebP bytes, encoder milliseconds and SSIM of three arms (native, the width
ceiling, resized to the rendered width). Per page: image bytes before the first scroll and after it,
with and without the lazy rewrite applied by page.route, video bytes, iframe hosts and the LCP
element. Two real embeds (YouTube, Vimeo) are loaded with and without the facade.

tinyimg is read from --tinyimg DIR (or SPOOL_TINYIMG), a folder holding node_modules/@gmitch215/tinyimg.
--save DIR keeps the first-seen JPEG and PNG bodies as <sha1>.bin; the set subcommand turns them into the
paisley image set.`;

const PAGES_PER_SITE = 4;
const LAZY_PAGES = 3;
const LAZY_SKIP = 2;
const DELAY_MS = 250;
const SETTLE_MS = 1500;
const SCROLL_STEPS = 40;
const MIN_BYTES = 4096;
const MAX_BYTES = 15_000_000;
const CEILING = 2560;
const QUALITY = 80;
const SITE_CONCURRENCY = 2;
const SSIM_SIDE = 512;
const VIDEO_YOUTUBE = 'dQw4w9WgXcQ';
const VIDEO_VIMEO = '76979871';

export const PROFILES = {
	desktop: {
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false
	},
	phone: devices['Pixel 7'] as Record<string, unknown>
} as const;

export type ProfileName = keyof typeof PROFILES;

// #region pure helpers

/**
 * Structural similarity of two luma planes (0 to 255 values, `width` by `height`), the mean of the
 * SSIM of each non-overlapping 8 by 8 block with the usual constants, 1 for identical planes. A plane
 * narrower or shorter than 8 uses one block of that size. Self-contained, because the rig runs its
 * source inside the page.
 */
export function ssimLuma(
	x: ArrayLike<number>,
	y: ArrayLike<number>,
	width: number,
	height: number
): number {
	const c1 = 6.5025;
	const c2 = 58.5225;
	const bw = Math.min(8, width);
	const bh = Math.min(8, height);
	const nx = Math.floor(width / bw);
	const ny = Math.floor(height / bh);
	let total = 0;
	for (let by = 0; by < ny; by++) {
		for (let bx = 0; bx < nx; bx++) {
			let sx = 0;
			let sy = 0;
			for (let j = 0; j < bh; j++) {
				for (let i = 0; i < bw; i++) {
					const at = (by * bh + j) * width + bx * bw + i;
					sx += x[at] as number;
					sy += y[at] as number;
				}
			}
			const n = bw * bh;
			const mx = sx / n;
			const my = sy / n;
			let vx = 0;
			let vy = 0;
			let cv = 0;
			for (let j = 0; j < bh; j++) {
				for (let i = 0; i < bw; i++) {
					const at = (by * bh + j) * width + bx * bw + i;
					const dx = (x[at] as number) - mx;
					const dy = (y[at] as number) - my;
					vx += dx * dx;
					vy += dy * dy;
					cv += dx * dy;
				}
			}
			vx /= n - 1 || 1;
			vy /= n - 1 || 1;
			cv /= n - 1 || 1;
			total +=
				((2 * mx * my + c1) * (2 * cv + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2));
		}
	}
	return total / (nx * ny);
}

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'svg' | 'other';

/** the image format of `bytes` from its first bytes */
export function kindOf(bytes: Uint8Array): ImageKind {
	const at = (i: number) => bytes[i];
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
	const head = String.fromCharCode(...bytes.subarray(0, 12));
	if (head.startsWith('GIF8')) return 'gif';
	if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
	if (head.slice(4, 8) === 'ftyp') {
		const brand = String.fromCharCode(...bytes.subarray(8, 12));
		if (brand === 'avif' || brand === 'avis') return 'avif';
	}
	const text = String.fromCharCode(...bytes.subarray(0, 256)).trimStart();
	if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg')))
		return 'svg';
	return 'other';
}

/** the EXIF orientation (1 to 8) of a JPEG, or null when it has none */
export function exifOrientation(jpeg: Uint8Array): number | null {
	let at = 2;
	while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
		const marker = jpeg[at + 1] as number;
		const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number);
		if (
			marker === 0xe1 &&
			String.fromCharCode(...jpeg.subarray(at + 4, at + 10)) === 'Exif\0\0'
		) {
			const tiff = at + 10;
			const little = jpeg[tiff] === 0x49;
			const u16 = (i: number) =>
				little
					? (jpeg[i] as number) | ((jpeg[i + 1] as number) << 8)
					: ((jpeg[i] as number) << 8) | (jpeg[i + 1] as number);
			const u32 = (i: number) =>
				little ? u16(i) + u16(i + 2) * 65536 : u16(i) * 65536 + u16(i + 2);
			const ifd = tiff + u32(tiff + 4);
			const count = u16(ifd);
			for (let entry = 0; entry < count; entry++) {
				const base = ifd + 2 + entry * 12;
				if (u16(base) === 0x0112) return u16(base + 8);
			}
			return null;
		}
		if (marker === 0xda) break;
		at += 2 + length;
	}
	return null;
}

/** `jpeg` with an EXIF block that sets the orientation, placed right after the start-of-image marker */
export function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
	const tiff = [
		0x49,
		0x49,
		0x2a,
		0x00,
		0x08,
		0x00,
		0x00,
		0x00,
		0x01,
		0x00,
		0x12,
		0x01,
		0x03,
		0x00,
		0x01,
		0x00,
		0x00,
		0x00,
		orientation,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00,
		0x00
	];
	const body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
	const length = body.length + 2;
	const segment = [0xff, 0xe1, length >> 8, length & 0xff, ...body];
	return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

/** the encoder width for an image shown `cssWidth` CSS pixels wide on a `dpr` screen, or undefined when the file is no wider */
export function renderedWidth(
	cssWidth: number | null,
	dpr: number,
	naturalWidth: number
): number | undefined {
	if (cssWidth === null || cssWidth <= 0) return undefined;
	const wanted = Math.ceil(cssWidth * dpr);
	return wanted < naturalWidth ? wanted : undefined;
}

/** `url` with the query replaced by its parameter names, no fragment */
export function reduceUrl(url: string): string {
	const u = new URL(url);
	const names = [...u.searchParams.keys()];
	u.search = names.length > 0 ? `?${names.join('&')}` : '';
	u.hash = '';
	return u.href;
}

// #endregion

// #region tinyimg

type TinyBinding = {
	module: unknown;
	transform: (
		module: unknown,
		input: Uint8Array,
		options: Record<string, unknown>
	) => Promise<{ bytes(): Uint8Array; width: number; height: number }>;
	version: string;
};

async function loadTinyimg(dir: string): Promise<TinyBinding> {
	const root = join(resolve(dir), 'node_modules/@gmitch215/tinyimg');
	const lib = (await import(pathToFileURL(join(root, 'dist/index.js')).href)) as {
		TinyImgModule: { loadBytes(bytes: Uint8Array): Promise<{ version: number[] }> };
		transform: TinyBinding['transform'];
	};
	const module = await lib.TinyImgModule.loadBytes(readFileSync(join(root, 'dist/tinyimg.wasm')));
	return { module, transform: lib.transform, version: module.version.join('.') };
}

export type Arm = {
	bytes: number;
	ms: number;
	width: number;
	height: number;
	ssim: number | null;
	/** the width asked for, absent for the native arm */
	asked?: number;
};

async function encodeArm(
	tiny: TinyBinding,
	input: Uint8Array,
	extra: Record<string, unknown>
): Promise<{ arm: Arm; bytes: Uint8Array } | null> {
	const start = performance.now();
	try {
		const out = await tiny.transform(tiny.module, input, {
			format: 'webp',
			quality: QUALITY,
			...extra
		});
		const bytes = out.bytes();
		return {
			arm: {
				bytes: bytes.length,
				ms: Math.round((performance.now() - start) * 100) / 100,
				width: out.width,
				height: out.height,
				ssim: null,
				...(typeof extra.width === 'number' ? { asked: extra.width } : {})
			},
			bytes
		};
	} catch {
		return null;
	}
}

// #endregion

// #region the page side

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LCP_SCRIPT = `new PerformanceObserver((list) => {
	for (const e of list.getEntries()) {
		window.__lcp = { tag: e.element ? e.element.tagName : null, loading: e.element && e.element.getAttribute ? e.element.getAttribute('loading') : null, url: e.url || null };
	}
}).observe({ type: 'largest-contentful-paint', buffered: true });`;

/** SSIM of a converted image against the original, decoded and scaled to a common size, computed in the page */
async function ssimInPage(
	page: Page,
	original: Uint8Array,
	converted: Uint8Array
): Promise<{ ssim: number; side: [number, number]; original: [number, number] } | null> {
	try {
		return await page.evaluate(
			async ({ a, b, maxSide, fn }) => {
				const ssim = new Function(`return (${fn})`)() as (
					x: ArrayLike<number>,
					y: ArrayLike<number>,
					w: number,
					h: number
				) => number;
				const decode = async (base64: string) =>
					createImageBitmap(
						await (await fetch(`data:application/octet-stream;base64,${base64}`)).blob()
					);
				const [x, y] = await Promise.all([decode(a), decode(b)]);
				const scale = Math.min(1, maxSide / Math.max(y.width, y.height));
				const w = Math.max(1, Math.round(y.width * scale));
				const h = Math.max(1, Math.round(y.height * scale));
				const plane = (bitmap: ImageBitmap) => {
					const canvas = new OffscreenCanvas(w, h);
					const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
					g.fillStyle = '#fff';
					g.fillRect(0, 0, w, h);
					g.imageSmoothingQuality = 'high';
					g.drawImage(bitmap, 0, 0, w, h);
					const data = g.getImageData(0, 0, w, h).data;
					const luma = new Float32Array(w * h);
					for (let i = 0; i < luma.length; i++) {
						luma[i] =
							0.299 * data[i * 4]! +
							0.587 * data[i * 4 + 1]! +
							0.114 * data[i * 4 + 2]!;
					}
					return luma;
				};
				return {
					ssim: ssim(plane(x), plane(y), w, h),
					side: [w, h] as [number, number],
					original: [x.width, x.height] as [number, number]
				};
			},
			{
				a: Buffer.from(original).toString('base64'),
				b: Buffer.from(converted).toString('base64'),
				maxSide: SSIM_SIDE,
				fn: ssimLuma.toString()
			}
		);
	} catch {
		return null;
	}
}

type Req = {
	url: string;
	type: string;
	mime: string;
	status: number;
	bytes: number | null;
	cached: boolean;
	frameId: string;
	phase: 'load' | 'scroll';
};

type Shown = { src: string; cssW: number; cssH: number; naturalW: number; naturalH: number };

async function scrollToEnd(page: Page): Promise<void> {
	await page.evaluate(async (steps) => {
		for (let i = 0; i < steps; i++) {
			const before = window.scrollY;
			window.scrollBy(0, window.innerHeight);
			await new Promise((r) => setTimeout(r, 200));
			if (window.scrollY === before) break;
		}
	}, SCROLL_STEPS);
	await sleep(1000);
}

async function shownImages(page: Page): Promise<Shown[]> {
	return page.evaluate(() =>
		[...document.images]
			.filter((img) => img.currentSrc)
			.map((img) => {
				const box = img.getBoundingClientRect();
				return {
					src: img.currentSrc,
					cssW: box.width,
					cssH: box.height,
					naturalW: img.naturalWidth,
					naturalH: img.naturalHeight
				};
			})
	);
}

async function videoTags(page: Page) {
	return page.evaluate(() =>
		[...document.querySelectorAll('video')].map((v) => ({
			autoplay: v.hasAttribute('autoplay'),
			preload: v.getAttribute('preload'),
			controls: v.hasAttribute('controls')
		}))
	);
}

// #endregion

export type ImageRow = {
	kind: 'image';
	site: string;
	profile: ProfileName;
	page: string;
	url: string;
	phase: 'load' | 'scroll';
	format: ImageKind;
	bytes: number;
	sha1: string | null;
	cssWidth: number | null;
	cssHeight: number | null;
	naturalWidth: number | null;
	naturalHeight: number | null;
	dpr: number;
	arms: {
		native?: Arm;
		ceiling?: Arm | null;
		resized?: Arm | null;
		lossless?: Arm | null;
	} | null;
};

export type PageRow = {
	kind: 'page';
	site: string;
	profile: ProfileName;
	variant: 'original' | 'lazy';
	page: string;
	pageKind: 'home' | 'internal';
	ok: true | string;
	requests: number;
	docBytes: number | null;
	imageBytesLoad: number;
	imageBytesScroll: number;
	imagesLoad: number;
	imagesScroll: number;
	videoBytes: number;
	videoTags: Array<{ autoplay: boolean; preload: string | null; controls: boolean }>;
	iframes: Array<{ host: string; bytes: number; requests: number }>;
	lcp: { tag: string | null; loading: string | null; url: string | null } | null;
	lazied: number;
};

export type EmbedRow = {
	kind: 'embed';
	provider: 'youtube' | 'vimeo';
	arm: 'iframe' | 'facade';
	requests: number;
	bytes: number;
	docBytes: number;
	hosts: string[];
	thumbnailBytes: number;
};

type Ctx = {
	browser: Browser;
	tiny: TinyBinding | null;
	save: string | null;
	scorer: Page | null;
	skip: number;
};

const phaseTotal = (reqs: Req[], type: string, phase: Req['phase']) =>
	reqs
		.filter((r) => r.type === type && r.phase === phase)
		.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

async function visitPage(
	context: BrowserContext,
	ctx: Ctx,
	site: string,
	profile: ProfileName,
	variant: PageRow['variant'],
	url: string,
	pageKind: PageRow['pageKind'],
	seen: Set<string>,
	lazied: { n: number },
	images: ImageRow[]
): Promise<PageRow> {
	await sleep(DELAY_MS);
	const page = await context.newPage();
	const cdp: CDPSession = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Page.enable');
	const reqs = new Map<string, Req>();
	let phase: Req['phase'] = 'load';
	cdp.on(
		'Network.requestWillBeSent',
		(e: { requestId: string; request: { url: string }; type?: string; frameId?: string }) => {
			reqs.set(e.requestId, {
				url: e.request.url,
				type: e.type ?? 'Other',
				mime: '',
				status: 0,
				bytes: null,
				cached: false,
				frameId: e.frameId ?? '',
				phase
			});
		}
	);
	cdp.on(
		'Network.responseReceived',
		(e: { requestId: string; response: { status: number; mimeType: string } }) => {
			const r = reqs.get(e.requestId);
			if (r) {
				r.status = e.response.status;
				r.mime = e.response.mimeType;
			}
		}
	);
	cdp.on('Network.requestServedFromCache', (e: { requestId: string }) => {
		const r = reqs.get(e.requestId);
		if (r) r.cached = true;
	});
	cdp.on('Network.loadingFinished', (e: { requestId: string; encodedDataLength: number }) => {
		const r = reqs.get(e.requestId);
		if (r) r.bytes = e.encodedDataLength;
	});
	const before = lazied.n;
	let ok: true | string = true;
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
	} catch (error) {
		ok = String(error).slice(0, 160);
	}
	const empty: PageRow = {
		kind: 'page',
		site,
		profile,
		variant,
		page: new URL(url).pathname,
		pageKind,
		ok,
		requests: 0,
		docBytes: null,
		imageBytesLoad: 0,
		imageBytesScroll: 0,
		imagesLoad: 0,
		imagesScroll: 0,
		videoBytes: 0,
		videoTags: [],
		iframes: [],
		lcp: null,
		lazied: 0
	};
	if (ok !== true) {
		await page.close();
		return empty;
	}
	await sleep(SETTLE_MS);
	const lcp = (await page.evaluate(
		() => (window as unknown as { __lcp?: PageRow['lcp'] }).__lcp ?? null
	)) as PageRow['lcp'];
	phase = 'scroll';
	await scrollToEnd(page);
	const shown = await shownImages(page);
	const videos = await videoTags(page);
	const frames = (await cdp.send('Page.getFrameTree')) as {
		frameTree: {
			frame: { id: string };
			childFrames?: Array<{ frame: { id: string; url: string } }>;
		};
	};
	const hostOfFrame = new Map<string, string>();
	const walk = (
		node: { frame: { id: string; url?: string }; childFrames?: unknown[] },
		depth: number
	) => {
		if (depth > 0 && node.frame.url) {
			try {
				hostOfFrame.set(node.frame.id, new URL(node.frame.url).host);
			} catch {
				hostOfFrame.set(node.frame.id, 'about');
			}
		}
		for (const child of (node.childFrames ?? []) as Array<typeof node>) walk(child, depth + 1);
	};
	walk(frames.frameTree, 0);
	const all = [...reqs.entries()];
	const mainId = frames.frameTree.frame.id;
	const iframes = new Map<string, { bytes: number; requests: number }>();
	for (const [, r] of all) {
		if (!r.frameId || r.frameId === mainId) continue;
		const host = hostOfFrame.get(r.frameId) ?? 'unknown';
		const row = iframes.get(host) ?? { bytes: 0, requests: 0 };
		row.bytes += r.bytes ?? 0;
		row.requests++;
		iframes.set(host, row);
	}
	const list = all.map(([, r]) => r);
	const doc = list.find((r) => r.type === 'Document');
	const imgs = list.filter((r) => r.type === 'Image' && r.frameId === mainId);
	if (variant === 'original') {
		const byUrl = new Map<string, Shown>();
		for (const s of shown) {
			const prior = byUrl.get(s.src);
			if (!prior || s.cssW > prior.cssW) byUrl.set(s.src, s);
		}
		const dpr = (await page.evaluate(() => window.devicePixelRatio)) as number;
		for (const [id, r] of all) {
			if (r.type !== 'Image' || r.frameId !== mainId || r.cached || seen.has(r.url)) continue;
			if (r.url.startsWith('data:') || (r.bytes ?? 0) === 0) continue;
			seen.add(r.url);
			let body: Uint8Array | null = null;
			let kind: ImageKind = 'other';
			try {
				const res = (await cdp.send('Network.getResponseBody', { requestId: id })) as {
					body: string;
					base64Encoded: boolean;
				};
				body = res.base64Encoded ? Buffer.from(res.body, 'base64') : Buffer.from(res.body);
				kind = kindOf(body);
			} catch {
				kind = 'other';
			}
			const view = byUrl.get(r.url);
			const bytes = r.bytes ?? 0;
			const row: ImageRow = {
				kind: 'image',
				site,
				profile,
				page: new URL(url).pathname,
				url: reduceUrl(r.url),
				phase: r.phase,
				format: kind,
				bytes,
				sha1: null,
				cssWidth: view ? Math.round(view.cssW * 10) / 10 : null,
				cssHeight: view ? Math.round(view.cssH * 10) / 10 : null,
				naturalWidth: view?.naturalW ?? null,
				naturalHeight: view?.naturalH ?? null,
				dpr,
				arms: null
			};
			if (body && (kind === 'jpeg' || kind === 'png')) {
				row.sha1 = createHash('sha1').update(body).digest('hex');
				if (ctx.save) writeFileSync(join(ctx.save, `${row.sha1}.bin`), body);
				if (ctx.tiny && body.length >= MIN_BYTES && body.length <= MAX_BYTES) {
					row.arms = await convertArms(ctx, body, kind, row);
				}
			}
			images.push(row);
		}
	}
	const row: PageRow = {
		...empty,
		requests: list.length,
		docBytes: doc?.bytes ?? null,
		imageBytesLoad: phaseTotal(imgs, 'Image', 'load'),
		imageBytesScroll: phaseTotal(imgs, 'Image', 'scroll'),
		imagesLoad: imgs.filter((r) => r.phase === 'load' && (r.bytes ?? 0) > 0).length,
		imagesScroll: imgs.filter((r) => r.phase === 'scroll' && (r.bytes ?? 0) > 0).length,
		videoBytes: list
			.filter((r) => r.type === 'Media')
			.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
		videoTags: videos,
		iframes: [...iframes].map(([host, v]) => ({ host, ...v })),
		lcp,
		lazied: lazied.n - before
	};
	await page.close();
	return row;
}

async function convertArms(
	ctx: Ctx,
	body: Uint8Array,
	kind: 'jpeg' | 'png',
	row: ImageRow
): Promise<ImageRow['arms']> {
	const tiny = ctx.tiny as TinyBinding;
	const arms: NonNullable<ImageRow['arms']> = {};
	const native = await encodeArm(tiny, body, {});
	if (!native) return null;
	const score = async (made: { arm: Arm; bytes: Uint8Array }) => {
		const result = ctx.scorer ? await ssimInPage(ctx.scorer, body, made.bytes) : null;
		made.arm.ssim = result ? Math.round(result.ssim * 10_000) / 10_000 : null;
		return made.arm;
	};
	arms.native = await score(native);
	const naturalWidth =
		row.naturalWidth && row.naturalWidth > 0 ? row.naturalWidth : native.arm.width;
	if (naturalWidth > CEILING) {
		const made = await encodeArm(tiny, body, { width: CEILING, fit: 'scale-down' });
		arms.ceiling = made ? await score(made) : null;
	} else {
		arms.ceiling = null;
	}
	const width = renderedWidth(row.cssWidth, row.dpr, naturalWidth);
	if (width !== undefined) {
		const made = await encodeArm(tiny, body, { width, fit: 'scale-down' });
		arms.resized = made ? await score(made) : null;
	} else {
		arms.resized = null;
	}
	if (kind === 'png') {
		const made = await encodeArm(tiny, body, { lossless: true });
		arms.lossless = made ? await score(made) : null;
	}
	return arms;
}

const pageUrls = new Map<string, string[]>();

async function chooseUrls(context: BrowserContext, site: string, pages: number): Promise<string[]> {
	const known = pageUrls.get(site);
	if (known) return known;
	const origin = new URL(site).origin;
	let urls = [site];
	try {
		const home = await context.request.get(site, { timeout: 30_000, failOnStatusCode: false });
		const html = home.ok() ? await home.text() : '';
		urls = [
			site,
			...pickPages(internalLinks(html, home.url()), new Set(), pages).map(
				(p) => `${origin}${p}`
			)
		];
	} catch {
		urls = [site];
	}
	pageUrls.set(site, urls);
	return urls;
}

async function walkSite(
	ctx: Ctx,
	site: string,
	profile: ProfileName,
	variant: PageRow['variant'],
	pages: number,
	lazyPages: number
): Promise<{ pages: PageRow[]; images: ImageRow[] }> {
	const version = ctx.browser.version();
	const context = await ctx.browser.newContext({
		...(PROFILES[profile] as Record<string, unknown>),
		userAgent: `Mozilla/5.0 (${profile === 'phone' ? 'Linux; Android 14; Pixel 7' : 'Macintosh; Intel Mac OS X 10_15_7'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}${profile === 'phone' ? ' Mobile' : ''} Safari/537.36 spool-image-crawl/1.0`
	});
	const lazied = { n: 0 };
	await context.addInitScript(LCP_SCRIPT);
	await context.route('**/*', async (route) => {
		const request = route.request();
		if (!request.isNavigationRequest() || request.frame().parentFrame() !== null) {
			return route.continue();
		}
		try {
			const response = await route.fetch();
			const type = response.headers()['content-type'] ?? '';
			if (!type.includes('text/html')) return route.fulfill({ response });
			const text = await response.text();
			const result =
				variant === 'lazy'
					? rewriteLazy(text, { skip: ctx.skip })
					: { html: text, rewritten: 0 };
			lazied.n += result.rewritten;
			const headers = { ...response.headers() };
			for (const name of ['content-encoding', 'content-length', 'transfer-encoding'])
				delete headers[name];
			return route.fulfill({ response, body: result.html, headers });
		} catch {
			return route.continue();
		}
	});
	const urls = (await chooseUrls(context, site, pages)).slice(
		0,
		variant === 'lazy' ? lazyPages : pages + 1
	);
	const rows: PageRow[] = [];
	const images: ImageRow[] = [];
	const seen = new Set<string>();
	for (const [i, url] of urls.entries()) {
		rows.push(
			await visitPage(
				context,
				ctx,
				site,
				profile,
				variant,
				url,
				i === 0 ? 'home' : 'internal',
				seen,
				lazied,
				images
			)
		);
	}
	await context.close();
	return { pages: rows, images };
}

// #region embeds

const EMBEDS = [
	{ provider: 'youtube', src: `https://www.youtube.com/embed/${VIDEO_YOUTUBE}` },
	{ provider: 'vimeo', src: `https://player.vimeo.com/video/${VIDEO_VIMEO}` }
] as const;

/** a real embed loaded as an iframe, then as the facade, each with an empty cache and no click */
async function embedRows(browser: Browser): Promise<EmbedRow[]> {
	const rows: EmbedRow[] = [];
	for (const embed of EMBEDS) {
		const iframe = `<!doctype html><title>x</title><iframe width="560" height="315" src="${embed.src}" title="Play video" allow="autoplay"></iframe>`;
		const facade = rewriteEmbeds(iframe).html;
		for (const arm of ['iframe', 'facade'] as const) {
			const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
			const html = arm === 'iframe' ? iframe : facade;
			await context.route('https://spool.test/', (route) =>
				route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
			);
			const page = await context.newPage();
			const cdp = await context.newCDPSession(page);
			await cdp.send('Network.enable');
			const seen = new Map<string, { url: string; bytes: number; frame: string }>();
			cdp.on(
				'Network.requestWillBeSent',
				(e: { requestId: string; request: { url: string }; frameId?: string }) => {
					seen.set(e.requestId, { url: e.request.url, bytes: 0, frame: e.frameId ?? '' });
				}
			);
			cdp.on(
				'Network.loadingFinished',
				(e: { requestId: string; encodedDataLength: number }) => {
					const r = seen.get(e.requestId);
					if (r) r.bytes = e.encodedDataLength;
				}
			);
			try {
				await page.goto('https://spool.test/', { waitUntil: 'load', timeout: 45_000 });
				await sleep(6000);
			} catch {
				// the row records what arrived
			}
			const list = [...seen.values()].filter(
				(r) => r.url !== 'https://spool.test/' && !r.url.startsWith('data:')
			);
			rows.push({
				kind: 'embed',
				provider: embed.provider,
				arm,
				requests: list.length,
				bytes: list.reduce((sum, r) => sum + r.bytes, 0),
				docBytes: Buffer.byteLength(html),
				hosts: [...new Set(list.map((r) => new URL(r.url).host))].sort(),
				thumbnailBytes: list
					.filter((r) => r.url.includes('ytimg.com'))
					.reduce((sum, r) => sum + r.bytes, 0)
			});
			await context.close();
		}
	}
	return rows;
}

// #endregion

// #region the paisley image set

type SetEntry = {
	file: string;
	sha1: string;
	format: ImageKind;
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

/** images for the decode and encode experiments: JPEG and PNG with a known rendered width narrower than the file, spread over sites */
export function chooseSet(rows: readonly ImageRow[], count: number, maxBytes: number): ImageRow[] {
	const eligible = rows.filter(
		(r) =>
			r.sha1 !== null &&
			(r.format === 'jpeg' || r.format === 'png') &&
			r.cssWidth !== null &&
			r.naturalWidth !== null &&
			r.bytes >= 30_000 &&
			renderedWidth(r.cssWidth, r.dpr, r.naturalWidth) !== undefined
	);
	const unique = [...new Map(eligible.map((r) => [r.sha1, r])).values()];
	const bySite = new Map<string, ImageRow[]>();
	for (const row of unique.sort((a, b) => a.bytes - b.bytes)) {
		bySite.set(row.site, [...(bySite.get(row.site) ?? []), row]);
	}
	const chosen: ImageRow[] = [];
	let total = 0;
	for (let round = 0; chosen.length < count && round < 20; round++) {
		for (const rowsOfSite of bySite.values()) {
			const pick = rowsOfSite[Math.floor(((round + 0.5) * rowsOfSite.length) / 20)];
			if (!pick || chosen.includes(pick) || total + pick.bytes > maxBytes) continue;
			chosen.push(pick);
			total += pick.bytes;
			if (chosen.length === count) break;
		}
	}
	return chosen;
}

async function buildSet(
	from: string,
	readingPath: string,
	to: string,
	count: number,
	maxMb: number,
	tiny: TinyBinding
) {
	const reading = JSON.parse(readFileSync(readingPath, 'utf8')) as {
		rows: Array<ImageRow | PageRow | EmbedRow>;
	};
	const rows = reading.rows.filter((r): r is ImageRow => r.kind === 'image');
	const chosen = chooseSet(rows, count, maxMb * 1_000_000);
	mkdirSync(to, { recursive: true });
	const entries: SetEntry[] = [];
	for (const [i, row] of chosen.entries()) {
		const body = readFileSync(join(from, `${row.sha1}.bin`));
		const name = String(i + 1).padStart(2, '0');
		const ext = row.format === 'png' ? 'png' : 'jpg';
		const width = renderedWidth(row.cssWidth, row.dpr, row.naturalWidth as number) as number;
		const native = await encodeArm(tiny, body, {});
		const resized = await encodeArm(tiny, body, { width, fit: 'scale-down' });
		if (!native || !resized) continue;
		writeFileSync(join(to, `${name}-original.${ext}`), body);
		writeFileSync(join(to, `${name}-native.webp`), native.bytes);
		writeFileSync(join(to, `${name}-resized.webp`), resized.bytes);
		entries.push({
			file: name,
			sha1: row.sha1 as string,
			format: row.format,
			bytes: body.length,
			naturalWidth: row.naturalWidth as number,
			naturalHeight: row.naturalHeight as number,
			cssWidth: row.cssWidth as number,
			dpr: row.dpr,
			resizedWidth: width,
			original: `${name}-original.${ext}`,
			webp: `${name}-native.webp`,
			resized: `${name}-resized.webp`,
			webpBytes: native.bytes.length,
			resizedBytes: resized.bytes.length
		});
	}
	writeFileSync(
		join(to, 'manifest.json'),
		`${JSON.stringify({ tinyimg: tiny.version, quality: QUALITY, images: entries }, null, '\t')}\n`
	);
	return entries;
}

// #endregion

export function parse(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false },
			sites: { type: 'string' },
			profiles: { type: 'string', default: 'desktop,phone' },
			pages: { type: 'string', default: String(PAGES_PER_SITE) },
			'lazy-pages': { type: 'string', default: String(LAZY_PAGES) },
			skip: { type: 'string', default: String(LAZY_SKIP) },
			tinyimg: { type: 'string', default: process.env.SPOOL_TINYIMG },
			save: { type: 'string' },
			'no-convert': { type: 'boolean', default: false },
			'no-embeds': { type: 'boolean', default: false },
			from: { type: 'string' },
			reading: { type: 'string' },
			to: { type: 'string' },
			count: { type: 'string', default: '40' },
			'max-mb': { type: 'string', default: '25' }
		}
	});
	const profiles = (values.profiles as string)
		.split(',')
		.filter((p): p is ProfileName => p in PROFILES);
	return {
		command: positionals[0],
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean,
		sites: values.sites?.split(',') ?? null,
		profiles,
		pages: Number(values.pages),
		lazyPages: Number(values['lazy-pages']),
		skip: Number(values.skip),
		tinyimg: values.tinyimg,
		save: values.save,
		noConvert: values['no-convert'] as boolean,
		noEmbeds: values['no-embeds'] as boolean,
		from: values.from,
		reading: values.reading,
		to: values.to,
		count: Number(values.count),
		maxMb: Number(values['max-mb'])
	};
}

/** what a dry run prints: the plan with every default resolved and the file it would write */
export function plan(args: ReturnType<typeof parse>) {
	const sites = SITES.filter((s) => !args.sites || args.sites.some((part) => s.includes(part)));
	return {
		rig: 'image-crawl',
		date: utcDate(),
		sites,
		profiles: args.profiles,
		internalPagesPerSite: args.pages,
		lazyPagesPerSite: args.lazyPages,
		lazySkip: args.skip,
		variants: ['original', 'lazy'],
		pageLoadsPerSite: args.profiles.length * (args.pages + 1 + args.lazyPages),
		delayMs: DELAY_MS,
		convert: !args.noConvert,
		tinyimg: args.tinyimg ?? null,
		embeds: args.noEmbeds ? [] : EMBEDS.map((e) => e.provider),
		save: args.save ?? null,
		output: `measurements/image-crawl/${utcDate()}${args.experiment ? `-${args.experiment}` : ''}.json`
	};
}

const stat = (xs: number[]) => ({ median: median(xs), p90: quantile(xs, 0.9) });

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(JSON.stringify(plan(args), null, 2));
	} else if (args.command === 'set') {
		if (!args.from || !args.reading || !args.to || !args.tinyimg)
			throw new Error('set needs --from, --reading, --to and --tinyimg');
		const tiny = await loadTinyimg(args.tinyimg);
		const entries = await buildSet(
			args.from,
			args.reading,
			args.to,
			args.count,
			args.maxMb,
			tiny
		);
		console.log(
			JSON.stringify({
				images: entries.length,
				bytes: entries.reduce((s, e) => s + e.bytes + e.webpBytes + e.resizedBytes, 0)
			})
		);
	} else {
		if (args.save) mkdirSync(args.save, { recursive: true });
		const tiny = args.noConvert || !args.tinyimg ? null : await loadTinyimg(args.tinyimg);
		if (!args.noConvert && !tiny)
			throw new Error('set --tinyimg DIR or SPOOL_TINYIMG, or pass --no-convert');
		const browser = await chromium.launch();
		const scorerContext = await browser.newContext();
		const scorer = await scorerContext.newPage();
		await scorer.goto('about:blank');
		const ctx: Ctx = { browser, tiny, save: args.save ?? null, scorer, skip: args.skip };
		const sites = plan(args).sites;
		const rows: Array<PageRow | ImageRow | EmbedRow> = [];
		const failed: string[] = [];
		const queue = [...sites];
		const worker = async () => {
			for (let site = queue.shift(); site !== undefined; site = queue.shift()) {
				for (const profile of args.profiles) {
					for (const variant of ['original', 'lazy'] as const) {
						try {
							const done = await walkSite(
								ctx,
								site,
								profile,
								variant,
								args.pages,
								args.lazyPages
							);
							rows.push(...done.pages, ...done.images);
						} catch (error) {
							failed.push(
								`${site} ${profile} ${variant}: ${String(error).slice(0, 160)}`
							);
						}
					}
				}
				console.error(`done ${site}`);
			}
		};
		await Promise.all(Array.from({ length: SITE_CONCURRENCY }, worker));
		if (!args.noEmbeds) rows.push(...(await embedRows(browser)));
		const version = browser.version();
		await browser.close();
		const images = rows.filter((r): r is ImageRow => r.kind === 'image');
		const pages = rows.filter((r): r is PageRow => r.kind === 'page');
		console.error(
			JSON.stringify(
				{
					images: images.length,
					pages: pages.length,
					bytesPerImage: stat(images.map((r) => r.bytes)),
					imageBytesLoad: stat(
						pages.filter((p) => p.variant === 'original').map((p) => p.imageBytesLoad)
					)
				},
				null,
				2
			)
		);
		const draft: Draft = {
			rig: 'image-crawl',
			date: utcDate(),
			layer: 'L1',
			question:
				'what the images, video and iframes of a first view cost in bytes on 16 public sites, what converting each JPEG and PNG to WebP (native size, under a width ceiling, resized to the rendered width, lossless for PNG) would save and at what SSIM, how many image bytes load before the first scroll, and what loading="lazy" removes from that count',
			instrument:
				'Chromium CDP Network (encodedDataLength, response bodies), DOM image and LCP observations; @gmitch215/tinyimg ' +
				`${tiny?.version ?? 'not run'} for the WebP arms and its milliseconds; SSIM (8 by 8 blocks, luma, both decodes scaled to the converted size, long side at most ${SSIM_SIDE}) computed in the page from canvas pixels`,
			machine: localMachine(args.machine),
			software: {
				browser: `Chromium ${version}, Playwright bundled build`,
				runtime: `Bun ${process.versions.bun}`,
				tinyimg: tiny?.version ?? 'none'
			},
			method: {
				sites: sites.length,
				profiles: Object.fromEntries(
					args.profiles.map((p) => [
						p,
						p === 'phone'
							? 'Playwright Pixel 7 device (dpr 2.625, touch, mobile)'
							: '1440 by 900, dpr 1'
					])
				),
				pages: `home plus up to ${args.pages} internal pages chosen by payload.ts pickPages from the home page links; the lazy variant visits the first ${args.lazyPages} of them`,
				context:
					'one fresh browser context per site, profile and variant; both variants route every request through Playwright (the main-frame HTML is fetched by the route and fulfilled, rewritten only in the lazy variant), which turns the browser HTTP cache off, so every page loads with an empty cache; an image row is kept once, on the first page that downloads it',
				scroll: `load, wait ${SETTLE_MS} ms, record image bytes (before the first scroll), then scroll one viewport at a time up to ${SCROLL_STEPS} steps, wait 1000 ms, record again; an image whose request began after the scroll started has phase scroll`,
				'rendered size':
					'getBoundingClientRect width of the largest <img> showing the URL, after the scroll; CSS backgrounds have none',
				arms: `native (WebP quality ${QUALITY}), ceiling (width ${CEILING}, fit scale-down, only for files wider than it), resized (width = ceil(rendered CSS width x dpr), only when narrower than the file), lossless (PNG only)`,
				ssim: 'original and converted decoded with createImageBitmap, drawn on white at the converted size scaled so the long side is at most 512, luma, mean SSIM over 8 by 8 blocks',
				lazy: `the main-frame HTML is rewritten by rewriteLazy (skip ${args.skip}; it leaves an image with fetchpriority, a preload link or a header ancestor) through page.route before the browser sees it; the LCP element is read from a PerformanceObserver before the scroll`,
				embeds: 'a page served at https://spool.test/ holds one iframe to a real YouTube or Vimeo embed, or the facade rewriteEmbeds makes of it; nothing is clicked; 6 s after load; bytes are encodedDataLength of every request except the page',
				'request pacing': `${DELAY_MS} ms before each page visit, ${SITE_CONCURRENCY} sites at once; the browser fetches a page's own subresources in parallel`
			},
			exclusions: [
				...failed,
				...pages
					.filter((p) => p.ok !== true)
					.map((p) => `${p.site} ${p.page} ${p.profile} ${p.variant}: ${String(p.ok)}`),
				'image rows with a zero-byte transfer or served from cache',
				'images in an iframe, which the iframe rows count'
			],
			rows: rows as unknown as Record<string, unknown>[]
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	}
}
