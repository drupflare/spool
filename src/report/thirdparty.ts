import type { TimedView } from '../protocol/view.js';
import { loaded, median } from './derive.js';
import type { Row } from './measurement.js';

/** what a third-party origin is for, as far as the table below knows */
export type OriginClass =
	| 'analytics'
	| 'ads'
	| 'consent'
	| 'fonts'
	| 'cdn'
	| 'video'
	| 'maps'
	| 'social'
	| 'chat'
	| 'unknown';

/**
 * What can be done about a class, from the third-party surveys of 2026-10-19:
 * `defer` holds the request and sends it later, `cache` keeps a versioned file, `self-host` removes
 * the request, `network` stays on the network, `review` means the origin is not in the table.
 */
export type Remedy = 'defer' | 'cache' | 'self-host' | 'network' | 'review';

/** a known origin suffix, its class and what can be done */
export type KnownOrigin = { suffix: string; class: OriginClass; remedy: Remedy };

/**
 * A short table of common third-party hosts. It is a starting point for a site to extend, not a
 * claim about any vendor's behaviour: the class and remedy come from reading vendor documentation
 * in the surveys and are not measured here.
 */
export const KNOWN_ORIGINS: readonly KnownOrigin[] = [
	{ suffix: 'google-analytics.com', class: 'analytics', remedy: 'defer' },
	{ suffix: 'analytics.google.com', class: 'analytics', remedy: 'defer' },
	{ suffix: 'googletagmanager.com', class: 'analytics', remedy: 'review' },
	{ suffix: 'cloudflareinsights.com', class: 'analytics', remedy: 'defer' },
	{ suffix: 'hotjar.com', class: 'analytics', remedy: 'review' },
	{ suffix: 'plausible.io', class: 'analytics', remedy: 'defer' },
	{ suffix: 'doubleclick.net', class: 'ads', remedy: 'network' },
	{ suffix: 'googlesyndication.com', class: 'ads', remedy: 'network' },
	{ suffix: 'onetrust.com', class: 'consent', remedy: 'network' },
	{ suffix: 'cookiebot.com', class: 'consent', remedy: 'network' },
	{ suffix: 'fonts.googleapis.com', class: 'fonts', remedy: 'self-host' },
	{ suffix: 'fonts.gstatic.com', class: 'fonts', remedy: 'cache' },
	{ suffix: 'cdnjs.cloudflare.com', class: 'cdn', remedy: 'cache' },
	{ suffix: 'cdn.jsdelivr.net', class: 'cdn', remedy: 'cache' },
	{ suffix: 'unpkg.com', class: 'cdn', remedy: 'cache' },
	{ suffix: 'youtube.com', class: 'video', remedy: 'network' },
	{ suffix: 'ytimg.com', class: 'video', remedy: 'network' },
	{ suffix: 'vimeo.com', class: 'video', remedy: 'network' },
	{ suffix: 'maps.googleapis.com', class: 'maps', remedy: 'network' },
	{ suffix: 'facebook.net', class: 'social', remedy: 'network' },
	{ suffix: 'twitter.com', class: 'social', remedy: 'network' },
	{ suffix: 'intercom.io', class: 'chat', remedy: 'network' },
	{ suffix: 'drift.com', class: 'chat', remedy: 'network' }
];

/** the class and remedy of an origin: the longest table suffix its host ends with, else unknown */
export function classifyOrigin(
	origin: string,
	table: readonly KnownOrigin[] = KNOWN_ORIGINS
): { class: OriginClass; remedy: Remedy } {
	let host: string;
	try {
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return { class: 'unknown', remedy: 'review' };
	}
	let best: KnownOrigin | undefined;
	for (const entry of table) {
		if (host === entry.suffix || host.endsWith(`.${entry.suffix}`)) {
			if (!best || entry.suffix.length > best.suffix.length) best = entry;
		}
	}
	return best
		? { class: best.class, remedy: best.remedy }
		: { class: 'unknown', remedy: 'review' };
}

/** one third-party origin and what it costs the site's zero-network views */
export type ThirdPartyRow = {
	origin: string;
	class: OriginClass;
	remedy: Remedy;
	/** reported views that loaded anything from this origin */
	views: number;
	/** resources loaded from it, summed over those views */
	loads: number;
	/** `views` as a share of reported views */
	share: number;
	/** views whose only third-party origin was this one: the ones removing it would unblock */
	soloViews: number;
};

