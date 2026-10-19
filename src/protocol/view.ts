import type { Scope } from './artifact.js';
import type { BeaconEvent } from './beacon.js';
import type { Strategy } from './route.js';

/** `serve` answers views locally; `shadow` decides and compares but lets the network answer */
export type Mode = 'serve' | 'shadow';

/** how a view was answered; `shadow` means the network answered and the reason is what local would have done */
export type ViewTier = 'local' | 'local-revalidate' | 'network' | 'fallback' | 'shadow';

/**
 * Why a view went the way it did, from the worker's first check to its last: nothing stored
 * (`cold`), a route the worker never serves (`principal`), within the bound (`fresh`), past a
 * soft bound with the sync left for a network moment (`soft-deferred`) or sent now (`soft-sync`),
 * past a hard bound and synced first (`hard-sync`), past it offline and shown anyway
 * (`offline-stale`), a stored copy a change outdated (`invalidated`, `stale-after-sync`), a hard
 * route offline that refuses (`hard-refused`), or a render the worker declined (`refused`).
 */
export type ViewReason =
	| 'cold'
	| 'principal'
	| 'fresh'
	| 'soft-deferred'
	| 'soft-sync'
	| 'hard-sync'
	| 'offline-stale'
	| 'invalidated'
	| 'stale-after-sync'
	| 'hard-refused'
	| 'refused';

/** the tier a reason has when the worker serves; a shadow view keeps the reason and drops the tier */
export const REASON_TIER: Record<ViewReason, Exclude<ViewTier, 'shadow'>> = {
	cold: 'network',
	principal: 'network',
	fresh: 'local',
	'soft-deferred': 'local',
	'soft-sync': 'local-revalidate',
	'hard-sync': 'local-revalidate',
	'offline-stale': 'local-revalidate',
	invalidated: 'fallback',
	'stale-after-sync': 'fallback',
	'hard-refused': 'fallback',
	refused: 'fallback'
};

/** the layout engine, which decides what the browser does with a worker: not the vendor */
export type Engine = 'chromium' | 'firefox' | 'webkit' | 'other';

/** one page view on a declared route, as the worker reports it in `spool.view` */
export type ViewEvent = {
	/** names this view, so the page's later report of its cross-origin loads can be joined to it */
	id: string;
	tier: ViewTier;
	reason: ViewReason;
	/** seconds since the stored copy was last known good, or null when none was stored */
	staleSec: number | null;
	engine: Engine;
	scope: Scope;
	strategy: Strategy;
	/** the matched route pattern */
	route: string;
	/** whether the local render differed from the network one; null when no local render was made */
	mismatch: boolean | null;
	/** milliseconds since this worker instance started */
	swAgeMs: number;
	/** milliseconds since this worker's previous view, or null for its first */
	gapMs: number | null;
	/**
	 * Cross-origin resources the page loaded during the view, as the page runtime counted them from
	 * `PerformanceResourceTiming` when it was hidden. Without `Timing-Allow-Origin` such an entry has a
	 * transfer size of 0 whether it came from cache or network, so a cache hit counts: this is an upper
	 * bound on cross-origin network requests. Null until the page reports, and when it never does.
	 */
	crossOriginLoads: number | null;
};

/** a view with the device time it was recorded at, epoch milliseconds */
export type TimedView = ViewEvent & {
	at: number;
	/** cross-origin loads by origin, when the page's report named them */
	crossOriginOrigins?: Record<string, number>;
};

/** longest route pattern a view may name; a longer one is not read as a view */
export const MAX_ROUTE_CHARS = 256;

/** the `path` a view carries inside a beacon batch */
export const VIEW_PATH = '/.spool/view';

/** the `path` of the page's later report of a view's cross-origin loads */
export const LOADS_PATH = '/.spool/loads';

/** most origins a loads report names; the page keeps the busiest */
export const MAX_LOAD_ORIGINS = 32;

/**
 * a page's count of the cross-origin loads of view `view`, and how many came from each origin
 * (origins only, never paths or query strings)
 */
export type LoadsReport = {
	view: string;
	count: number;
	at: number;
	origins?: Record<string, number>;
};

/** a loads report as a queued beacon */
export function loadsToBeacon(
	view: string,
	count: number,
	at: number,
	origins?: Record<string, number>
): BeaconEvent {
	return {
		path: LOADS_PATH,
		body: JSON.stringify(
			origins && Object.keys(origins).length > 0 ? { view, count, origins } : { view, count }
		),
		contentType: 'application/json',
		at
	};
}

/** the report inside a beacon, or null when it is another request or does not validate */
export function loadsFromBeacon(event: BeaconEvent): LoadsReport | null {
	if (event.path !== LOADS_PATH) return null;
	try {
		const { view, count, origins } = JSON.parse(event.body) as Record<string, unknown>;
		if (typeof view !== 'string' || view === '' || view.length > 64) return null;
		if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
		if (origins === undefined) return { view, count, at: event.at };
		if (typeof origins !== 'object' || origins === null || Array.isArray(origins)) return null;
		const entries = Object.entries(origins);
		if (entries.length > MAX_LOAD_ORIGINS) return null;
		for (const [name, n] of entries) {
			if (name.length > 253 || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
				return null;
			}
		}
		return { view, count, at: event.at, origins: origins as Record<string, number> };
	} catch {
		return null;
	}
}

