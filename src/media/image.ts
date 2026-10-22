import { ProtocolError } from '../protocol/errors.js';
import { sourceHash } from '../trim/manifest.js';
import { mergeList, signalsOf } from './headers.js';
import { resolveLazyOptions, type LazyOptions, type ResolvedLazyOptions } from './lazy.js';
import {
	RESPONSIVE_PARAM,
	resolveResponsiveOptions,
	takeWidth,
	type ResolvedResponsiveOptions,
	type ResponsiveOptions
} from './responsive.js';

/** what an {@link ImageEncoder} is asked to produce */
export type ImageEncodeOptions = {
	format: 'webp';
	/** 1 to 100 */
	quality: number;
	/** the widest the output may be, in pixels; absent means the source width */
	width?: number;
	/** encode without loss, so `quality` has no effect; absent means lossy */
	lossless?: boolean;
	/**
	 * the time the encoder may spend, in milliseconds; absent means no limit. It is a hint for an
	 * encoder that can trade quality for time, and the proxy stops waiting at this time either way
	 */
	budgetMs?: number;
};

/** what an {@link ImageEncoder} returns */
export type ImageEncoded = { bytes: Uint8Array };

/**
 * Re-encodes JPEG or PNG bytes. The encoder never upscales: `width` is a ceiling, and an image
 * narrower than it keeps its size. It throws on input it cannot decode, and the proxy then serves
 * the original bytes.
 */
export type ImageEncoder = (
	input: Uint8Array,
	options: ImageEncodeOptions
) => Promise<ImageEncoded>;

/** the options tinyimg's `transform` takes that {@link tinyimgEncoder} sets */
export type TinyimgTransformOptions = {
	format: 'webp';
	quality: number;
	width?: number;
	fit?: 'scale-down';
	lossless?: boolean;
	budgetMs?: number;
};

/**
 * The part of tinyimg (`@gmitch215/tinyimg`) that {@link tinyimgEncoder} calls: the loaded
 * `module` and the `transform` function, both from the caller's own import of the package. spool
 * imports nothing from tinyimg.
 */
export type TinyimgBinding<M = unknown> = {
	module: M;
	transform: (
		module: M,
		input: Uint8Array,
		options: TinyimgTransformOptions
	) => Promise<{ bytes(): Uint8Array }>;
};

/** the oldest tinyimg that turns an EXIF-rotated JPEG upright; 1.1.0 and earlier leave it sideways */
export const TINYIMG_MIN_VERSION = [1, 1, 1] as const;

/** the version text of a module that reports one older than {@link TINYIMG_MIN_VERSION}, else null */
function tooOld(module: unknown): string | null {
	const version = (module as { version?: unknown } | null)?.version;
	if (!Array.isArray(version) || version.length !== 3 || !version.every(Number.isInteger)) {
		return null;
	}
	for (const [at, need] of TINYIMG_MIN_VERSION.entries()) {
		const have = version[at] as number;
		if (have !== need) return have < need ? version.join('.') : null;
	}
	return null;
}

/**
 * An {@link ImageEncoder} over tinyimg. It passes `fit: 'scale-down'` when a width is set, which
 * keeps tinyimg from upscaling, passes `lossless` and `budgetMs` when the proxy sets them, and
 * returns the bytes of the result. A module whose `version` is older than
 * {@link TINYIMG_MIN_VERSION} is refused with a `ProtocolError`, since converting an EXIF-rotated
 * JPEG with it would serve the picture sideways. A module that reports no version is accepted.
 */
export function tinyimgEncoder<M>(binding: TinyimgBinding<M>): ImageEncoder {
	const old = tooOld(binding.module);
	if (old !== null) {
		throw new ProtocolError(
			'bad-route',
			`tinyimg ${old} leaves an EXIF-rotated JPEG sideways; use ${TINYIMG_MIN_VERSION.join('.')} or later`
		);
	}
	return async (input, { format, quality, width, lossless, budgetMs }) => {
		const out = await binding.transform(binding.module, input, {
			format,
			quality,
			...(width === undefined ? {} : { width, fit: 'scale-down' as const }),
			...(lossless ? { lossless: true } : {}),
			...(budgetMs === undefined ? {} : { budgetMs })
		});
		return { bytes: out.bytes() };
	};
}

