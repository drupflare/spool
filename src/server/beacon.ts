import type { Artifact } from '../protocol/artifact.js';
import { parseBeaconBatch } from '../protocol/beacon.js';
import { ProtocolError } from '../protocol/errors.js';
import type { Sink } from './sink.js';
import { json } from './sync.js';

/** the largest flush body the server reads, in characters */
export const MAX_BEACON_BODY = 262_144;

/** builds the public artifacts for the paths a flush asked for; paths it cannot serve are left out */
export type Provide = (paths: readonly string[]) => Promise<Artifact[]>;

/**
 * Accepts a batched flush at `/.spool/beacon` and hands its events to the sink. A flush that
 * asked for artifacts is answered with them in a 200; any other is a 204.
 */
export async function respondBeacon(
	request: Request,
	sink: Sink | undefined,
	provide?: Provide
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
	if (provide && batch.want && batch.want.length > 0) {
		return json({ protocol: 1, artifacts: await provide(batch.want) });
	}
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
