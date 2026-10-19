import { cdnClientUrl } from '../cdn/location.js';
import { parseArtifact, PROTOCOL_VERSION, type Artifact } from '../protocol/artifact.js';
import type { CatalogueAsk } from '../protocol/beacon.js';
import { checkCollectors, type CollectorConfig } from '../protocol/collector.js';
import {
	clientPath,
	PATHS,
	SPOOL_PREFIX,
	type AssetMode,
	type ProvisionConfig,
	type SwConfig,
	type ThirdPartyConfig
} from '../protocol/config.js';
import { HEADERS, writeEnvelope, type Envelope } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { collectRefs, createCollector } from '../protocol/graph.js';
import { checkPattern } from '../protocol/pattern.js';
import {
	benefit,
	chooseEntries,
	DEFAULT_CATALOGUE_BYTES,
	priorFrom,
	type EntryCandidate
} from '../protocol/provision.js';
import {
	matchRoute,
	serializeRoute,
	type Identity,
	type Route,
	type RouteContext
} from '../protocol/route.js';
import { artifactTag, MAX_HAVE, parseHeld } from '../protocol/sync.js';
import { clientTag, injectClientTag } from '../protocol/tag.js';
import type { Mode } from '../protocol/view.js';
import type { VersionStore } from '../stores/version-store.js';
import { VERSION } from '../version.js';
import { respondBeacon, type Bundle } from './beacon.js';
import { CLIENT_CORE } from './embedded.js';
import { partitionId, type IdentityOptions } from './identity.js';
import type { Sink } from './sink.js';
import { compressedSize, type Sizer } from './size.js';
import { workerResponse, workerScript } from './stub.js';
import { json, respondSync } from './sync.js';
import type { WorkSeries } from './work.js';

/** most changed tags a response carries inline before the worker is left to ask `/.spool/sync` */
export const MAX_PIGGYBACK = 32;

/** most pages one catalogue request makes the server build, whatever its route suggests */
export const MAX_CATALOGUE_BUILD = 32;

/** the strategies whose artifact is data for a template or projection the device already holds */
const ENTRY_STRATEGIES: readonly string[] = ['template', 'projection', 'data'];

/** what `createSpool` takes */
export type SpoolOptions = {
	routes: readonly Route[];
	store: VersionStore;
	identity?: IdentityOptions;
	sink?: Sink;
	/**
	 * serve the page runtime from a CDN with SRI; omitted, it is served from
	 * `/.spool/<version>/client.js`. `url` defaults to this version's `cdn.drupflare.com` build,
	 * whose `integrity` is in the release notes and in `dist/cdn/manifest.json`.
	 */
	cdn?: { url?: string; integrity: string };
	/** same-origin POST paths the worker queues and flushes in one request */
	beacons?: readonly string[];
	/** the mode for routes that do not name one; default `serve`. `shadow` never serves locally */
	mode?: Mode;
	/** the share of views, 0 to 1, that run in shadow while the mode is `serve`; default 0 */
	shadowSample?: number;
	/** whether the worker queues a `spool.view` per page view; default true */
	views?: boolean;
	/** records the time each request took, by route; read it with `work.samples()` */
	work?: WorkSeries;
	/** reads a millisecond clock for `work`; default `performance.now`, which is elapsed time and not CPU */
	meter?: () => number;
	/**
	 * priors the worker uses before its own telemetry exists, and the server uses to leave out an
	 * artifact whose transfer its expected reuse does not repay
	 */
	provision?: ProvisionConfig;
	/** the most compressed bytes of entries one catalogue bundle may carry; default 32 KiB */
	catalogueBytes?: number;
	/** measures an entry's compressed bytes for the catalogue; default Brotli, gzip where the runtime has no Brotli stream */
	catalogueSize?: Sizer;
	/** how the worker treats same-origin subresources; default `cache` */
	assets?: AssetMode;
	/** same-origin paths whose request ends the session; the worker wipes the principal store first */
	logout?: readonly string[];
	/** cross-origin analytics collectors the worker holds and delivers later */
	collectors?: readonly CollectorConfig[];
	/** the opt-in worker cache for versioned cross-origin files */
	thirdParty?: ThirdPartyConfig;
	/**
	 * a bundled worker to serve in place of the embedded one, such as a bundle of `serve(config,
	 * renderers)` from `@drupflare/spool/sw`; it finds the config in `self.__SPOOL_CONFIG__`
	 */
	worker?: string;
};

