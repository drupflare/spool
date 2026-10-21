import { ProtocolError } from '../protocol/errors.js';
import { sourceHash } from '../trim/manifest.js';
import { mergeList, signalsOf } from './headers.js';

/** what an {@link ImageEncoder} is asked to produce */
export type ImageEncodeOptions = {
	format: 'webp';
	/** 1 to 100 */
	quality: number;
	/** the widest the output may be, in pixels; absent means the source width */
	width?: number;
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

/**
 * An {@link ImageEncoder} over tinyimg. It passes `fit: 'scale-down'` when a width is set, which
 * keeps tinyimg from upscaling, and returns the bytes of the result.
 */
export function tinyimgEncoder<M>(binding: TinyimgBinding<M>): ImageEncoder {
	return async (input, { format, quality, width }) => {
		const out = await binding.transform(binding.module, input, {
			format,
			quality,
			...(width === undefined ? {} : { width, fit: 'scale-down' as const })
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
	/** `fallback` is the width ceiling for a request that names none; default no resize */
	width?: { fallback?: number };
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
	width: { fallback?: number };
	hints: boolean;
	paths: RegExp;
};

/** what the proxy counted since it started; `bytesIn` and `bytesOut` cover converted responses only */
export type ImageStats = {
	converted: number;
	bytesIn: number;
	bytesOut: number;
	cacheHits: number;
	/**
	 * Requests and responses left as they were, by the first test that failed: `path`, `accept`,
	 * `range`, `authorization`, `status`, `type`, `set-cookie`, `size-min`, `size-max`, `larger`
	 * (the encoder's output was not smaller), `failed` (the encoder threw) and `not-modified`
	 * (answered 304 without encoding).
	 */
	skipped: Record<string, number>;
};

/** the state `spoolProxy` keeps for `images`: checked options, the cache and the counters */
export type ImageConverter = {
	readonly options: ResolvedImageOptions;
	readonly cache: ImageCache | undefined;
	readonly stats: ImageStats;
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
	return {
		encoder: options.encoder,
		quality,
		minBytes,
		maxBytes,
		width:
			fallback === undefined
				? {}
				: { fallback: integerIn(fallback, 1, MAX_WIDTH, 'width.fallback') },
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
		stats: { converted: 0, bytesIn: 0, bytesOut: 0, cacheHits: 0, skipped: {} }
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
 * Answers one origin response to a request that passed {@link imageRequest}: a `200` JPEG or PNG
 * that sets no cookie and is between `minBytes` and `maxBytes` becomes WebP, and anything else
 * comes back as it was. The conversion keeps the origin's `Cache-Control`, merges {@link IMAGE_VARY}
 * into `Vary`, sets a weak `ETag` from the origin bytes, the quality and the width, and answers
 * `304` when the request's `If-None-Match` matches it. `X-Spool-Image` reads
 * `<bytesIn>-><bytesOut>; q=<quality>; w=<width or 0>`.
 *
 * The origin is fetched for every request, so a visitor only ever gets the bytes the origin sent
 * that visitor. An encoder that throws, or output that is not smaller, serves the origin's bytes
 * with a `200`. The response never fails because of the conversion.
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

	const { quality, width } = imageVariant(request.headers, options);
	const hash = await sourceHash(bytes);
	const etag = `W/"${hex(hash)}-${quality}-${width ?? 0}"`;
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

	const key = `${hash}|${quality}|${width ?? 0}`;
	let out = cache?.get(key);
	if (out) {
		stats.cacheHits++;
	} else {
		try {
			out = (
				await options.encoder(bytes, {
					format: 'webp',
					quality,
					...(width === undefined ? {} : { width })
				})
			).bytes;
		} catch {
			return skipWith(converter, 'failed', original());
		}
		if (out.length === 0) return skipWith(converter, 'failed', original());
		cache?.set(key, out);
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
