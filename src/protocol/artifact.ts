import { ProtocolError } from './errors.js';
import {
	isRef,
	parseProjectionEntry,
	parseRecordEntry,
	type ProjectionEntry,
	type RecordEntry,
	type Ref
} from './graph.js';

/** protocol version both halves speak; a response with another value is ignored by the worker */
export const PROTOCOL_VERSION = 1;

/** markup or a value, or a reference the replica resolves to one when the page renders */
export type Text = string | Ref;

/** a shell with named holes, the fragments that fill them and named values for the rest */
export type AssemblyBody = {
	shell: string;
	fragments?: Record<string, Text>;
	slots?: Record<string, Text>;
};

/** the JSON a template renders against; the template itself ships in the worker config */
export type TemplateBody = { data: unknown };

/**
 * What a stored static file is. The bytes live in the worker's Cache, keyed by the artifact's id;
 * `version` is the manifest's label for them, absent when the server's version vector tracks the file.
 */
export type StaticBody = { type: string; bytes: number; version?: string };

/** who may be served an artifact from the replica */
export type Scope = 'public' | 'principal';

type ArtifactBase = {
	protocol: typeof PROTOCOL_VERSION;
	/** the request path the artifact answers */
	id: string;
	scope: Scope;
	/** tags the artifact was built from; a change to any of them invalidates it */
	deps: string[];
	/** the version vector cursor read before the artifact was built */
	vector: number;
	/** records this artifact references that the worker did not already hold */
	records?: RecordEntry[];
	/** projections this artifact references that the worker did not already hold */
	projections?: ProjectionEntry[];
};

/** one authorised, versioned dependency set and what to render it with */
export type Artifact = ArtifactBase &
	(
		| { strategy: 'assembly'; body: AssemblyBody }
		| { strategy: 'template' | 'projection' | 'data'; body: TemplateBody }
		| { strategy: 'static'; body: StaticBody }
	);

function bad(message: string): never {
	throw new ProtocolError('bad-artifact', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textMap(value: unknown, field: string): Record<string, Text> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return bad(`${field} must be an object`);
	for (const v of Object.values(value)) {
		if (typeof v !== 'string' && !isRef(v))
			return bad(`${field} values must be strings or references`);
	}
	return value as Record<string, Text>;
}

function entries<T>(value: unknown, field: string, parse: (v: unknown) => T): T[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return bad(`${field} must be a list`);
	return value.map(parse);
}

/** validates JSON from `/.spool/artifact`; the worker calls this before it stores anything */
export function parseArtifact(value: unknown): Artifact {
	if (!isRecord(value)) return bad('artifact must be an object');
	if (value['protocol'] !== PROTOCOL_VERSION) return bad('unsupported protocol version');
	const { id, scope, deps, vector, strategy, body } = value;
	if (typeof id !== 'string' || !id.startsWith('/')) return bad('id must be a path');
	if (scope !== 'public' && scope !== 'principal')
		return bad('scope must be public or principal');
	if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
		return bad('deps must be a list of strings');
	}
	if (typeof vector !== 'number' || !Number.isSafeInteger(vector) || vector < 0) {
		return bad('vector must be a non-negative integer');
	}
	if (!isRecord(body)) return bad('body must be an object');
	const base: ArtifactBase = {
		protocol: PROTOCOL_VERSION,
		id,
		scope,
		deps: deps as string[],
		vector
	};
	const records = entries(value['records'], 'records', parseRecordEntry);
	const projections = entries(value['projections'], 'projections', parseProjectionEntry);
	if (records) base.records = records;
	if (projections) base.projections = projections;
	if (strategy === 'template' || strategy === 'projection' || strategy === 'data') {
		if (!('data' in body)) return bad(`${strategy} body needs data`);
		return { ...base, strategy, body: { data: body['data'] } };
	}
	if (strategy === 'assembly') {
		if (typeof body['shell'] !== 'string') return bad('assembly body needs a shell string');
		const out: AssemblyBody = { shell: body['shell'] };
		const fragments = textMap(body['fragments'], 'fragments');
		const slots = textMap(body['slots'], 'slots');
		if (fragments) out.fragments = fragments;
		if (slots) out.slots = slots;
		return { ...base, strategy, body: out };
	}
	return bad(`unknown strategy ${String(strategy)}`);
}
