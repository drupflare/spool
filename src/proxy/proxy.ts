import {
	resolveEmbedOptions,
	rewriteEmbeds,
	type EmbedOptions,
	type EmbedStats
} from '../media/embeds.js';
import { makePrivate, mergeList, signalsOf } from '../media/headers.js';
import {
	convertImage,
	createImageConverter,
	IMAGE_HINTS,
	imageRequest,
	originSearch,
	type ImageOptions,
	type ImageStats
} from '../media/image.js';
import { rewriteLazy } from '../media/lazy.js';
import { rewriteResponsive } from '../media/responsive.js';
import { resolveVideoOptions, rewriteVideo, type VideoOptions } from '../media/video.js';
import { PATHS } from '../protocol/config.js';
import { writeEnvelope } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { normalise } from '../protocol/normalise.js';
import {
	defineRoute,
	matchRoute,
	type AssemblyRoute,
	type DataRoute,
	type Route,
	type RouteContext
} from '../protocol/route.js';
import { artifactTag } from '../protocol/sync.js';
import { createSpool, type Spool, type SpoolOptions } from '../server/spool.js';
import {
	guardPage,
	sourceHash,
	stripTrimParam,
	TRIM_PARAM,
	trimKey,
	type TrimManifest
} from '../trim/index.js';
import { createDictionaries, type DictionaryOptions, type DictionaryStats } from './dictionary.js';
import {
	decline,
	htmlCharset,
	isUtf8,
	setsPrivateCookie,
	type Decline,
	type Gate
} from './eligible.js';
import { PURGE_PATH, respondPurge } from './purge.js';
import { pathTag, readTags, stripTags } from './tags.js';

const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host'
];

/**
 * A route the proxy answers locally, declared like a `createSpool` route minus `load`: the proxy
 * loads the page from the origin. A `data` route parses the origin's JSON. `depends` adds tags to
 * the ones the origin sent.
 */
export type ProxyRoute =
	| ({ pattern: string; strategy?: 'assembly' } & Omit<AssemblyRoute, 'strategy' | 'load'>)
	| ({ pattern: string; strategy: 'data' } & Omit<DataRoute, 'strategy' | 'load'>);

/** what `spoolProxy` takes */
export type ProxyOptions = {
	/** the origin to forward to, such as `https://origin.internal`; no path */
	origin: string | URL;
	/**
	 * the options `createSpool` takes, minus `routes`: the worker's route list is fixed when the
	 * spool is created, and the proxy puts its own catch-all route there
	 */
	spool: Omit<SpoolOptions, 'routes'>;
	/** routes that override the default of one public `assembly` route per path; they match first */
	routes?: readonly ProxyRoute[];
	/**
	 * cookie names that carry no identity, such as a bot-check or load-balancer cookie: they do not
	 * make a request ineligible, and setting them does not clear the device; default none
	 */
	publicCookies?: readonly string[];
	/** keep the tag headers on what the browser receives; default false */
	exposeTags?: boolean;
	/** most tags one response may name before it is not kept; default 512 */
	maxTags?: number;
	/** largest page body kept, in bytes; default 2 MiB */
	maxBytes?: number;
	/** patterns blanked before a page is hashed, such as a per-render form token */
	ignore?: readonly RegExp[];
	/** most pages whose last body hash is remembered, the oldest going first; default 10,000 */
	maxRemembered?: number;
	/** the shared secret `POST /.spool/purge` requires; without one every purge is refused */
	purgeSecret?: string;
	/** how requests reach the origin; default global `fetch`. A Workers service binding passes its `fetch` */
	fetch?: (request: Request) => Promise<Response>;
	/**
	 * trimmed stylesheets from `buildTrimManifest`. A same-origin stylesheet in the manifest is
	 * answered with its trimmed text when the origin's bytes still hash to the manifest's `source`,
	 * and every HTML page is checked against the guard first. Without it nothing is trimmed.
	 */
	trim?: TrimManifest;
	/**
	 * Converts JPEG and PNG responses to WebP for a browser that accepts it, at the quality and
	 * width the request's headers call for, up to a width ceiling of 2560 pixels when the request
	 * names none. Identical simultaneous requests share one encoder call, and an encoder that runs
	 * past 10 seconds is abandoned for that request. See `ImageOptions`. Without it no image is
	 * touched.
	 */
	images?: ImageOptions;
	/**
	 * Rewrites `<video>` tags in HTML responses, such as `preload="none"`; see `VideoOptions`.
	 * Without it no page is touched for video.
	 */
	video?: VideoOptions;
	/**
	 * Replaces server-rendered YouTube and Vimeo `<iframe>` embeds with a link that loads the
	 * player on click; see `EmbedOptions`. A page that sends a `Content-Security-Policy` is left
	 * alone. Without it no embed is touched.
	 */
	embeds?: EmbedOptions;
	/**
	 * Serves a stylesheet or script as `dcz` or `dcb` against an earlier public file of the same
	 * directory the visitor already holds (RFC 9842, Chromium 130 and later); see
	 * `DictionaryOptions`. Without it no response is marked or encoded.
	 */
	dictionary?: DictionaryOptions;
};

