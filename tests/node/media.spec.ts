import { describe, expect, it, vi } from 'vitest';
import { makePrivate, mergeList } from '../../src/media/headers';
import {
	createImageConverter,
	embedOf,
	facadeDocument,
	IMAGE_HINTS,
	IMAGE_VARY,
	imageVariant,
	memoryImageCache,
	resolveResponsiveOptions,
	rewriteEmbeds,
	rewriteLazy,
	rewriteResponsive,
	rewriteVideo,
	signalsOf,
	takeWidth,
	TINYIMG_MIN_VERSION,
	tinyimgEncoder,
	type ImageCache,
	type ImageEncodeOptions,
	type ImageEncoder,
	type ImageOptions,
	type ResponsiveOptions,
	type VideoOptions
} from '../../src/media/index';
import { decodeEnvelope, parseArtifact, ProtocolError } from '../../src/protocol/index';
import { spoolProxy, type ProxyOptions } from '../../src/proxy/index';
import { memoryStore } from '../../src/stores/index';
import { buildTrimManifest } from '../../src/trim/index';
import { fakeOrigin, HTML, type Reply } from './exercise';

const HOST = 'https://site.test';
const ORIGIN = 'https://origin.test';
const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>body</p></body></html>';
const WEBP = 'image/avif,image/webp,*/*';
const NONE = { saveData: false, slow: false };

/** a JPEG by its magic number, `size` bytes long, distinct by `seed` */
function jpeg(size: number, seed = 1): Uint8Array {
	const bytes = new Uint8Array(size).fill(seed);
	bytes.set([0xff, 0xd8, 0xff]);
	return bytes;
}

/** a PNG by its magic number, `size` bytes long, distinct by `seed` */
function png(size: number, seed = 1): Uint8Array {
	const bytes = new Uint8Array(size).fill(seed);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return bytes;
}

const JPEG_REPLY = (body: Uint8Array): Reply => ({
	headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000' },
	body
});

type Call = { length: number; options: ImageEncodeOptions };

/** an encoder that keeps a quarter of the bytes and records what it was asked */
function fakeEncoder(): { calls: Call[]; encoder: ImageEncoder } {
	const calls: Call[] = [];
	const encoder: ImageEncoder = async (input, options) => {
		calls.push({ length: input.length, options });
		return { bytes: new Uint8Array(Math.max(1, Math.floor(input.length / 4))) };
	};
	return { calls, encoder };
}

function rig(images: Partial<ImageOptions> = {}, over: Partial<ProxyOptions> = {}) {
	const origin = fakeOrigin();
	const { calls, encoder } = fakeEncoder();
	const proxy = spoolProxy({
		origin: ORIGIN,
		spool: { store: memoryStore() },
		fetch: origin.fetch,
		images: { encoder, ...images },
		...over
	});
	origin.replies.set('/photo.jpg', JPEG_REPLY(jpeg(10_000)));
	origin.replies.set('/chart.png', {
		headers: { 'content-type': 'image/png' },
		body: png(8_000)
	});
	origin.replies.set('/page', {
		body: PAGE,
		headers: { 'content-type': HTML, 'cache-tag': 't1' }
	});
	const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
		proxy(new Request(`${HOST}${path}`, { ...init, headers: { accept: WEBP, ...headers } }));
	return { ...origin, calls, encoder, proxy, call };
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

/** the page text without the client script the spool adds to a kept page */
const undecorated = async (response: Response) =>
	(await response.text()).replace(/<script src="\/\.spool\/[^>]*><\/script>/, '');

const ZERO = {
	converted: 0,
	bytesIn: 0,
	bytesOut: 0,
	cacheHits: 0,
	coalesced: 0,
	lazied: 0,
	responsive: 0,
	skipped: {}
};

describe('imageVariant', () => {
	const headers = (init: Record<string, string>) => new Headers(init);

	it('uses the default quality and no width when the request says nothing', () => {
		expect(imageVariant(headers({}))).toEqual({ quality: 80 });
		expect(imageVariant(headers({}), { quality: { default: 75 } })).toEqual({ quality: 75 });
	});

	it('picks the quality from Save-Data, then from a slow ECT', () => {
		const quality = { default: 80, saveData: 60, slow: 70 };
		expect(imageVariant(headers({ 'save-data': 'on' }), { quality }).quality).toBe(60);
		expect(imageVariant(headers({ 'save-data': ' ON ' }), { quality }).quality).toBe(60);
		expect(imageVariant(headers({ 'save-data': 'off' }), { quality }).quality).toBe(80);
		for (const ect of ['slow-2g', '2g', '3G']) {
			expect(imageVariant(headers({ ect }), { quality }).quality, ect).toBe(70);
		}
		expect(imageVariant(headers({ ect: '4g' }), { quality }).quality).toBe(80);
		expect(imageVariant(headers({ 'save-data': 'on' })).quality).toBe(65);
		expect(imageVariant(headers({ ect: '3g' })).quality).toBe(70);
	});

	it('lets Save-Data win over a slow connection', () => {
		const both = headers({ 'save-data': 'on', ect: 'slow-2g' });
		expect(imageVariant(both, { quality: { saveData: 50, slow: 70 } }).quality).toBe(50);
	});

	it('reads the width from Sec-CH-Width, then viewport times DPR rounded up, then the fallback', () => {
		const width = { fallback: 1200 };
		expect(imageVariant(headers({ 'sec-ch-width': '640' }), { width }).width).toBe(640);
		expect(
			imageVariant(headers({ 'sec-ch-width': '640', 'sec-ch-viewport-width': '1000' }), {
				width
			}).width
		).toBe(640);
		const phone = headers({ 'sec-ch-viewport-width': '393', 'sec-ch-dpr': '2.625' });
		expect(imageVariant(phone, { width }).width).toBe(1032);
		expect(imageVariant(headers({}), { width }).width).toBe(1200);
		expect(imageVariant(headers({}))).not.toHaveProperty('width');
	});

	it('ignores a width that is not a positive number of at most 16384', () => {
		const width = { fallback: 900 };
		for (const bad of ['abc', '0', '-5', '16385', '12.5', '', '1e3']) {
			expect(imageVariant(headers({ 'sec-ch-width': bad }), { width }).width, bad).toBe(900);
		}
		expect(imageVariant(headers({ 'sec-ch-width': '16384' })).width).toBe(16384);
		const viewport = (vw: string, dpr: string) =>
			imageVariant(headers({ 'sec-ch-viewport-width': vw, 'sec-ch-dpr': dpr }), { width })
				.width;
		expect(viewport('1000', '0')).toBe(900);
		expect(viewport('1000', 'x')).toBe(900);
		expect(viewport('0', '2')).toBe(900);
		expect(viewport('10000', '2')).toBe(900);
		expect(imageVariant(headers({ 'sec-ch-viewport-width': '500' }), { width }).width).toBe(
			900
		);
	});

	it('names the Vary and Accept-CH members', () => {
		expect(IMAGE_VARY).toEqual([
			'Accept',
			'Save-Data',
			'Sec-CH-Width',
			'Sec-CH-DPR',
			'Sec-CH-Viewport-Width',
			'ECT'
		]);
		expect(IMAGE_HINTS).toEqual(['Sec-CH-DPR', 'Sec-CH-Width', 'Sec-CH-Viewport-Width', 'ECT']);
	});
});

describe('tinyimgEncoder', () => {
	it('passes the module, the bytes and fit only when a width is set, and returns the bytes', async () => {
		const seen: Array<{ module: unknown; input: Uint8Array; options: object }> = [];
		const module = { loaded: true };
		const encode = tinyimgEncoder({
			module,
			transform: async (m, input, options) => {
				seen.push({ module: m, input, options });
				return { bytes: () => new Uint8Array([1, 2, 3]) };
			}
		});
		const input = new Uint8Array([9]);
		expect(await encode(input, { format: 'webp', quality: 70 })).toEqual({
			bytes: new Uint8Array([1, 2, 3])
		});
		await encode(input, { format: 'webp', quality: 70, width: 640 });
		expect(seen[0]?.module).toBe(module);
		expect(seen[0]?.input).toBe(input);
		expect(seen[0]?.options).toEqual({ format: 'webp', quality: 70 });
		expect(seen[1]?.options).toEqual({
			format: 'webp',
			quality: 70,
			width: 640,
			fit: 'scale-down'
		});
		await encode(input, { format: 'webp', quality: 70, budgetMs: 8000 });
		expect(seen[2]?.options).toEqual({ format: 'webp', quality: 70, budgetMs: 8000 });
	});

	it('refuses a module older than the orientation fix and accepts the rest', () => {
		const transform = async () => ({ bytes: () => new Uint8Array(1) });
		for (const version of [
			[1, 1, 0],
			[1, 0, 9],
			[0, 9, 9]
		]) {
			expect(() => tinyimgEncoder({ module: { version }, transform })).toThrow(
				`tinyimg ${version.join('.')} leaves an EXIF-rotated JPEG sideways; use 1.1.1 or later`
			);
		}
		for (const version of [
			[1, 1, 1],
			[1, 1, 2],
			[1, 2, 0],
			[2, 0, 0]
		]) {
			expect(() => tinyimgEncoder({ module: { version }, transform })).not.toThrow();
		}
		for (const module of [
			{},
			{ version: '1.1.0' },
			{ version: [1, 1] },
			{ version: [1, 1.5, 0] },
			null,
			0
		]) {
			expect(() => tinyimgEncoder({ module, transform })).not.toThrow();
		}
		expect(TINYIMG_MIN_VERSION).toEqual([1, 1, 1]);
	});

	it('lets what the transform throws reach the caller', async () => {
		const encode = tinyimgEncoder({
			module: 0,
			transform: async () => {
				throw new Error('bad image');
			}
		});
		await expect(encode(new Uint8Array(1), { format: 'webp', quality: 80 })).rejects.toThrow(
			'bad image'
		);
	});
});

describe('memoryImageCache', () => {
	it('drops the least recently used entry past the cap, and a get refreshes an entry', () => {
		const cache = memoryImageCache(10);
		cache.set('a', new Uint8Array(4));
		cache.set('b', new Uint8Array(4));
		expect(cache.get('a')).toHaveLength(4);
		cache.set('c', new Uint8Array(4));
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')).toBeDefined();
		expect(cache.get('c')).toBeDefined();
	});

	it('replaces a key without counting its old bytes twice, and refuses an entry past the cap', () => {
		const cache = memoryImageCache(10);
		cache.set('a', new Uint8Array(6));
		cache.set('a', new Uint8Array(6));
		cache.set('b', new Uint8Array(4));
		expect(cache.get('a')).toHaveLength(6);
		expect(cache.get('b')).toHaveLength(4);
		cache.set('big', new Uint8Array(11));
		expect(cache.get('big')).toBeUndefined();
		expect(cache.get('a')).toBeDefined();
	});

	it('refuses a cap that is not a positive integer', () => {
		expect(() => memoryImageCache(0)).toThrow(ProtocolError);
		expect(() => memoryImageCache(1.5)).toThrow(/maxBytes/);
	});
});

describe('option validation', () => {
	const { encoder } = fakeEncoder();
	const bad = (images: Partial<ImageOptions>) => () =>
		spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			images: { encoder, ...images }
		});

	it('refuses an image option out of range with a bad-route error', () => {
		expect(bad({ quality: { default: 0 } })).toThrow(ProtocolError);
		expect(bad({ quality: { default: 101 } })).toThrow(/quality.default/);
		expect(bad({ quality: { saveData: 70.5 } })).toThrow(/quality.saveData/);
		expect(bad({ quality: { slow: -1 } })).toThrow(/quality.slow/);
		expect(bad({ minBytes: -1 })).toThrow(/minBytes/);
		expect(bad({ minBytes: 1.5 })).toThrow(/minBytes/);
		expect(bad({ maxBytes: 0 })).toThrow(/maxBytes/);
		expect(bad({ minBytes: 100, maxBytes: 50 })).toThrow(/must not exceed/);
		expect(bad({ width: { fallback: 0 } })).toThrow(/width.fallback/);
		expect(bad({ width: { fallback: 16385 } })).toThrow(/width.fallback/);
		expect(bad({ minBytes: 0, maxBytes: 1, width: { fallback: 16384 } })).not.toThrow();
		try {
			bad({ quality: { default: 0 } })();
		} catch (error) {
			expect((error as ProtocolError).code).toBe('bad-route');
		}
	});

	it('refuses a video option it does not know', () => {
		const video = (options: object) => () =>
			spoolProxy({
				origin: ORIGIN,
				spool: { store: memoryStore() },
				video: options as VideoOptions
			});
		expect(video({ preload: 'auto' })).toThrow(/preload/);
		expect(video({ autoplay: 'drop' })).toThrow(/autoplay/);
		expect(video({ when: 'never' })).toThrow(/when/);
		expect(video({ preload: false, autoplay: 'defer', when: 'slow' })).not.toThrow();
	});

	it('builds a converter with the documented defaults', () => {
		const converter = createImageConverter({ encoder });
		expect(converter.options).toMatchObject({
			quality: { default: 80, saveData: 65, slow: 70 },
			minBytes: 4096,
			maxBytes: 15_000_000,
			width: { fallback: 2560 },
			timeoutMs: 10_000,
			hints: true
		});
		expect(converter.options.paths.test('/a/B.JPEG')).toBe(true);
		expect(converter.options.paths.test('/a.gif')).toBe(false);
		expect(converter.cache).toBeDefined();
		expect(createImageConverter({ encoder, cache: false }).cache).toBeUndefined();
	});
});

