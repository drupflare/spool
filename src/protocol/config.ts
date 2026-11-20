import type { PROTOCOL_VERSION } from './artifact.js';
import type { BundleDelta } from './bundle.js';
import type { CollectorConfig } from './collector.js';
import type { SerializedRoute } from './route.js';
import type { CompiledTemplate } from './template/compile.js';
import type { Mode } from './view.js';
import type { ResourceWrite, WriteConfig } from './write.js';

/** every path under this prefix belongs to spool */
export const SPOOL_PREFIX = '/.spool/';

/** the prefix of the site packs, one path per version: `/.spool/bundle/<version>` */
export const BUNDLE_PREFIX = '/.spool/bundle/';

/** the prefix of the deltas between two packs: `/.spool/bundle/delta/<from>/<to>` */
export const BUNDLE_DELTA_PREFIX = '/.spool/bundle/delta/';

/** where the server answers sync, artifact, dataset and beacon requests, and where the worker script lives */
export const PATHS = {
	sync: '/.spool/sync',
	artifact: '/.spool/artifact',
	dataset: '/.spool/dataset',
	beacon: '/.spool/beacon',
	write: '/.spool/write',
	worker: '/spool-sw.js'
} as const;

/**
 * where a visible page holds one server-sent event stream open: the principal lease, a `revoked`
 * event, and public tag changes where the site opts in. The request takes `partition` (the principal
 * partition the page holds) and `have` (the cursor the page holds); the worker never handles it.
 */
export const LIVE_PATH = '/.spool/live';

/**
 * the text a page sends over a live socket to renew its lease. The server answers it with a `lease`
 * event, which a hibernating Durable Object can do without waking.
 */
export const LIVE_PING = 'ping';

/** the cookie a no-worker page writes with the version it holds; the server reads it, nothing else does */
export const COOKIES = { held: 'spool-held' } as const;

/** the same-origin path of the page runtime script for a given version */
export function clientPath(version: string): string {
	return `${SPOOL_PREFIX}${encodeURIComponent(version)}/client.js`;
}

/** the same-origin path of the in-page navigation script, loaded once the page holds a head */
export function navigatePath(version: string): string {
	return `${SPOOL_PREFIX}${encodeURIComponent(version)}/navigate.js`;
}

/**
 * the same-origin path of the boot script for a runtime version and a pack version: the page
 * runtime, the navigation script and that pack in one file
 */
export function bootPath(version: string, pack: number): string {
	return `${SPOOL_PREFIX}${encodeURIComponent(version)}/boot/${pack}.js`;
}

/**
 * Priors and the hot list for provisioning. Every number is a scenario assumption the operator
 * replaces with its own telemetry; `hot` names paths to warm in priority order, riding the next
 * beacon flush.
 */
export type ProvisionConfig = {
	reuse?: number;
	futureViews?: number;
	requestBytes?: number;
	artifactBytes?: number;
	avoidedBytes?: number;
	/** rate of change per dependency tag, per day, before the worker has seen any */
	changesPerDay?: number;
	hot?: string[];
};

/**
 * How the worker treats same-origin subresources. `cache` answers an immutable one from
 * CacheStorage; `passthrough` leaves it to the browser's own cache with no worker involvement;
 * `static-routing` asks the browser (`InstallEvent.addRoutes`) to send only navigations, beacons
 * and routed paths to the worker and everything else to the network, and acts as `passthrough` where
 * the API does not exist.
 */
export type AssetMode = 'cache' | 'passthrough' | 'static-routing';

/**
 * The opt-in worker cache for cross-origin files. Only an origin in `allow` is touched, and only a
 * response the worker can read (a CORS answer) for a URL that looks versioned, or one the origin
 * marks immutable, is kept. Everything else goes to the network untouched.
 */