/** per-call overrides for {@link Spool.decorate} */
export type DecorateOptions = {
	/** the cursor read before the response was built; read now when omitted */
	vector?: number;
	/** `Spool-Clear` tokens to send, such as `['*']` on logout */
	clear?: readonly string[];
	/** also send `Clear-Site-Data: "storage"`, the browser's own wipe of everything the origin holds */
	hardReset?: boolean;
};

/** what `createSpool` returns */
export type Spool = {
	/** answers `/.spool/*` and the worker script, otherwise calls `next` and decorates */
	handle(
		request: Request,
		next: (request: Request) => Response | Promise<Response>
	): Promise<Response>;
	/** a `Response` for `/.spool/*`, `undefined` for anything else */
	respond(request: Request): Promise<Response | undefined>;
	/** adds the envelope headers and the client tag to a response the app produced */
	decorate(request: Request, response: Response, options?: DecorateOptions): Promise<Response>;
	/** bumps the vector after a write; `drop` also removes artifacts by id */
	invalidate(tags: readonly string[], options?: { drop?: readonly string[] }): Promise<number>;
	/**
	 * The `Spool-Partition` value for a principal. A login or account-switch handler sets it on its
	 * own response, since the request it answers still carries the old identity: the worker then
	 * swaps its store before any local view can read the old one.
	 */
	partition(principal: string): Promise<string>;
	/** the `/spool-sw.js` response */
	stub(): Response;
	/** the config embedded in the worker script */
	readonly config: SwConfig;
};

