import { PROTOCOL_VERSION } from './artifact.js';
import { ProtocolError } from './errors.js';

/**
 * One request the worker held back: where it was going, what it carried and when it happened. A
 * same-origin one leaves `origin` out. A request to another origin names it, with the `vendor`
 * whose delay cap applies and, when `deliver` is `sink`, the server half forwards it.
 */
export type BeaconEvent = {
	path: string;
	body: string;
	contentType: string;
	/** epoch milliseconds on the device */
	at: number;
	/** the query string of the original URL, with its leading `?` */
	search?: string;
	/** `GET` for a pixel beacon; absent means `POST` */
	method?: 'GET';
	/** the origin of a held cross-origin request; absent for the site's own */
	origin?: string;
	/** the collector entry that matched, which sets the age cap */
	vendor?: string;
	/** `sink` sends the event to the server half in the flush; absent, the worker replays it to its URL */
	deliver?: 'sink';
	/** epoch milliseconds after which the worker drops the event instead of sending it; never sent */
	until?: number;
};

/**
 * A flush's request for the catalogue of the page the visitor is on. `sweep` says the worker names
 * the entries it holds and no page has opened at every required sync of a principal page, so a
 * revoked one is dropped. The server sends principal entries only to a worker that says so.
 */
export type CatalogueAsk = { path: string; sweep?: true };

/**
 * The body of `/.spool/beacon`: every held request in one flush. `want` asks for the artifacts of
 * these paths in the answer, so provisioning rides a request that is happening anyway, and
 * `catalogue` asks for the entries a site suggests for the page the visitor is on.
 */
export type BeaconBatch = {
	protocol: typeof PROTOCOL_VERSION;
	events: BeaconEvent[];
	want?: string[];
	catalogue?: CatalogueAsk;
};

/** most characters of the page path a catalogue request names */
export const MAX_CATALOGUE_PATH = 2048;

/** where the worker records events it dropped past a vendor's age cap; the body is `{vendor, count}` */
export const DROPPED_PATH = '/.spool/dropped';

/** the paths under `/.spool/` are spool's own and always travel in the flush */
export const OWN_PREFIX = '/.spool/';

/** the largest beacon body the worker holds or the server keeps in one event, in UTF-8 bytes */
export const MAX_BEACON_BYTES = 65_536;

/** most events one flush may carry; the server refuses a larger batch */
export const MAX_BEACON_EVENTS = 500;

/** most artifact paths one flush may ask for */
export const MAX_WANT = 8;

function bad(message: string): never {
	throw new ProtocolError('bad-beacon', message);
}

/** validates a flush body */
export function parseBeaconBatch(value: unknown): BeaconBatch {
	if (typeof value !== 'object' || value === null) return bad('batch must be an object');
	const v = value as Record<string, unknown>;
	if (v['protocol'] !== PROTOCOL_VERSION) return bad('unsupported protocol version');
	if (!Array.isArray(v['events'])) return bad('events must be a list');
	if (v['events'].length > MAX_BEACON_EVENTS) return bad(`more than ${MAX_BEACON_EVENTS} events`);
	const events = v['events'].map((raw: unknown): BeaconEvent => {
		const e = (raw ?? {}) as Record<string, unknown>;
		if (typeof e['path'] !== 'string' || !e['path'].startsWith('/')) return bad('event path');
		if (typeof e['body'] !== 'string') return bad('event body must be a string');
		if (typeof e['contentType'] !== 'string') return bad('event contentType must be a string');
		if (typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) return bad('event at');
		const out: BeaconEvent = {
			path: e['path'],
			body: e['body'],
			contentType: e['contentType'],
			at: e['at']
		};
		for (const field of ['search', 'origin', 'vendor'] as const) {
			const value = e[field];
			if (value === undefined) continue;
			if (typeof value !== 'string') return bad(`event ${field} must be a string`);
			out[field] = value;
		}
		if (e['method'] !== undefined) {
			if (e['method'] !== 'GET') return bad('event method must be GET');
			out.method = 'GET';
		}
		if (e['deliver'] !== undefined) {
			if (e['deliver'] !== 'sink') return bad('event deliver must be sink');
			out.deliver = 'sink';
		}
		return out;
	});
	const batch: BeaconBatch = { protocol: PROTOCOL_VERSION, events };
	const want = v['want'];
	if (want !== undefined) {
		if (!Array.isArray(want) || want.length > MAX_WANT)
			return bad(`want must be a list of at most ${MAX_WANT}`);
		if (want.some((p) => typeof p !== 'string' || !p.startsWith('/'))) return bad('want paths');
		batch.want = want as string[];
	}
	const catalogue = v['catalogue'];
	if (catalogue !== undefined) {
		const ask = (catalogue ?? {}) as Record<string, unknown>;
		const path = ask['path'];
		if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_CATALOGUE_PATH) {
			return bad('catalogue path');
		}
		if (ask['sweep'] !== undefined && ask['sweep'] !== true) return bad('catalogue sweep');
		batch.catalogue = ask['sweep'] === true ? { path, sweep: true } : { path };
	}
	return batch;
}
