import { ProtocolError } from './errors.js';

/** how a replayed request carries the time the event happened */
export type StampKind = 'age-ms' | 'epoch-ms' | 'epoch-s' | 'datetime-utc';

/**
 * A cross-origin analytics collector the worker holds instead of letting the page send it. The
 * page gets an immediate empty answer; the event leaves on a network moment that happens anyway,
 * inside `maxAgeMs`. Events older than that are dropped and counted, never sent late.
 */
export type CollectorConfig = {
	/** names the collector in drop counts and on the held event */
	vendor: string;
	/** the origin and path prefix of the collector's URL, such as `https://www.google-analytics.com/g/collect` */
	match: string;
	/** the vendor's backfill window less a margin, in milliseconds */
	maxAgeMs: number;
	/**
	 * `replay` sends the held request from the worker to its own URL with no cookies, so identity
	 * has to be in the payload. `sink` hands it to the server half in the flush, for a vendor that
	 * needs a secret the page must not hold.
	 */
	delivery: 'replay' | 'sink';
	/** a query parameter the replay sets to the event's time, for a vendor that accepts one */
	stamp?: { param: string; kind: StampKind };
};

const HOUR = 3_600_000;

/** GA4 Measurement Protocol: backdating works up to 72 hours, and attribution wants 48 */
export const GA4_RECOMMENDED_MS = 48 * HOUR;

/** the longest cap a `ga4` collector may declare */
export const GA4_HARD_MS = 72 * HOUR;

/**
 * The GA4 browser collector, forwarded through the server half because the Measurement Protocol
 * needs an API secret the page must not hold. The cap is the 48-hour attribution window.
 */
export const GA4_COLLECTOR: CollectorConfig = {
	vendor: 'ga4',
	match: 'https://www.google-analytics.com/g/collect',
	maxAgeMs: GA4_RECOMMENDED_MS,
	delivery: 'sink'
};

function bad(message: string): never {
	throw new ProtocolError('bad-route', message);
}

/** validates collectors from a server config; a `ga4` cap past the 72-hour limit is refused */
export function checkCollectors(collectors: readonly CollectorConfig[]): void {
	const seen = new Set<string>();
	for (const c of collectors) {
		if (!c.vendor) bad('collector needs a vendor');
		if (seen.has(c.vendor)) bad(`collector ${c.vendor} declared twice`);
		seen.add(c.vendor);
		let url: URL;
		try {
			url = new URL(c.match);
		} catch {
			return bad(`collector ${c.vendor}: match must be an absolute URL`);
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			bad(`collector ${c.vendor}: match must be http or https`);
		}
		if (!Number.isFinite(c.maxAgeMs) || c.maxAgeMs <= 0) {
			bad(`collector ${c.vendor}: maxAgeMs must be a positive number of milliseconds`);
		}
		if (c.vendor === 'ga4' && c.maxAgeMs > GA4_HARD_MS) {
			bad('collector ga4: maxAgeMs is past the 72 hour Measurement Protocol limit');
		}
		if (c.delivery !== 'replay' && c.delivery !== 'sink') {
			bad(`collector ${c.vendor}: delivery must be replay or sink`);
		}
		if (c.stamp && !['age-ms', 'epoch-ms', 'epoch-s', 'datetime-utc'].includes(c.stamp.kind)) {
			bad(`collector ${c.vendor}: unknown stamp kind`);
		}
	}
}

/** the collector whose `match` the URL falls under, or undefined */
export function matchCollector(
	collectors: readonly CollectorConfig[] | undefined,
	url: string
): CollectorConfig | undefined {
	if (!collectors || collectors.length === 0) return undefined;
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return undefined;
	}
	return collectors.find((c) => {
		const m = new URL(c.match);
		return target.origin === m.origin && target.pathname.startsWith(m.pathname);
	});
}

function stampValue(kind: StampKind, at: number, now: number): string {
	if (kind === 'age-ms') return String(Math.max(0, Math.round(now - at)));
	if (kind === 'epoch-ms') return String(Math.round(at));
	if (kind === 'epoch-s') return String(Math.floor(at / 1000));
	return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

/** `search` with the stamp parameter set to when the event happened, other parameters kept */
export function applyStamp(
	search: string,
	stamp: NonNullable<CollectorConfig['stamp']>,
	at: number,
	now: number
): string {
	const params = new URLSearchParams(search);
	params.set(stamp.param, stampValue(stamp.kind, at, now));
	const text = params.toString();
	return text === '' ? '' : `?${text}`;
}
