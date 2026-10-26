import type { AssemblyBody, Scope } from './artifact.js';
import { ProtocolError } from './errors.js';
import type { Collector } from './graph.js';
import { checkPattern, matchPattern, type Params } from './pattern.js';
import type { QuerySchema } from './query.js';
import { compileTemplate, type CompiledTemplate, type TemplateSource } from './template/compile.js';
import type { Mode } from './view.js';

/**
 * how a route is answered locally. `projection` renders stored JSON through a function the site
 * bundles into its own worker; `data` answers a GET for JSON, such as an API read, with no request.
 */
export type Strategy = 'assembly' | 'template' | 'static' | 'projection' | 'data';

/**
 * how long a principal route's copy may live on the device: `persistent` seals it under a key that
 * stays in IndexedDB, `session` under a key held in the worker's memory, which a worker restart loses
 */
export type Retention = 'persistent' | 'session';

/** `hard` blocks on a sync once `maxStale` passes; `soft` shows first and syncs once after */
export type FreshnessMode = 'hard' | 'soft';

/** the staleness contract of a route; `maxStale` is in seconds */
export type Freshness = {
	/** seconds a copy may age before the mode applies */
	maxStale: number;
	/** what happens past maxStale: block on a sync, or show first and sync later */
	mode: FreshnessMode;
};

/** whether the worker may show a snapshot it cannot validate because the network is down */
export type OfflineRule = 'serve' | 'refuse';

/** who is asking, as the app's `identity.resolve` reports it */
export type Identity = {
	/** the principal's id, as identity.resolve reports it */
	principal: string;
	/** role names the principal holds; absent when none */
	roles?: readonly string[];
};

/** when a soft route past its bound refreshes: right after the view, or at the next network moment */
export type SyncRule = 'background' | 'deferred';

/**
 * What `depends` and `load` receive. `record` and `projection` put data into the replica once
 * and return the reference to embed in the page's data; see {@link Collector}.
 */
export type RouteContext = {
	/** the request being answered */
	request: Request;
	/** the request URL, parsed */
	url: URL;
	/** the values the route pattern captured */
	params: Params;
	/** the principal the app resolved for this request; null when none */
	identity: Identity | null;
} & Pick<Collector, 'record' | 'projection'>;

/** public routes default to 15 minutes soft, principal routes to 5 minutes hard */
export const DEFAULT_FRESHNESS: Record<Scope, Freshness> = {
	public: { maxStale: 900, mode: 'soft' },
	principal: { maxStale: 300, mode: 'hard' }
};

/**
 * a page a route's catalogue suggests, with the share of devices expected to open it next and,
 * when the share is an estimate, `n`, the observations behind it
 */
export type CatalogueGuess = {
	/** the page path a device may open next */
	path: string;
	/** share of devices expected to open the page next, from 0 to 1 */
	p: number;
	/** observations behind p; absent when p is a fixed prior */
	n?: number;
};

/** the declaration fields every strategy shares */
export type RouteCommon = {
	/** public or principal; public when absent */
	scope?: Scope;
	/** overrides the scope's default maxStale and mode */
	freshness?: Partial<Freshness>;
	/** keep the artifact across worker restarts; default true */
	persist?: boolean;
	/** serve shows a snapshot offline, refuse does not; default follows the scope */
	offline?: OfflineRule;
	/** `shadow` renders locally and compares but never serves; the server's mode when absent */
	mode?: Mode;
	/** how a soft route past its bound refreshes; default `background` */
	sync?: SyncRule;
	/** tags the artifact is built from; records and projections the load registers are added */
	depends?(ctx: RouteContext): readonly string[] | Promise<readonly string[]>;
	/** a principal route's at-rest key; default `session` */
	retention?: Retention;
	/** overrides the provisioning priors for this route when the server decides whether to ship it */
	provision?: {
		/** chance a provisioned artifact serves a later view; the server's prior when absent */
		reuse?: number;
		/** later views one provisioned artifact is expected to serve; the server's prior when absent */
		futureViews?: number;
	};
	/**
	 * Pages a device on this route may open next, each with the share of devices expected to
	 * (from the site's own `nextShare` over the sink, link position, or a fixed prior). The server
	 * ships the data of those that repay their transfer, never their HTML. Only `template`,
	 * `projection` and `data` routes can be entries.
	 */
	catalogue?(ctx: RouteContext): readonly CatalogueGuess[] | Promise<readonly CatalogueGuess[]>;
	/** compressed bytes of the document this route renders, which a catalogue entry for it replaces; the server's prior when absent */
	documentBytes?: number;
};