describe('image conversion in the proxy', () => {
	it('converts a JPEG and a PNG and counts the bytes', async () => {
		const s = rig();
		const photo = await s.call('/photo.jpg');
		expect(photo.status).toBe(200);
		expect(photo.headers.get('content-type')).toBe('image/webp');
		expect(photo.headers.has('content-length')).toBe(false);
		expect(photo.headers.get('cache-control')).toBe('public, max-age=31536000');
		expect(photo.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=2560');
		expect(photo.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{16}-80-2560"$/);
		expect(photo.headers.get('vary')).toBe(IMAGE_VARY.join(', '));
		expect(await bytesOf(photo)).toHaveLength(2500);
		const chart = await s.call('/chart.png');
		expect(chart.headers.get('x-spool-image')).toBe('8000->2000; q=80; w=2560');
		expect(await bytesOf(chart)).toHaveLength(2000);
		const options = { format: 'webp', quality: 80, width: 2560, budgetMs: 10_000 };
		expect(s.calls).toEqual([
			{ length: 10_000, options },
			{ length: 8_000, options }
		]);
		expect({ ...s.proxy.images }).toEqual({
			...ZERO,
			converted: 2,
			bytesIn: 18_000,
			bytesOut: 4_500
		});
	});

	it('encodes once per distinct bytes, quality and width, and counts the repeats as cache hits', async () => {
		const s = rig();
		for (let i = 0; i < 3; i++) await s.call('/photo.jpg');
		expect(s.calls).toHaveLength(1);
		expect(s.proxy.images.cacheHits).toBe(2);
		const saver = await s.call('/photo.jpg', { 'save-data': 'on' });
		expect(saver.headers.get('x-spool-image')).toBe('10000->2500; q=65; w=2560');
		expect(s.calls).toHaveLength(2);
		const sized = await s.call('/photo.jpg', { 'sec-ch-width': '640' });
		expect(sized.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=640');
		await s.call('/photo.jpg', { 'sec-ch-width': '640' });
		expect(s.calls).toHaveLength(3);
		expect(s.calls[2]?.options).toEqual({
			format: 'webp',
			quality: 80,
			width: 640,
			budgetMs: 10_000
		});
		expect(s.proxy.images.cacheHits).toBe(3);
		s.replies.set('/photo.jpg', JPEG_REPLY(jpeg(10_000, 2)));
		await s.call('/photo.jpg');
		expect(s.calls).toHaveLength(4);
		expect(s.proxy.images.converted).toBe(7);
		expect(s.proxy.images.bytesOut).toBe(7 * 2500);
	});

	it('uses the width ceiling from the options when the request names none', async () => {
		const s = rig({ width: { fallback: 1200 } });
		const response = await s.call('/photo.jpg');
		expect(response.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=1200');
		expect(s.calls[0]?.options.width).toBe(1200);
	});

	it('calls the encoder every time with cache: false', async () => {
		const s = rig({ cache: false });
		for (let i = 0; i < 3; i++) await s.call('/photo.jpg');
		expect(s.calls).toHaveLength(3);
		expect(s.proxy.images.cacheHits).toBe(0);
		expect(s.proxy.images.converted).toBe(3);
	});

	it('keeps converted bytes in a cache the caller supplies, keyed by hash, quality and width', async () => {
		const held = new Map<string, Uint8Array>();
		const cache: ImageCache = {
			get: (key) => held.get(key),
			set: (key, bytes) => void held.set(key, bytes)
		};
		const s = rig({ cache });
		await s.call('/photo.jpg', { 'sec-ch-width': '320' });
		expect([...held.keys()]).toHaveLength(1);
		expect([...held.keys()][0]).toMatch(/^sha256-[A-Za-z0-9+/]+=*\|80\|320$/);
	});

	const skipped: Array<{
		name: string;
		path: string;
		reply?: Reply;
		headers?: Record<string, string>;
		images?: Partial<ImageOptions>;
		key: string;
		status?: number;
	}> = [
		{
			name: 'no image/webp in Accept',
			path: '/photo.jpg',
			headers: { accept: '*/*' },
			key: 'accept'
		},
		{
			name: 'a Range request',
			path: '/photo.jpg',
			headers: { range: 'bytes=0-9' },
			key: 'range'
		},
		{
			name: 'Authorization',
			path: '/photo.jpg',
			headers: { authorization: 'Basic eDp5' },
			key: 'authorization'
		},
		{
			name: 'a path that is not a JPEG or PNG',
			path: '/photo.gif',
			reply: { headers: { 'content-type': 'image/gif' }, body: new Uint8Array(9000) },
			key: 'path'
		},
		{ name: 'a 404', path: '/missing.jpg', key: 'status', status: 404 },
		{
			name: 'a content type that is not JPEG or PNG',
			path: '/odd.jpg',
			reply: { headers: { 'content-type': 'text/plain' }, body: jpeg(9000) },
			key: 'type'
		},
		{
			name: 'a WebP behind a JPEG name',
			path: '/modern.jpg',
			reply: { headers: { 'content-type': 'image/webp' }, body: jpeg(9000) },
			key: 'type'
		},
		{
			name: 'a PNG body under a JPEG content type',
			path: '/liar.jpg',
			reply: { headers: { 'content-type': 'image/jpeg' }, body: png(9000) },
			key: 'type'
		},
		{
			name: 'a JPEG body under a PNG content type',
			path: '/liar.png',
			reply: { headers: { 'content-type': 'image/png' }, body: jpeg(9000) },
			key: 'type'
		},
		{
			name: 'a file below minBytes',
			path: '/icon.png',
			reply: { headers: { 'content-type': 'image/png' }, body: png(100) },
			key: 'size-min'
		},
		{
			name: 'a file above maxBytes read from the body',
			path: '/photo.jpg',
			images: { maxBytes: 5000 },
			key: 'size-max'
		},
		{
			name: 'a file above maxBytes by its Content-Length',
			path: '/photo.jpg',
			reply: {
				headers: { 'content-type': 'image/jpeg', 'content-length': '10000' },
				body: jpeg(10_000)
			},
			images: { maxBytes: 5000 },
			key: 'size-max'
		},
		{
			name: 'Set-Cookie',
			path: '/photo.jpg',
			reply: {
				headers: { 'content-type': 'image/jpeg', 'set-cookie': 'a=1' },
				body: jpeg(10_000)
			},
			key: 'set-cookie'
		}
	];

	it.each(skipped)(
		'passes $name through unchanged and counts it under $key',
		async ({ path, reply, headers, images, key, status }) => {
			const s = rig(images);
			if (reply) s.replies.set(path, reply);
			const response = await s.call(path, headers);
			const original = reply?.body ?? jpeg(10_000);
			expect(response.status).toBe(status ?? 200);
			if (status === undefined) expect(await bytesOf(response)).toEqual(original);
			expect(response.headers.has('vary')).toBe(false);
			expect(response.headers.has('x-spool-image')).toBe(false);
			expect(s.calls).toHaveLength(0);
			expect({ ...s.proxy.images }).toEqual({
				converted: 0,
				bytesIn: 0,
				bytesOut: 0,
				cacheHits: 0,
				coalesced: 0,
				lazied: 0,
				responsive: 0,
				skipped: { [key]: 1 }
			});
		}
	);

	it('leaves a write alone and does not count it', async () => {
		const s = rig();
		const response = await s.call('/photo.jpg', {}, { method: 'POST', body: 'x' });
		expect(await bytesOf(response)).toEqual(jpeg(10_000));
		expect(s.proxy.images.skipped).toEqual({});
		expect(s.calls).toHaveLength(0);
	});

	it('serves the original bytes with a 200 when the output is not smaller, and keeps the larger result cached', async () => {
		const calls: number[] = [];
		const encoder: ImageEncoder = async (input) => {
			calls.push(input.length);
			return { bytes: new Uint8Array(input.length) };
		};
		const s = rig({ encoder });
		const first = await s.call('/photo.jpg');
		expect(first.status).toBe(200);
		expect(first.headers.get('content-type')).toBe('image/jpeg');
		expect(first.headers.has('vary')).toBe(false);
		expect(await bytesOf(first)).toEqual(jpeg(10_000));
		await s.call('/photo.jpg');
		expect(calls).toEqual([10_000]);
		expect({ ...s.proxy.images }).toEqual({ ...ZERO, cacheHits: 1, skipped: { larger: 2 } });
	});

	it('serves the original bytes with a 200 when the encoder throws or returns nothing', async () => {
		let mode: 'throw' | 'empty' = 'throw';
		const encoder: ImageEncoder = async () => {
			if (mode === 'throw') throw new Error('cannot decode');
			return { bytes: new Uint8Array(0) };
		};
		const s = rig({ encoder, cache: false });
		for (const next of ['throw', 'empty'] as const) {
			mode = next;
			const response = await s.call('/photo.jpg');
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('image/jpeg');
			expect(await bytesOf(response)).toEqual(jpeg(10_000));
		}
		expect({ ...s.proxy.images }).toEqual({ ...ZERO, skipped: { failed: 2 } });
	});

	it('merges Vary into the origin value without duplicates, in any case, and leaves Vary: * alone', async () => {
		const s = rig();
		s.replies.set('/photo.jpg', {
			headers: { 'content-type': 'image/jpeg', vary: 'accept, Accept-Encoding, ect' },
			body: jpeg(10_000)
		});
		expect((await s.call('/photo.jpg')).headers.get('vary')).toBe(
			'accept, Accept-Encoding, ect, Save-Data, Sec-CH-Width, Sec-CH-DPR, Sec-CH-Viewport-Width'
		);
		s.replies.set('/photo.jpg', {
			headers: { 'content-type': 'image/jpeg', vary: '*' },
			body: jpeg(10_000)
		});
		expect((await s.call('/photo.jpg')).headers.get('vary')).toBe('*');
	});

	it('answers 304 with no body when If-None-Match matches, without calling the encoder', async () => {
		const s = rig();
		const first = await s.call('/photo.jpg');
		const etag = first.headers.get('etag') as string;
		expect(s.calls).toHaveLength(1);
		for (const header of [etag, etag.slice(2), `"other", ${etag}`, '*']) {
			const response = await s.call('/photo.jpg', { 'if-none-match': header });
			expect(response.status, header).toBe(304);
			expect(await response.text()).toBe('');
			expect(response.headers.get('etag')).toBe(etag);
			expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
		}
		const stale = await s.call('/photo.jpg', { 'if-none-match': 'W/"0000000000000000-80-0"' });
		expect(stale.status).toBe(200);
		const lower = await s.call('/photo.jpg', { 'if-none-match': etag, 'save-data': 'on' });
		expect(lower.status).toBe(200);
		expect(lower.headers.get('etag')).not.toBe(etag);
		expect(s.proxy.images.skipped).toEqual({ 'not-modified': 4 });
		expect(s.proxy.images.converted).toBe(3);
	});

	it('forwards an image request without its conditional headers, and leaves other requests alone', async () => {
		const s = rig();
		const conditional = {
			'if-none-match': '"x"',
			'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT'
		};
		await s.call('/photo.jpg', conditional);
		const sent = s.hits.at(-1)?.request.headers;
		expect(sent?.has('if-none-match')).toBe(false);
		expect(sent?.has('if-modified-since')).toBe(false);
		await s.call('/photo.jpg', { ...conditional, accept: '*/*' });
		expect(s.hits.at(-1)?.request.headers.get('if-none-match')).toBe('"x"');
		await s.call('/page', conditional);
		expect(s.hits.at(-1)?.request.headers.get('if-none-match')).toBe('"x"');
		expect(s.hits.at(-1)?.request.headers.get('if-modified-since')).toBeTruthy();
	});

	it('sets nothing and counts nothing without images', async () => {
		const origin = fakeOrigin();
		origin.replies.set('/photo.jpg', JPEG_REPLY(jpeg(10_000)));
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch
		});
		const response = await proxy(
			new Request(`${HOST}/photo.jpg`, { headers: { accept: WEBP } })
		);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect({ ...proxy.images }).toEqual(ZERO);
		expect({ ...proxy.video }).toEqual({ pages: 0, rewritten: 0 });
	});
});

/** an encoder that holds every call until the test releases it */
function gatedEncoder() {
	const calls: Call[] = [];
	const waiting: Array<{ done: () => void; fail: (error: Error) => void }> = [];
	const encoder: ImageEncoder = (input, options) => {
		calls.push({ length: input.length, options });
		return new Promise((resolve, reject) => {
			waiting.push({
				done: () => resolve({ bytes: new Uint8Array(Math.floor(input.length / 4)) }),
				fail: reject
			});
		});
	};
	const until = (check: () => unknown) => vi.waitFor(() => expect(check()).toBeTruthy());
	return { calls, waiting, encoder, until };
}

describe('width ceiling', () => {
	it('applies maxWidth to a request with no width and lets a hint win', async () => {
		const s = rig({ maxWidth: 1600 });
		expect((await s.call('/photo.jpg')).headers.get('x-spool-image')).toBe(
			'10000->2500; q=80; w=1600'
		);
		expect(s.calls[0]?.options.width).toBe(1600);
		const hinted = await s.call('/photo.jpg', { 'sec-ch-width': '640' });
		expect(hinted.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=640');
		const phone = await s.call('/photo.jpg', {
			'sec-ch-viewport-width': '393',
			'sec-ch-dpr': '2'
		});
		expect(phone.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=786');
	});

	it('removes the ceiling with maxWidth: false and sends the encoder no width', async () => {
		const s = rig({ maxWidth: false });
		const response = await s.call('/photo.jpg');
		expect(response.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=0');
		expect(response.headers.get('etag')).toMatch(/-80-0"$/);
		expect(s.calls[0]?.options).not.toHaveProperty('width');
	});

	it('lets width.fallback win over maxWidth', async () => {
		const s = rig({ maxWidth: 1600, width: { fallback: 1200 } });
		expect((await s.call('/photo.jpg')).headers.get('x-spool-image')).toBe(
			'10000->2500; q=80; w=1200'
		);
	});

	it('puts the ceiling in the ETag and the cache key, so two ceilings never share bytes', async () => {
		const held = new Map<string, Uint8Array>();
		const cache: ImageCache = {
			get: (key) => held.get(key),
			set: (key, bytes) => void held.set(key, bytes)
		};
		const a = await rig({ cache, maxWidth: 1000 }).call('/photo.jpg');
		const b = await rig({ cache, maxWidth: 2000 }).call('/photo.jpg');
		expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'));
		expect([...held.keys()].map((key) => key.split('|')[2])).toEqual(['1000', '2000']);
	});

	it('refuses a maxWidth outside 1 to 16384', () => {
		const { encoder } = fakeEncoder();
		const make = (maxWidth: number | false) => () =>
			createImageConverter({ encoder, maxWidth });
		for (const bad of [0, -1, 16385, 12.5, Number.NaN]) {
			expect(make(bad), String(bad)).toThrow(/maxWidth/);
		}
		expect(make(1)).not.toThrow();
		expect(make(16384)).not.toThrow();
		expect(make(false)).not.toThrow();
	});
});

describe('encoder limits', () => {
	function gated(images: Partial<ImageOptions> = {}) {
		const gate = gatedEncoder();
		const s = rig({ encoder: gate.encoder, ...images });
		return { ...s, ...gate };
	}

	it('shares one encoder call between simultaneous identical requests', async () => {
		const s = gated();
		const all = [s.call('/photo.jpg'), s.call('/photo.jpg'), s.call('/photo.jpg')];
		await s.until(() => s.proxy.images.coalesced === 2);
		expect(s.calls).toHaveLength(1);
		s.waiting[0]?.done();
		const responses = await Promise.all(all);
		for (const response of responses) {
			expect(response.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=2560');
			expect(await bytesOf(response)).toHaveLength(2500);
		}
		expect({ ...s.proxy.images }).toEqual({
			...ZERO,
			converted: 3,
			bytesIn: 30_000,
			bytesOut: 7_500,
			coalesced: 2
		});
	});

	it('shares the call with no cache, and starts a new one once the first has finished', async () => {
		const s = gated({ cache: false });
		const first = [s.call('/photo.jpg'), s.call('/photo.jpg')];
		await s.until(() => s.proxy.images.coalesced === 1);
		s.waiting[0]?.done();
		await Promise.all(first);
		const later = s.call('/photo.jpg');
		await s.until(() => s.calls.length === 2);
		expect(s.calls).toHaveLength(2);
		s.waiting[1]?.done();
		await later;
		expect(s.proxy.images.coalesced).toBe(1);
		expect(s.proxy.images.converted).toBe(3);
	});

	it('keeps requests that differ in quality, width or bytes apart', async () => {
		const s = gated();
		const all = [
			s.call('/photo.jpg'),
			s.call('/photo.jpg', { 'save-data': 'on' }),
			s.call('/photo.jpg', { 'sec-ch-width': '640' }),
			s.call('/chart.png')
		];
		await s.until(() => s.calls.length === 4);
		for (const waiter of s.waiting) waiter.done();
		await Promise.all(all);
		expect(s.proxy.images.coalesced).toBe(0);
	});

	it('serves the origin bytes to every waiter when a shared encode fails, and caches nothing', async () => {
		const s = gated();
		const all = [s.call('/photo.jpg'), s.call('/photo.jpg'), s.call('/photo.jpg')];
		await s.until(() => s.proxy.images.coalesced === 2);
		s.waiting[0]?.fail(new Error('cannot decode'));
		for (const response of await Promise.all(all)) {
			expect(response.headers.get('content-type')).toBe('image/jpeg');
			expect(await bytesOf(response)).toEqual(jpeg(10_000));
		}
		expect({ ...s.proxy.images }).toEqual({ ...ZERO, coalesced: 2, skipped: { failed: 3 } });
		const again = s.call('/photo.jpg');
		await s.until(() => s.calls.length === 2);
		s.waiting[1]?.done();
		expect((await again).headers.get('content-type')).toBe('image/webp');
	});

	it('serves the origin bytes when the encoder runs past timeoutMs, then caches its late result', async () => {
		const held = new Map<string, Uint8Array>();
		const cache: ImageCache = {
			get: (key) => held.get(key),
			set: (key, bytes) => void held.set(key, bytes)
		};
		const s = gated({ timeoutMs: 5, cache });
		const slow = await s.call('/photo.jpg');
		expect(slow.status).toBe(200);
		expect(slow.headers.get('content-type')).toBe('image/jpeg');
		expect(await bytesOf(slow)).toEqual(jpeg(10_000));
		expect(s.calls[0]?.options.budgetMs).toBe(5);
		expect(s.proxy.images.skipped).toEqual({ timeout: 1 });
		expect(held.size).toBe(0);
		s.waiting[0]?.done();
		await s.until(() => held.size === 1);
		const next = await s.call('/photo.jpg');
		expect(next.headers.get('content-type')).toBe('image/webp');
		expect(s.calls).toHaveLength(1);
		expect({ ...s.proxy.images }).toEqual({
			...ZERO,
			converted: 1,
			bytesIn: 10_000,
			bytesOut: 2_500,
			cacheHits: 1,
			skipped: { timeout: 1 }
		});
	});

	it('counts a joiner that times out too, and does not cache a late failure', async () => {
		const s = gated({ timeoutMs: 5 });
		await Promise.all([s.call('/photo.jpg'), s.call('/photo.jpg')]);
		expect(s.calls).toHaveLength(1);
		expect({ ...s.proxy.images }).toEqual({ ...ZERO, coalesced: 1, skipped: { timeout: 2 } });
		s.waiting[0]?.fail(new Error('late'));
		const next = s.call('/photo.jpg');
		await s.until(() => s.calls.length === 2);
		await next;
		expect(s.proxy.images.skipped).toEqual({ timeout: 3 });
	});

	it('waits without limit and sets no budget with timeoutMs: false', async () => {
		const s = gated({ timeoutMs: false });
		const pending = s.call('/photo.jpg');
		await s.until(() => s.calls.length === 1);
		expect(s.calls[0]?.options).not.toHaveProperty('budgetMs');
		s.waiting[0]?.done();
		expect((await pending).headers.get('content-type')).toBe('image/webp');
		expect(s.proxy.images.skipped).toEqual({});
	});

	it('serves the origin bytes when the encoder throws before it returns a promise, and again afterwards', async () => {
		let calls = 0;
		const encoder: ImageEncoder = () => {
			calls++;
			throw new Error('sync');
		};
		const s = rig({ encoder });
		await s.call('/photo.jpg');
		await s.call('/photo.jpg');
		expect(calls).toBe(2);
		expect(s.proxy.images.skipped).toEqual({ failed: 2 });
	});

	it('refuses a timeoutMs that is not a positive integer or false', () => {
		const { encoder } = fakeEncoder();
		const make = (timeoutMs: number | false) => () =>
			createImageConverter({ encoder, timeoutMs });
		for (const bad of [0, -5, 1.5, Number.NaN]) {
			expect(make(bad), String(bad)).toThrow(/timeoutMs/);
		}
		expect(make(1)).not.toThrow();
		expect(make(false)).not.toThrow();
	});
});

describe('rewriteLazy', () => {
	const img = (n: number, extra = '') => `<img src="${n}.jpg"${extra}>`;
	const LAZY = ' loading="lazy" decoding="async"';

	it('leaves the first two images and adds loading and decoding to the rest', () => {
		const html = `<body>${img(1)}${img(2)}${img(3)}${img(4)}</body>`;
		expect(rewriteLazy(html)).toEqual({
			html: `<body>${img(1)}${img(2)}${img(3, LAZY)}${img(4, LAZY)}</body>`,
			rewritten: 2
		});
	});

	it('takes skip from the options, 0 included', () => {
		const html = `${img(1)}${img(2)}${img(3)}`;
		expect(rewriteLazy(html, { skip: 0 }).rewritten).toBe(3);
		expect(rewriteLazy(html, { skip: 1 }).html).toBe(`${img(1)}${img(2, LAZY)}${img(3, LAZY)}`);
		expect(rewriteLazy(html, { skip: 9 })).toEqual({ html, rewritten: 0 });
	});

	it('leaves a tag that has loading, a high fetch priority or a lazy-loading attribute, and still counts it', () => {
		const skipped = [
			img(1, ' loading="eager"'),
			img(2, ' FetchPriority="High"'),
			img(3, ' data-src="x.jpg"'),
			img(4, ' data-srcset="x.jpg 1x"'),
			img(5, ' data-lazy-src="x.jpg"'),
			img(6, ' data-lazyload')
		].join('');
		expect(rewriteLazy(`${img(0)}${skipped}${img(7)}`, { skip: 1 })).toEqual({
			html: `${img(0)}${skipped}${img(7, LAZY)}`,
			rewritten: 1
		});
		expect(rewriteLazy(img(1, ' fetchpriority="low"'), { skip: 0 })).toEqual({
			html: img(1, ' fetchpriority="low"'),
			rewritten: 0
		});
	});

	it('leaves an image a preload link names, and one inside a header, and still counts them', () => {
		const html = `<head><link rel="preload" as="image" href="2.jpg"><link rel="Preload stylesheet" as="style" href="3.jpg"><link rel="icon" as="image" href="4.jpg"></head><body><header><nav>${img(1)}</nav></header>${img(2)}${img(3)}<HEADER><header>${img(4)}</header>${img(5)}</HEADER>${img(6)}</body>`;
		const out = rewriteLazy(html, { skip: 0 });
		expect(out.rewritten).toBe(2);
		expect(out.html).toBe(html.replace(img(3), img(3, LAZY)).replace(img(6), img(6, LAZY)));
	});

	it('keeps an existing decoding attribute', () => {
		expect(rewriteLazy('<img src=a decoding="sync">', { skip: 0 }).html).toBe(
			'<img src=a decoding="sync" loading="lazy">'
		);
	});

	it('neither counts nor edits an image in head, noscript or a comment', () => {
		const html = `<head>${img(1)}</head><body><noscript>${img(2)}</noscript><!-- ${img(3)} -->${img(4)}${img(5)}${img(6)}</body>`;
		expect(rewriteLazy(html, { skip: 2 })).toEqual({
			html: `<head>${img(1)}</head><body><noscript>${img(2)}</noscript><!-- ${img(3)} -->${img(4)}${img(5)}${img(6, LAZY)}</body>`,
			rewritten: 1
		});
	});

	it('adds loading to iframes with iframes: true, and only then', () => {
		const html = `${img(1)}<iframe src="a"></iframe><iframe src="b" loading="eager"></iframe>`;
		expect(rewriteLazy(html, { skip: 5 })).toEqual({ html, rewritten: 0 });
		expect(rewriteLazy(html, { skip: 5, iframes: true })).toEqual({
			html: `${img(1)}<iframe src="a" loading="lazy"></iframe><iframe src="b" loading="eager"></iframe>`,
			rewritten: 1
		});
	});

	it('inserts before the slash of a self-closing tag and reads names in any case', () => {
		expect(rewriteLazy('<IMG SRC="a" />', { skip: 0 }).html).toBe(`<IMG SRC="a"${LAZY}/>`);
		expect(rewriteLazy('<img src=a/>', { skip: 0 }).html).toBe(`<img src=a/${LAZY}>`);
	});

	it('is idempotent and leaves every byte outside the edited tags', () => {
		const html = `<p>café &amp; \u0093x\u0094</p>${img(1)}\n${img(2)}${img(3)}<p>m</p>`;
		const once = rewriteLazy(html, { skip: 1 });
		expect(once.html).toBe(
			`<p>café &amp; \u0093x\u0094</p>${img(1)}\n${img(2, LAZY)}${img(3, LAZY)}<p>m</p>`
		);
		expect(rewriteLazy(once.html, { skip: 1 })).toEqual({ html: once.html, rewritten: 0 });
		expect(rewriteLazy('<img src=a')).toEqual({ html: '<img src=a', rewritten: 0 });
	});

	it('refuses a skip that is not a whole number of 0 or more', () => {
		for (const skip of [-1, 1.5, Number.NaN]) {
			expect(() => rewriteLazy('<img>', { skip }), String(skip)).toThrow(/lazy.skip/);
		}
		const { encoder } = fakeEncoder();
		expect(() => createImageConverter({ encoder, lazy: { skip: -1 } })).toThrow(ProtocolError);
	});
});

describe('lazy in the proxy', () => {
	const PAGE_IMGS = `<!doctype html><html><head><title>t</title></head><body>${[1, 2, 3, 4].map((n) => `<img src="${n}.jpg">`).join('')}</body></html>`;

	function lazyRig(images: Partial<ImageOptions>) {
		const s = rig(images);
		s.replies.set('/gallery', {
			body: PAGE_IMGS,
			headers: { 'content-type': HTML, 'cache-tag': 'g1', etag: '"g"' }
		});
		return s;
	}

	it('rewrites the page and the copy the spool keeps, counts the tags and weakens the ETag', async () => {
		const s = lazyRig({ lazy: {} });
		const response = await s.call('/gallery');
		const text = await response.text();
		expect(text.match(/loading="lazy"/g)).toHaveLength(2);
		expect(text).toContain('<img src="3.jpg" loading="lazy" decoding="async">');
		expect(response.headers.get('etag')).toBe('W/"g"');
		expect(s.proxy.images.lazied).toBe(2);
		const held = await s.proxy(
			new Request(`${HOST}/.spool/artifact?path=/gallery&have=`, {
				headers: { accept: '*/*' }
			})
		);
		const artifact = parseArtifact(await held.json());
		expect(artifact.strategy === 'assembly' ? artifact.body.shell : '').toContain(
			'<img src="4.jpg" loading="lazy" decoding="async">'
		);
		expect(s.proxy.images.lazied).toBe(2);
	});

	it('takes skip and iframes from the options', async () => {
		const s = lazyRig({ lazy: { skip: 3 } });
		expect((await (await s.call('/gallery')).text()).match(/loading="lazy"/g)).toHaveLength(1);
	});

	it('touches no page without lazy, or with lazy: false', async () => {
		for (const images of [{}, { lazy: false as const }]) {
			const s = lazyRig(images);
			const response = await s.call('/gallery');
			expect(await undecorated(response)).toBe(PAGE_IMGS);
			expect(s.proxy.images.lazied).toBe(0);
		}
	});
});

describe('png modes', () => {
	/** keeps a quarter of a lossy encode and `1 / losslessDivisor` of a lossless one */
	function modal(losslessDivisor: number, fail: 'lossy' | 'lossless' | 'both' | null = null) {
		const calls: ImageEncodeOptions[] = [];
		const encoder: ImageEncoder = async (input, options) => {
			calls.push(options);
			if (fail === 'both' || fail === (options.lossless ? 'lossless' : 'lossy')) {
				throw new Error('no');
			}
			const share = options.lossless ? losslessDivisor : 4;
			return { bytes: new Uint8Array(Math.floor(input.length / share)) };
		};
		return { calls, encoder };
	}

	it('encodes lossy and leaves the ETag as it was by default', async () => {
		const m = modal(8);
		const s = rig({ encoder: m.encoder });
		const chart = await s.call('/chart.png');
		expect(chart.headers.get('x-spool-image')).toBe('8000->2000; q=80; w=2560');
		expect(chart.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{16}-80-2560"$/);
		expect(m.calls).toEqual([{ format: 'webp', quality: 80, width: 2560, budgetMs: 10_000 }]);
	});

	it('encodes every PNG without loss with png: lossless, and leaves a JPEG lossy', async () => {
		const m = modal(8);
		const s = rig({ encoder: m.encoder, png: 'lossless' });
		const chart = await s.call('/chart.png');
		expect(chart.headers.get('x-spool-image')).toBe('8000->1000; q=80; w=2560');
		expect(chart.headers.get('etag')).toMatch(/-80-2560-lossless"$/);
		const photo = await s.call('/photo.jpg');
		expect(photo.headers.get('etag')).toMatch(/-80-2560"$/);
		expect(m.calls.map((call) => call.lossless)).toEqual([true, undefined]);
	});

	it('encodes a PNG under 200 KB both ways with png: auto and serves the smaller', async () => {
		for (const [divisor, out] of [
			[8, 1000],
			[2, 2000]
		] as const) {
			const m = modal(divisor);
			const s = rig({ encoder: m.encoder, png: 'auto' });
			const chart = await s.call('/chart.png');
			expect(chart.headers.get('x-spool-image')).toBe(`8000->${out}; q=80; w=2560`);
			expect(chart.headers.get('etag')).toMatch(/-80-2560-auto"$/);
			expect(await bytesOf(chart)).toHaveLength(out);
			expect(m.calls.map((call) => Boolean(call.lossless)).sort()).toEqual([false, true]);
			await s.call('/chart.png');
			expect(m.calls).toHaveLength(2);
			expect(s.proxy.images.cacheHits).toBe(1);
		}
	});

	it('encodes a PNG of 200 KB or more lossy only, whatever the mode, and keeps its ETag plain', async () => {
		const m = modal(8);
		const s = rig({ encoder: m.encoder, png: 'auto' });
		s.replies.set('/big.png', { headers: { 'content-type': 'image/png' }, body: png(200_000) });
		s.replies.set('/just.png', {
			headers: { 'content-type': 'image/png' },
			body: png(199_999)
		});
		const big = await s.call('/big.png');
		expect(big.headers.get('etag')).toMatch(/-80-2560"$/);
		expect(m.calls).toHaveLength(1);
		expect(m.calls[0]?.lossless).toBeUndefined();
		await s.call('/just.png');
		expect(m.calls).toHaveLength(3);
	});

	it('serves the arm that worked when the other throws, and the origin bytes when both do', async () => {
		for (const [fail, out] of [
			['lossless', 2000],
			['lossy', 1000]
		] as const) {
			const s = rig({ encoder: modal(8, fail).encoder, png: 'auto' });
			const chart = await s.call('/chart.png');
			expect(await bytesOf(chart)).toHaveLength(out);
			expect(s.proxy.images.converted).toBe(1);
		}
		const s = rig({ encoder: modal(8, 'both').encoder, png: 'auto' });
		const chart = await s.call('/chart.png');
		expect(chart.headers.get('content-type')).toBe('image/png');
		expect(s.proxy.images.skipped).toEqual({ failed: 1 });
	});

	it('keeps lossy and lossless bytes of one PNG under different cache keys', async () => {
		const held = new Map<string, Uint8Array>();
		const cache: ImageCache = {
			get: (key) => held.get(key),
			set: (key, bytes) => void held.set(key, bytes)
		};
		await rig({ cache }).call('/chart.png');
		await rig({ cache, png: 'lossless' }).call('/chart.png');
		await rig({ cache, png: 'auto' }).call('/chart.png');
		const keys = [...held.keys()].map((key) => key.split('|').slice(1).join('|'));
		expect(keys).toEqual(['80|2560', '80|2560|lossless', '80|2560|auto']);
	});

	it('refuses a mode it does not know and passes lossless to tinyimg only when set', async () => {
		const { encoder } = fakeEncoder();
		expect(() => createImageConverter({ encoder, png: 'both' as 'auto' })).toThrow(/png/);
		expect(createImageConverter({ encoder }).options.png).toBe('lossy');
		const seen: object[] = [];
		const encode = tinyimgEncoder({
			module: 0,
			transform: async (_m, _input, options) => {
				seen.push(options);
				return { bytes: () => new Uint8Array(1) };
			}
		});
		const input = new Uint8Array(1);
		await encode(input, { format: 'webp', quality: 80, lossless: true });
		await encode(input, { format: 'webp', quality: 80, lossless: false });
		expect(seen).toEqual([
			{ format: 'webp', quality: 80, lossless: true },
			{ format: 'webp', quality: 80 }
		]);
	});
});

describe('responsive options', () => {
	it('defaults to six widths and 100vw, sorts and dedupes, and refuses what it cannot use', () => {
		expect(resolveResponsiveOptions()).toEqual({
			widths: [320, 480, 640, 960, 1280, 1920],
			sizes: '100vw'
		});
		expect(resolveResponsiveOptions({ widths: [640, 320, 640], sizes: ' 50vw ' })).toEqual({
			widths: [320, 640],
			sizes: '50vw'
		});
		for (const widths of [[], [0], [16385], [1.5], [Number.NaN]]) {
			expect(() => resolveResponsiveOptions({ widths }), String(widths)).toThrow(/widths/);
		}
		expect(() => resolveResponsiveOptions({ sizes: '' })).toThrow(/sizes/);
		expect(() => resolveResponsiveOptions({ sizes: 'a\nb' })).toThrow(/sizes/);
		expect(() => resolveResponsiveOptions({ widths: [1, 16384] })).not.toThrow();
		const { encoder } = fakeEncoder();
		expect(() => createImageConverter({ encoder, responsive: { widths: [] } })).toThrow(
			ProtocolError
		);
	});

	it('takes a listed width out of the query and drops an unlisted one without a width', () => {
		const widths = [320, 640];
		expect(takeWidth('', widths)).toEqual({ search: '' });
		expect(takeWidth('?v=1', widths)).toEqual({ search: '?v=1' });
		expect(takeWidth('?spool-w=640', widths)).toEqual({ search: '', width: 640 });
		expect(takeWidth('?v=1&spool-w=320&x=2', widths)).toEqual({
			search: '?v=1&x=2',
			width: 320
		});
		for (const bad of ['641', '', 'abc', '-1', '0640x', '99999999']) {
			expect(takeWidth(`?v=1&spool-w=${bad}`, widths), bad).toEqual({ search: '?v=1' });
		}
		expect(takeWidth('?spool-w', widths)).toEqual({ search: '' });
		expect(takeWidth('?spool-w=320&spool-w=640', widths)).toEqual({ search: '', width: 640 });
		expect(takeWidth('?spool-wx=320', widths)).toEqual({ search: '?spool-wx=320' });
	});
});

describe('rewriteResponsive', () => {
	const context = { pageUrl: 'https://site.test/a/b', paths: /\.(?:jpe?g|png)$/i };
	const set = (src: string, widths = [320, 480, 640, 960, 1280, 1920]) =>
		widths
			.map((w) => `${src}${src.includes('?') ? '&amp;' : '?'}spool-w=${w} ${w}w`)
			.join(', ');
	const added = (src: string, sizes = '100vw') => ` srcset="${set(src)}" sizes="${sizes}"`;
	const run = (html: string, options: ResponsiveOptions = {}) =>
		rewriteResponsive(html, options, context);

	it('adds srcset and sizes to a same-origin image the paths match, and keeps src', () => {
		expect(run('<p><img src="/a.jpg" alt="x"></p>')).toEqual({
			html: `<p><img src="/a.jpg" alt="x"${added('/a.jpg')}></p>`,
			rewritten: 1
		});
		expect(run('<img src="c.png">').html).toBe(`<img src="c.png"${added('c.png')}>`);
		expect(run('<img src="/a.jpg?v=1&amp;w=2">').html).toBe(
			`<img src="/a.jpg?v=1&amp;w=2"${added('/a.jpg?v=1&amp;w=2')}>`
		);
		expect(run('<img src="https://site.test/x.JPEG" />').html).toBe(
			`<img src="https://site.test/x.JPEG"${added('https://site.test/x.JPEG')}/>`
		);
	});

	it('keeps a sizes the tag has, and takes widths and sizes from the options', () => {
		expect(run('<img src="/a.jpg" sizes="50vw">').html).toBe(
			`<img src="/a.jpg" sizes="50vw" srcset="${set('/a.jpg')}">`
		);
		const out = run('<img src="/a.jpg">', {
			widths: [640, 320],
			sizes: '(min-width: 800px) 50vw, 100vw'
		});
		expect(out.html).toBe(
			`<img src="/a.jpg" srcset="${set('/a.jpg', [320, 640])}" sizes="(min-width: 800px) 50vw, 100vw">`
		);
		expect(run('<img src="/a.jpg">', { sizes: 'a"b&c' }).html).toContain(
			'sizes="a&quot;b&amp;c"'
		);
	});

	it.each([
		['srcset', '<img src="/a.jpg" srcset="/a.jpg 1x">'],
		['data-src', '<img src="/a.jpg" data-src="/b.jpg">'],
		['data-srcset', '<img src="/a.jpg" data-srcset="/b.jpg 1x">'],
		['a picture', '<picture><source srcset="/a.webp"><img src="/a.jpg"></picture>'],
		['a noscript', '<noscript><img src="/a.jpg"></noscript>'],
		['a comment', '<!-- <img src="/a.jpg"> -->'],
		['the head', '<head><img src="/a.jpg"></head><body></body>'],
		['another origin', '<img src="https://cdn.test/a.jpg">'],
		['a protocol-relative URL', '<img src="//cdn.test/a.jpg">'],
		['a path the paths miss', '<img src="/a.gif"><img src="/a.jpg/x">'],
		['a data URL', '<img src="data:image/png;base64,AAAA">'],
		['no src', '<img alt="x">'],
		['an empty src', '<img src="">'],
		['a space in the src', '<img src="/a b.jpg">'],
		['a comma in the src', '<img src="/a,b.jpg">'],
		['a fragment in the src', '<img src="/a.jpg#x">'],
		['spool-w already in the src', '<img src="/a.jpg?spool-w=320">'],
		['a tag that never closes', '<img src="/a.jpg"']
	])('leaves an image with %s alone', (_name, html) => {
		expect(run(html)).toEqual({ html, rewritten: 0 });
	});

	it('is idempotent and leaves every byte outside the edited tags', () => {
		const html =
			'<p>café &amp; \u0093x\u0094</p><img src="/a.jpg">\n<img src="/b.png"><p>m</p>';
		const once = run(html);
		expect(once.rewritten).toBe(2);
		expect(
			once.html.startsWith('<p>café &amp; \u0093x\u0094</p><img src="/a.jpg" srcset=')
		).toBe(true);
		expect(once.html.endsWith('><p>m</p>')).toBe(true);
		expect(run(once.html)).toEqual({ html: once.html, rewritten: 0 });
	});
});

describe('responsive in the proxy', () => {
	const GALLERY = `<!doctype html><html><head><title>t</title></head><body><img src="/photo.jpg"><img src="https://elsewhere.test/x.jpg"></body></html>`;

	function responsiveRig(images: Partial<ImageOptions>) {
		const s = rig(images);
		s.replies.set('/gallery', {
			body: GALLERY,
			headers: { 'content-type': HTML, 'cache-tag': 'g1', etag: '"g"' }
		});
		return s;
	}
	const lastUrl = (s: ReturnType<typeof rig>) => s.hits.at(-1)?.request.url;

	it('rewrites the page and the copy the spool keeps, counts the tags and weakens the ETag', async () => {
		const s = responsiveRig({ responsive: {} });
		const response = await s.call('/gallery');
		const text = await response.text();
		expect(text).toContain(
			'<img src="/photo.jpg" srcset="/photo.jpg?spool-w=320 320w, /photo.jpg?spool-w=480 480w,'
		);
		expect(text).toContain(' sizes="100vw"><img src="https://elsewhere.test/x.jpg">');
		expect(response.headers.get('etag')).toBe('W/"g"');
		expect(s.proxy.images.responsive).toBe(1);
		const held = await s.proxy(
			new Request(`${HOST}/.spool/artifact?path=/gallery&have=`, {
				headers: { accept: '*/*' }
			})
		);
		const artifact = parseArtifact(await held.json());
		expect(artifact.strategy === 'assembly' ? artifact.body.shell : '').toContain(
			'spool-w=1920 1920w'
		);
		expect(s.proxy.images.responsive).toBe(1);
	});

	it('touches no page without responsive, or with responsive: false', async () => {
		for (const images of [{}, { responsive: false as const }]) {
			const s = responsiveRig(images);
			expect(await undecorated(await s.call('/gallery'))).toBe(GALLERY);
			expect(s.proxy.images.responsive).toBe(0);
		}
	});

	it('converts to the width a listed spool-w names and hides the parameter from the origin', async () => {
		const s = responsiveRig({ responsive: {} });
		const response = await s.call('/photo.jpg?spool-w=640');
		expect(response.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=640');
		expect(response.headers.get('etag')).toMatch(/-80-640"$/);
		expect(s.calls[0]?.options.width).toBe(640);
		expect(lastUrl(s)).toBe(`${ORIGIN}/photo.jpg`);
		await s.call('/photo.jpg?v=3&spool-w=320');
		expect(lastUrl(s)).toBe(`${ORIGIN}/photo.jpg?v=3`);
		expect(s.calls[1]?.options.width).toBe(320);
	});

	it('ignores a width that is not listed, and still hides it', async () => {
		const s = responsiveRig({ responsive: { widths: [320, 640] } });
		const response = await s.call('/photo.jpg?spool-w=641');
		expect(response.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=2560');
		expect(lastUrl(s)).toBe(`${ORIGIN}/photo.jpg`);
	});

	it('takes the smaller of the named width and a width hint', async () => {
		const s = responsiveRig({ responsive: {} });
		const wide = await s.call('/photo.jpg?spool-w=640', { 'sec-ch-width': '1000' });
		expect(wide.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=640');
		const narrow = await s.call('/photo.jpg?spool-w=640', { 'sec-ch-width': '400' });
		expect(narrow.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=400');
	});

	it('serves the origin bytes when the variant is not smaller, and counts the request as skipped', async () => {
		const s = responsiveRig({
			responsive: {},
			encoder: async (input) => ({ bytes: new Uint8Array(input.length) })
		});
		const response = await s.call('/photo.jpg?spool-w=640');
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(await bytesOf(response)).toHaveLength(10_000);
		expect(s.proxy.images.skipped).toEqual({ larger: 1 });
	});

	it('leaves the parameter in place without responsive, and on a path paths does not match', async () => {
		const plain = responsiveRig({});
		await plain.call('/photo.jpg?spool-w=640');
		expect(lastUrl(plain)).toBe(`${ORIGIN}/photo.jpg?spool-w=640`);
		expect(plain.calls[0]?.options.width).toBe(2560);
		const s = responsiveRig({ responsive: {} });
		await s.call('/page?spool-w=640');
		expect(lastUrl(s)).toBe(`${ORIGIN}/page?spool-w=640`);
	});
});

describe('embedOf', () => {
	it('reads the provider and id of an embed URL, https, http or protocol-relative', () => {
		const cases: Array<[string, string, string]> = [
			['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
			['https://youtube.com/embed/dQw4w9WgXcQ?start=4', 'youtube', 'dQw4w9WgXcQ'],
			['//www.youtube-nocookie.com/embed/dQw4w9WgXcQ/', 'youtube', 'dQw4w9WgXcQ'],
			['http://www.youtube.com/embed/abc_-123', 'youtube', 'abc_-123'],
			['https://player.vimeo.com/video/76979871?h=abc', 'vimeo', '76979871'],
			['https://WWW.YouTube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ']
		];
		for (const [src, provider, id] of cases) {
			expect(embedOf(src), src).toMatchObject({ provider, id });
		}
		expect(embedOf('//player.vimeo.com/video/76979871')?.url.protocol).toBe('https:');
	});

	it('refuses other hosts, paths, ids and schemes', () => {
		for (const src of [
			'https://www.youtube.com/embed/short',
			'https://www.youtube.com/embed/has space1',
			'https://www.youtube.com/embed/dQw4w9WgXcQ/extra',
			'https://www.youtube.com/embed/videoseries?list=PL123',
			'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			'https://youtube.com.evil.test/embed/dQw4w9WgXcQ',
			'https://evil.test/https://www.youtube.com/embed/dQw4w9WgXcQ',
			'https://player.vimeo.com/video/123',
			'https://vimeo.com/76979871',
			'javascript:alert(1)',
			'/embed/dQw4w9WgXcQ',
			'',
			'https://'
		]) {
			expect(embedOf(src), src).toBeNull();
		}
	});

	it('decodes entities in the src before it reads it', () => {
		expect(embedOf('https://www.youtube.com/embed/dQw4w9WgXcQ?a=1&amp;b=2')?.url.search).toBe(
			'?a=1&b=2'
		);
	});
});

describe('rewriteEmbeds', () => {
	const YT = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
	const frame = (src: string, extra = '') =>
		`<iframe width="560" height="315" src="${src}"${extra}></iframe>`;

	it('turns a YouTube iframe into a facade with the thumbnail and autoplay on the link', () => {
		const result = rewriteEmbeds(
			`<p>a</p>${frame(YT, ' title="My talk" class="v" allowfullscreen allow="autoplay" frameborder="0"')}<p>b</p>`
		);
		expect(result.rewritten).toBe(1);
		expect(result.skipped).toEqual({});
		const tag = /<iframe [^>]*>/.exec(result.html)?.[0] ?? '';
		expect(tag).toContain(
			'width="560" height="315" title="My talk" class="v" allowfullscreen allow="autoplay" srcdoc="'
		);
		expect(tag).not.toContain('src="https');
		expect(tag).not.toContain('frameborder');
		const doc = /srcdoc="([^"]*)"/
			.exec(tag)?.[1]
			?.replace(/&quot;/g, '"')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&');
		expect(doc).toContain(`<a href="${YT}?autoplay=1" aria-label="My talk">`);
		expect(doc).toContain(
			'<img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="">'
		);
		expect(doc).toContain('<span class=t>My talk</span>');
		expect(result.html.startsWith('<p>a</p><iframe')).toBe(true);
		expect(result.html.endsWith('></iframe><p>b</p>')).toBe(true);
	});

	it('adds autoplay=1 to the original query, replacing autoplay=0', () => {
		const doc = (src: string) => facadeDocument(embedOf(src)!, 'x', false);
		expect(doc(`${YT}?start=4&autoplay=0`)).toContain(`href="${YT}?start=4&amp;autoplay=1"`);
		expect(doc(`${YT}?rel=0`)).toContain(`href="${YT}?rel=0&amp;autoplay=1"`);
	});

	it('gives Vimeo a placeholder with no thumbnail, and YouTube none with thumbnail: false', () => {
		const vimeo = rewriteEmbeds(frame('https://player.vimeo.com/video/76979871'));
		expect(vimeo.html).toContain('player.vimeo.com/video/76979871?autoplay=1');
		expect(vimeo.html).not.toContain('ytimg');
		expect(vimeo.html).not.toContain('&lt;img');
		const plain = rewriteEmbeds(frame(YT), { thumbnail: false });
		expect(plain.html).not.toContain('ytimg');
		expect(plain.rewritten).toBe(1);
	});

	it('takes the providers from the options', () => {
		const html = frame(YT) + frame('https://player.vimeo.com/video/76979871');
		expect(rewriteEmbeds(html, { providers: ['vimeo'] }).rewritten).toBe(1);
		expect(rewriteEmbeds(html, { providers: ['vimeo'] }).html).toContain(`src="${YT}"`);
		expect(rewriteEmbeds(html, { providers: [] })).toEqual({ html, rewritten: 0, skipped: {} });
	});

	it('escapes the title in the link text, the label and the attribute', () => {
		const result = rewriteEmbeds(frame(YT, ' title=\'A "b" <i>c</i> &amp; d\''));
		expect(/srcdoc="[^"]*<[^"]*"/.test(result.html)).toBe(false);
		const attr = /srcdoc="([^"]*)"/.exec(result.html)?.[1] ?? '';
		expect(attr).not.toContain('"');
		expect(attr).toContain(
			'aria-label=&quot;A &amp;quot;b&amp;quot; &amp;lt;i&amp;gt;c&amp;lt;/i&amp;gt; &amp;amp; d&quot;'
		);
	});

	it('uses Play video when there is no title, and keeps sandbox, referrerpolicy, id and loading', () => {
		const result = rewriteEmbeds(
			frame(
				YT,
				' sandbox="allow-scripts" referrerpolicy="no-referrer" id="p1" loading="lazy" data-x="1"'
			)
		);
		expect(result.html).toContain('aria-label=&quot;Play video&quot;');
		for (const kept of [
			'sandbox="allow-scripts"',
			'referrerpolicy="no-referrer"',
			'id="p1"',
			'loading="lazy"'
		]) {
			expect(result.html).toContain(kept);
		}
		expect(result.html).not.toContain('data-x');
	});

	it('leaves an iframe in a comment or noscript, one with srcdoc and any other iframe alone', () => {
		const html = `<!-- ${frame(YT)} --><noscript>${frame(YT)}</noscript><iframe src="${YT}" srcdoc="x"></iframe><iframe src="https://example.com/embed/dQw4w9WgXcQ"></iframe><iframe></iframe>`;
		expect(rewriteEmbeds(html)).toEqual({ html, rewritten: 0, skipped: {} });
	});

	it('leaves an iframe whose URL asks for the player API, and counts it as jsapi', () => {
		const html = frame(`${YT}?enablejsapi=1`);
		expect(rewriteEmbeds(html)).toEqual({ html, rewritten: 0, skipped: { jsapi: 1 } });
	});

	it('leaves every embed on a page with a CSP and counts them, unless ignoreCsp is set', () => {
		const html = frame(YT) + frame('https://player.vimeo.com/video/76979871');
		expect(rewriteEmbeds(html, {}, { csp: true })).toEqual({
			html,
			rewritten: 0,
			skipped: { csp: 2 }
		});
		expect(rewriteEmbeds(html, { ignoreCsp: true }, { csp: true }).rewritten).toBe(2);
	});

	it('rewrites two embeds and leaves the bytes between them', () => {
		const html = `<p>\u0093x\u0094</p>${frame(YT)}\n<p>m</p>${frame(YT)}`;
		const result = rewriteEmbeds(html);
		expect(result.rewritten).toBe(2);
		expect(result.html).toContain('</iframe>\n<p>m</p><iframe');
		expect(result.html.startsWith('<p>\u0093x\u0094</p><iframe')).toBe(true);
	});
});

describe('embeds in the proxy', () => {
	const YT = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
	const EMBED_PAGE = PAGE.replace('<p>body</p>', `<iframe src="${YT}" title="T"></iframe>`);

	function embedRig(embeds: ProxyOptions['embeds'], headers: Record<string, string> = {}) {
		const origin = fakeOrigin();
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch,
			embeds
		});
		origin.replies.set('/e', {
			body: EMBED_PAGE,
			headers: { 'content-type': HTML, 'cache-tag': 'e1', etag: '"e"', ...headers }
		});
		return { ...origin, proxy, call: () => proxy(new Request(`${HOST}/e`)) };
	}

	it('rewrites the page and the copy the spool keeps, and counts the page and the embed once', async () => {
		const s = embedRig({});
		const response = await s.call();
		const text = await response.text();
		expect(text).toContain('srcdoc="');
		expect(text).not.toContain(`src="${YT}"`);
		expect(response.headers.get('etag')).toBe('W/"e"');
		expect({ ...s.proxy.embeds }).toEqual({ pages: 1, rewritten: 1, skipped: {} });
		const held = await s.proxy(
			new Request(`${HOST}/.spool/artifact?path=/e&have=`, { headers: { accept: '*/*' } })
		);
		const artifact = parseArtifact(await held.json());
		expect(artifact.strategy === 'assembly' ? artifact.body.shell : '').toContain('srcdoc="');
		expect(s.proxy.embeds.rewritten).toBe(1);
	});

	it('leaves a page with a Content-Security-Policy as it was and counts the embed under csp', async () => {
		const s = embedRig({}, { 'content-security-policy': "default-src 'self'" });
		const response = await s.call();
		expect(await undecorated(response)).toBe(EMBED_PAGE);
		expect({ ...s.proxy.embeds }).toEqual({ pages: 0, rewritten: 0, skipped: { csp: 1 } });
		const forced = embedRig(
			{ ignoreCsp: true },
			{ 'content-security-policy': "default-src 'self'" }
		);
		expect(await (await forced.call()).text()).toContain('srcdoc="');
	});

	it('touches nothing without embeds and counts nothing', async () => {
		const origin = fakeOrigin();
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch
		});
		origin.replies.set('/e', { body: EMBED_PAGE, headers: { 'content-type': HTML } });
		expect(await undecorated(await proxy(new Request(`${HOST}/e`)))).toBe(EMBED_PAGE);
		expect({ ...proxy.embeds }).toEqual({ pages: 0, rewritten: 0, skipped: {} });
	});
});

describe('client hints on HTML', () => {
	it('adds Accept-CH to a page, merges it into the origin value, and omits it with hints: false', async () => {
		const s = rig();
		expect((await s.call('/page')).headers.get('accept-ch')).toBe(IMAGE_HINTS.join(', '));
		s.replies.set('/page', {
			body: PAGE,
			headers: { 'content-type': HTML, 'accept-ch': 'sec-ch-dpr, Sec-CH-UA' }
		});
		expect((await s.call('/page')).headers.get('accept-ch')).toBe(
			'sec-ch-dpr, Sec-CH-UA, Sec-CH-Width, Sec-CH-Viewport-Width, ECT'
		);
		const off = rig({ hints: false });
		expect((await off.call('/page')).headers.has('accept-ch')).toBe(false);
	});

	it('leaves the page body as it was and sets no header on a proxy without images', async () => {
		const withImages = rig();
		const plain = rig();
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: plain.fetch
		});
		const a = await withImages.call('/page');
		const b = await proxy(new Request(`${HOST}/page`, { headers: { accept: WEBP } }));
		expect(await a.text()).toBe(await b.text());
		expect(b.headers.has('accept-ch')).toBe(false);
	});

	it('does not touch a trim-only page: a video option on a page with no video changes nothing', async () => {
		const css = '.ok{a:b}\n.gone{c:d}';
		const link = '<link rel="stylesheet" href="/site.css">';
		const page = `<!doctype html><html><head>${link}</head><body class="gone"><p>x</p></body></html>`;
		const build = async (video?: VideoOptions) => {
			const origin = fakeOrigin();
			origin.replies.set('/gone', {
				body: page,
				headers: { 'content-type': HTML, etag: '"p"' }
			});
			const trim = await buildTrimManifest({
				pages: ['<body class="ok"></body>'],
				scripts: [],
				styles: [{ url: '/site.css', text: css }]
			});
			const proxy = spoolProxy({
				origin: ORIGIN,
				spool: { store: memoryStore() },
				fetch: origin.fetch,
				trim,
				...(video ? { video } : {})
			});
			return proxy(new Request(`${HOST}/gone`));
		};
		const plain = await build();
		const withVideo = await build({ preload: 'none' });
		const text = await plain.text();
		expect(text).toContain('href="/site.css?spool-trim=0"');
		expect(await withVideo.text()).toBe(text);
		expect(plain.headers.get('etag')).toBe('W/"p"');
		expect(withVideo.headers.get('etag')).toBe('W/"p"');
	});
});

describe('signalsOf and the header helpers', () => {
	it('reads Save-Data and ECT', () => {
		expect(signalsOf(new Headers({ 'save-data': 'On', ect: '2G' }))).toEqual({
			saveData: true,
			slow: true
		});
		expect(signalsOf(new Headers({ 'save-data': 'off', ect: '4g' }))).toEqual(NONE);
		expect(signalsOf(new Headers())).toEqual(NONE);
	});

	it('merges list members once, in any case, and keeps a header that has a wildcard', () => {
		const headers = new Headers({ vary: 'Accept-Encoding, accept' });
		mergeList(headers, 'vary', ['Accept', 'Save-Data']);
		expect(headers.get('vary')).toBe('Accept-Encoding, accept, Save-Data');
		mergeList(headers, 'vary', ['save-data']);
		expect(headers.get('vary')).toBe('Accept-Encoding, accept, Save-Data');
		mergeList(headers, 'accept-ch', ['ECT']);
		expect(headers.get('accept-ch')).toBe('ECT');
		mergeList(headers, 'x-empty', []);
		expect(headers.has('x-empty')).toBe(false);
		const star = new Headers({ vary: '*' });
		mergeList(star, 'vary', ['Save-Data']);
		expect(star.get('vary')).toBe('*');
	});

	it('makes Cache-Control private: public is replaced, a missing header is created', () => {
		const cases: Array<[string | null, string]> = [
			[null, 'private, max-age=0'],
			['public, max-age=60', 'private, max-age=60'],
			['Public', 'private'],
			['max-age=60', 'private, max-age=60'],
			['max-age=60, private', 'max-age=60, private']
		];
		for (const [before, after] of cases) {
			const headers = new Headers(before === null ? {} : { 'cache-control': before });
			makePrivate(headers);
			expect(headers.get('cache-control'), String(before)).toBe(after);
		}
	});
});

describe('rewriteVideo', () => {
	const run = (html: string, options: VideoOptions = {}, signals = NONE) =>
		rewriteVideo(html, options, signals);

	it('adds preload="none" to a tag with none, and sets none over metadata, auto and an empty value', () => {
		expect(run('<video src="a.mp4"></video>')).toEqual({
			html: '<video src="a.mp4" preload="none"></video>',
			rewritten: 1
		});
		expect(run('<video preload="metadata" src=a>').html).toBe('<video preload="none" src=a>');
		expect(run("<video preload='auto'>").html).toBe("<video preload='none'>");
		expect(run('<video preload=metadata controls>').html).toBe('<video preload=none controls>');
		expect(run('<video preload>').html).toBe('<video preload="none">');
		expect(run('<video preload = "">').html).toBe('<video preload = "none">');
	});

	it('does not count a tag that already says none, in any case', () => {
		for (const html of ['<video preload="none">', '<VIDEO PRELOAD=" None ">']) {
			expect(run(html), html).toEqual({ html, rewritten: 0 });
		}
	});

	it('leaves preload alone with false, and with metadata sets metadata', () => {
		const html = '<video preload="auto" src=a>';
		expect(run(html, { preload: false })).toEqual({ html, rewritten: 0 });
		expect(run('<video src=a>', { preload: false }).html).toBe('<video src=a>');
		expect(run('<video src=a>', { preload: 'metadata' }).html).toBe(
			'<video src=a preload="metadata">'
		);
	});

	it('keeps the autoplay attribute by default, because autoplay overrides preload', () => {
		expect(run('<video autoplay muted src=a>').html).toBe(
			'<video autoplay muted src=a preload="none">'
		);
	});

	it('defers autoplay: removes the attribute, marks the tag, adds controls once and sets preload', () => {
		const defer: VideoOptions = { autoplay: 'defer' };
		expect(run('<video autoplay muted loop src="a.mp4"></video>', defer).html).toBe(
			'<video data-spool-autoplay muted loop src="a.mp4" controls preload="none"></video>'
		);
		expect(run('<video autoplay controls>', defer).html).toBe(
			'<video data-spool-autoplay controls preload="none">'
		);
		expect(run('<video autoplay>', { autoplay: 'defer', preload: 'metadata' }).html).toBe(
			'<video data-spool-autoplay controls preload="metadata">'
		);
		expect(
			run('<video autoplay preload="auto">', { autoplay: 'defer', preload: false }).html
		).toBe('<video data-spool-autoplay preload="none" controls>');
		expect(run('<video data-spool-autoplay autoplay controls>', defer).html).toBe(
			'<video data-spool-autoplay controls preload="none">'
		);
	});

	it('is idempotent: a rewritten page rewrites to itself', () => {
		const html = '<video autoplay muted src=a></video><video src=b>';
		const once = run(html, { autoplay: 'defer' });
		expect(once.rewritten).toBe(2);
		expect(run(once.html, { autoplay: 'defer' })).toEqual({ html: once.html, rewritten: 0 });
	});

	it('does not defer a tag that has no autoplay, which only gets its preload', () => {
		expect(run('<video src=a>', { autoplay: 'defer' }).html).toBe(
			'<video src=a preload="none">'
		);
	});

	it('reads attribute names in any case', () => {
		expect(run('<VIDEO PRELOAD="Metadata" AUTOPLAY>', { autoplay: 'defer' }).html).toBe(
			'<VIDEO PRELOAD="none" data-spool-autoplay controls>'
		);
	});

	it('inserts before the slash of a self-closing tag, and keeps a slash that ends an unquoted value', () => {
		expect(run('<video src="a.mp4"/>').html).toBe('<video src="a.mp4" preload="none"/>');
		expect(run('<video src="a.mp4" />').html).toBe('<video src="a.mp4" preload="none"/>');
		expect(run('<video controls/>').html).toBe('<video controls preload="none"/>');
		expect(run('<video/>').html).toBe('<video preload="none"/>');
		expect(run('<video />').html).toBe('<video preload="none"/>');
		expect(run('<video src=a/>').html).toBe('<video src=a/ preload="none">');
	});

	it('rewrites two videos and counts both, leaving the text between them byte for byte', () => {
		const html = '<p>café &amp; <b>x</b></p><video src=a></video>\n<p>m</p><video src=b>';
		expect(run(html)).toEqual({
			html: '<p>café &amp; <b>x</b></p><video src=a preload="none"></video>\n<p>m</p><video src=b preload="none">',
			rewritten: 2
		});
	});

	it('skips a video inside a comment, including one that never closes', () => {
		expect(run('<!-- <video src=a></video> --><video src=b>').html).toBe(
			'<!-- <video src=a></video> --><video src=b preload="none">'
		);
		const open = '<video src=a><!-- <video src=b>';
		expect(run(open).html).toBe('<video src=a preload="none"><!-- <video src=b>');
	});

	it('leaves audio, source, iframe, a script string and a tag that never closes alone', () => {
		const html =
			'<audio src=a></audio><iframe src="https://v.test/embed"></iframe><script>var s = "<video>";</script><video><source src="a.mp4" type="video/mp4"></video>';
		expect(run(html)).toEqual({
			html: html.replace('<video><source', '<video preload="none"><source'),
			rewritten: 1
		});
		expect(run('<video src=a')).toEqual({ html: '<video src=a', rewritten: 0 });
	});

	it('applies when it is told to: save-data needs the header, slow needs a slow connection or the header', () => {
		const html = '<video src=a>';
		const done = '<video src=a preload="none">';
		expect(run(html, { when: 'save-data' }, NONE).rewritten).toBe(0);
		expect(run(html, { when: 'save-data' }, { saveData: false, slow: true }).rewritten).toBe(0);
		expect(run(html, { when: 'save-data' }, { saveData: true, slow: false }).html).toBe(done);
		expect(run(html, { when: 'slow' }, NONE).rewritten).toBe(0);
		expect(run(html, { when: 'slow' }, { saveData: false, slow: true }).html).toBe(done);
		expect(run(html, { when: 'slow' }, { saveData: true, slow: false }).html).toBe(done);
		expect(run(html, { when: 'always' }, NONE).html).toBe(done);
	});
});

describe('video in the proxy', () => {
	const VIDEO_PAGE = `${PAGE.replace('<p>body</p>', '<video autoplay muted src="a.mp4"></video>')}`;

	function videoRig(video: VideoOptions, reply: Partial<Reply> = {}) {
		const origin = fakeOrigin();
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch,
			video
		});
		origin.replies.set('/v', {
			body: VIDEO_PAGE,
			headers: { 'content-type': HTML, 'cache-tag': 'v1', etag: '"v"' },
			...reply
		});
		const call = (headers: Record<string, string> = {}, path = '/v') =>
			proxy(new Request(`${HOST}${path}`, { headers }));
		const shell = async (headers: Record<string, string> = {}) => {
			const response = await call(
				{ accept: '*/*', ...headers },
				'/.spool/artifact?path=/v&have='
			);
			const artifact = parseArtifact(await response.json());
			return artifact.strategy === 'assembly' ? artifact.body.shell : '';
		};
		return { ...origin, proxy, call, shell };
	}

	it('with when: always, sets preload and the page the spool keeps carries it', async () => {
		const s = videoRig({});
		const response = await s.call();
		const text = await response.text();
		expect(text).toContain('<video autoplay muted src="a.mp4" preload="none">');
		expect(decodeEnvelope(response.headers).artifact?.id).toBe('/v');
		expect(response.headers.get('etag')).toBe('W/"v"');
		expect(response.headers.has('cache-control')).toBe(false);
		expect(response.headers.has('vary')).toBe(false);
		expect({ ...s.proxy.video }).toEqual({ pages: 1, rewritten: 1 });
		expect(await s.shell()).toContain('<video autoplay muted src="a.mp4" preload="none">');
	});

	it('defers autoplay in the page and the held copy', async () => {
		const s = videoRig({ autoplay: 'defer' });
		const text = await (await s.call()).text();
		expect(text).toContain(
			'<video data-spool-autoplay muted src="a.mp4" controls preload="none">'
		);
		expect(await s.shell()).toContain(
			'<video data-spool-autoplay muted src="a.mp4" controls preload="none">'
		);
	});

	it('counts nothing for a page that already says none, or has no video', async () => {
		const none = videoRig(
			{},
			{ body: PAGE.replace('<p>body</p>', '<video preload="none"></video>') }
		);
		await none.call();
		const bare = videoRig({}, { body: PAGE });
		await bare.call();
		expect({ ...none.proxy.video }).toEqual({ pages: 0, rewritten: 0 });
		expect({ ...bare.proxy.video }).toEqual({ pages: 0, rewritten: 0 });
	});

	it('with when: save-data and the header, rewrites the page, makes it private, varies it and does not keep it', async () => {
		const s = videoRig({ when: 'save-data' });
		const response = await s.call({ 'save-data': 'on' });
		expect(await response.text()).toContain('preload="none"');
		expect(response.headers.get('cache-control')).toBe('private, max-age=0');
		expect(response.headers.get('vary')).toBe('Save-Data, ECT');
		expect(response.headers.get('etag')).toBe('W/"v"');
		expect(response.headers.has('spool-artifact')).toBe(false);
		expect(response.headers.get('spool-invalidate')).toContain(
			encodeURIComponent('spool:artifact:/v')
		);
		expect({ ...s.proxy.video }).toEqual({ pages: 1, rewritten: 1 });
		expect(await s.shell({ 'save-data': 'on' })).not.toContain('preload');
	});

	it('replaces public in Cache-Control and merges Save-Data and ECT into an existing Vary', async () => {
		const s = videoRig(
			{ when: 'slow' },
			{
				headers: {
					'content-type': HTML,
					'cache-control': 'public, max-age=60',
					vary: 'Accept-Encoding, ect'
				}
			}
		);
		const response = await s.call({ ect: '3g' });
		expect(response.headers.get('cache-control')).toBe('private, max-age=60');
		expect(response.headers.get('vary')).toBe('Accept-Encoding, ect, Save-Data');
		expect(response.headers.has('spool-artifact')).toBe(false);
	});

	it('with when: save-data and no header, leaves the page and its headers as they were', async () => {
		const s = videoRig({ when: 'save-data' });
		const origin = fakeOrigin();
		origin.replies.set('/v', {
			body: VIDEO_PAGE,
			headers: { 'content-type': HTML, 'cache-tag': 'v1', etag: '"v"' }
		});
		const bare = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch
		});
		const a = await s.call();
		const b = await bare(new Request(`${HOST}/v`));
		expect(await a.text()).toBe(await b.text());
		for (const name of ['etag', 'cache-control', 'vary', 'spool-artifact']) {
			expect(a.headers.get(name), name).toBe(b.headers.get(name));
		}
		expect(decodeEnvelope(a.headers).artifact?.id).toBe('/v');
		expect({ ...s.proxy.video }).toEqual({ pages: 0, rewritten: 0 });
	});

	it('rewrites a page in another charset byte for byte', async () => {
		const latin = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
		const page = (video: string) =>
			`<html><head><meta charset="windows-1252"></head><body>café \u0093x\u0094${video}</body></html>`;
		const s = videoRig(
			{},
			{
				body: latin(page('<video src=a>')),
				headers: { 'content-type': 'text/html' }
			}
		);
		const got = new Uint8Array(await (await s.call()).arrayBuffer());
		expect([...got]).toEqual([...latin(page('<video src=a preload="none">'))]);
		expect(s.proxy.video.rewritten).toBe(1);
	});
});
