import { ProtocolError } from './errors.js';
import { checkPattern } from './pattern.js';
import {
	DEFAULT_FRESHNESS,
	type Freshness,
	type OfflineRule,
	type SerializedRoute,
	type SyncRule
} from './route.js';

/** the schema number a `spool.json` carries */
export const MANIFEST_SCHEMA = 1;

/** longest `version` a manifest route may carry */
export const MAX_VERSION_CHARS = 256;

/** one file a site serves as is and the worker may keep */
export type ManifestRoute = {
	/** the path, or a `:name` pattern; every path a pattern matches shares the one version */
	pattern: string;
	strategy: 'static';
	/**
	 * What the file is at now: a content hash (`sha256-<base64>`, also `sha384-` and `sha512-`),
	 * an entity tag (`"abc"`), or any label. A hash and a tag are checked against the bytes
	 * fetched; a label is trusted. A changed value drops the stored copy.
	 */
	version: string;
	freshness?: Partial<Freshness>;
	offline?: OfflineRule;
	sync?: SyncRule;
};

/** the `spool.json` a static site serves beside `spool-sw.js` */
export type Manifest = { schema: typeof MANIFEST_SCHEMA; routes: ManifestRoute[] };

function bad(message: string): never {
	throw new ProtocolError('bad-manifest', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoute(value: unknown, index: number): ManifestRoute {
	const where = `routes[${index}]`;
	if (!isRecord(value)) return bad(`${where} must be an object`);
	const { pattern, strategy, version, freshness, offline, sync } = value;
	if (typeof pattern !== 'string') return bad(`${where}.pattern must be a string`);
	try {
		checkPattern(pattern);
	} catch (error) {
		return bad(`${where}: ${error instanceof Error ? error.message : 'bad pattern'}`);
	}
	if (strategy !== 'static') return bad(`${pattern}: strategy must be "static"`);
	if (typeof version !== 'string' || version === '' || version.length > MAX_VERSION_CHARS) {
		return bad(`${pattern}: version must be a string of 1 to ${MAX_VERSION_CHARS} characters`);
	}
	const out: ManifestRoute = { pattern, strategy, version };
	if (freshness !== undefined) {
		if (!isRecord(freshness)) return bad(`${pattern}: freshness must be an object`);
		const { maxStale, mode } = freshness;
		if (maxStale !== undefined) {
			if (typeof maxStale !== 'number' || !Number.isFinite(maxStale) || maxStale <= 0) {
				return bad(`${pattern}: freshness.maxStale must be a positive number of seconds`);
			}
		}
		if (mode !== undefined && mode !== 'hard' && mode !== 'soft') {
			return bad(`${pattern}: freshness.mode must be "hard" or "soft"`);
		}
		out.freshness = {
			...(maxStale === undefined ? {} : { maxStale }),
			...(mode === undefined ? {} : { mode })
		};
	}
	if (offline !== undefined) {
		if (offline !== 'serve' && offline !== 'refuse') {
			return bad(`${pattern}: offline must be "serve" or "refuse"`);
		}
		out.offline = offline;
	}
	if (sync !== undefined) {
		if (sync !== 'background' && sync !== 'deferred') {
			return bad(`${pattern}: sync must be "background" or "deferred"`);
		}
		out.sync = sync;
	}
	return out;
}

/** validates the JSON of a `spool.json`; the worker calls this before it replaces its routes */
export function parseManifest(value: unknown): Manifest {
	if (!isRecord(value)) return bad('manifest must be an object');
	if (value['schema'] !== MANIFEST_SCHEMA) return bad('unsupported manifest schema');
	const { routes } = value;
	if (!Array.isArray(routes)) return bad('routes must be a list');
	const parsed = routes.map(parseRoute);
	const seen = new Set<string>();
	for (const route of parsed) {
		if (seen.has(route.pattern)) return bad(`${route.pattern}: declared twice`);
		seen.add(route.pattern);
	}
	return { schema: MANIFEST_SCHEMA, routes: parsed };
}

/** the worker's routes for a manifest, with the defaults of a public route filled in */
export function manifestRoutes(manifest: Manifest): SerializedRoute[] {
	return manifest.routes.map((route) => ({
		pattern: route.pattern,
		strategy: 'static',
		scope: 'public',
		freshness: { ...DEFAULT_FRESHNESS.public, ...route.freshness },
		persist: true,
		offline: route.offline ?? 'serve',
		sync: route.sync ?? 'background',
		version: route.version
	}));
}
