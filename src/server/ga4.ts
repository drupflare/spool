import type { BeaconEvent } from '../protocol/beacon.js';
import { GA4_HARD_MS, GA4_RECOMMENDED_MS } from '../protocol/collector.js';
import { ProtocolError } from '../protocol/errors.js';
import type { Sink } from './sink.js';

/** most events one Measurement Protocol request may carry */
export const MP_MAX_EVENTS = 25;

/** one Measurement Protocol request body */
export type MpBody = {
	client_id: string;
	events: Array<{
		name: string;
		params: Record<string, string | number>;
		timestamp_micros: number;
	}>;
};

/** what {@link ga4Requests} makes of a batch of held events */
export type Ga4Plan = {
	/** request bodies, one client and at most {@link MP_MAX_EVENTS} events each */
	bodies: MpBody[];
	/** events older than the cap, which are not sent */
	dropped: number;
};

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** the gtag collect parameters that map to a named event parameter */
const NAMED: Record<string, string> = {
	dl: 'page_location',
	dr: 'page_referrer',
	dt: 'page_title',
	ul: 'language',
	sr: 'screen_resolution'
};

function paramsOf(text: string): URLSearchParams {
	return new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
}

/**
 * Turns a held gtag collect request into Measurement Protocol events, each stamped with the
 * time it happened. A batched request carries one event per body line and the shared parameters in
 * the query. Events with no client id or an invalid name are skipped. The parameter mapping
 * (`dl`, `dt`, `ep.name`, `epn.name`, `_et`, `sid`) is the one gtag.js uses on the wire; it is read
 * from observed requests, not from a vendor document.
 */
export function eventsOf(
	event: BeaconEvent
): Array<{ client: string; body: MpBody['events'][number] }> {
	const base = paramsOf(event.search ?? '');
	const lines = event.body.split('\n').filter((line) => line.trim() !== '');
	const sets = lines.length > 0 ? lines.map(paramsOf) : [new URLSearchParams()];
	const out: Array<{ client: string; body: MpBody['events'][number] }> = [];
	for (const own of sets) {
		const merged = new URLSearchParams(base);
		for (const [key, value] of own) merged.set(key, value);
		const client = merged.get('cid');
		const name = merged.get('en');
		if (!client || !name || !NAME.test(name)) continue;
		const params: Record<string, string | number> = {};
		for (const [key, value] of merged) {
			if (NAMED[key]) params[NAMED[key] as string] = value;
			else if (key.startsWith('ep.') && NAME.test(key.slice(3))) params[key.slice(3)] = value;
			else if (key.startsWith('epn.') && NAME.test(key.slice(4))) {
				const n = Number(value);
				if (Number.isFinite(n)) params[key.slice(4)] = n;
			} else if (key === '_et' && Number.isFinite(Number(value))) {
				params['engagement_time_msec'] = Number(value);
			} else if (key === 'sid' && Number.isFinite(Number(value))) {
				params['session_id'] = Number(value);
			}
		}
		out.push({
			client,
			body: { name, params, timestamp_micros: Math.round(event.at * 1000) }
		});
	}
	return out;
}

/**
 * Groups held GA4 events by client, drops those past `maxAgeMs` and splits each client's events
 * into requests of at most {@link MP_MAX_EVENTS}. Order within a client is the order held.
 */
export function ga4Requests(
	events: readonly BeaconEvent[],
	now: number,
	maxAgeMs: number = GA4_RECOMMENDED_MS
): Ga4Plan {
	const byClient = new Map<string, MpBody['events']>();
	let dropped = 0;
	for (const event of events) {
		if (event.vendor !== 'ga4') continue;
		const made = eventsOf(event);
		if (now - event.at > maxAgeMs) {
			dropped += Math.max(made.length, 1);
			continue;
		}
		for (const { client, body } of made) {
			const list = byClient.get(client) ?? [];
			list.push(body);
			byClient.set(client, list);
		}
	}
	const bodies: MpBody[] = [];
	for (const [client_id, list] of byClient) {
		for (let at = 0; at < list.length; at += MP_MAX_EVENTS) {
			bodies.push({ client_id, events: list.slice(at, at + MP_MAX_EVENTS) });
		}
	}
	return { bodies, dropped };
}

/**
 * The rules this module checks a body against before sending: a client id, at most 25 events, a
 * valid name on each, and a timestamp no more than 72 hours old and not in the future. It stands
 * in for the validation `/debug/mp/collect` does, which needs a live measurement id and API secret
 * and so is not called from tests.
 */
export function mpViolations(body: MpBody, now: number): string[] {
	const out: string[] = [];
	if (!body.client_id) out.push('client_id is empty');
	if (body.events.length === 0) out.push('no events');
	if (body.events.length > MP_MAX_EVENTS) out.push(`more than ${MP_MAX_EVENTS} events`);
	for (const event of body.events) {
		if (!NAME.test(event.name)) out.push(`bad event name ${event.name}`);
		const age = now - event.timestamp_micros / 1000;
		if (age > GA4_HARD_MS) out.push(`${event.name} is older than 72 hours`);
		if (age < -60_000) out.push(`${event.name} is in the future`);
	}
	return out;
}

/** what {@link ga4Sink} takes */
export type Ga4Options = {
	measurementId: string;
	/** the Measurement Protocol API secret; it stays on the server and never reaches the page */
	apiSecret: string;
	/** events older than this are dropped and counted; default 48 hours, never past 72 */
	maxAgeMs?: number;
	/** post to `/debug/mp/collect`, which validates and returns messages without recording */
	debug?: boolean;
	fetch?: typeof fetch;
	now?: () => number;
};

/** the sink {@link ga4Sink} returns, with what it has sent and dropped so far */
export type Ga4Sink = Sink & { readonly sent: number; readonly dropped: number };

/**
 * Forwards held GA4 collect events to the Measurement Protocol with their original timestamps, so a
 * view recorded on a phone offline arrives dated when it happened. Only events of vendor `ga4` are
 * read; the rest of a batch is left to other sinks. A failed request throws, which makes the
 * worker keep the batch and send it again, so a request that did go out before the failure can be
 * sent twice.
 */
export function ga4Sink(options: Ga4Options): Ga4Sink {
	const maxAge = options.maxAgeMs ?? GA4_RECOMMENDED_MS;
	if (!(maxAge > 0 && maxAge <= GA4_HARD_MS)) {
		throw new ProtocolError('bad-route', 'ga4 maxAgeMs must be between 1 and 72 hours');
	}
	const post = options.fetch ?? fetch;
	const clock = options.now ?? Date.now;
	const base = `https://www.google-analytics.com${options.debug ? '/debug' : ''}/mp/collect`;
	const url = `${base}?measurement_id=${encodeURIComponent(options.measurementId)}&api_secret=${encodeURIComponent(options.apiSecret)}`;
	let sent = 0;
	let dropped = 0;
	return {
		get sent() {
			return sent;
		},
		get dropped() {
			return dropped;
		},
		async write(events) {
			const plan = ga4Requests(events, clock(), maxAge);
			dropped += plan.dropped;
			for (const body of plan.bodies) {
				const response = await post(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				if (!response.ok)
					throw new Error(`Measurement Protocol answered ${response.status}`);
				sent += body.events.length;
			}
		}
	};
}

/** one sink that writes every batch to each of `sinks` in turn */
export function combineSinks(...sinks: Sink[]): Sink {
	return {
		async write(events) {
			for (const sink of sinks) await sink.write(events);
		}
	};
}