/** a route answered by filling placeholders in a stored shell */
export type AssemblyRoute = RouteCommon & {
	/** fills placeholders in a stored shell */
	strategy: 'assembly';
	/** returns the body that fills the shell's placeholders */
	load(ctx: RouteContext): AssemblyBody | Promise<AssemblyBody>;
};

/** the declaration of a public route that answers query strings from a collection it holds */
export type QueryRoute = {
	/**
	 * The query strings the worker answers from the stored collection. `load` then returns an
	 * object whose `list` key holds the array and which carries `proof: await datasetProof(items)`.
	 */
	query?: QuerySchema;
};

/** a route answered by rendering stored JSON through a compiled template */
export type TemplateRoute = RouteCommon &
	QueryRoute & {
		/** renders stored JSON through the template */
		strategy: 'template';
		/** the template source, compiled once when the route is defined */
		template: TemplateSource;
		/** returns the JSON the template renders */
		load(ctx: RouteContext): unknown;
	};

/**
 * A route for a file the application serves as is, such as a page or an asset with fixed bytes.
 * The worker stores the response it fetched and shows it with no request until a tag in
 * `depends` changes or the freshness bound passes. It has no `load`, is always public, and
 * is answered in `serve` mode only.
 */
export type StaticRoute = Omit<RouteCommon, 'scope' | 'persist' | 'mode' | 'retention'> & {
	/** the file's response, stored and shown with no request */
	strategy: 'static';
	/** always absent; a static route is public */
	scope?: undefined;
	/** always absent; a static route is always kept */
	persist?: undefined;
	/** always absent; a static route has no mode */
	mode?: undefined;
	/** always absent; a static route has no load */
	load?: undefined;
};

/**
 * A route whose stored JSON a bundled worker renders into a page: `serve(config, renderers)` from
 * `@drupflare/spool/sw` takes a renderer keyed by this pattern. Without one the worker refuses the
 * local view and the network answers.
 */
export type ProjectionRoute = RouteCommon &
	QueryRoute & {
		/** renders stored JSON with the renderer the bundled worker holds */
		strategy: 'projection';
		/** returns the JSON the renderer receives */
		load(ctx: RouteContext): unknown;
	};

/**
 * A route for a JSON read. The worker answers a GET (not a navigation) from the stored value with
 * `JSON.stringify`, so the application's own handler has to return the same JSON `load` does.
 */
export type DataRoute = RouteCommon &
	QueryRoute & {
		/** answers a GET with the stored JSON */
		strategy: 'data';
		/** returns the JSON the local answer serializes */
		load(ctx: RouteContext): unknown;
		/** the content type of the local answer; default `application/json` */
		contentType?: string;
	};

/** what `defineRoute` accepts */
export type RouteDeclaration =
	AssemblyRoute | TemplateRoute | StaticRoute | ProjectionRoute | DataRoute;

/** a validated route with every default applied */
export type Route = {
	/** the path pattern the route matches */
	pattern: string;
	/** how the route is answered locally */
	strategy: Strategy;
	/** public or principal, after the default */
	scope: Scope;
	/** the staleness contract with every default applied */
	freshness: Freshness;
	/** whether the artifact survives a worker restart; true by default */
	persist: boolean;
	/** whether a snapshot may be shown while offline, after the default */
	offline: OfflineRule;
	/** serve or shadow; absent means the server decides */
	mode?: Mode;
	/** when a soft route past its bound refreshes */
	sync: SyncRule;
	/** at-rest key lifetime; set only on principal routes */
	retention?: Retention;
	/** content type of a data route's local answer */
	contentType?: string;
	/** provisioning priors that override the server's for this route */
	provision?: {
		/** chance a provisioned artifact serves a later view; the server's prior when absent */
		reuse?: number;
		/** later views one provisioned artifact is expected to serve; the server's prior when absent */
		futureViews?: number;
	};
	/** the compiled template of a template route */
	template?: CompiledTemplate;
	/** the route's catalogue function, when it declares one */
	catalogue?: RouteCommon['catalogue'];
	/** compressed bytes of the document the route renders */
	documentBytes?: number;
	/** query strings the worker answers from the stored collection */
	query?: QuerySchema;
	/** tags the artifact is built from; a change to one invalidates it */
	depends(ctx: RouteContext): readonly string[] | Promise<readonly string[]>;
	/** returns the data the artifact is built from */
	load(ctx: RouteContext): unknown;
};

