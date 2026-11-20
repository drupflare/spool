import { cdnClientUrl, cdnWorkerUrl } from '../cdn/location.js';
import { parseArtifact, PROTOCOL_VERSION, type Artifact } from '../protocol/artifact.js';
import type { CatalogueAsk } from '../protocol/beacon.js';
import { BLOCK_ROWS, MAX_BUNDLE_FRAME_BYTES } from '../protocol/bundle.js';
import { checkCollectors, type CollectorConfig } from '../protocol/collector.js';
import {
	bootPath,
	BUNDLE_DELTA_PREFIX,
	BUNDLE_PREFIX,
	clientPath,
	LIVE_PATH,
	navigatePath,
	PATHS,
	SPOOL_PREFIX,
	type AssetMode,
	type ProvisionConfig,
	type SwConfig,
	type ThirdPartyConfig
} from '../protocol/config.js';
import type { Dataset, DatasetRow } from '../protocol/dataset.js';
import { HEADERS, writeEnvelope, type Envelope } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { collectRefs, createCollector, resolveRefs, splitRowId } from '../protocol/graph.js';
import { shellHash } from '../protocol/hash.js';
import { escapeInline, inlineElement, placeInline } from '../protocol/inline.js';
import { checkPattern } from '../protocol/pattern.js';
import {
	benefit,
	chooseEntries,
	DEFAULT_CATALOGUE_BYTES,
	priorFrom,
	type EntryCandidate
} from '../protocol/provision.js';
import { keyField, verifyProof } from '../protocol/query.js';
import {
	DELTA_ELEMENT_ID,
	RING_ELEMENT_ID,
	WRITES_ELEMENT_ID,
	type BootstrapGate,
	type WorkerMode
} from '../protocol/ring.js';
import {
	matchRoute,
	serializeRoute,
	type Identity,
	type Route,
	type RouteContext
} from '../protocol/route.js';
import { artifactTag, MAX_HAVE, parseHeld } from '../protocol/sync.js';
import { clientTag, gateTag, injectClientTag } from '../protocol/tag.js';
import type { Mode } from '../protocol/view.js';
import { serializeWrite, writeFor, type Resource, type Write } from '../protocol/write.js';
import { recordDecline, responseDecline } from '../proxy/eligible.js';
import type { VersionStore } from '../stores/version-store.js';
import { POLICY_HEADERS, policyHeaders, type HeaderSet } from '../sw/policy.js';
import { VERSION } from '../version.js';
import { respondBeacon, type Bundle } from './beacon.js';
import { buildBundle, respondBoot, respondBundle, type BundleStore } from './bundle.js';
import { respondDataset, viewOf, type DatasetStats } from './dataset.js';
import { CLIENT_CORE, GATE_CORE, NAVIGATE_CORE, SW_CORE } from './embedded.js';
import { partitionId, type IdentityOptions } from './identity.js';
import {
	frameText,
	LIVE_HEADERS,
	liveSettings,
	openingFrames,
	parseLiveQuery,
	publishing,
	type LiveOptions
} from './live.js';
import {
	bootShape,
	buildRing,
	deltaElement,
	gatePaths,
	heldVersion,
	placeRing,
	RING_BYTES,
	ringElement,
	ringPacks,
	writesElement
} from './ring.js';
import type { Sink } from './sink.js';
import { compressedSize, type Sizer } from './size.js';
import {
	staticHeaders,
	type PublishStaticOptions,
	type PublishStaticResult,
	type StaticPolicySource,
	type StaticSink
} from './static.js';
import {
	checkCore,
	packReader,
	respondDelta,
	STUB_DELTAS,
	workerEtag,
	workerImport,
	workerReply,
	workerResponse,
	workerScript
} from './stub.js';
import { json, respondSync } from './sync.js';
import type { WorkSeries } from './work.js';
import { createResourceWrites, createWriteServer, DELTA_HEADER_BYTES } from './write.js';

/** most changed tags a response carries inline before the worker is left to ask `/.spool/sync` */
export const MAX_PIGGYBACK = 32;

/** most pages one catalogue request makes the server build, whatever its route suggests */
export const MAX_CATALOGUE_BUILD = 32;

/** the lease of the worker script in the browser's cache, in seconds: one day */
const STUB_MAX_AGE = 86_400;

/** the strategies whose artifact is data for a template or projection the device already holds */
const ENTRY_STRATEGIES: readonly string[] = ['template', 'projection', 'data'];

