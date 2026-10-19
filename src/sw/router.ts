import { matchCollector, type CollectorConfig } from '../protocol/collector.js';
import type { SwConfig } from '../protocol/config.js';
import { matchPattern, type Params } from '../protocol/pattern.js';
import { matchRoute, type SerializedRoute } from '../protocol/route.js';

/** how the worker treats a request; a `static` hit keys its file by pathname plus query string */
export type Classified =
	| { kind: 'ignore' }
	| { kind: 'beacon' }
	| { kind: 'collector'; collector: CollectorConfig }
	| { kind: 'thirdparty' }
	| { kind: 'logout' }
	| { kind: 'navigation'; route: SerializedRoute; params: Params; path: string }
	| { kind: 'static'; route: SerializedRoute; path: string }
	| { kind: 'data'; route: SerializedRoute; path: string }
	| { kind: 'asset' }
	| { kind: 'pass' };

/** whether `url` falls under an origin the worker may cache files from */
function thirdPartyOrigin(config: SwConfig, url: URL): boolean {
	return config.thirdParty?.allow.includes(url.origin) === true;
}

/**
 * Sorts a request without touching it. A request to another origin is a held collector hit, a
 * file of an allowed third-party origin, or ignored so the browser handles it natively. A
 * same-origin one is a logout request, a queued beacon, a navigation on a declared route, a GET for
 * a JSON route, a GET for a subresource (cache-first when immutable), a GET of a file a static
 * route keeps, or a pass-through that the worker still observes for spool headers.
 */
export function classify(config: SwConfig, request: Request, origin: string): Classified {
	const url = new URL(request.url);
	if (url.origin !== origin) {
		const collector = matchCollector(config.collectors, request.url);
		if (collector && (request.method === 'POST' || request.method === 'GET')) {
			return { kind: 'collector', collector };
		}
		if (request.method === 'GET' && thirdPartyOrigin(config, url))
			return { kind: 'thirdparty' };
		return { kind: 'ignore' };
	}
	if (config.logout?.some((pattern) => matchPattern(pattern, url.pathname))) {
		return { kind: 'logout' };
	}
	if (request.method === 'POST' && config.beacons.includes(url.pathname))
		return { kind: 'beacon' };
	if (request.method !== 'GET') return { kind: 'pass' };
	const hit = matchRoute(config.routes, url.pathname);
	// an artifact is keyed by path alone, so a query string can never be answered from one
	const queried = url.search !== '';
	if (request.mode !== 'navigate') {
		if (hit?.route.strategy === 'static' && !request.headers.has('range')) {
			return { kind: 'static', route: hit.route, path: url.pathname + url.search };
		}
		if (hit?.route.strategy === 'data' && !request.headers.has('range') && !queried) {
			return { kind: 'data', route: hit.route, path: url.pathname };
		}
		return { kind: 'asset' };
	}
	if (!hit || hit.route.strategy === 'data' || queried) return { kind: 'pass' };
	return { kind: 'navigation', route: hit.route, params: hit.params, path: url.pathname };
}