/** the part of a route the service worker needs; functions stay on the server */
export type SerializedRoute = {
	/** the path pattern the route matches */
	pattern: string;
	/** how the route is answered locally */
	strategy: Strategy;
	/** public or principal */
	scope: Scope;
	/** the staleness contract, with maxStale in seconds */
	freshness: Freshness;
	/** whether the artifact survives a worker restart */
	persist: boolean;
	/** whether a snapshot may be shown while offline */
	offline: OfflineRule;
	/** serve or shadow; absent means the server decides */
	mode?: Mode;
	/** when a soft route past its bound refreshes */
	sync: SyncRule;
	/** a principal route's at-rest key; absent on a public route */
	retention?: Retention;
	/** the content type a `data` route answers with, when it is not JSON */
	type?: string;
	/** what a manifest route's file is at now; the worker compares it with the stored copy */
	version?: string;
	/** the route declares a `catalogue`, so the worker asks for one when a flush goes out on it */
	catalogue?: true;
	/** the query strings the worker answers from the stored collection of a public route */
	query?: QuerySchema;
};

function bad(pattern: string, message: string): never {
	throw new ProtocolError('bad-route', `${pattern}: ${message}`);
}

const QUERY_KEYS = ['list', 'filter', 'sort', 'pageSize'];
const RESERVED = ['sort', 'page'];

/** the validated copy of a route's `query`; throws `bad-route` for a schema the worker could not apply */
function checkQuery(pattern: string, value: unknown): QuerySchema {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return bad(pattern, 'query must be an object');
	}
	const given = value as Record<string, unknown>;
	for (const key of Object.keys(given)) {
		if (!QUERY_KEYS.includes(key)) return bad(pattern, `unknown query option "${key}"`);
	}
	const { list, filter, sort, pageSize } = given;
	if (typeof list !== 'string' || list === '') return bad(pattern, 'query.list must be a name');
	if (list === 'proof' || list === 'query') {
		return bad(pattern, `query.list cannot be "${list}", which the data already uses`);
	}
	const out: QuerySchema = { list };
	if (filter !== undefined) {
		if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
			return bad(pattern, 'query.filter must be an object');
		}
		out.filter = {};
		for (const [name, type] of Object.entries(filter)) {
			if (name === '' || RESERVED.includes(name)) {
				return bad(pattern, `query.filter cannot name "${name}"`);
			}
			if (type !== 'string' && type !== 'number') {
				return bad(pattern, `query.filter.${name} must be "string" or "number"`);
			}
			out.filter[name] = type;
		}
	}
	if (sort !== undefined) {
		if (!Array.isArray(sort)) return bad(pattern, 'query.sort must be a list of field names');
		for (const field of sort) {
			if (typeof field !== 'string' || field === '' || RESERVED.includes(field)) {
				return bad(pattern, `query.sort cannot name ${JSON.stringify(field)}`);
			}
		}
		out.sort = [...(sort as string[])];
	}
	if (pageSize !== undefined) {
		if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1) {
			return bad(pattern, 'query.pageSize must be a positive integer');
		}
		out.pageSize = pageSize;
	}
	return out;
}

/**
 * Declares a route. Validates the pattern and the freshness contract, compiles a template, and
 * fills the defaults: freshness by scope, and `offline` as `serve` for public, `refuse` for
 * principal.
 */