/** what `createSpool` takes */
export type SpoolOptions = {
	routes: readonly Route[];
	/**
	 * Resources from `defineResource`: their item families join `routes`, and their writes are sent to
	 * the server and answered with the rows they changed as `Spool-Delta`. Needs `bundles` for the
	 * device to keep its pack current; the writes themselves work without it.
	 */
	resources?: readonly Resource[];
	store: VersionStore;
	/** public datasets `/.spool/dataset` answers, each by its own name */
	datasets?: readonly Dataset[];
	/**
	 * Lets `datasets` hold principal ones, whose rows differ per signed-in principal and which the
	 * device keeps sealed in that principal's partition. Off by default: a principal dataset then
	 * throws `bad-dataset`. Needs `identity`. Unreviewed.
	 */
	principalDatasets?: boolean;
	/**
	 * Declared last-value writes for principal routes, from `defineWrite`. Off unless `enabled` is
	 * true: the worker then queues nothing and `/.spool/write` answers `writes-off`. Needs `identity`.
	 * Unreviewed.
	 */
	writes?: { enabled?: boolean; classes: readonly Write[]; remember?: number };
	identity?: IdentityOptions;
	sink?: Sink;
	/**
	 * serve the page runtime from a CDN with SRI; omitted, it is served from
	 * `/.spool/<version>/client.js`. `url` defaults to this version's `cdn.drupflare.com` build,
	 * whose `integrity` is in the release notes and in `dist/cdn/manifest.json`.
	 *
	 * `worker` also moves the worker core to the CDN: the stub becomes the config and one
	 * `importScripts` line, a few KB in place of the core, and the core is fetched from
	 * `worker.url`, or from this version's `cdn.drupflare.com` build when `worker` is `true`. A
	 * browser has no integrity check for an imported script, so the site trusts the CDN host with a
	 * script that can answer every request of the origin. Off by default. A site with a custom
	 * `worker` bundle must give `worker.url`. `publishStatic` checks the served bytes with
	 * `verifyCore`.
	 */
	cdn?: { url?: string; integrity: string; worker?: boolean | { url: string } };
	/** same-origin POST paths the worker queues and flushes in one request */
	beacons?: readonly string[];
	/** the mode for routes that do not name one; default `serve`. `shadow` never serves locally */
	mode?: Mode;
	/** the share of views, 0 to 1, that run in shadow while the mode is `serve`; default 0 */
	shadowSample?: number;
	/**
	 * whether the worker queues a `spool.view` per page view; default true with a `sink`, false
	 * without one
	 */
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
	/**
	 * How cautious the catalogue is about a share it estimated: a guess with `n` observations is
	 * judged on the lower confidence bound of its `p` at this many standard deviations (1.28 is
	 * one-sided 90%). A guess with no `n` keeps its `p`. Default 0, which judges every guess on `p`.
	 */
	catalogueConfidence?: number;
	/** measures an entry's compressed bytes for the catalogue; default Brotli, gzip where the runtime has no Brotli stream */
	catalogueSize?: Sizer;
	/**
	 * The most bytes of escaped artifact JSON a public `template` page carries in the page itself,
	 * so the worker stores it from the navigation and asks no `/.spool/artifact`. Every network view
	 * of such a page pays for the bytes and one more `load`, whether or not the visitor has a
	 * worker; a larger artifact is left out. Default 0, which is off; 2048 is the limit measured.
	 */
	inlineMaxBytes?: number;
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
	/** where `buildBundle` keeps packs; `GET /.spool/bundle/<version>` answers 404 without it */
	bundles?: BundleStore;
	/**
	 * `maxAge`, in seconds, is the lease of `/spool-sw.js` in the browser's cache; default one day.
	 * A check inside it costs nothing, and after it one request brings the version and its changes.
	 * A floor applies on top of the lease: Chromium checked the stub on the first document navigation
	 * after each 24 hours whatever `maxAge` was (measured in Chromium only, with the wall clock shifted),
	 * so a lease longer than a day does not cut the checks. A stub that changed at that check installs,
	 * which is the contact.
	 */
	freshness?: { maxAge?: number };
	/**
	 * A counter the stub carries, a non-negative integer or a function that returns one, read on each stub
	 * request. The stub's bytes change when it does, so advance it at each publish or each lease period.
	 * Absent, the stub's bytes are the same as before the option existed.
	 */
	stamp?: number | (() => number);
	/**
	 * Options for the packs `publish` builds. `ringBytes` is the budget of the ring on each
	 * family page, default 24,576 and not measured. `blockRows` is rows per block, default 128.
	 * `maxBytes` is the most compressed bytes of one block, at most the reader's frame cap.
	 */
	bundle?: { ringBytes?: number; blockRows?: number; maxBytes?: number };
	/**
	 * Security headers a pack or delta response names for a device that holds no site policy. Names
	 * are limited to the policy list. Default: the headers of the last HTML page this server answered.
	 * `{}` names no headers. With neither, `publishStatic` writes a stub with no policy field.
	 */
	policy?: Record<string, string>;
	/**
	 * When the device fetches the pack: `second-view` on the second view, the default, or `first-view`.
	 * The ring in the first document is the same either way.
	 */
	bootstrap?: BootstrapGate;
	/**
	 * How a second-view page loads the runtime. `inline` (default) puts a small gate in place of the
	 * script tag. The gate waits for the first click or GET form submit that the held pages answer,
	 * then loads one script that carries the runtime and the pack, in place of the document that
	 * click would have fetched, so a visitor never makes more requests than the site without
	 * spool. A page with no ring, or whose ring names no boot script (`cdn` is set), loads the
	 * runtime from the second view. `script` keeps the tag, for a page whose CSP forbids inline
	 * scripts. A first-view site always uses the tag.
	 */
	clientTag?: 'inline' | 'script';
	/**
	 * `never` keeps every read in the page: the ring names no worker and the page registers none.
	 * `auto` (default) registers the worker, except on WebKit for a page that carries a ring: WebKit
	 * checks the worker script on each navigation (WebKit bug 332455), so those pages keep every
	 * read in the page. `always` registers the worker on WebKit too.
	 */
	workerMode?: WorkerMode;
	/**
	 * The stream a visible page holds open at `/.spool/live`, for the principal lease and its
	 * revocation and, with `public`, for pushed tag changes. A page with a principal partition and a
	 * stream sends no renewal while it reads, and a revoked session reaches it in milliseconds. `false`
	 * is off; `true` and an object are on; absent, it is on when `identity` is set on a host that is one
	 * process (Node, Bun, Deno) and off on Workers, where the stream needs a hub every isolate can
	 * reach: pass `durableObjectHub` from `@drupflare/spool/stores/durable-object`. A page without
	 * the stream renews at its route's bound as before. The default is off for public freshness.
	 * By default the policy is adaptive: the first lease renewal of a visible session is an ordinary
	 * request and the second becomes the stream, so a visitor who loads documents never opens one.
	 * `'always'` (or `{ mode: 'always' }`) opens at login and whenever a tab becomes visible, for an
	 * app that stays open.
	 */
	live?: boolean | 'always' | LiveOptions;
};