/** converted bytes by content hash, quality and width */
export type ImageCache = {
	get(key: string): Uint8Array | undefined;
	set(key: string, bytes: Uint8Array): void;
};

/** an in-memory {@link ImageCache} that drops the least recently used entry past `maxBytes` */
export function memoryImageCache(maxBytes: number): ImageCache {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new ProtocolError('bad-route', 'image cache maxBytes must be a positive integer');
	}
	const entries = new Map<string, Uint8Array>();
	let size = 0;
	return {
		get(key) {
			const hit = entries.get(key);
			if (hit) {
				entries.delete(key);
				entries.set(key, hit);
			}
			return hit;
		},
		set(key, bytes) {
			if (bytes.length > maxBytes) return;
			const old = entries.get(key);
			if (old) size -= old.length;
			entries.delete(key);
			entries.set(key, bytes);
			size += bytes.length;
			for (const [oldest, held] of entries) {
				if (size <= maxBytes) break;
				entries.delete(oldest);
				size -= held.length;
			}
		}
	};
}

/** how a PNG becomes WebP; see `ImageOptions.png` */
export type PngMode = 'lossy' | 'auto' | 'lossless';

/** the largest PNG, in bytes, that `png: 'auto'` encodes both ways */
export const PNG_AUTO_BYTES = 200_000;

/** what `spoolProxy({ images })` takes */
export type ImageOptions = {
	/** converts the bytes; see {@link tinyimgEncoder} */
	encoder: ImageEncoder;
	/** WebP quality, 1 to 100, by the visitor's connection; defaults 80, 65 for `Save-Data: on`, 70 for `ECT` of `slow-2g`, `2g` or `3g` */
	quality?: { default?: number; saveData?: number; slow?: number };
	/** smallest origin file converted, in bytes; default 4096, so icons and sprites stay as they are */
	minBytes?: number;
	/** largest origin file converted, in bytes; default 15,000,000 */
	maxBytes?: number;
	/** `fallback` is the width ceiling for a request that names none; default `maxWidth`, and it wins over `maxWidth` when both are set */
	width?: { fallback?: number };
	/**
	 * The width ceiling, 1 to 16384, for a request that carries no width hint; default 2560, `false`
	 * for none. A `Sec-CH-Width` or a viewport and DPR pair wins over it. An image narrower than the
	 * ceiling keeps its size.
	 */
	maxWidth?: number | false;
	/**
	 * How long the proxy waits for the encoder, in milliseconds; default 10,000, `false` to wait
	 * without limit. When the time runs out the visitor gets the origin's bytes, and the encoder is
	 * left to finish: a result that arrives late is cached for the next request.
	 */
	timeoutMs?: number | false;
	/**
	 * How a PNG becomes WebP; default `'lossy'`. `'lossless'` encodes every PNG without loss, and
	 * `'auto'` encodes a PNG under 200 KB both ways and serves the smaller (a screenshot or a flat
	 * graphic is often smaller lossless, a photograph in a PNG is not). A JPEG is always lossy. The
	 * mode is part of the cache key and the ETag of a PNG that is not `'lossy'`.
	 */
	png?: PngMode;
	/**
	 * Adds a `srcset` of `?spool-w=<width>` variants to same-origin `<img>` tags in HTML, so a
	 * browser that sends no `Sec-CH-Width` (Firefox, Safari) still asks for a smaller file; default
	 * `false`, no page is touched for it. See `rewriteResponsive`.
	 */
	responsive?: ResponsiveOptions | false;
	/**
	 * Adds `loading="lazy"` and `decoding="async"` to `<img>` tags in HTML after the first `skip`
	 * (default 2), and `loading="lazy"` to `<iframe>` tags with `iframes`; default `false`, no page
	 * is touched for it. See `rewriteLazy`.
	 */
	lazy?: LazyOptions | false;
	/** add `Accept-CH` to HTML responses so the browser sends the width hints; default true */
	hints?: boolean;
	/** converted bytes by content hash; default an in-memory cache of 64 MiB, `false` for none */
	cache?: ImageCache | false;
	/** the paths converted, tested against the pathname; default `/\.(?:jpe?g|png)$/i` */
	paths?: RegExp;
};