/** the per-site third-party report */
export type ThirdPartyReport = {
	/** every view in the stream */
	views: number;
	/** views whose page reported a cross-origin count; the rest are unknown, never counted as clean */
	reported: number;
	/** reported views with no cross-origin load: strict zero-network candidates */
	clean: number;
	/** reported views with at least one */
	blocked: number;
	/** blocked views whose report named no origin, such as one from an older page runtime */
	unnamed: number;
	/** origins by `soloViews`, then `views`, then name */
	rows: ThirdPartyRow[];
};

/** how long a third-party response may be kept without asking its origin */
export type Cacheability = 'immutable' | 'long' | 'short' | 'uncacheable';

const DAY_S = 86400;
const YEAR_S = 365 * DAY_S;
const CLASSES: readonly Cacheability[] = ['immutable', 'long', 'short', 'uncacheable'];

/**
 * The class of one recorded response from its cache headers. `immutable` is an `immutable`
 * directive or a max-age of a year; `long` a max-age of a day up to a year; `short` a max-age under
 * a day, or a validator with no freshness; `uncacheable` a `no-store`, or neither freshness nor a
 * validator. The reading keeps `expires` as a flag only, so it is not read.
 */
export function cacheability(response: Row): Cacheability {
	const directives = new Map<string, string>();
	for (const part of String(response.cacheControl ?? '').split(',')) {
		const [name = '', value = ''] = part.trim().toLowerCase().split('=');
		if (name) directives.set(name, value.replace(/"/g, ''));
	}
	if (directives.has('no-store')) return 'uncacheable';
	const raw = directives.get('max-age');
	const maxAge = raw === undefined ? NaN : Number(raw);
	if (directives.has('immutable') || maxAge >= YEAR_S) return 'immutable';
	if (maxAge >= DAY_S) return 'long';
	if (Number.isFinite(maxAge)) return 'short';
	return response.etag === true || response.lastModified === true ? 'short' : 'uncacheable';
}

/** third-party network bytes and requests of one repeat view, by cacheability */
export type CacheSplit = {
	bytes: Record<Cacheability, number>;
	requests: Record<Cacheability, number>;
	/** third-party network bytes */
	total: number;
	/** bytes from a cache-remedy origin that is immutable or long: what a worker could answer */
	answerable: number;
	/** bytes, and immutable or long bytes, by origin class and remedy, keyed `class|remedy` */
	byOrigin: Record<string, { bytes: number; longLived: number }>;
};

/**
 * The third-party requests of one repeat view that reached the network, split by cacheability.
 * First-party requests and requests the browser cache answered are left out, as in `splitRequestBytes`.
 */
export function thirdPartyCacheSplit(requests: readonly Row[]): CacheSplit {
	const zeros = (): Record<Cacheability, number> => ({
		immutable: 0,
		long: 0,
		short: 0,
		uncacheable: 0
	});
	const split: CacheSplit = {
		bytes: zeros(),
		requests: zeros(),
		total: 0,
		answerable: 0,
		byOrigin: {}
	};
	for (const request of requests) {
		if (request.fromCache === true || request.sameOrigin === true) continue;
		const bytes = typeof request.bytes === 'number' ? request.bytes : 0;
		const kind = cacheability(request);
		const { class: origin, remedy } = classifyOrigin(String(request.url ?? ''));
		const longLived = kind === 'immutable' || kind === 'long' ? bytes : 0;
		split.bytes[kind] += bytes;
		split.requests[kind] += 1;
		split.total += bytes;
		if (remedy === 'cache') split.answerable += longLived;
		const key = `${origin}|${remedy}`;
		const cell = split.byOrigin[key] ?? { bytes: 0, longLived: 0 };
		cell.bytes += bytes;
		cell.longLived += longLived;
		split.byOrigin[key] = cell;
	}
	return split;
}

/** {@link thirdPartyCacheSplit} for each site's loaded home-page repeat view, picked as `repeatSplitBySite` picks it */
export function thirdPartyCacheBySite(rows: readonly Row[]): Map<string, CacheSplit> {
	const out = new Map<string, CacheSplit>();
	for (const row of rows) {
		for (const nav of (row.navs as Row[] | undefined) ?? []) {
			if (loaded(nav) && nav.kind === 'warm-home-repeat' && Array.isArray(nav.requestList)) {
				out.set(String(row.site ?? ''), thirdPartyCacheSplit(nav.requestList as Row[]));
			}
		}
	}
	return out;
}

/** cross-site figures of {@link CacheSplit}s; shares are over the sites that had third-party bytes */
export type CacheabilityFigures = {
	/** sites with a loaded repeat view */
	sites: number;
	/** sites whose repeat view had third-party network bytes */
	withThirdParty: number;
	/** each class's share of a site's third-party bytes, and its pooled share */
	shares: Record<Cacheability, { median: number; mean: number; pooled: number }>;
	/** answerable bytes per site, over every site, zero included */
	answerableBytes: { median: number; mean: number };
	/** answerable bytes as a share of a site's third-party bytes, and pooled */
	answerableShare: { median: number; mean: number; pooled: number };
};

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const mean = (xs: readonly number[]) =>
	xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
const middle = (xs: readonly number[]) => (xs.length === 0 ? 0 : median(xs));

/** the median, mean and pooled figures of the splits, one per class and for the answerable bytes */
export function cacheabilityFigures(splits: readonly CacheSplit[]): CacheabilityFigures {
	const timed = splits.filter((s) => s.total > 0);
	const pooledTotal = splits.reduce((n, s) => n + s.total, 0);
	const shares = {} as CacheabilityFigures['shares'];
	for (const kind of CLASSES) {
		const xs = timed.map((s) => s.bytes[kind] / s.total);
		shares[kind] = {
			median: middle(xs),
			mean: mean(xs),
			pooled: ratio(
				splits.reduce((n, s) => n + s.bytes[kind], 0),
				pooledTotal
			)
		};
	}
	const answerable = timed.map((s) => s.answerable / s.total);
	return {
		sites: splits.length,
		withThirdParty: timed.length,
		shares,
		answerableBytes: {
			median: middle(splits.map((s) => s.answerable)),
			mean: mean(splits.map((s) => s.answerable))
		},
		answerableShare: {
			median: middle(answerable),
			mean: mean(answerable),
			pooled: ratio(
				splits.reduce((n, s) => n + s.answerable, 0),
				pooledTotal
			)
		}
	};
}

/**
 * What blocks zero-network on this site: for each third-party origin the views that loaded from it,
 * ranked by how many views it alone blocks. Pass the views from `viewsOf`, which joins each page's
 * loads report to its view. The counts are an upper bound on network requests, since a cross-origin
 * resource timing entry says nothing about cache hits without `Timing-Allow-Origin`.
 */
export function thirdPartyReport(
	views: readonly TimedView[],
	table: readonly KnownOrigin[] = KNOWN_ORIGINS
): ThirdPartyReport {
	const rows = new Map<string, { views: number; loads: number; solo: number }>();
	let reported = 0;
	let clean = 0;
	let unnamed = 0;
	for (const view of views) {
		if (view.crossOriginLoads === null) continue;
		reported += 1;
		if (view.crossOriginLoads === 0) {
			clean += 1;
			continue;
		}
		const named = Object.entries(view.crossOriginOrigins ?? {});
		if (named.length === 0) {
			unnamed += 1;
			continue;
		}
		for (const [origin, count] of named) {
			const row = rows.get(origin) ?? { views: 0, loads: 0, solo: 0 };
			row.views += 1;
			row.loads += count;
			if (named.length === 1) row.solo += 1;
			rows.set(origin, row);
		}
	}
	return {
		views: views.length,
		reported,
		clean,
		blocked: reported - clean,
		unnamed,
		rows: [...rows]
			.map(([origin, row]): ThirdPartyRow => {
				const kind = classifyOrigin(origin, table);
				return {
					origin,
					class: kind.class,
					remedy: kind.remedy,
					views: row.views,
					loads: row.loads,
					share: row.views / reported,
					soloViews: row.solo
				};
			})
			.sort(
				(a, b) =>
					b.soloViews - a.soloViews ||
					b.views - a.views ||
					(a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0)
			)
	};
}