export type ThirdPartyConfig = {
	/** origins whose GET requests the worker may answer from its copy, such as `https://fonts.gstatic.com` */
	allow: string[];
	/** extra patterns, as regular expression sources, that mark a URL as versioned */
	versioned?: string[];
	/** a copy of an unversioned file is checked again at a network moment once it is this old; default one day */
	revalidateAfterMs?: number;
	/** most files held; the oldest go first; default 64 */
	maxEntries?: number;
	/** keep opaque (no-cors) responses, which Chromium counts as about 7 MB each against quota; default false */
	allowOpaque?: boolean;
};

/**
 * The pack a worker script carries: the current version and set digest, and the deltas from the
 * versions just before it, each straight to the current one.
 */
export type StubPack = { version: number; digest: string; deltas: BundleDelta[] };

/** what the server compiles into the worker script: routes, templates and the tag to inject */
export type SwConfig = {
	protocol: typeof PROTOCOL_VERSION;
	version: string;
	/** the hash of the worker's own code; a different one empties the replica, a content version does not */
	runtime?: string;
	/** the pack the script carries, when the server holds one for its current version */
	pack?: StubPack;
	/** the site's security headers, as name and value pairs, for a worker that holds no site policy yet */
	policy?: Array<[string, string]>;
	routes: SerializedRoute[];
	/** compiled templates keyed by route pattern */
	templates: Record<string, CompiledTemplate>;
	/** same-origin POST paths the worker queues and flushes in one request */
	beacons: string[];
	/** the exact script tag the server injects, so a local render matches a network one */
	clientTag: string;
	/** the mode for routes that do not name one; `serve` when absent */
	mode?: Mode;
	/** the share of views, 0 to 1, that run in shadow while the mode is `serve`; 0 when absent */
	shadowSample?: number;
	/** whether the worker queues a `spool.view` per page view; true when absent */
	views?: boolean;
	/** seconds the browser may hold the worker script: the lease after which the page checks it again */
	lease?: number;
	/**
	 * The operator's counter for the stub. Its bytes change when the stamp does, so a static host that
	 * republishes each lease period makes a forced check install a new script, and the install is a contact.
	 */
	stamp?: number;
	/** what the worker assumes before telemetry says otherwise, and which pages to warm */
	provision?: ProvisionConfig;
	/**
	 * The URL of a `spool.json`. Present, the worker has no spool server: it takes its routes from
	 * that file, checks it for changes in place of `/.spool/sync`, and sends no request to `/.spool/*`.
	 */
	manifest?: string;
	/** how same-origin subresources are handled; `cache` when absent */
	assets?: AssetMode;
	/** same-origin paths whose request ends the session: the worker wipes the principal store first */
	logout?: string[];
	/** cross-origin analytics collectors the worker holds and delivers later */
	collectors?: CollectorConfig[];
	/** the opt-in cache for versioned cross-origin files */
	thirdParty?: ThirdPartyConfig;
	/**
	 * The share, above 0 and at most 1, of the storage headroom one dataset may use. The worker
	 * refuses a seed whose rows would use more; 1 when absent.
	 */
	datasetShare?: number;
	/** the declared write classes; absent while declared writes are off, which is the default */
	writes?: WriteConfig[];
	/** the resource writes a request is sent to the server for, each applied from its `Spool-Delta` */
	resourceWrites?: readonly ResourceWrite[];
	/** the principal datasets and how long each may answer after its last confirmed sync; absent while the flag is off */
	principalDatasets?: Array<{ name: string; maxStaleMs: number }>;
	/**
	 * Present while the server answers `/.spool/live`. `public` is true when the stream also carries
	 * public freshness, so the worker treats its public replica as current while a lease is open.
	 * `mode` is `always` when the page opens the stream whenever it is visible, and `adaptive` when the
	 * worker asks for it at the second lease renewal of a page's visible session. `socket` is true
	 * when the hub also accepts a WebSocket upgrade at the same path; a page then opens a socket
	 * and falls back to server-sent events if the upgrade fails.
	 */
	live?: { public: boolean; mode: 'adaptive' | 'always'; socket?: true };
};