/** what the proxy counted since it started: trimmed answers, hash mismatches and guard firings */
export type TrimStats = { served: number; mismatched: number; guarded: number };

/** what the proxy counted for `video`: pages with at least one rewritten tag, and the tags */
export type VideoStats = { pages: number; rewritten: number };

/** where the proxy writes a guard firing or a hash mismatch to the sink, as JSON `{ kind, ... }` */
export const TRIM_PATH = '/.spool/trim';

/** the Fetch handler `spoolProxy` returns, with the spool it built */
export type SpoolProxy = {
	(request: Request): Promise<Response>;
	readonly spool: Spool;
	/** live counters; all zero when `trim` is not set */
	readonly trim: Readonly<TrimStats>;
	/** live counters; all zero when `images` is not set */
	readonly images: Readonly<ImageStats>;
	/** live counters; all zero when `video` is not set */
	readonly video: Readonly<VideoStats>;
	/** live counters; all zero when `embeds` is not set */
	readonly embeds: Readonly<EmbedStats>;
	/** live counters; all zero when `dictionary` is not set */
	readonly dictionary: Readonly<DictionaryStats>;
};

type Page = { text: string; tags: string[] };

const isHtml = (response: Response) =>
	(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');

/** one character per byte, so an ASCII edit leaves every other byte as it was */
function fromBytes(bytes: Uint8Array): string {
	let text = '';
	for (let at = 0; at < bytes.length; at += 8192) {
		text += String.fromCharCode(...bytes.subarray(at, at + 8192));
	}
	return text;
}

const toBytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/**
 * A Fetch handler that sits in front of an origin that cannot load the library, such as PHP or a
 * Drupal site with no module, and gives it local page views.
 *
 * `/.spool/*` and `/spool-sw.js` are answered here. Everything else goes to the origin with its
 * method, headers and body, and redirects are passed through. A GET or HEAD without `Authorization`
 * or a cookie outside `publicCookies`, answered 200 as `text/html` with no `Set-Cookie`, `private`
 * or `no-store`, is decorated so the worker can keep it; anything else is forwarded untouched.
 * The tags the origin sends in `Cache-Tag`, `Surrogate-Key`, `X-Drupal-Cache-Tags` or `xkey`
 * become the page's dependencies, and a page with none depends on its own path.
 *
 * With `images` the proxy answers a JPEG or PNG request from a browser that accepts WebP with the
 * converted file, and adds `Accept-CH` to HTML so later image requests carry their width. With
 * `video` it rewrites `<video>` tags in HTML. Both run on the origin's response before the page is
 * kept, so a held page carries the rewritten tags.
 *
 * Limits: the proxy sees finished HTML, so an artifact is the whole page, the replica holds no
 * records, and two pages never share a fragment. A page is invalidated by `POST /.spool/purge`, or
 * when the proxy sees its body change, and it stays on a device until its route's `maxStale` runs
 * out and the next sync reports the change. Freshness is therefore bounded by `maxStale` plus the
 * time a purge takes to arrive. The memory of last-seen bodies lives in the instance: a restart
 * forgets it, and each instance of a scaled-out proxy keeps its own.
 */
export function spoolProxy(options: ProxyOptions): SpoolProxy {
	const base = new URL(options.origin);
	if (base.pathname !== '/' || base.search !== '' || base.hash !== '') {
		throw new ProtocolError('bad-route', `origin ${base.href} must have no path`);
	}
	const gate: Gate = {
		publicCookies: new Set(options.publicCookies ?? []),
		maxTags: options.maxTags ?? 512,
		maxBytes: options.maxBytes ?? 2 * 1024 * 1024
	};
	if (!Number.isInteger(gate.maxTags) || gate.maxTags < 1) {
		throw new ProtocolError('bad-route', 'maxTags must be a positive integer');
	}
	if (!Number.isInteger(gate.maxBytes) || gate.maxBytes < 1) {
		throw new ProtocolError('bad-route', 'maxBytes must be a positive integer');
	}
	const remembered = options.maxRemembered ?? 10_000;
	if (!Number.isInteger(remembered) || remembered < 1) {
		throw new ProtocolError('bad-route', 'maxRemembered must be a positive integer');
	}
	const call = options.fetch ?? ((request: Request) => fetch(request));
	const { store } = options.spool;
	const { trim } = options;
	const stats: TrimStats = { served: 0, mismatched: 0, guarded: 0 };
	const images = options.images ? createImageConverter(options.images) : undefined;
	const video = options.video ? resolveVideoOptions(options.video) : undefined;
	const videoStats: VideoStats = { pages: 0, rewritten: 0 };
	const imageStats: ImageStats = images?.stats ?? {
		converted: 0,
		bytesIn: 0,
		bytesOut: 0,
		cacheHits: 0,
		coalesced: 0,
		lazied: 0,
		responsive: 0,
		skipped: {}
	};
	const dictionaries = options.dictionary
		? createDictionaries(options.dictionary, gate)
		: undefined;
	const embeds = options.embeds ? resolveEmbedOptions(options.embeds) : undefined;
	const embedStats: EmbedStats = { pages: 0, rewritten: 0, skipped: {} };
	const lazy = images?.options.lazy || undefined;
	const responsive = images?.options.responsive || undefined;
	const readsHtml = Boolean(
		trim || video || embeds || lazy || responsive || images?.options.hints
	);

	/** the embed, responsive and lazy rewrites, which do not depend on the visitor; only the live path counts them */
	function rewriteMarkup(
		text: string,
		headers: Headers,
		pageUrl: string,
		count: boolean
	): string {
		let out = text;
		if (embeds) {
			const result = rewriteEmbeds(out, embeds, {
				csp: headers.has('content-security-policy')
			});
			out = result.html;
			if (count) {
				if (result.rewritten > 0) {
					embedStats.pages++;
					embedStats.rewritten += result.rewritten;
				}
				for (const [why, n] of Object.entries(result.skipped)) {
					embedStats.skipped[why] = (embedStats.skipped[why] ?? 0) + n;
				}
			}
		}
		if (responsive && images) {
			const result = rewriteResponsive(out, responsive, {
				pageUrl,
				paths: images.options.paths
			});
			out = result.html;
			if (count) imageStats.responsive += result.rewritten;
		}
		if (lazy) {
			const result = rewriteLazy(out, lazy);
			out = result.html;
			if (count) imageStats.lazied += result.rewritten;
		}
		return out;
	}

	function note(kind: 'guard' | 'mismatch', detail: Record<string, unknown>): void {
		if (!options.spool.sink) return;
		try {
			const written = options.spool.sink.write([
				{
					path: TRIM_PATH,
					body: JSON.stringify({ kind, ...detail }),
					contentType: 'application/json',
					at: Date.now()
				}
			]);
			Promise.resolve(written).catch(() => undefined);
		} catch {
			// a failing sink never breaks a page
		}
	}

	/** the page with its trimmed stylesheets pointed at the full files when the guard fires */
	function guarded(text: string, pageUrl: string): string {
		if (!trim) return text;
		const verdict = guardPage(text, trim, pageUrl);
		if (!verdict.fired) return text;
		stats.guarded++;
		note('guard', {
			page: new URL(pageUrl).pathname,
			reason: verdict.reason,
			files: verdict.files
		});
		return verdict.html;
	}

	function weaken(headers: Headers): void {
		const etag = headers.get('etag');
		if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
	}

	// the page a request resolved to, so `depends` and `load` do not fetch it again
	const pages = new WeakMap<Request, { path: string; page: Promise<Page> }>();
	const seen = new Map<string, { hash: string; tags: string[] }>();

	function originHeaders(source: Headers, publicUrl: URL): Headers {
		const headers = new Headers(source);
		for (const name of HOP_BY_HOP) headers.delete(name);
		for (const name of [...headers.keys()]) if (name.startsWith('spool-')) headers.delete(name);
		headers.set('x-forwarded-host', publicUrl.host);
		headers.set('x-forwarded-proto', publicUrl.protocol.slice(0, -1));
		return headers;
	}

	function forward(request: Request, url: URL, whole: boolean): Request {
		const read = request.method === 'GET' || request.method === 'HEAD';
		const headers = originHeaders(request.headers, url);
		// a conversion needs the whole file, so the origin gets no conditional request
		if (whole) {
			headers.delete('if-none-match');
			headers.delete('if-modified-since');
		}
		const search = images ? originSearch(images, url) : url.search;
		return new Request(new URL(url.pathname + stripTrimParam(search), base), {
			method: request.method,
			headers,
			redirect: 'manual',
			signal: request.signal,
			...(read || !request.body ? {} : { body: request.body, duplex: 'half' })
		} as RequestInit);
	}

	/** the headers the browser gets: bodies arrive decoded, so the encoding and its length go */
	function tidy(source: Headers, url: URL): Headers {
		const headers = new Headers(source);
		if (headers.has('content-encoding')) {
			headers.delete('content-encoding');
			headers.delete('content-length');
		}
		const location = headers.get('location');
		if (location && /^[a-z][a-z0-9+.-]*:/i.test(location)) {
			const target = new URL(location);
			if (target.origin === base.origin) {
				headers.set(
					'location',
					new URL(target.pathname + target.search + target.hash, url).href
				);
			}
		}
		if (!options.exposeTags) stripTags(headers);
		return headers;
	}

	async function digest(text: string): Promise<string> {
		const bytes = new TextEncoder().encode(
			normalise(text, options.ignore ? { ignore: options.ignore } : {})
		);
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		return btoa(String.fromCharCode(...hash));
	}

	/** records a public page's body and bumps its tags when it differs from the last one seen */
	async function settle(path: string, text: string, tags: string[]): Promise<void> {
		const hash = await digest(text);
		const prior = seen.get(path);
		seen.delete(path);
		seen.set(path, { hash, tags });
		if (seen.size > remembered) seen.delete(seen.keys().next().value as string);
		if (prior && prior.hash !== hash) {
			await spool.invalidate([...new Set([...prior.tags, ...tags])]);
		}
	}

	async function fetchPage(ctx: RouteContext, data: boolean, principal: boolean): Promise<Page> {
		const path = ctx.url.pathname;
		const headers = originHeaders(ctx.request.headers, new URL(ctx.request.url));
		for (const name of [
			'range',
			'if-match',
			'if-none-match',
			'if-modified-since',
			'if-unmodified-since',
			'if-range',
			'content-length',
			'content-type'
		]) {
			headers.delete(name);
		}
		headers.set('accept', data ? 'application/json' : 'text/html');
		const response = await call(
			new Request(new URL(path, base), { method: 'GET', headers, redirect: 'manual' })
		);
		const tags = readTags(response.headers);
		const why = decline(
			{
				method: 'GET',
				search: '',
				requestHeaders: ctx.request.headers,
				response,
				tags,
				data,
				principal
			},
			gate
		);
		if (why) throw new ProtocolError('bad-artifact', `${path} is not kept (${why})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!data && !isUtf8(htmlCharset(response.headers, bytes))) {
			throw new ProtocolError('bad-artifact', `${path} is not kept (charset)`);
		}
		let text = guarded(new TextDecoder().decode(bytes), ctx.url.href);
		// a signal-triggered rewrite is never part of a held copy
		if (!data && video?.when === 'always') {
			text = rewriteVideo(text, video, { saveData: false, slow: false }).html;
		}
		if (!data) text = rewriteMarkup(text, response.headers, ctx.url.href, false);
		if (text.length > gate.maxBytes) {
			throw new ProtocolError('bad-artifact', `${path} is not kept (size)`);
		}
		const effective = tags.length > 0 ? tags : [pathTag(path)];
		if (!principal) await settle(path, text, effective);
		return { text, tags: effective };
	}

	function pageFor(ctx: RouteContext, data: boolean, principal: boolean): Promise<Page> {
		const known = pages.get(ctx.request);
		if (known && known.path === ctx.url.pathname) return known.page;
		const page = fetchPage(ctx, data, principal);
		pages.set(ctx.request, { path: ctx.url.pathname, page });
		return page;
	}

	function proxied(pattern: string, declaration?: ProxyRoute): Route {
		const data = declaration?.strategy === 'data';
		const principal = declaration?.scope === 'principal';
		if (principal && !options.spool.identity) {
			throw new ProtocolError(
				'bad-route',
				`${pattern}: a principal route needs spool.identity`
			);
		}
		const extra = declaration?.depends;
		const depends = async (ctx: RouteContext) => [
			...(await pageFor(ctx, data, principal)).tags,
			...(extra ? await extra(ctx) : [])
		];
		if (declaration?.strategy === 'data') {
			return defineRoute(pattern, {
				...declaration,
				strategy: 'data',
				depends,
				load: async (ctx) => {
					const { text } = await pageFor(ctx, true, principal);
					try {
						return JSON.parse(text);
					} catch {
						throw new ProtocolError(
							'bad-artifact',
							`${pattern}: the origin sent no JSON`
						);
					}
				}
			} as DataRoute);
		}
		return defineRoute(pattern, {
			...declaration,
			strategy: 'assembly',
			depends,
			load: async (ctx) => ({ shell: (await pageFor(ctx, false, principal)).text })
		} as AssemblyRoute);
	}

	const routes = [
		...(options.routes ?? []).map((declaration) => proxied(declaration.pattern, declaration)),
		proxied('/**')
	];
	const spool = createSpool({ ...options.spool, routes });

	/** a page the proxy declines tells the worker to drop its copy of that path, in the same response */
	async function unfit(response: Response, path: string, why: Decline, page: boolean) {
		if (!page || why === 'query') return response;
		const headers = new Headers(response.headers);
		writeEnvelope(headers, { invalidate: { [artifactTag(path)]: (await store.cursor()) + 1 } });
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}

	async function purge(tags: string[]): Promise<number> {
		const named = new Set(tags);
		for (const [path, entry] of seen) {
			if (entry.tags.some((tag) => named.has(tag))) seen.delete(path);
		}
		return spool.invalidate(tags);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === PURGE_PATH) return respondPurge(request, options.purgeSecret, purge);
		const answered = await spool.respond(request);
		if (answered) return answered;
		if (url.pathname === PATHS.worker && request.method === 'GET') return spool.stub();

		const converting = images !== undefined && imageRequest(images, request);
		let upstream: Response;
		try {
			upstream = await call(forward(request, url, converting));
		} catch {
			return new Response('bad gateway', {
				status: 502,
				headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' }
			});
		}
		if (images && converting) upstream = await convertImage(images, request, upstream);
		if (request.method === 'GET') {
			const key = trim ? trimKey(url.href) : '';
			const entry = trim?.styles[key];
			if (
				trim &&
				entry &&
				url.searchParams.get(TRIM_PARAM) !== '0' &&
				upstream.status === 200 &&
				(upstream.headers.get('content-type') ?? '').toLowerCase().includes('text/css')
			) {
				const bytes = new Uint8Array(await upstream.arrayBuffer());
				const headers = new Headers(upstream.headers);
				headers.delete('content-length');
				const match = (await sourceHash(bytes)) === entry.source;
				if (match) {
					weaken(headers);
					stats.served++;
				} else {
					stats.mismatched++;
					note('mismatch', { file: key });
				}
				upstream = new Response(match ? entry.css : bytes, {
					status: 200,
					statusText: upstream.statusText,
					headers
				});
			} else if (
				readsHtml &&
				isHtml(upstream) &&
				![204, 205, 304].includes(upstream.status)
			) {
				const bytes = new Uint8Array(await upstream.arrayBuffer());
				// another charset is rewritten byte for byte; the edits insert ASCII only
				const utf8 = isUtf8(htmlCharset(upstream.headers, bytes));
				const text = utf8 ? new TextDecoder().decode(bytes) : fromBytes(bytes);
				let verdict = guarded(text, url.href);
				const headers = new Headers(upstream.headers);
				headers.delete('content-length');
				if (video) {
					const result = rewriteVideo(verdict, video, signalsOf(request.headers));
					if (result.rewritten > 0) {
						verdict = result.html;
						videoStats.pages++;
						videoStats.rewritten += result.rewritten;
						// a page rewritten for one visitor's connection is not another's copy
						if (video.when !== 'always') {
							makePrivate(headers);
							mergeList(headers, 'vary', ['Save-Data', 'ECT']);
						}
					}
				}
				verdict = rewriteMarkup(verdict, upstream.headers, url.href, true);
				if (images?.options.hints) mergeList(headers, 'accept-ch', IMAGE_HINTS);
				if (verdict !== text) weaken(headers);
				const body = verdict === text ? bytes : utf8 ? verdict : toBytes(verdict);
				upstream = new Response(body, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers
				});
			}
		}
		const tags = readTags(upstream.headers);
		const headers = tidy(upstream.headers, url);
		const init = { status: upstream.status, statusText: upstream.statusText, headers };
		// a new cookie may be a login or a logout (the held copies are another visitor's view)
		if (setsPrivateCookie(upstream.headers, gate.publicCookies))
			writeEnvelope(headers, { clear: ['*'] });
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response(upstream.body, init);
		}
		if (dictionaries?.applies(request, upstream)) {
			return dictionaries.apply(request, new Response(upstream.body, init));
		}

		const hit = matchRoute(routes, url.pathname) as { route: Route };
		const data = hit.route.strategy === 'data';
		const principal = hit.route.scope === 'principal';
		const page = upstream.status === 200 && (data || isHtml(upstream));
		const why = decline(
			{
				method: request.method,
				search: url.search,
				requestHeaders: request.headers,
				response: upstream,
				tags,
				data,
				principal
			},
			gate
		);
		if (why) return unfit(new Response(upstream.body, init), url.pathname, why, page);

		const bytes = new Uint8Array(await upstream.arrayBuffer());
		if (!data && !isUtf8(htmlCharset(upstream.headers, bytes))) {
			return unfit(new Response(bytes, init), url.pathname, 'charset', page);
		}
		const text = new TextDecoder().decode(bytes);
		headers.delete('content-length');
		if (text.length > gate.maxBytes) {
			return unfit(new Response(text, init), url.pathname, 'size', page);
		}
		const effective = tags.length > 0 ? tags : [pathTag(url.pathname)];
		if (request.method === 'GET' && !principal) await settle(url.pathname, text, effective);
		pages.set(request, {
			path: url.pathname,
			page: Promise.resolve({ text, tags: effective })
		});
		return spool.decorate(request, new Response(text, init));
	}

	return Object.assign(handle, {
		spool,
		trim: stats,
		images: imageStats,
		video: videoStats,
		embeds: embedStats,
		dictionary: dictionaries?.stats ?? {
			registered: 0,
			encoded: 0,
			bytesIn: 0,
			bytesOut: 0,
			skipped: {}
		}
	});
}