/** `ImageOptions` with every default applied and every value checked */
export type ResolvedImageOptions = {
	encoder: ImageEncoder;
	quality: { default: number; saveData: number; slow: number };
	minBytes: number;
	maxBytes: number;
	/** `fallback` is `width.fallback` when set, else `maxWidth` */
	width: { fallback?: number };
	timeoutMs: number | false;
	png: PngMode;
	responsive: ResolvedResponsiveOptions | false;
	lazy: ResolvedLazyOptions | false;
	hints: boolean;
	paths: RegExp;
};

/** what the proxy counted since it started; `bytesIn` and `bytesOut` cover converted responses only */
export type ImageStats = {
	converted: number;
	bytesIn: number;
	bytesOut: number;
	cacheHits: number;
	/** requests that waited for an encode another request had already started */
	coalesced: number;
	/** `<img>` and `<iframe>` tags that got `loading="lazy"` */
	lazied: number;
	/** `<img>` tags that got a `srcset` of `spool-w` variants */
	responsive: number;
	/**
	 * Requests and responses left as they were, by the first test that failed: `path`, `accept`,
	 * `range`, `authorization`, `status`, `type`, `set-cookie`, `size-min`, `size-max`, `larger`
	 * (the encoder's output was not smaller), `failed` (the encoder threw), `timeout` (the encoder
	 * ran past `timeoutMs`) and `not-modified` (answered 304 without encoding).
	 */
	skipped: Record<string, number>;
};

/** the state `spoolProxy` keeps for `images`: checked options, the cache, the running encodes and the counters */
export type ImageConverter = {
	readonly options: ResolvedImageOptions;
	readonly cache: ImageCache | undefined;
	readonly stats: ImageStats;
	/** encodes in flight by cache key, so identical requests share one encoder call */
	readonly running: Map<string, Promise<Uint8Array>>;
};

/** the Vary entries a converted image answers with */
export const IMAGE_VARY: readonly string[] = [
	'Accept',
	'Save-Data',
	'Sec-CH-Width',
	'Sec-CH-DPR',
	'Sec-CH-Viewport-Width',
	'ECT'
];

/** the client hints an HTML response asks the browser to send on later image requests */
export const IMAGE_HINTS: readonly string[] = [
	'Sec-CH-DPR',
	'Sec-CH-Width',
	'Sec-CH-Viewport-Width',
	'ECT'
];

const MAX_WIDTH = 16384;
const DEFAULT_MAX_WIDTH = 2560;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

function integerIn(value: number, low: number, high: number, name: string): number {
	if (!Number.isInteger(value) || value < low || value > high) {
		throw new ProtocolError(
			'bad-route',
			`images ${name} must be an integer from ${low} to ${high}`
		);
	}
	return value;
}

