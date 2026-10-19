import type { Artifact } from '../protocol/artifact.js';
import { parseBeaconBatch, type CatalogueAsk } from '../protocol/beacon.js';
import { HEADERS } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import type { Sink } from './sink.js';
import { json } from './sync.js';

/** the largest flush body the server reads, in characters */
export const MAX_BEACON_BODY = 262_144;

/** builds the public artifacts for the paths a flush asked for; paths it cannot serve are left out */
export type Provide = (paths: readonly string[]) => Promise<Artifact[]>;

/** the entries chosen for one catalogue request; `partition` is set when any is a principal entry */
export type Bundle = { artifacts: Artifact[]; partition?: string };

/** chooses the entries for the page a flush named */
export type Catalogue = (ask: CatalogueAsk) => Promise<Bundle>;

/** whether the visitor asked the browser for reduced data use */
const savesData = (request: Request) =>
	request.headers.get('save-data')?.trim().toLowerCase() === 'on';

/**
 * Accepts a batched flush at `/.spool/beacon` and hands its events to the sink. A flush that
 * asked for artifacts or a catalogue is answered with them in a 200; any other is a 204. A
 * request with `Save-Data: on` is never sent a catalogue.
 */
export async function respondBeacon(
	request: Request,
	sink: Sink | undefined,
	provide?: Provide,
	catalogue?: Catalogue
): Promise<Response> {
	if (request.method !== 'POST')
		return new Response(null, { status: 405, headers: { allow: 'POST' } });
	const text = await request.text();
	if (text.length > MAX_BEACON_BODY) return new Response(null, { status: 413 });
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ProtocolError('bad-beacon', 'body is not JSON');
	}
	const batch = parseBeaconBatch(value);
	if (batch.events.length > 0) await sink?.write(batch.events);
	const body: { protocol: 1; artifacts?: Artifact[]; catalogue?: Artifact[] } = { protocol: 1 };
	const headers: Record<string, string> = {};
	if (provide && batch.want && batch.want.length > 0) body.artifacts = await provide(batch.want);
	if (catalogue && batch.catalogue && !savesData(request)) {
		const bundle = await catalogue(batch.catalogue);
		if (bundle.artifacts.length > 0) {
			body.catalogue = bundle.artifacts;
			if (bundle.partition !== undefined) {
				headers[HEADERS.partition] = bundle.partition;
				headers['cache-control'] = 'private, no-store';
			}
		}
	}
	if (body.artifacts || body.catalogue) return json(body, 200, headers);
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
