import type { PROTOCOL_VERSION } from './artifact.js';
import type { CollectorConfig } from './collector.js';
import type { SerializedRoute } from './route.js';
import type { CompiledTemplate } from './template/compile.js';
import type { Mode } from './view.js';

/** every path under this prefix belongs to spool */
export const SPOOL_PREFIX = '/.spool/';

/** where the server answers sync, artifact and beacon requests, and where the worker script lives */
export const PATHS = {
	sync: '/.spool/sync',
	artifact: '/.spool/artifact',
	beacon: '/.spool/beacon',
	worker: '/spool-sw.js'
} as const;

/** the same-origin path of the page runtime script for a given version */
export function clientPath(version: string): string {
	return `${SPOOL_PREFIX}${encodeURIComponent(version)}/client.js`;
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

/** what the server compiles into the worker script: routes, templates and the tag to inject */
export type SwConfig = {
	protocol: typeof PROTOCOL_VERSION;
	version: string;
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
};