/** applies the defaults to `options` and refuses a value out of range with `ProtocolError('bad-route')` */
export function resolveImageOptions(options: ImageOptions): ResolvedImageOptions {
	const quality = {
		default: integerIn(options.quality?.default ?? 80, 1, 100, 'quality.default'),
		saveData: integerIn(options.quality?.saveData ?? 65, 1, 100, 'quality.saveData'),
		slow: integerIn(options.quality?.slow ?? 70, 1, 100, 'quality.slow')
	};
	const minBytes = integerIn(options.minBytes ?? 4096, 0, Number.MAX_SAFE_INTEGER, 'minBytes');
	const maxBytes = integerIn(
		options.maxBytes ?? 15_000_000,
		1,
		Number.MAX_SAFE_INTEGER,
		'maxBytes'
	);
	if (minBytes > maxBytes) {
		throw new ProtocolError('bad-route', 'images minBytes must not exceed maxBytes');
	}
	const fallback = options.width?.fallback;
	const ceiling = options.maxWidth === undefined ? DEFAULT_MAX_WIDTH : options.maxWidth;
	const checked = ceiling === false ? false : integerIn(ceiling, 1, MAX_WIDTH, 'maxWidth');
	const timeout = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
	const png = options.png ?? 'lossy';
	if (png !== 'lossy' && png !== 'auto' && png !== 'lossless') {
		throw new ProtocolError('bad-route', "images png must be 'lossy', 'auto' or 'lossless'");
	}
	return {
		encoder: options.encoder,
		quality,
		minBytes,
		maxBytes,
		width:
			fallback !== undefined
				? { fallback: integerIn(fallback, 1, MAX_WIDTH, 'width.fallback') }
				: checked === false
					? {}
					: { fallback: checked },
		timeoutMs:
			timeout === false ? false : integerIn(timeout, 1, Number.MAX_SAFE_INTEGER, 'timeoutMs'),
		png,
		responsive: options.responsive ? resolveResponsiveOptions(options.responsive) : false,
		lazy: options.lazy ? resolveLazyOptions(options.lazy) : false,
		hints: options.hints !== false,
		paths: options.paths ?? /\.(?:jpe?g|png)$/i
	};
}

/** a converter with the options resolved, an empty cache and zeroed counters */
export function createImageConverter(options: ImageOptions): ImageConverter {
	const resolved = resolveImageOptions(options);
	return {
		options: resolved,
		cache:
			options.cache === false
				? undefined
				: (options.cache ?? memoryImageCache(DEFAULT_CACHE_BYTES)),
		stats: {
			converted: 0,
			bytesIn: 0,
			bytesOut: 0,
			cacheHits: 0,
			coalesced: 0,
			lazied: 0,
			responsive: 0,
			skipped: {}
		},
		running: new Map()
	};
}

function positive(value: string | null): number | null {
	if (value === null || !/^\s*\d+\s*$/.test(value)) return null;
	const n = Number(value);
	return n > 0 && n <= MAX_WIDTH ? n : null;
}

/**
 * The WebP quality and width ceiling for one request, from its headers. `Save-Data: on` picks
 * `quality.saveData`, else an `ECT` of `slow-2g`, `2g` or `3g` picks `quality.slow`, else
 * `quality.default`. The width is `Sec-CH-Width`, else `Sec-CH-Viewport-Width` times `Sec-CH-DPR`
 * rounded up, else `width.fallback`; a value that is not a positive number of at most 16384 is
 * ignored.
 */
export function imageVariant(
	headers: Headers,
	options: Pick<ImageOptions, 'quality' | 'width'> = {}
): { quality: number; width?: number } {
	const signals = signalsOf(headers);
	const quality = signals.saveData
		? (options.quality?.saveData ?? 65)
		: signals.slow
			? (options.quality?.slow ?? 70)
			: (options.quality?.default ?? 80);
	let width = positive(headers.get('sec-ch-width'));
	if (width === null) {
		const viewport = positive(headers.get('sec-ch-viewport-width'));
		const ratio = Number(headers.get('sec-ch-dpr'));
		if (viewport !== null && Number.isFinite(ratio) && ratio > 0) {
			const scaled = Math.ceil(viewport * ratio);
			if (scaled <= MAX_WIDTH) width = scaled;
		}
	}
	width ??= options.width?.fallback ?? null;
	return width === null ? { quality } : { quality, width };
}

function skip(converter: ImageConverter, why: string): void {
	const { skipped } = converter.stats;
	skipped[why] = (skipped[why] ?? 0) + 1;
}

/**
 * The request-side tests: a `GET` whose path matches `paths`, that accepts `image/webp` and carries
 * no `Range` or `Authorization`. A request that fails one is counted under `path`, `accept`,
 * `range` or `authorization` and `false` comes back; a method other than `GET` is not an image
 * request and is not counted. The proxy forwards a request that passes without its conditional
 * headers, so the origin sends the whole file.
 */
