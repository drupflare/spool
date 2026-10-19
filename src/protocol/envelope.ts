import { PROTOCOL_VERSION, type Scope } from './artifact.js';
import { ProtocolError } from './errors.js';

/** the header names, lowercase as `Headers` reports them */
export const HEADERS = {
	protocol: 'spool-protocol',
	artifact: 'spool-artifact',
	invalidate: 'spool-invalidate',
	clear: 'spool-clear',
	vector: 'spool-vector',
	partition: 'spool-partition',
	vectorSeen: 'spool-vector-seen',
	provision: 'spool-provision'
} as const;

/** `Spool-Clear` token that wipes everything the worker holds */
export const CLEAR_ALL = '*';

/** what a response says about the artifact it carries */
export type EnvelopeArtifact = {
	id: string;
	scope: Scope;
	deps: string[];
	/** the vector cursor the artifact reflects */
	version: number;
};

/** every spool header of a response, decoded; an absent header is an absent field */
export type Envelope = {
	protocol?: number;
	artifact?: EnvelopeArtifact;
	/** tag to the vector version at which it last changed */
	invalidate?: Record<string, number>;
	/** partition ids to wipe, or {@link CLEAR_ALL} */
	clear?: string[];
	vector?: number;
	/** echo of the request's `Spool-Vector-Seen`: `invalidate` is the complete diff since this cursor */
	seen?: number;
	partition?: string;
};

const PARTITION = /^[A-Za-z0-9_-]{1,128}$/;

function bad(message: string): never {
	throw new ProtocolError('bad-header', message);
}

function integer(text: string, field: string): number {
	if (!/^\d{1,15}$/.test(text.trim())) return bad(`${field} must be a non-negative integer`);
	return Number(text);
}

function decode(text: string, field: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return bad(`${field} has a bad escape`);
	}
}

function list(text: string): string[] {
	return text
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part !== '');
}

/** the header map for an envelope; `Spool-Protocol` is always present */
export function encodeEnvelope(envelope: Envelope): Record<string, string> {
	const out: Record<string, string> = {
		[HEADERS.protocol]: String(envelope.protocol ?? PROTOCOL_VERSION)
	};
	const { artifact, invalidate, clear, vector, seen, partition } = envelope;
	if (artifact) {
		out[HEADERS.artifact] = [
			`id=${encodeURIComponent(artifact.id)}`,
			`scope=${artifact.scope}`,
			`deps=${artifact.deps.map(encodeURIComponent).join(',')}`,
			`v=${artifact.version}`
		].join('; ');
	}
	const changed = Object.entries(invalidate ?? {});
	if (changed.length > 0) {
		out[HEADERS.invalidate] = changed
			.map(([t, v]) => `${encodeURIComponent(t)}=${v}`)
			.join(', ');
	}
	if (clear && clear.length > 0) out[HEADERS.clear] = clear.map(encodeURIComponent).join(', ');
	if (vector !== undefined) out[HEADERS.vector] = String(vector);
	if (seen !== undefined) out[HEADERS.vectorSeen] = String(seen);
	if (partition !== undefined) {
		if (!PARTITION.test(partition)) return bad('partition must be a base64url token');
		out[HEADERS.partition] = partition;
	}
	return out;
}

/** sets every header of `envelope` on `headers`, replacing any spool header already there */
export function writeEnvelope(headers: Headers, envelope: Envelope): void {
	for (const [name, value] of Object.entries(encodeEnvelope(envelope))) headers.set(name, value);
}

/**
 * The envelope of a response as the worker uses it. A malformed spool header drops every field
 * but `Spool-Clear`, which is read on its own so a valid clear still applies and a malformed one
 * reads as a full wipe. A response that names another protocol version is left alone.
 */
export function decodeEnvelopeOrClear(headers: Headers): Envelope | undefined {
	try {
		return decodeEnvelope(headers);
	} catch {
		const version = headers.get(HEADERS.protocol)?.trim();
		if (version && /^\d{1,15}$/.test(version) && Number(version) !== PROTOCOL_VERSION) {
			return undefined;
		}
		const raw = headers.get(HEADERS.clear);
		if (raw === null) return undefined;
		try {
			return {
				protocol: PROTOCOL_VERSION,
				clear: list(raw).map((t) => decode(t, 'Spool-Clear'))
			};
		} catch {
			return { protocol: PROTOCOL_VERSION, clear: [CLEAR_ALL] };
		}
	}
}

/** reads the spool headers; throws `ProtocolError` on a malformed one */
export function decodeEnvelope(headers: Headers): Envelope {
	const out: Envelope = {};
	const protocol = headers.get(HEADERS.protocol);
	if (protocol !== null) out.protocol = integer(protocol, 'Spool-Protocol');

	const artifact = headers.get(HEADERS.artifact);
	if (artifact !== null) {
		const fields = new Map<string, string>();
		for (const part of artifact.split(';')) {
			const eq = part.indexOf('=');
			if (eq < 1) return bad('Spool-Artifact has a field without a name');
			fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
		}
		const id = fields.get('id');
		const scope = fields.get('scope');
		const version = fields.get('v');
		if (id === undefined || version === undefined) return bad('Spool-Artifact needs id and v');
		if (scope !== 'public' && scope !== 'principal')
			return bad('Spool-Artifact scope is unknown');
		out.artifact = {
			id: decode(id, 'Spool-Artifact id'),
			scope,
			deps: list(fields.get('deps') ?? '').map((d) => decode(d, 'Spool-Artifact deps')),
			version: integer(version, 'Spool-Artifact v')
		};
	}

	const invalidate = headers.get(HEADERS.invalidate);
	if (invalidate !== null) {
		out.invalidate = Object.fromEntries(
			list(invalidate).map((pair): [string, number] => {
				const eq = pair.lastIndexOf('=');
				if (eq < 1) return bad('Spool-Invalidate entries are tag=version');
				return [
					decode(pair.slice(0, eq), 'Spool-Invalidate tag'),
					integer(pair.slice(eq + 1), 'Spool-Invalidate version')
				];
			})
		);
	}

	const clear = headers.get(HEADERS.clear);
	if (clear !== null) out.clear = list(clear).map((t) => decode(t, 'Spool-Clear'));

	const vector = headers.get(HEADERS.vector);
	if (vector !== null) out.vector = integer(vector, 'Spool-Vector');

	const seen = headers.get(HEADERS.vectorSeen);
	if (seen !== null) out.seen = integer(seen, 'Spool-Vector-Seen');

	const partition = headers.get(HEADERS.partition);
	if (partition !== null) {
		if (!PARTITION.test(partition)) return bad('Spool-Partition must be a base64url token');
		out.partition = partition;
	}
	return out;
}