/** per-call overrides for {@link Spool.decorate} */
export type DecorateOptions = {
	/** the cursor read before the response was built; read now when omitted */
	vector?: number;
	/** `Spool-Clear` tokens to send, such as `['*']` on logout */
	clear?: readonly string[];
	/** also send `Clear-Site-Data: "storage"`, the browser's own wipe of everything the origin holds */
	hardReset?: boolean;
	/**
	 * the shell text of this route's `assembly` artifact, as the body carries it before the client
	 * tag goes in. `Spool-Artifact` then names its hash, and the worker keeps the page it already
	 * received in place of asking `/.spool/artifact`. Ignored unless the route is a public
	 * `assembly` route and the body is tagged HTML.
	 */
	assembled?: string;
	/** set when the caller has judged the response, so `decorate` skips the public-route gate */
	judged?: boolean;
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
	/**
	 * adds the envelope headers and the client tag to a response the app produced. A public route's
	 * response that sets a cookie, is `private` or `no-store`, or varies by anything but encoding and
	 * cookies is returned unchanged.
	 */
	decorate(request: Request, response: Response, options?: DecorateOptions): Promise<Response>;
	/** bumps the vector after a write; `drop` also removes artifacts by id */
	invalidate(tags: readonly string[], options?: { drop?: readonly string[] }): Promise<number>;
	/**
	 * Builds the pack at the store cursor and keeps it in `bundles`.
	 * Returns `{ version, bytes }`. A version already holding other
	 * bytes is refused, so call `invalidate` after a data change.
	 * `url` is what the seed functions receive.
	 */
	publish(url: URL): Promise<{ version: number; bytes: number }>;
	/**
	 * Writes the static tier to `sink`: the page runtime, the stub, the packs held for the store cursor and
	 * the deltas to it, and a `_headers` file. A host that serves these files answers them with no Worker
	 * invocation. Packs and runtime are immutable, so a sink that reports them with `has` keeps the ones
	 * already there. Build the packs with `publish` first. Each pack also gets its boot script, unless `cdn` is set.
	 * The stub names the site policy in this order: `options.policy`, the `policy` option of
	 * `createSpool`, the headers of the last HTML page answered, `options.fallbackPolicy`. With none of
	 * them the stub carries no `policy` field, and a device renders locally after one network view that
	 * teaches it the headers; `policy: 'none'` in the result says so. `{}` names a known-empty policy.
	 * `options.url` builds the pack at the cursor first. Returns the store cursor, the paths written
	 * and the policy source.
	 */
	publishStatic(sink: StaticSink, options?: PublishStaticOptions): Promise<PublishStaticResult>;
	/**
	 * The `Spool-Partition` value for a principal. A login or account-switch handler sets it on its
	 * own response, since the request it answers still carries the old identity: the worker then
	 * swaps its store before any local view can read the old one.
	 */
	partition(principal: string): Promise<string>;
	/**
	 * Ends the live streams of a principal's partition: each gets `revoked` and closes, and the page
	 * wipes the partition. Call it where the app ends a session on the server (a ban, a logout on
	 * another device, a sweep of expired sessions). It does nothing while `live` is off.
	 */
	revoke(principal: string): Promise<void>;
	/**
	 * The `/spool-sw.js` response. Pass the request to get an `ETag` and a `304` for a matching
	 * `If-None-Match`, so a re-check of an unchanged script after the lease costs a few hundred bytes.
	 * With no request the response has no validator, as before.
	 */
	stub(): Response;
	stub(request: Request): Promise<Response>;
	/** the config embedded in the worker script */
	readonly config: SwConfig;
};