export function imageRequest(converter: ImageConverter, request: Request): boolean {
	if (request.method !== 'GET') return false;
	const { paths } = converter.options;
	paths.lastIndex = 0;
	if (!paths.test(new URL(request.url).pathname)) return skipBecause(converter, 'path');
	if (!(request.headers.get('accept') ?? '').toLowerCase().includes('image/webp')) {
		return skipBecause(converter, 'accept');
	}
	if (request.headers.has('range')) return skipBecause(converter, 'range');
	if (request.headers.has('authorization')) return skipBecause(converter, 'authorization');
	return true;
}

/**
 * The query string the origin should see for `url`: with `responsive` set and a pathname that
 * `paths` matches, every `spool-w` parameter is removed, so the origin never sees a parameter
 * only the proxy reads; otherwise `url.search` as it is.
 */
export function originSearch(converter: ImageConverter, url: URL): string {
	const { responsive, paths } = converter.options;
	if (!responsive || !url.search.includes(RESPONSIVE_PARAM)) return url.search;
	paths.lastIndex = 0;
	return paths.test(url.pathname) ? takeWidth(url.search, responsive.widths).search : url.search;
}

function skipBecause(converter: ImageConverter, why: string): false {
	skip(converter, why);
	return false;
}

function magicOf(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	return png.every((byte, at) => bytes[at] === byte) ? 'image/png' : null;
}

function hex(hash: string): string {
	return [...atob(hash.slice('sha256-'.length)).slice(0, 8)]
		.map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
		.join('');
}

