import type { AssemblyBody, Scope } from './artifact.js';
import { ProtocolError } from './errors.js';
import type { Collector } from './graph.js';
import { checkPattern, matchPattern, type Params } from './pattern.js';
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
export type Freshness = { maxStale: number; mode: FreshnessMode };

/** whether the worker may show a snapshot it cannot validate because the network is down */
export type OfflineRule = 'serve' | 'refuse';

/** who is asking, as the app's `identity.resolve` reports it */
export type Identity = { principal: string; roles?: readonly string[] };

/** when a soft route past its bound refreshes: right after the view, or at the next network moment */
export type SyncRule = 'background' | 'deferred';

/**
 * What `depends` and `load` receive. `record` and `projection` put data into the replica once
 * and return the reference to embed in the page's data; see {@link Collector}.
 */
export type RouteContext = {
	request: Request;
	url: URL;
	params: Params;
	identity: Identity | null;
} & Pick<Collector, 'record' | 'projection'>;

/** public routes default to 15 minutes soft, principal routes to 5 minutes hard */
export const DEFAULT_FRESHNESS: Record<Scope, Freshness> = {
	public: { maxStale: 900, mode: 'soft' },
	principal: { maxStale: 300, mode: 'hard' }
};

/** the declaration fields every strategy shares */
export type RouteCommon = {
	scope?: Scope;
	freshness?: Partial<Freshness>;
	/** keep the artifact across worker restarts; default true */
	persist?: boolean;
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
	provision?: { reuse?: number; futureViews?: number };
};

/** a route answered by filling placeholders in a stored shell */
export type AssemblyRoute = RouteCommon & {
	strategy: 'assembly';
	load(ctx: RouteContext): AssemblyBody | Promise<AssemblyBody>;
};

/** a route answered by rendering stored JSON through a compiled template */
export type TemplateRoute = RouteCommon & {
	strategy: 'template';
	template: TemplateSource;
	load(ctx: RouteContext): unknown;
};

/**
 * A route for a file the application serves as is, such as a page or an asset with fixed bytes.
 * The worker stores the response it fetched and shows it with no request until a tag in
 * `depends` changes or the freshness bound passes. It has no `load`, is always public, and
 * is answered in `serve` mode only.
 */
export type StaticRoute = Omit<RouteCommon, 'scope' | 'persist' | 'mode' | 'retention'> & {
	strategy: 'static';
	scope?: undefined;
	persist?: undefined;
	mode?: undefined;
	load?: undefined;
};

/**
 * A route whose stored JSON a bundled worker renders into a page: `serve(config, renderers)` from
 * `@drupflare/spool/sw` takes a renderer keyed by this pattern. Without one the worker refuses the
 * local view and the network answers.
 */
export type ProjectionRoute = RouteCommon & {
	strategy: 'projection';
	load(ctx: RouteContext): unknown;
};

/**
 * A route for a JSON read. The worker answers a GET (not a navigation) from the stored value with
 * `JSON.stringify`, so the application's own handler has to return the same JSON `load` does.
 */
export type DataRoute = RouteCommon & {
	strategy: 'data';
	load(ctx: RouteContext): unknown;
	/** the content type of the local answer; default `application/json` */
	contentType?: string;
};

/** what `defineRoute` accepts */
export type RouteDeclaration =
	AssemblyRoute | TemplateRoute | StaticRoute | ProjectionRoute | DataRoute;

/** a validated route with every default applied */
export type Route = {
	pattern: string;
	strategy: Strategy;
	scope: Scope;
	freshness: Freshness;
	persist: boolean;
	offline: OfflineRule;
	mode?: Mode;
	sync: SyncRule;
	retention?: Retention;
	contentType?: string;
	provision?: { reuse?: number; futureViews?: number };
	template?: CompiledTemplate;
	depends(ctx: RouteContext): readonly string[] | Promise<readonly string[]>;
	load(ctx: RouteContext): unknown;
};

/** the part of a route the service worker needs; functions stay on the server */
export type SerializedRoute = {
	pattern: string;
	strategy: Strategy;
	scope: Scope;
	freshness: Freshness;
	persist: boolean;
	offline: OfflineRule;
	mode?: Mode;
	sync: SyncRule;
	/** a principal route's at-rest key; absent on a public route */
	retention?: Retention;
	/** the content type a `data` route answers with, when it is not JSON */
	type?: string;
	/** what a manifest route's file is at now; the worker compares it with the stored copy */
	version?: string;
};

function bad(pattern: string, message: string): never {
	throw new ProtocolError('bad-route', `${pattern}: ${message}`);
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
	if (declaration.strategy === 'data' && declaration.contentType) {
		route.contentType = declaration.contentType;
	}
	if (declaration.strategy === 'template') {
		if (!declaration.template) return bad(pattern, 'a template route needs a template');
		route.template = compileTemplate(declaration.template);
	}
	return route;
}

/** the first route whose pattern fits `path`, with the params it captured */
export function matchRoute<T extends { pattern: string }>(
	routes: readonly T[],
	path: string
): { route: T; params: Params } | null {
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
	return out;
}