function isHtml(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/** wires routes, a version store and the endpoints into one handler set */
export function createSpool(options: SpoolOptions): Spool {
	const { store, sink } = options;
	const routes = [...options.routes];
	const seen = new Set<string>();
	for (const route of routes) {
		if (seen.has(route.pattern)) {
			throw new ProtocolError('bad-route', `${route.pattern}: declared twice`);
		}
		seen.add(route.pattern);
	}
	const mode: Mode = options.mode ?? 'serve';
	if (mode !== 'serve' && mode !== 'shadow') {
		throw new ProtocolError('bad-route', `unknown mode "${String(mode)}"`);
	}
	const shadowSample = options.shadowSample ?? 0;
	if (!(shadowSample >= 0 && shadowSample <= 1)) {
		throw new ProtocolError('bad-route', 'shadowSample must be between 0 and 1');
	}
	const { work } = options;
	const meter = options.meter ?? (() => performance.now());
	const beacons = [...(options.beacons ?? [])];
	for (const path of beacons) {
		if (!path.startsWith('/') || path.startsWith(SPOOL_PREFIX)) {
			throw new ProtocolError(
				'bad-route',
				`beacon path ${path} must be outside ${SPOOL_PREFIX}`
			);
		}
	}

	const logout = [...(options.logout ?? [])];
	for (const path of logout) {
		checkPattern(path);
		if (path.startsWith(SPOOL_PREFIX)) {
			throw new ProtocolError(
				'bad-route',
				`logout path ${path} must be outside ${SPOOL_PREFIX}`
			);
		}
	}
	const collectors = [...(options.collectors ?? [])];
	checkCollectors(collectors);
	const prior = priorFrom(options.provision);
	const catalogueBytes = options.catalogueBytes ?? DEFAULT_CATALOGUE_BYTES;
	if (!(Number.isFinite(catalogueBytes) && catalogueBytes >= 0)) {
		throw new ProtocolError('bad-route', 'catalogueBytes must be a non-negative number');
	}
	const measure = options.catalogueSize ?? compressedSize;

	const config: SwConfig = {
		protocol: PROTOCOL_VERSION,
		version: VERSION,
		routes: routes.map(serializeRoute),
		templates: Object.fromEntries(
			routes.flatMap((r) => (r.template ? [[r.pattern, r.template] as const] : []))
		),
		beacons,
		mode,
		shadowSample,
		clientTag: clientTag(
			options.cdn
				? {
						src: options.cdn.url ?? cdnClientUrl(VERSION),
						integrity: options.cdn.integrity
					}
				: { src: clientPath(VERSION) }
		)
	};
	if (options.provision) config.provision = options.provision;
	if (options.assets) config.assets = options.assets;
	if (logout.length > 0) config.logout = logout;
	if (collectors.length > 0) config.collectors = collectors;
	if (options.thirdParty) config.thirdParty = options.thirdParty;
	if (options.views === false) config.views = false;
	let script: string | undefined;
	const stub = () => workerResponse((script ??= workerScript(config, options.worker)));

	const who = async (request: Request): Promise<Identity | null> =>
		options.identity ? await options.identity.resolve(request) : null;

	const context = (
		request: Request,
		url: URL,
		params: Record<string, string>,
		identity: Identity | null,
		collector = createCollector()
	): RouteContext => ({
		request,
		url,
		params,
		identity,
		record: collector.record,
		projection: collector.projection
	});

	/** drops the records and projections the worker already holds at a version no change has passed */
	async function trim(artifact: Artifact, have: Record<string, number>): Promise<Artifact> {
		const held = Object.values(have);
		if (held.length === 0) return artifact;
		const diff = await store.diff(Math.min(...held));
		if (diff.reset) return artifact;
		const moved = (tags: readonly string[], version: number) =>
			tags.some((tag) => (diff.changed[tag] ?? 0) > version);
		const holds = (id: string, tags: readonly string[]) =>
			Object.hasOwn(have, id) && !moved(tags, have[id] as number);
		const out = { ...artifact };
		if (artifact.records) {
			out.records = artifact.records.filter((r) => !holds(r.id, [r.id]));
		}
		if (artifact.projections) {
			out.projections = artifact.projections.filter((p) => !holds(p.id, p.deps));
		}
		return out;
	}

	type Built =
		{ artifact: Artifact; partition?: string } | { response: Response } | { declined: true };

	async function buildArtifact(
		request: Request,
		url: URL,
		path: string,
		have: Record<string, number> = {},
		weighed = false
	): Promise<Built> {
		if (!path.startsWith('/'))
			throw new ProtocolError('bad-artifact', 'path must start with "/"');
		const hit = matchRoute(routes, path);
		if (!hit) return { response: json({ error: 'no route' }, 404) };
		if (hit.route.strategy === 'static') {
			return { response: json({ error: 'a static route is not provisioned' }, 404) };
		}
		const identity = await who(request);
		if (hit.route.scope === 'principal' && !identity) {
			return { response: json({ error: 'sign in' }, 401) };
		}

		const vector = await store.cursor();
		const collector = createCollector();
		const ctx = context(request, new URL(path, url), hit.params, identity, collector);
		const dependsOn = [...(await hit.route.depends(ctx))];
		const loaded = await hit.route.load(ctx);
		const body = hit.route.strategy === 'assembly' ? loaded : { data: loaded };
		const collected = collector.collect(vector);
		const stored = new Set([...collected.records.map((r) => r.id)]);
		const known = new Set(collected.projections.map((p) => p.id));
		const refs = collectRefs(body);
		for (const id of refs.records) {
			if (!stored.has(id)) {
				throw new ProtocolError(
					'bad-artifact',
					`${path} references record ${id} it did not register`
				);
			}
		}
		for (const id of refs.projections) {
			if (!known.has(id)) {
				throw new ProtocolError(
					'bad-artifact',
					`${path} references projection ${id} it did not register`
				);
			}
		}
		const artifact = parseArtifact({
			protocol: PROTOCOL_VERSION,
			id: path,
			scope: hit.route.scope,
			strategy: hit.route.strategy,
			deps: [...new Set([...dependsOn, ...collected.deps])],
			vector,
			body,
			...(collected.records.length > 0 ? { records: collected.records } : {}),
			...(collected.projections.length > 0 ? { projections: collected.projections } : {})
		});
		const trimmed = await trim(artifact, have);
		if (weighed && hit.route.scope === 'public') {
			const bytes = new TextEncoder().encode(JSON.stringify(trimmed)).length;
			const mine = { ...prior, ...hit.route.provision };
			const data = hit.route.strategy === 'data';
			const worth = benefit(
				{
					id: path,
					kind: 'route',
					provision: { bytes, requests: 1 },
					avoided: { bytes: data ? bytes : prior.avoidedBytes, requests: 1 }
				},
				mine
			);
			if (worth <= 0) return { declined: true };
		}
		const out: Built = { artifact: trimmed };
		if (identity && hit.route.scope === 'principal') {
			out.partition = await partitionId(
				(options.identity as IdentityOptions).secret,
				identity.principal
			);
		}
		return out;
	}

	async function respondArtifact(request: Request, url: URL): Promise<Response> {
		const path = url.searchParams.get('path') ?? '';
		const raw = url.searchParams.get('have');
		const built = await buildArtifact(
			request,
			url,
			path,
			raw === null ? {} : parseHeld(raw, MAX_HAVE),
			true
		);
		if ('response' in built) return built.response;
		if ('declined' in built) {
			return new Response(null, {
				status: 204,
				headers: { 'cache-control': 'no-store', [HEADERS.provision]: 'declined' }
			});
		}
		const headers: Record<string, string> = { [HEADERS.protocol]: String(PROTOCOL_VERSION) };
		if (built.artifact.scope === 'principal') {
			headers['cache-control'] = 'private, no-store';
			if (built.partition) headers[HEADERS.partition] = built.partition;
		}
		return json(built.artifact, 200, headers);
	}

	/** the public artifacts a beacon flush asked for, for the paths this server can build */
	const provide = (request: Request) => async (paths: readonly string[]) => {
		const out: Artifact[] = [];
		for (const path of paths) {
			let built: Built;
			try {
				built = await buildArtifact(
					new Request(request.url, { headers: { accept: 'application/json' } }),
					new URL(request.url),
					path,
					{},
					true
				);
			} catch {
				continue;
			}
			if ('artifact' in built && built.artifact.scope === 'public') out.push(built.artifact);
		}
		return out;
	};

	/**
	 * The entries to send a device on `ask.path`: the data of pages that route's `catalogue` suggests,
	 * kept when the share expected to open one reaches its break-even and the bundle stays under
	 * `catalogueBytes`. A failure sends nothing, so it never turns a flush into an error.
	 */
	const catalogue =
		(request: Request) =>
		async (ask: CatalogueAsk): Promise<Bundle> => {
			const none: Bundle = { artifacts: [] };
			try {
				const here = matchRoute(routes, ask.path);
				if (!here?.route.catalogue) return none;
				const headers = new Headers(request.headers);
				headers.delete('content-type');
				headers.delete('content-length');
				headers.set('accept', 'application/json');
				const probe = new Request(request.url, { headers });
				const identity = await who(probe);
				if (here.route.scope === 'principal' && !identity) return none;
				const url = new URL(request.url);
				const ctx = context(probe, new URL(ask.path, url), here.params, identity);
				const guesses = [...(await here.route.catalogue(ctx))]
					.filter(
						(g) =>
							typeof g.path === 'string' &&
							g.path.startsWith('/') &&
							!g.path.startsWith(SPOOL_PREFIX) &&
							!/[?#]/.test(g.path) &&
							g.path !== ask.path &&
							typeof g.p === 'number' &&
							g.p > 0 &&
							g.p <= 1
					)
					.sort((a, b) => b.p - a.p);
				const built = new Map<string, { artifact: Artifact; partition?: string }>();
				const pool: EntryCandidate[] = [];
				let attempts = 0;
				for (const guess of guesses) {
					if (attempts >= MAX_CATALOGUE_BUILD) break;
					if (built.has(guess.path)) continue;
					const target = matchRoute(routes, guess.path);
					if (!target || !ENTRY_STRATEGIES.includes(target.route.strategy)) continue;
					if (target.route.scope === 'principal' && !ask.sweep) continue;
					attempts += 1;
					let result: Built;
					try {
						result = await buildArtifact(probe, url, guess.path);
					} catch {
						continue;
					}
					if (!('artifact' in result)) continue;
					// ponytail: records two entries share are sized and sent once per entry, dedupe if bundles repeat them
					const entryBytes = await measure(
						new TextEncoder().encode(JSON.stringify(result.artifact))
					);
					const documentBytes =
						target.route.documentBytes ??
						(target.route.strategy === 'data' ? entryBytes : prior.avoidedBytes);
					built.set(guess.path, result);
					pool.push({ path: guess.path, p: guess.p, entryBytes, documentBytes });
				}
				const chosen = chooseEntries(pool, { capBytes: catalogueBytes });
				const entries = chosen.flatMap((c) => built.get(c.path) ?? []);
				const partition = entries.find((e) => e.partition !== undefined)?.partition;
				return {
					artifacts: entries.map((e) => e.artifact),
					...(partition !== undefined ? { partition } : {})
				};
			} catch {
				return none;
			}
		};

	async function respond(request: Request): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith(SPOOL_PREFIX)) return undefined;
		const began = work ? meter() : 0;
		try {
			return await answer(request, url);
		} finally {
			if (work) {
				const known = Object.values(PATHS).includes(url.pathname as never);
				work.record(known ? url.pathname : '/.spool/*', meter() - began);
			}
		}
	}

	async function answer(request: Request, url: URL): Promise<Response> {
		try {
			const get = request.method === 'GET' || request.method === 'HEAD';
			if (url.pathname === PATHS.sync && get) {
				const identity = await who(request);
				const partition =
					identity && options.identity
						? await partitionId(options.identity.secret, identity.principal)
						: undefined;
				return await respondSync(url, store, partition);
			}
			if (url.pathname === PATHS.artifact && get) return await respondArtifact(request, url);
			if (url.pathname === PATHS.beacon) {
				return await respondBeacon(request, sink, provide(request), catalogue(request));
			}
			if (url.pathname === clientPath(VERSION) && get) {
				return new Response(CLIENT_CORE, {
					headers: {
						'content-type': 'text/javascript; charset=utf-8',
						'cache-control': 'public, max-age=31536000, immutable'
					}
				});
			}
			return json({ error: 'not found' }, 404);
		} catch (error) {
			if (error instanceof ProtocolError) return json({ error: error.message }, 400);
			return json({ error: 'internal error' }, 500);
		}
	}

	async function decorate(
		request: Request,
		response: Response,
		decorateOptions: DecorateOptions = {}
	): Promise<Response> {
		if (response.status === 101) return response;
		const url = new URL(request.url);
		const headers = new Headers(response.headers);
		const envelope: Envelope = {};
		const read = request.method === 'GET' || request.method === 'HEAD';
		const before = decorateOptions.vector ?? (await store.cursor());
		envelope.vector = before;

		const seenHeader = request.headers.get(HEADERS.vectorSeen);
		if (read && seenHeader !== null) {
			headers.append('vary', HEADERS.vectorSeen);
			const from = /^\d{1,15}$/.test(seenHeader) ? Number(seenHeader) : -1;
			delete envelope.vector;
			if (from >= 0) {
				const diff = await store.diff(from);
				const count = Object.keys(diff.changed).length;
				if (diff.reset) {
					envelope.clear = ['*'];
					envelope.vector = diff.cursor;
					envelope.seen = from;
				} else if (count <= MAX_PIGGYBACK) {
					envelope.invalidate = diff.changed;
					envelope.vector = diff.cursor;
					envelope.seen = from;
				}
			}
		} else if (!read) {
			const diff = await store.diff(before);
			const count = Object.keys(diff.changed).length;
			if (diff.reset || count > MAX_PIGGYBACK) envelope.clear = ['*'];
			else if (count > 0) envelope.invalidate = diff.changed;
			envelope.vector = diff.cursor;
		}
		if (decorateOptions.clear) envelope.clear = [...decorateOptions.clear];

		const identity = options.identity ? await who(request) : null;
		if (identity && options.identity && !headers.has(HEADERS.partition)) {
			envelope.partition = await partitionId(options.identity.secret, identity.principal);
		}

		const hit = read && response.status === 200 ? matchRoute(routes, url.pathname) : null;
		if (hit) {
			headers.set('x-spool-route', hit.route.pattern);
			headers.set('x-spool-mode', hit.route.mode ?? mode);
		}
		const kept =
			hit?.route.strategy === 'static' || hit?.route.strategy === 'data' || isHtml(response);
		if (hit && kept && (hit.route.scope === 'public' || identity)) {
			const ctx = context(request, url, hit.params, identity);
			envelope.artifact = {
				id: url.pathname,
				scope: hit.route.scope,
				deps: [...(await hit.route.depends(ctx))],
				version: before
			};
		}
		writeEnvelope(headers, envelope);
		if (decorateOptions.hardReset) headers.set('clear-site-data', '"storage"');

		const tag =
			request.method === 'GET' &&
			response.status === 200 &&
			isHtml(response) &&
			!response.headers.has('content-encoding');
		if (!tag) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
		const html = await response.text();
		const tagged = injectClientTag(html, config.clientTag);
		if (tagged !== html) {
			headers.delete('content-length');
			const etag = headers.get('etag');
			if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
		}
		return new Response(tagged, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}

	return {
		config,
		stub,
		partition: async (principal) => {
			if (!options.identity) {
				throw new ProtocolError('bad-route', 'partition needs an identity option');
			}
			return partitionId(options.identity.secret, principal);
		},
		respond,
		decorate,
		async handle(request, next) {
			const early = await respond(request);
			if (early) return early;
			const url = new URL(request.url);
			if (url.pathname === PATHS.worker && request.method === 'GET') return stub();
			const began = work ? meter() : 0;
			const vector = await store.cursor();
			const response = await decorate(request, await next(request), { vector });
			if (work) {
				const hit = matchRoute(routes, url.pathname);
				work.record(hit ? hit.route.pattern : 'other', meter() - began);
			}
			return response;
		},
		invalidate: (tags, invalidateOptions = {}) =>
			store.bump([...tags, ...(invalidateOptions.drop ?? []).map(artifactTag)])
	};
}