function matches(header: string | null, etag: string): boolean {
	if (header === null) return false;
	const opaque = etag.slice(2);
	return header
		.split(',')
		.map((part) => part.trim())
		.some((part) => part === '*' || part.replace(/^W\//, '') === opaque);
}

/**
 * The encoded bytes for `key`, or `'failed'` when the encoder threw or returned nothing, or
 * `'timeout'` when it ran past `timeoutMs`. A request for a key that is already encoding waits for
 * that encode instead of starting another. The encode caches its own result when it finishes, so
 * one that outlives its waiters still serves the next request.
 */
async function encode(
	converter: ImageConverter,
	key: string,
	bytes: Uint8Array,
	quality: number,
	width: number | undefined,
	mode: PngMode
): Promise<Uint8Array | 'failed' | 'timeout'> {
	const { options, stats, cache, running } = converter;
	let task = running.get(key);
	if (task) {
		stats.coalesced++;
	} else {
		const budget = options.timeoutMs === false ? {} : { budgetMs: options.timeoutMs };
		const run = async (lossless: boolean) =>
			(
				await options.encoder(bytes, {
					format: 'webp',
					quality,
					...(width === undefined ? {} : { width }),
					...(lossless ? { lossless: true } : {}),
					...budget
				})
			).bytes;
		const started = (async () => {
			let out: Uint8Array;
			if (mode === 'auto') {
				// a failed arm loses to the other; both failing fails the encode
				const arms = await Promise.allSettled([run(false), run(true)]);
				const made = arms.flatMap((arm) =>
					arm.status === 'fulfilled' && arm.value.length > 0 ? [arm.value] : []
				);
				if (made.length === 0) throw new Error('the encoder returned no bytes');
				out = made.reduce((best, next) => (next.length < best.length ? next : best));
			} else {
				out = await run(mode === 'lossless');
				if (out.length === 0) throw new Error('the encoder returned no bytes');
			}
			cache?.set(key, out);
			return out;
		})();
		task = started;
		running.set(key, started);
		const clear = () => {
			if (running.get(key) === started) running.delete(key);
		};
		started.then(clear, clear);
	}
	const limit = options.timeoutMs;
	if (limit === false) {
		return task.catch(() => 'failed' as const);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), limit);
	});
	try {
		return await Promise.race([task, expired]);
	} catch {
		return 'failed';
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Answers one origin response to a request that passed {@link imageRequest}: a `200` JPEG or PNG
 * that sets no cookie and is between `minBytes` and `maxBytes` becomes WebP, and anything else
 * comes back as it was. The conversion keeps the origin's `Cache-Control`, merges {@link IMAGE_VARY}
 * into `Vary`, sets a weak `ETag` from the origin bytes, the quality and the width, and answers
 * `304` when the request's `If-None-Match` matches it. `X-Spool-Image` reads
 * `<bytesIn>-><bytesOut>; q=<quality>; w=<width or 0>`. With `responsive`, a listed `spool-w` in the
 * request URL lowers the width to at most that value; an unlisted one is ignored. A PNG follows
 * `png`.
 *
 * The origin is fetched for every request, so a visitor only ever gets the bytes the origin sent
 * that visitor. An encoder that throws, runs past `timeoutMs`, or produces output that is not
 * smaller serves the origin's bytes with a `200`. The response never fails because of the
 * conversion. Simultaneous requests for the same bytes, quality and width share one encoder call.
 */
export async function convertImage(
	converter: ImageConverter,
	request: Request,
	upstream: Response
): Promise<Response> {
	const { options, stats, cache } = converter;
	if (upstream.status !== 200) return skipWith(converter, 'status', upstream);
	const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
	if (type !== 'image/jpeg' && type !== 'image/png') return skipWith(converter, 'type', upstream);
	if (upstream.headers.getSetCookie().length > 0)
		return skipWith(converter, 'set-cookie', upstream);
	const declared = upstream.headers.get('content-length');
	if (declared !== null && Number(declared) > options.maxBytes) {
		return skipWith(converter, 'size-max', upstream);
	}
	const bytes = new Uint8Array(await upstream.arrayBuffer());
	const original = () =>
		new Response(bytes, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers
		});
	if (magicOf(bytes) !== type) return skipWith(converter, 'type', original());
	if (bytes.length < options.minBytes) return skipWith(converter, 'size-min', original());
	if (bytes.length > options.maxBytes) return skipWith(converter, 'size-max', original());

	const variant = imageVariant(request.headers, options);
	const { quality } = variant;
	let { width } = variant;
	if (options.responsive) {
		const asked = takeWidth(new URL(request.url).search, options.responsive.widths).width;
		if (asked !== undefined) width = width === undefined ? asked : Math.min(width, asked);
	}
	// only a PNG has a mode, and `auto` stays lossy above the size it encodes both ways
	const mode: PngMode =
		type === 'image/png' && (options.png !== 'auto' || bytes.length < PNG_AUTO_BYTES)
			? options.png
			: 'lossy';
	const hash = await sourceHash(bytes);
	const etag = `W/"${hex(hash)}-${quality}-${width ?? 0}${mode === 'lossy' ? '' : `-${mode}`}"`;
	const headers = new Headers(upstream.headers);
	headers.set('content-type', 'image/webp');
	headers.delete('content-length');
	headers.delete('accept-ranges');
	mergeList(headers, 'vary', IMAGE_VARY);
	headers.set('etag', etag);
	if (matches(request.headers.get('if-none-match'), etag)) {
		skip(converter, 'not-modified');
		return new Response(null, { status: 304, headers });
	}

	const key = `${hash}|${quality}|${width ?? 0}${mode === 'lossy' ? '' : `|${mode}`}`;
	let out = cache?.get(key);
	if (out) {
		stats.cacheHits++;
	} else {
		const result = await encode(converter, key, bytes, quality, width, mode);
		if (typeof result === 'string') return skipWith(converter, result, original());
		out = result;
	}
	if (out.length >= bytes.length) return skipWith(converter, 'larger', original());
	headers.set('x-spool-image', `${bytes.length}->${out.length}; q=${quality}; w=${width ?? 0}`);
	stats.converted++;
	stats.bytesIn += bytes.length;
	stats.bytesOut += out.length;
	return new Response(out as BodyInit, { status: 200, statusText: upstream.statusText, headers });
}

function skipWith(converter: ImageConverter, why: string, response: Response): Response {
	skip(converter, why);
	return response;
}