function isHtml(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

const ELIDED = new Set(['', '...', '…']);

/**
 * Why a template route's source cannot be a real page, or null. Two shapes only, because nothing
 * else can be known without the page: a source with no text or only an ellipsis, and a source with
 * no field, loop or condition under a pattern that has parameters (one constant page for every
 * value of the parameter). A constant page that really is the same for every value belongs on an
 * `assembly` or `static` route.
 */
function placeholderOf(route: Route): string | null {
	const nodes = route.template?.nodes;
	if (route.strategy !== 'template' || nodes === undefined) return null;
	const text = nodes.every((node) => node.t === 'text')
		? nodes.map((node) => (node.t === 'text' ? node.v : '')).join('')
		: null;
	if (text !== null && ELIDED.has(text.trim())) return 'it has no content';
	if (text !== null && route.pattern.includes(':')) {
		return 'it prints no field, so every value of the route parameter would show the same page';
	}
	return null;
}

/** wires routes, a version store and the endpoints into one handler set */
export function createSpool(options: SpoolOptions): Spool {
	const { sink } = options;
	const stream = liveSettings(options);
	const store = stream ? publishing(options.store, stream.hub) : options.store;
	const routes = [
		...options.routes,
		...(options.resources ?? []).flatMap((resource) => resource.routes)
	];
	const seen = new Set<string>();
	for (const route of routes) {
		if (seen.has(route.pattern)) {
			throw new ProtocolError('bad-route', `${route.pattern}: declared twice`);
		}
		seen.add(route.pattern);
		const placeholder = placeholderOf(route);
		if (placeholder) {
			throw new ProtocolError(
				'bad-template',
				`${route.pattern}: the template is a placeholder, ${placeholder}`
			);
		}
	}
	const datasets = new Map<string, Dataset>();
	const families = new Set(
		routes.flatMap((route) => (route.family ? [route.family.dataset] : []))
	);
	const principalOn = options.principalDatasets === true;
	for (const dataset of options.datasets ?? []) {
		if (datasets.has(dataset.name)) {
			throw new ProtocolError('bad-dataset', `${dataset.name}: declared twice`);
		}
		if (dataset.scope === 'principal') {
			if (!principalOn) {
				throw new ProtocolError(
					'bad-dataset',
					`${dataset.name}: a principal dataset needs the principal datasets flag: set the principalDatasets option of createSpool`
				);
			}
			if (!options.identity) {
				throw new ProtocolError(
					'bad-dataset',
					`${dataset.name}: a principal dataset needs an identity option`
				);
			}
		}
		datasets.set(dataset.name, dataset);
	}
	for (const route of routes) {
		const family = route.family && datasets.get(route.family.dataset);
		if (family) {
			if (family.scope !== route.scope) {
				throw new ProtocolError(
					'bad-route',
					`${route.pattern}: a ${route.scope} route cannot read the ${family.scope} dataset "${family.name}"`
				);
			}
		}
		const name = route.query?.dataset;
		if (name !== undefined) {
			const dataset = datasets.get(name);
			if (!dataset) {
				throw new ProtocolError(
					'bad-route',
					`${route.pattern}: query.dataset "${name}" is not declared`
				);
			}
			if (dataset.scope !== route.scope) {
				throw new ProtocolError(
					'bad-route',
					`${route.pattern}: a ${route.scope} route cannot query the ${dataset.scope} dataset "${name}"`
				);
			}
		}
		for (const join of route.query?.plan?.join ?? []) {
			if (!datasets.has(join.dataset)) {
				throw new ProtocolError(
					'bad-route',
					`${route.pattern}: query.plan join dataset "${join.dataset}" is not declared`
				);
			}
			if (datasets.get(join.dataset)?.scope !== route.scope) {
				throw new ProtocolError(
					'bad-route',
					`${route.pattern}: query.plan join dataset "${join.dataset}" must be ${route.scope}`
				);
			}
		}
	}
	const resourceWrites = (options.resources ?? []).flatMap((resource) => resource.writes);
	for (const write of resourceWrites) {
		if (datasets.get(write.dataset)?.scope !== 'public') {
			throw new ProtocolError(
				'bad-write',
				`${write.pattern}: dataset "${write.dataset}" must be a declared public dataset`
			);
		}
	}
	const writes = [...(options.writes?.classes ?? [])];
	const writeNames = new Set<string>();
	for (const write of writes) {
		if (writeNames.has(write.name)) {
			throw new ProtocolError('bad-write', `${write.name}: declared twice`);
		}
		writeNames.add(write.name);
		const target = routes.find((route) => route.pattern === write.path);
		if (!target || target.scope !== 'principal') {
			throw new ProtocolError(
				'bad-write',
				`${write.name}: path ${write.path} must be a declared principal route`
			);
		}
	}
	if (writes.length > 0 && !options.identity) {
		throw new ProtocolError('bad-write', 'writes need an identity option');
	}
	const writesOn = options.writes?.enabled === true && writes.length > 0;
	const writeServer = createWriteServer({
		enabled: writesOn,
		writes,
		...(options.writes?.remember !== undefined ? { remember: options.writes.remember } : {})
	});
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
	const datasetStats = new Map<string, DatasetStats>();
	const catalogueBytes = options.catalogueBytes ?? DEFAULT_CATALOGUE_BYTES;
	if (!(Number.isFinite(catalogueBytes) && catalogueBytes >= 0)) {
		throw new ProtocolError('bad-route', 'catalogueBytes must be a non-negative number');
	}
	const catalogueConfidence = options.catalogueConfidence ?? 0;
	if (!(Number.isFinite(catalogueConfidence) && catalogueConfidence >= 0)) {
		throw new ProtocolError('bad-route', 'catalogueConfidence must be a non-negative number');
	}
	const measure = options.catalogueSize ?? compressedSize;
	const inlineMax = options.inlineMaxBytes ?? 0;
	if (!(Number.isFinite(inlineMax) && inlineMax >= 0)) {
		throw new ProtocolError('bad-route', 'inlineMaxBytes must be a non-negative number');
	}
	const policyNames: readonly string[] = POLICY_HEADERS;
	const policySet = (policy: Record<string, string> | undefined): HeaderSet | undefined => {
		for (const [name, value] of Object.entries(policy ?? {})) {
			if (!policyNames.includes(name)) {
				throw new ProtocolError(
					'bad-route',
					`policy names "${name}", which is not a policy header`
				);
			}
			if (typeof value !== 'string')
				throw new ProtocolError('bad-route', `policy ${name} is not a string`);
		}
		return (
			policy && Object.entries(policy).map(([name, value]): [string, string] => [name, value])
		);
	};
	const policyOption = policySet(options.policy);
	let lastPolicy: HeaderSet | undefined;
	const ringBytes = options.bundle?.ringBytes ?? RING_BYTES;
	if (!(Number.isSafeInteger(ringBytes) && ringBytes >= 0)) {
		throw new ProtocolError('bad-route', 'bundle.ringBytes must be a non-negative integer');
	}
	const blockRows = options.bundle?.blockRows ?? BLOCK_ROWS;
	if (!(Number.isSafeInteger(blockRows) && blockRows >= 1)) {
		throw new ProtocolError('bad-route', 'bundle.blockRows must be a positive integer');
	}
	const maxBytes = options.bundle?.maxBytes ?? MAX_BUNDLE_FRAME_BYTES;
	if (!(Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= MAX_BUNDLE_FRAME_BYTES)) {
		throw new ProtocolError(
			'bad-route',
			`bundle.maxBytes must be 1 to ${MAX_BUNDLE_FRAME_BYTES}`
		);
	}
	const bootstrap: BootstrapGate = options.bootstrap ?? 'second-view';
	if (bootstrap !== 'first-view' && bootstrap !== 'second-view') {
		throw new ProtocolError('bad-route', `unknown bootstrap "${String(bootstrap)}"`);
	}
	const workerMode: WorkerMode = options.workerMode ?? 'auto';
	if (workerMode !== 'auto' && workerMode !== 'never' && workerMode !== 'always') {
		throw new ProtocolError('bad-route', `unknown workerMode "${String(workerMode)}"`);
	}

	const clientMode = options.clientTag ?? 'inline';
	if (clientMode !== 'inline' && clientMode !== 'script') {
		throw new ProtocolError('bad-route', `unknown clientTag "${String(clientMode)}"`);
	}
	const tagOptions = options.cdn
		? {
				src: options.cdn.url ?? cdnClientUrl(VERSION),
				integrity: options.cdn.integrity,
				worker: workerMode
			}
		: { src: clientPath(VERSION), worker: workerMode };
	const gated = bootstrap === 'second-view' && clientMode === 'inline';
	// the boot script holds the runtime itself, so a site that serves it from a CDN keeps its own tag
	const bootOn = gated && !options.cdn && options.bundles !== undefined;
	const bootPrefix = bootPath(VERSION, 0).slice(0, -'0.js'.length);
	const bootCode = `${NAVIGATE_CORE}\n${CLIENT_CORE}`;
	// the routes and templates ride in the boot script, once; the ring names it by their id
	let shaped: ReturnType<typeof bootShape> | undefined;
	const shapeOf = () => (shaped ??= bootShape(routes));
	const maxAge = options.freshness?.maxAge ?? STUB_MAX_AGE;
	if (!(Number.isSafeInteger(maxAge) && maxAge >= 0)) {
		throw new ProtocolError('bad-route', 'freshness.maxAge must be a non-negative integer');
	}
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
		clientTag: gated
			? gateTag(
					{ ...tagOptions, held: bootOn ? gatePaths(routes) : undefined, lease: maxAge },
					GATE_CORE
				)
			: clientTag(tagOptions)
	};
	if (options.provision) config.provision = options.provision;
	if (options.assets) config.assets = options.assets;
	if (logout.length > 0) config.logout = logout;
	if (collectors.length > 0) config.collectors = collectors;
	if (options.thirdParty) config.thirdParty = options.thirdParty;
	if (writesOn) config.writes = writes.map(serializeWrite);
	if (resourceWrites.length > 0) config.resourceWrites = resourceWrites;
	const principalSets = [...datasets.values()].flatMap((d) =>
		d.scope === 'principal' ? [{ name: d.name, maxStaleMs: d.maxStaleMs as number }] : []
	);
	if (principalOn && principalSets.length > 0) config.principalDatasets = principalSets;
	if (!(options.views ?? sink !== undefined)) config.views = false;
	if (stream) {
		config.live = {
			public: stream.public,
			mode: stream.mode,
			...(stream.hub.sockets ? { socket: true as const } : {})
		};
	}
	config.lease = maxAge;
	const packs = options.bundles ? packReader(options.bundles) : undefined;
	const ringPack = options.bundles ? ringPacks(options.bundles) : undefined;
	const writeThrough = options.bundles
		? createResourceWrites({
				datasets,
				store,
				bundles: options.bundles,
				routes,
				blockRows,
				maxBytes
			})
		: undefined;
	const core = options.worker ?? SW_CORE;
	const runtime = shellHash(core);
	const workerCdn = options.cdn?.worker || undefined;
	const workerUrl = typeof workerCdn === 'object' ? workerCdn.url : undefined;
	if (workerUrl !== undefined && !/^https?:\/\//i.test(workerUrl)) {
		throw new ProtocolError(
			'bad-route',
			'cdn.worker.url must be an absolute http or https URL'
		);
	}
	if (workerCdn === true && options.worker !== undefined) {
		throw new ProtocolError('bad-route', 'a custom worker needs cdn.worker.url');
	}
	// what follows the config line: the core itself, or the one line that imports it
	const body = async () =>
		workerCdn ? workerImport(workerUrl ?? cdnWorkerUrl(VERSION, await runtime)) : core;
	// the script carries the pack of the store cursor; one text is kept for the cursor it was built at
	let built: { key: string; text: Promise<string>; etag?: Promise<string> } | undefined;
	const stampOf = (): number | undefined => {
		const stamp = typeof options.stamp === 'function' ? options.stamp() : options.stamp;
		if (stamp !== undefined && !(Number.isSafeInteger(stamp) && stamp >= 0)) {
			throw new ProtocolError('bad-route', 'stamp must be a non-negative integer');
		}
		return stamp;
	};
	stampOf();
	const scriptBuilt = async (given?: HeaderSet): Promise<NonNullable<typeof built>> => {
		const cursor = await store.cursor();
		// undefined is unknown: no option and no page seen yet, so the stub names no policy
		const policy = given ?? policyOption ?? lastPolicy;
		const stamp = stampOf();
		const key = `${cursor}\n${JSON.stringify(policy ?? null)}\n${stamp ?? ''}`;
		if (built?.key !== key) {
			const text = (async () => {
				const pack = await packs?.stub(cursor);
				return workerScript(
					{
						...config,
						runtime: await runtime,
						...(pack ? { pack } : {}),
						...(policy ? { policy } : {}),
						...(stamp !== undefined ? { stamp } : {})
					},
					await body()
				);
			})();
			built = { key, text };
		}
		return built;
	};
	const scriptText = async (given?: HeaderSet): Promise<string> =>
		(await scriptBuilt(given)).text;
	// the hash is made on first use, so a text that fails to build rejects only the caller that asked
	const scriptWithEtag = async () => {
		const current = await scriptBuilt();
		const text = await current.text;
		return { text, etag: await (current.etag ??= workerEtag(text)) };
	};
	function stub(): Response;
	function stub(request: Request): Promise<Response>;
	function stub(request?: Request): Response | Promise<Response> {
		return request
			? workerReply(request, scriptWithEtag, maxAge)
			: workerResponse(scriptText, maxAge);
	}

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
		projection: collector.projection,
		row: collector.row
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
		| { artifact: Artifact; partition?: string }
		| { response: Response }
		| { declined: 'benefit' | 'budget' };

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
		if (hit.route.origin !== undefined) {
			return { response: json({ error: 'a cross-origin route is not provisioned' }, 404) };
		}
		const identity = await who(request);
		if (hit.route.scope === 'principal' && !identity) {
			return { response: json({ error: 'sign in' }, 401) };
		}

		const vector = await store.cursor();
		const collector = createCollector();
		const ctx = context(request, new URL(path, url), hit.params, identity, collector);
		const dependsOn = [...(await hit.route.depends(ctx))];
		const family = hit.route.family;
		const dataset =
			family && hit.route.scope === 'principal' ? datasets.get(family.dataset) : undefined;
		let loaded: unknown = await hit.route.load(ctx);
		if (family?.key === 'viewer.id' && identity && dataset) {
			const [row] = await dataset.read([identity.principal], {
				request,
				url: ctx.url,
				principal: identity
			});
			loaded = row !== undefined && dataset.key(row) === identity.principal ? row : undefined;
		}
		const view = identity && dataset ? viewOf(dataset, identity, true) : undefined;
		if (view && loaded !== undefined) loaded = view(loaded as DatasetRow);
		if (hit.route.family && loaded === undefined) {
			return { response: json({ error: 'no row for family' }, 404) };
		}
		// a data family answers with the row's JSON, so its artifact holds the row alone
		const framed = hit.route.family !== undefined && hit.route.strategy !== 'data';
		const body =
			hit.route.strategy === 'assembly'
				? loaded
				: { data: framed ? { params: hit.params, row: loaded } : loaded };
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
		for (const id of refs.rows ?? []) {
			const at = splitRowId(id);
			if (!at || datasets.get(at.dataset)?.scope !== hit.route.scope) {
				throw new ProtocolError(
					'bad-artifact',
					`${path} references row ${id} of no dataset here`
				);
			}
		}
		if (hit.route.query && hit.route.query.dataset === undefined) {
			// the worker checks the proof after it resolves refs, so the server checks the same text
			const recordsById = new Map(collected.records.map((r) => [r.id, r]));
			const projectionsById = new Map(collected.projections.map((p) => [p.id, p]));
			const lookup = {
				record: (id: string) => recordsById.get(id),
				projection: (id: string) => projectionsById.get(id)
			};
			const resolved = resolveRefs(loaded, lookup);
			if (
				!resolved.ok ||
				!(await verifyProof(hit.route.query, resolved.value, keyField(hit.route.query)))
			) {
				throw new ProtocolError(
					'bad-artifact',
					`${path}: a query route's load needs an array at "${hit.route.query.list}" and a matching proof over its resolved rows`
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
		if (weighed) {
			const bytes = new TextEncoder().encode(JSON.stringify(trimmed)).length;
			// a query.dataset route's rows are bounded by the dataset's maxBytes at its seed
			const budget =
				hit.route.query?.dataset === undefined ? hit.route.provision?.maxBytes : undefined;
			if (budget !== undefined && bytes > budget) return { declined: 'budget' };
			if (hit.route.scope === 'public') {
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
				if (worth <= 0) return { declined: 'benefit' };
			}
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

	/** the escaped artifact JSON of a public page, or null when it is over the limit or fails to build */
	async function inlineText(url: URL): Promise<string | null> {
		try {
			const probe = new Request(url.href, { headers: { accept: 'application/json' } });
			const built = await buildArtifact(probe, url, url.pathname, {}, true);
			if (!('artifact' in built) || built.artifact.scope !== 'public') return null;
			const text = escapeInline(JSON.stringify(built.artifact));
			return new TextEncoder().encode(text).length <= inlineMax ? text : null;
		} catch {
			return null;
		}
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
				headers: {
					'cache-control': 'no-store',
					[HEADERS.provision]: 'declined',
					[HEADERS.provisionReason]: built.declined
				}
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
					pool.push({
						path: guess.path,
						p: guess.p,
						...(typeof guess.n === 'number' && guess.n > 0 && Number.isFinite(guess.n)
							? { weight: guess.n }
							: {}),
						entryBytes,
						documentBytes
					});
				}
				const chosen = chooseEntries(pool, {
					capBytes: catalogueBytes,
					z: catalogueConfidence
				});
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

	/**
	 * The stream. A page that holds a partition the request's session does not own gets `revoked`
	 * and nothing else; a stream with no partition is a public one and exists only where the site
	 * opted in. The delta in the stream is the tag diff `/.spool/sync` already gives anyone.
	 */
	async function respondLive(request: Request, url: URL): Promise<Response> {
		if (!stream || request.method !== 'GET') return json({ error: 'not found' }, 404);
		const { have, partition } = parseLiveQuery(url);
		const identity = await who(request);
		const secret = options.identity?.secret;
		const owner = async () =>
			identity && secret !== undefined ? await partitionId(secret, identity.principal) : null;
		if (partition !== null && (await owner()) !== partition) {
			const gone = frameText({ event: 'revoked', data: {} });
			return new Response(gone, { headers: LIVE_HEADERS });
		}
		if (partition === null && !stream.public) return new Response(null, { status: 204 });
		return await stream.hub.open({
			partition,
			first: await openingFrames(store, have),
			leaseMs: stream.leaseMs,
			keepaliveMs: stream.keepaliveMs,
			maxAgeMs: stream.maxAgeMs,
			signal: request.signal,
			...(request.headers.get('upgrade')?.toLowerCase() === 'websocket'
				? { socket: true }
				: {}),
			...(partition === null
				? {}
				: {
						valid: async () => {
							const again = await who(request);
							return (
								again !== null &&
								secret !== undefined &&
								(await partitionId(secret, again.principal)) === partition
							);
						}
					})
		});
	}

	async function answer(request: Request, url: URL): Promise<Response> {
		try {
			const get = request.method === 'GET' || request.method === 'HEAD';
			if (url.pathname === LIVE_PATH) return await respondLive(request, url);
			if (url.pathname === PATHS.sync && get) {
				const identity = await who(request);
				const partition =
					identity && options.identity
						? await partitionId(options.identity.secret, identity.principal)
						: undefined;
				return await respondSync(url, store, partition);
			}
			if (url.pathname === PATHS.artifact && get) return await respondArtifact(request, url);
			if (url.pathname.startsWith(BUNDLE_DELTA_PREFIX) && get) {
				return await respondDelta(packs, url.pathname.slice(BUNDLE_DELTA_PREFIX.length));
			}
			if (url.pathname.startsWith(BUNDLE_PREFIX) && get) {
				return await respondBundle(
					options.bundles,
					url.pathname.slice(BUNDLE_PREFIX.length)
				);
			}
			if (url.pathname === PATHS.dataset && get) {
				return await respondDataset(
					request,
					url,
					datasets,
					{ prior, stats: datasetStats },
					async () => {
						const identity = await who(request);
						if (!identity || !options.identity) return null;
						return {
							identity,
							partition: await partitionId(
								options.identity.secret,
								identity.principal
							)
						};
					},
					families
				);
			}
			if (url.pathname === PATHS.write) {
				return await writeServer.respond(request, writesOn ? await who(request) : null);
			}
			if (url.pathname === PATHS.beacon) {
				return await respondBeacon(request, sink, provide(request), catalogue(request));
			}
			if (
				get &&
				bootOn &&
				url.pathname.startsWith(bootPrefix) &&
				url.pathname.endsWith('.js')
			) {
				return await respondBoot(
					options.bundles,
					url.pathname.slice(bootPrefix.length, -'.js'.length),
					bootCode,
					await shapeOf()
				);
			}
			if (
				get &&
				(url.pathname === clientPath(VERSION) || url.pathname === navigatePath(VERSION))
			) {
				const script = url.pathname === clientPath(VERSION) ? CLIENT_CORE : NAVIGATE_CORE;
				return new Response(script, {
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

	/** the ring element for a family page at `version`, or undefined when no pack or row is held */
	async function ringFor(url: URL, version: number): Promise<string | undefined> {
		const pack = await ringPack?.(version);
		if (!pack) return undefined;
		const ring = buildRing({
			path: url.pathname,
			version,
			digest: pack.digest,
			routes,
			tables: pack.tables,
			packBytes: pack.bytes,
			ringBytes,
			bootstrap,
			worker: workerMode,
			boot: bootOn ? `${bootPath(VERSION, version)}?r=${(await shapeOf()).id}` : undefined,
			slim: bootOn,
			writes: resourceWrites,
			lease: maxAge
		});
		return ring && ringElement(ring);
	}

	/** the delta a page that holds an older version needs, or undefined; a pointer when it is past the header threshold */
	async function heldElement(request: Request, version: number): Promise<string | undefined> {
		const held = heldVersion(request.headers.get('cookie'));
		if (held === undefined || held >= version || !packs) return undefined;
		const delta = await packs.delta(held, version);
		if (!delta) return undefined;
		const text = JSON.stringify(delta);
		const fits = new TextEncoder().encode(text).length <= DELTA_HEADER_BYTES;
		return deltaElement(held, version, fits ? text : undefined);
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
		const haveHeader = request.headers.get(HEADERS.have);
		if (haveHeader !== null && !headers.has(HEADERS.delta)) {
			headers.append('vary', HEADERS.have);
			const have = /^\d{1,15}$/.test(haveHeader) ? Number(haveHeader) : -1;
			const delta = have >= 0 && have < before ? await packs?.delta(have, before) : undefined;
			const text = delta && JSON.stringify(delta);
			if (text && new TextEncoder().encode(text).length <= DELTA_HEADER_BYTES) {
				headers.set(HEADERS.delta, text);
			}
		}
		if (decorateOptions.clear) envelope.clear = [...decorateOptions.clear];

		const identity = options.identity ? await who(request) : null;
		if (identity && options.identity && !headers.has(HEADERS.partition)) {
			envelope.partition = await partitionId(options.identity.secret, identity.principal);
		}

		const hit = read && response.status === 200 ? matchRoute(routes, url.pathname) : null;
		const declined =
			!decorateOptions.judged && hit?.route.scope === 'public'
				? responseDecline(response.headers, new Set(), false)
				: null;
		if (hit && declined) {
			await recordDecline(sink, declined, hit.route.pattern, 'gate');
			return response;
		}
		if (hit) {
			headers.set('x-spool-route', hit.route.pattern);
			headers.set('x-spool-mode', hit.route.mode ?? mode);
		}
		const kept =
			hit?.route.strategy === 'static' || hit?.route.strategy === 'data' || isHtml(response);
		const tag =
			request.method === 'GET' &&
			response.status === 200 &&
			isHtml(response) &&
			!response.headers.has('content-encoding');
		const html = tag ? await response.text() : null;
		if (tag) lastPolicy = policyHeaders(response.headers);
		let inline: string | null = null;
		if (
			hit &&
			kept &&
			hit.route.provisionable !== false &&
			(hit.route.scope === 'public' || identity)
		) {
			const ctx = context(request, url, hit.params, identity);
			envelope.artifact = {
				id: url.pathname,
				scope: hit.route.scope,
				deps: [...(await hit.route.depends(ctx))],
				version: before
			};
			const { assembled } = decorateOptions;
			if (tag && hit.route.scope === 'public') {
				if (hit.route.strategy === 'assembly' && assembled !== undefined) {
					envelope.artifact.hash = await shellHash(assembled);
				} else if (hit.route.strategy === 'template' && inlineMax > 0) {
					inline = await inlineText(url);
					if (inline !== null) envelope.artifact.hash = await shellHash(inline);
				}
			}
		}
		writeEnvelope(headers, envelope);
		if (decorateOptions.hardReset) headers.set('clear-site-data', '"storage"');

		if (html === null) {
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
		let tagged = injectClientTag(html, config.clientTag);
		if (inline !== null) tagged = placeInline(tagged, inlineElement(inline));
		// a gate page names the boot script on every public page, since a visitor may start on any
		const ringed = bootOn
			? hit === null || hit.route.scope === 'public'
			: hit?.route.family !== undefined && hit.route.scope === 'public';
		if (tag && ringed) {
			const element = await ringFor(url, before);
			if (element !== undefined && !tagged.includes(`id="${RING_ELEMENT_ID}"`)) {
				tagged = placeRing(tagged, element);
			}
		}
		if (
			tag &&
			resourceWrites.length > 0 &&
			(hit === null || hit.route.scope === 'public') &&
			!tagged.includes(`id="${RING_ELEMENT_ID}"`) &&
			!tagged.includes(`id="${WRITES_ELEMENT_ID}"`)
		) {
			tagged = placeRing(tagged, writesElement(resourceWrites));
		}
		// the held cookie comes from a page with no worker: any in never mode, a WebKit one in auto mode
		const cookie = request.headers.get('cookie');
		if (
			tag &&
			cookie !== null &&
			(workerMode === 'never' || (workerMode === 'auto' && heldVersion(cookie) !== undefined))
		) {
			headers.append('vary', 'cookie');
			const element = await heldElement(request, before);
			if (element !== undefined && !tagged.includes(`id="${DELTA_ELEMENT_ID}"`)) {
				tagged = placeRing(tagged, element);
			}
		}
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

	async function publish(url: URL): Promise<{ version: number; bytes: number }> {
		const bundles = options.bundles;
		if (!bundles) throw new ProtocolError('bad-bundle', 'publish needs the bundles option');
		const version = await store.cursor();
		const built = await buildBundle({
			store: bundles,
			datasets: [...datasets.values()],
			routes,
			version,
			url,
			blockRows,
			maxBytes
		});
		return { version, bytes: built.bytes.byteLength };
	}

	/** the runtime, the stub, the packs held for the cursor and the deltas to it, and the headers */
	async function publishStatic(
		sink: StaticSink,
		given: PublishStaticOptions = {}
	): Promise<PublishStaticResult> {
		const call = policySet(given.policy);
		const fallback = policySet(given.fallbackPolicy);
		const chosen = call ?? policyOption ?? lastPolicy ?? fallback;
		const policy: StaticPolicySource = call
			? 'call'
			: policyOption
				? 'option'
				: lastPolicy
					? 'page'
					: fallback
						? 'fallback'
						: 'none';
		if (given.verifyCore) {
			if (!workerCdn) throw new ProtocolError('bad-route', 'verifyCore needs cdn.worker');
			const fetcher = given.verifyCore === true ? fetch : given.verifyCore;
			await checkCore(
				workerUrl ?? cdnWorkerUrl(VERSION, await runtime),
				await runtime,
				fetcher
			);
		}
		if (given.url && options.bundles) await publish(given.url);
		const version = await store.cursor();
		const paths: string[] = [];
		const put = async (
			path: string,
			bytes: Uint8Array,
			contentType: string,
			immutable: boolean
		) => {
			if (immutable && (await sink.has?.(path))) return;
			await sink.put(path, bytes, contentType);
			paths.push(path);
		};
		const js = 'text/javascript; charset=utf-8';
		await put(clientPath(VERSION), new TextEncoder().encode(CLIENT_CORE), js, true);
		await put(navigatePath(VERSION), new TextEncoder().encode(NAVIGATE_CORE), js, true);
		await put(PATHS.worker, new TextEncoder().encode(await scriptText(chosen)), js, false);
		if (options.bundles && packs) {
			const bundles = options.bundles;
			for (let back = 0; back <= STUB_DELTAS; back++) {
				const from = version - back;
				const bytes = from >= 0 ? await bundles.get(from) : undefined;
				if (bytes === undefined) continue;
				await put(`${BUNDLE_PREFIX}${from}`, bytes, 'application/octet-stream', true);
				if (bootOn) {
					const boot = await respondBoot(
						bundles,
						String(from),
						bootCode,
						await shapeOf()
					);
					// the current pack's boot script is rewritten: a deploy can change the routes and templates it carries
					await put(
						bootPath(VERSION, from),
						new Uint8Array(await boot.arrayBuffer()),
						js,
						from < version
					);
				}
				const delta = from < version ? await packs.delta(from, version) : undefined;
				if (delta) {
					const text = new TextEncoder().encode(JSON.stringify(delta));
					await put(
						`${BUNDLE_DELTA_PREFIX}${from}/${version}`,
						text,
						'application/json',
						true
					);
				}
			}
		}
		const headers = new TextEncoder().encode(staticHeaders(maxAge));
		await put('/_headers', headers, 'text/plain; charset=utf-8', false);
		return { version, paths, policy };
	}

	return {
		config,
		stub,
		publishStatic,
		partition: async (principal) => {
			if (!options.identity) {
				throw new ProtocolError('bad-route', 'partition needs an identity option');
			}
			return partitionId(options.identity.secret, principal);
		},
		async revoke(principal) {
			if (!stream || !options.identity) return;
			await stream.hub.revoke(await partitionId(options.identity.secret, principal));
		},
		respond,
		decorate,
		publish,
		async handle(request, next) {
			const early = await respond(request);
			if (early) return early;
			const url = new URL(request.url);
			if (url.pathname === PATHS.worker && request.method === 'GET') {
				return workerMode === 'never' ? json({ error: 'no worker' }, 404) : stub(request);
			}
			const began = work ? meter() : 0;
			const vector = await store.cursor();
			const declared = writeFor(resourceWrites, request.method, url, url.origin);
			const answer =
				declared && writeThrough ? await writeThrough(request, next) : await next(request);
			const response = await decorate(request, answer, { vector });
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