export function defineRoute(pattern: string, declaration: RouteDeclaration): Route {
	checkPattern(pattern);
	const strategy: string = declaration.strategy;
	if (!['assembly', 'template', 'static', 'projection', 'data'].includes(strategy)) {
		return bad(pattern, `unknown strategy "${strategy}"`);
	}
	if (declaration.strategy === 'static') {
		if (declaration.scope !== undefined) return bad(pattern, 'a static route is always public');
		if (declaration.persist !== undefined) return bad(pattern, 'a static route is always kept');
		if (declaration.mode !== undefined) return bad(pattern, 'a static route has no mode');
		if (declaration.load !== undefined) return bad(pattern, 'a static route has no load');
	}
	const scope = declaration.scope ?? 'public';
	if (scope !== 'public' && scope !== 'principal')
		return bad(pattern, `unknown scope "${scope}"`);
	const freshness = { ...DEFAULT_FRESHNESS[scope], ...declaration.freshness };
	if (!Number.isFinite(freshness.maxStale) || freshness.maxStale <= 0) {
		return bad(pattern, 'freshness.maxStale must be a positive number of seconds');
	}
	if (freshness.mode !== 'hard' && freshness.mode !== 'soft') {
		return bad(pattern, `unknown freshness mode "${String(freshness.mode)}"`);
	}
	const offline = declaration.offline ?? (scope === 'public' ? 'serve' : 'refuse');
	if (offline !== 'serve' && offline !== 'refuse') {
		return bad(pattern, `unknown offline rule "${String(offline)}"`);
	}
	const sync = declaration.sync ?? 'background';
	if (sync !== 'background' && sync !== 'deferred') {
		return bad(pattern, `unknown sync rule "${String(sync)}"`);
	}
	if (
		declaration.mode !== undefined &&
		declaration.mode !== 'serve' &&
		declaration.mode !== 'shadow'
	) {
		return bad(pattern, `unknown mode "${String(declaration.mode)}"`);
	}
	if (declaration.strategy !== 'static' && typeof declaration.load !== 'function') {
		return bad(pattern, 'load is required');
	}
	const declared = declaration.strategy === 'static' ? undefined : declaration.retention;
	const retention = declared ?? 'session';
	if (retention !== 'persistent' && retention !== 'session') {
		return bad(pattern, `unknown retention "${String(retention)}"`);
	}
	if (declared !== undefined && scope !== 'principal') {
		return bad(pattern, 'retention applies to a principal route');
	}

	const route: Route = {
		pattern,
		strategy: declaration.strategy,
		scope,
		freshness,
		persist: declaration.persist ?? true,
		offline,
		sync,
		depends: declaration.depends ?? (() => []),
		load: declaration.load ?? (() => undefined)
	};
	if (declaration.mode) route.mode = declaration.mode;
	if (scope === 'principal') route.retention = retention;
	if (declaration.provision) route.provision = declaration.provision;
	if (declaration.catalogue !== undefined) {
		if (typeof declaration.catalogue !== 'function')
			return bad(pattern, 'catalogue must be a function');
		route.catalogue = declaration.catalogue;
	}
	if (declaration.documentBytes !== undefined) {
		if (!Number.isFinite(declaration.documentBytes) || declaration.documentBytes < 0) {
			return bad(pattern, 'documentBytes must be a non-negative number');
		}
		route.documentBytes = declaration.documentBytes;
	}
	if (declaration.strategy === 'data' && declaration.contentType) {
		route.contentType = declaration.contentType;
	}
	const query = (declaration as { query?: unknown }).query;
	if (query !== undefined) {
		if (scope !== 'public') return bad(pattern, 'query applies to a public route');
		if (!['template', 'projection', 'data'].includes(declaration.strategy)) {
			return bad(pattern, `a ${declaration.strategy} route cannot declare query`);
		}
		route.query = checkQuery(pattern, query);
	}
	if (declaration.strategy === 'template') {
		if (!declaration.template) return bad(pattern, 'a template route needs a template');
		route.template = compileTemplate(declaration.template);
	}
	return route;
}

/** the first route whose pattern fits `path`, with the params it captured */
export function matchRoute<
	T extends {
		/** the pattern a route is matched by */
		pattern: string;
	}
>(
	routes: readonly T[],
	path: string
): {
	/** the first route whose pattern matches the path */
	route: T;
	/** the values the pattern captured from the path */
	params: Params;
} | null {
	for (const route of routes) {
		const params = matchPattern(route.pattern, path);
		if (params) return { route, params };
	}
	return null;
}

/** strips a route to what the service worker config carries */
export function serializeRoute(route: Route): SerializedRoute {
	const { pattern, strategy, scope, freshness, persist, offline, sync } = route;
	const out: SerializedRoute = {
		pattern,
		strategy,
		scope,
		freshness: { ...freshness },
		persist,
		offline,
		sync
	};
	if (route.mode) out.mode = route.mode;
	if (route.retention) out.retention = route.retention;
	if (route.contentType) out.type = route.contentType;
	if (route.catalogue) out.catalogue = true;
	if (route.query) out.query = structuredClone(route.query);
	return out;
}