/**
 * The views in `events` with their cross-origin counts filled in from the loads reports among
 * them. A report that arrives in a later batch than its view needs the whole stream, so pass every
 * event; the last report for a view wins. A view with no report keeps null.
 */
export function viewsWithLoads(events: readonly BeaconEvent[]): TimedView[] {
	const counts = new Map<string, number>();
	const named = new Map<string, Record<string, number>>();
	for (const event of events) {
		const report = loadsFromBeacon(event);
		if (!report) continue;
		counts.set(report.view, report.count);
		if (report.origins) named.set(report.view, report.origins);
		else named.delete(report.view);
	}
	return events.flatMap((event) => {
		const view = viewFromBeacon(event);
		if (!view) return [];
		const count = counts.get(view.id);
		if (count === undefined) return [view];
		const origins = named.get(view.id);
		return [
			{
				...view,
				crossOriginLoads: count,
				...(origins ? { crossOriginOrigins: origins } : {})
			}
		];
	});
}

const STRATEGIES: readonly string[] = ['assembly', 'template', 'static', 'projection', 'data'];

const TIERS: readonly string[] = [
	'local',
	'local-revalidate',
	'network',
	'fallback',
	'shadow'
] satisfies ViewTier[];
const ENGINES: readonly string[] = ['chromium', 'firefox', 'webkit', 'other'] satisfies Engine[];

/** the view as a queued beacon, so it rides the same flush as every other held request */
export function viewToBeacon(view: ViewEvent, at: number): BeaconEvent {
	return { path: VIEW_PATH, body: JSON.stringify(view), contentType: 'application/json', at };
}

function nullableNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/** the view inside a beacon, or null when it is another request or does not validate */
export function viewFromBeacon(event: BeaconEvent): TimedView | null {
	if (event.path !== VIEW_PATH) return null;
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(event.body) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const {
		id,
		tier,
		reason,
		staleSec,
		engine,
		scope,
		strategy,
		route,
		mismatch,
		swAgeMs,
		gapMs,
		crossOriginLoads
	} = value;
	if (typeof id !== 'string' || id === '' || id.length > 64) return null;
	if (
		crossOriginLoads !== null &&
		(!Number.isSafeInteger(crossOriginLoads) || (crossOriginLoads as number) < 0)
	) {
		return null;
	}
	if (typeof tier !== 'string' || !TIERS.includes(tier)) return null;
	if (typeof reason !== 'string' || !Object.hasOwn(REASON_TIER, reason)) return null;
	if (typeof engine !== 'string' || !ENGINES.includes(engine)) return null;
	if (scope !== 'public' && scope !== 'principal') return null;
	if (!STRATEGIES.includes(strategy as string)) return null;
	if (typeof route !== 'string' || route.length > MAX_ROUTE_CHARS) return null;
	if (mismatch !== null && typeof mismatch !== 'boolean') return null;
	if (!nullableNumber(staleSec) || !nullableNumber(gapMs)) return null;
	if (typeof swAgeMs !== 'number' || !Number.isFinite(swAgeMs)) return null;
	return {
		id,
		crossOriginLoads: crossOriginLoads as number | null,
		tier: tier as ViewTier,
		reason: reason as ViewReason,
		staleSec,
		engine: engine as Engine,
		scope,
		strategy: strategy as Strategy,
		route,
		mismatch,
		swAgeMs,
		gapMs,
		at: event.at
	};
}

/**
 * The engine behind a user agent. Every browser on iOS runs WebKit, whatever its name says, so
 * the iOS tokens are checked first.
 */
export function engineOf(userAgent: string): Engine {
	if (/\b(?:CriOS|FxiOS|EdgiOS|OPiOS)\//.test(userAgent)) return 'webkit';
	if (/\bFirefox\//.test(userAgent)) return 'firefox';
	if (/\b(?:Chrome|Chromium)\//.test(userAgent)) return 'chromium';
	if (/\bSafari\//.test(userAgent)) return 'webkit';
	return 'other';
}

/** where a view stopped on the way to a zero-network render */
export type Funnel = 'ineligible' | 'cold' | 'unusable' | 'local';

/**
 * Where a view stopped: on a route the worker never serves (`ineligible`), with nothing stored
 * (`cold`), with a copy it could not show without the network (`unusable`), or shown with no
 * request (`local`). A view is local only when no cross-origin resource loaded during it, which the
 * page must have reported as 0: a count above 0 or no report makes it `unusable`, whatever the worker
 * did. A shadow view that would have been local but rendered differently from the network is
 * `unusable` too.
 */
export function funnelOf(
	view: Pick<ViewEvent, 'reason' | 'mismatch' | 'crossOriginLoads'>
): Funnel {
	if (view.reason === 'principal') return 'ineligible';
	if (view.reason === 'cold') return 'cold';
	const strict = REASON_TIER[view.reason] === 'local' && view.mismatch !== true;
	return strict && view.crossOriginLoads === 0 ? 'local' : 'unusable';
}
