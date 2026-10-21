import { describe, expect, it } from 'vitest';
import { makePrivate, mergeList } from '../../src/media/headers';
import {
	createImageConverter,
	IMAGE_HINTS,
	IMAGE_VARY,
	imageVariant,
	memoryImageCache,
	rewriteVideo,
	signalsOf,
	tinyimgEncoder,
	type ImageCache,
	type ImageEncodeOptions,
	type ImageEncoder,
	type ImageOptions,
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
			width: {},
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
		expect(photo.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=0');
		expect(photo.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{16}-80-0"$/);
		expect(photo.headers.get('vary')).toBe(IMAGE_VARY.join(', '));
		expect(await bytesOf(photo)).toHaveLength(2500);
		const chart = await s.call('/chart.png');
		expect(chart.headers.get('x-spool-image')).toBe('8000->2000; q=80; w=0');
		expect(await bytesOf(chart)).toHaveLength(2000);
		expect(s.calls).toEqual([
			{ length: 10_000, options: { format: 'webp', quality: 80 } },
			{ length: 8_000, options: { format: 'webp', quality: 80 } }
		]);
		expect({ ...s.proxy.images }).toEqual({
			converted: 2,
			bytesIn: 18_000,
			bytesOut: 4_500,
			cacheHits: 0,
			skipped: {}
		});
	});

	it('encodes once per distinct bytes, quality and width, and counts the repeats as cache hits', async () => {
		const s = rig();
		for (let i = 0; i < 3; i++) await s.call('/photo.jpg');
		expect(s.calls).toHaveLength(1);
		expect(s.proxy.images.cacheHits).toBe(2);
		const saver = await s.call('/photo.jpg', { 'save-data': 'on' });
		expect(saver.headers.get('x-spool-image')).toBe('10000->2500; q=65; w=0');
		expect(s.calls).toHaveLength(2);
		const sized = await s.call('/photo.jpg', { 'sec-ch-width': '640' });
		expect(sized.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=640');
		await s.call('/photo.jpg', { 'sec-ch-width': '640' });
		expect(s.calls).toHaveLength(3);
		expect(s.calls[2]?.options).toEqual({ format: 'webp', quality: 80, width: 640 });
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
		expect({ ...s.proxy.images }).toEqual({
			converted: 0,
			bytesIn: 0,
			bytesOut: 0,
			cacheHits: 1,
			skipped: { larger: 2 }
		});
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
		expect({ ...s.proxy.images }).toEqual({
			converted: 0,
			bytesIn: 0,
			bytesOut: 0,
			cacheHits: 0,
			skipped: { failed: 2 }
		});
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
		expect({ ...proxy.images }).toEqual({
			converted: 0,
			bytesIn: 0,
			bytesOut: 0,
			cacheHits: 0,
			skipped: {}
		});
		expect({ ...proxy.video }).toEqual({ pages: 0, rewritten: 0 });
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
