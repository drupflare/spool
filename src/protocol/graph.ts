import { ProtocolError } from './errors.js';

/** a reference to a record, resolved against the replica when a page renders */
export type RecordRef = { $record: string };

/** a reference to a projection, resolved against the replica when a page renders */
export type ProjectionRef = { $projection: string };

/** what a page's data carries in place of a record or projection stored once elsewhere */
export type Ref = RecordRef | ProjectionRef;

/** an authoritative piece of data, stored once by id; its id is the tag that invalidates it */
export type RecordEntry = {
	id: string;
	/** the vector cursor read before the record was built */
	version: number;
	data: unknown;
};

/** a value derived from records, shared by every page that references it */
export type ProjectionEntry = {
	id: string;
	version: number;
	/** record ids the projection reads, directly or through other projections */
	deps: string[];
	/** a tree that may reference records and other projections */
	data: unknown;
};

/** the id lists {@link collectRefs} found */
export type RefSet = { records: string[]; projections: string[] };

/** the reference to put in a page's data for record `id` */
export function recordRef(id: string): RecordRef {
	return { $record: id };
}

/** the reference to put in a page's data for projection `id` */
export function projectionRef(id: string): ProjectionRef {
	return { $projection: id };
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** whether `value` is exactly a reference, with no other keys */
export function isRef(value: unknown): value is Ref {
	if (!isPlain(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== 1) return false;
	const key = keys[0] as string;
	return (key === '$record' || key === '$projection') && typeof value[key] === 'string';
}

/** every record and projection id referenced anywhere in `value`, sorted and unique */
export function collectRefs(value: unknown): RefSet {
	const records = new Set<string>();
	const projections = new Set<string>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!isPlain(node)) return;
		if (isRef(node)) {
			if ('$record' in node) records.add(node.$record);
			else projections.add(node.$projection);
			return;
		}
		Object.values(node).forEach(walk);
	};
	walk(value);
	return { records: [...records].sort(), projections: [...projections].sort() };
}

/** where {@link resolveRefs} looks references up */
export type RefLookup = {
	record(id: string): RecordEntry | undefined;
	projection(id: string): ProjectionEntry | undefined;
};

/** the tree with every reference replaced by what it points at, or the first one that is missing */
export type Resolved = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Replaces every reference in `value` with the record's data or the projection's resolved tree.
 * A record's data is taken as is. A missing id or a projection that reaches itself is a refusal,
 * so a page is never rendered with a hole in it.
 */
export function resolveRefs(value: unknown, lookup: RefLookup): Resolved {
	const walk = (node: unknown, path: readonly string[]): unknown => {
		if (Array.isArray(node)) return node.map((item) => walk(item, path));
		if (!isPlain(node)) return node;
		if (isRef(node)) {
			if ('$record' in node) {
				const record = lookup.record(node.$record);
				if (!record) throw new Error(`record ${node.$record} is not stored`);
				return record.data;
			}
			const id = node.$projection;
			if (path.includes(id)) throw new Error(`projection ${id} reaches itself`);
			const projection = lookup.projection(id);
			if (!projection) throw new Error(`projection ${id} is not stored`);
			return walk(projection.data, [...path, id]);
		}
		return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, path)]));
	};
	try {
		return { ok: true, value: walk(value, []) };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : 'unresolved reference'
		};
	}
}

function bad(message: string): never {
	throw new ProtocolError('bad-artifact', message);
}

function version(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		return bad(`${field} version must be a non-negative integer`);
	}
	return value;
}

/** validates one record from an artifact response */
export function parseRecordEntry(value: unknown): RecordEntry {
	if (!isPlain(value)) return bad('record must be an object');
	if (typeof value['id'] !== 'string' || value['id'] === '') return bad('record id');
	if (!('data' in value)) return bad(`record ${value['id']} needs data`);
	return { id: value['id'], version: version(value['version'], 'record'), data: value['data'] };
}

/** validates one projection from an artifact response */
export function parseProjectionEntry(value: unknown): ProjectionEntry {
	if (!isPlain(value)) return bad('projection must be an object');
	const { id, deps } = value;
	if (typeof id !== 'string' || id === '') return bad('projection id');
	if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
		return bad(`projection ${id} deps must be a list of strings`);
	}
	if (!('data' in value)) return bad(`projection ${id} needs data`);
	return {
		id,
		version: version(value['version'], 'projection'),
		deps: deps as string[],
		data: value['data']
	};
}

/** what a load registered, stamped with the vector cursor it was read at */
export type Collected = {
	records: RecordEntry[];
	projections: ProjectionEntry[];
	/** every record id and projection dependency, for the artifact's own `deps` */
	deps: string[];
};

/** what a route's `load` calls to put records and projections into a page's data */
export type Collector = {
	record(id: string, data: unknown): RecordRef;
	projection(id: string, data: unknown, deps?: readonly string[]): ProjectionRef;
	/** everything registered so far; throws when a projection reaches an unregistered or cyclic one */
	collect(version: number): Collected;
};

/**
 * A collector for one load. Registering an id twice is allowed only with identical data, because
 * a record is the entity itself and cannot differ between the pages that show it.
 */
export function createCollector(): Collector {
	const records = new Map<string, string>();
	const recordData = new Map<string, unknown>();
	const projections = new Map<string, { data: unknown; deps: readonly string[]; text: string }>();

	const checkId = (kind: string, id: string) => {
		if (typeof id !== 'string' || id === '') bad(`${kind} id must be a non-empty string`);
	};
	const text = (kind: string, id: string, data: unknown): string => {
		const json = JSON.stringify(data);
		if (json === undefined) bad(`${kind} ${id} data is not JSON`);
		return json;
	};

	return {
		record(id, data) {
			checkId('record', id);
			const json = text('record', id, data);
			const prior = records.get(id);
			if (prior !== undefined && prior !== json) {
				bad(`record ${id} registered twice with different data`);
			}
			records.set(id, json);
			recordData.set(id, data);
			return recordRef(id);
		},
		projection(id, data, deps = []) {
			checkId('projection', id);
			const json = text('projection', id, data);
			const prior = projections.get(id);
			if (prior !== undefined && prior.text !== json) {
				bad(`projection ${id} registered twice with different data`);
			}
			projections.set(id, { data, deps, text: json });
			return projectionRef(id);
		},
		collect(vector) {
			const closure = (id: string, path: readonly string[]): Set<string> => {
				if (path.includes(id)) return bad(`projection ${id} reaches itself`);
				const entry = projections.get(id);
				if (!entry) return bad(`projection ${id} is referenced but never registered`);
				const refs = collectRefs(entry.data);
				const out = new Set<string>(entry.deps);
				for (const record of refs.records) {
					if (!records.has(record))
						bad(`record ${record} is referenced but never registered`);
					out.add(record);
				}
				for (const child of refs.projections) {
					for (const dep of closure(child, [...path, id])) out.add(dep);
				}
				return out;
			};
			const deps = new Set<string>(records.keys());
			const entries: ProjectionEntry[] = [...projections.keys()].sort().map((id) => {
				const reads = [...closure(id, [])].sort();
				for (const dep of reads) deps.add(dep);
				return {
					id,
					version: vector,
					deps: reads,
					data: (projections.get(id) as { data: unknown }).data
				};
			});
			return {
				records: [...recordData.keys()]
					.sort()
					.map((id) => ({ id, version: vector, data: recordData.get(id) })),
				projections: entries,
				deps: [...deps].sort()
			};
		}
	};
}
