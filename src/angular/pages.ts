import { registerMode, type Registration } from '../plugins/mode.js';
import { toSpoolPattern } from '../plugins/path.js';

/** the fields of an Angular `Route` the registration reads; a `Routes` entry fits this shape */
export type AngularRoute = {
	path?: string;
	redirectTo?: string;
	matcher?: unknown;
	component?: unknown;
	loadComponent?: unknown;
	loadChildren?: unknown;
	children?: readonly AngularRoute[];
};

/** the fields of an Angular `ServerRoute` the registration reads; `renderMode` is set on every variant */
export type AngularServerRoute = {
	path: string;
	renderMode: number;
	getPrerenderParams?: unknown;
};

/** one route as the plugin registers it; `pattern` is set only when the path converts */
export type AngularPage = Registration & { path: string; pattern?: string };

// the values of `RenderMode` in @angular/ssr
const SERVER = 0;
const CLIENT = 1;
const PRERENDER = 2;

type Flat = { path: string; route: AngularRoute };

function joinPath(parent: string, child: string): string {
	if (child === '') return parent;
	return parent === '' ? child : `${parent}/${child}`;
}

function flatten(routes: readonly AngularRoute[], parent = ''): Flat[] {
	return routes.flatMap((route) => {
		const path = joinPath(parent, route.path ?? '');
		return [{ path, route }, ...flatten(route.children ?? [], path)];
	});
}

function network(path: string, reason: string): AngularPage {
	return { path: `/${path}`, register: 'network', reason };
}

function registrationOf(declared: AngularServerRoute, pattern: string): Registration {
	const hasParams = pattern.includes(':');
	if (declared.renderMode === CLIENT) {
		return registerMode({ rendering: 'client', enumerable: true });
	}
	if (declared.renderMode === PRERENDER) {
		const enumerable = !hasParams || declared.getPrerenderParams !== undefined;
		return registerMode({ rendering: 'prerender', enumerable });
	}
	if (declared.renderMode === SERVER) {
		const registration = registerMode({ rendering: 'server', enumerable: !hasParams });
		if (hasParams) {
			registration.reason = `params not enumerable: declare a dataset family for ${pattern}`;
		}
		return registration;
	}
	return { register: 'network', reason: 'unknown render mode' };
}

// a server route matches a route by the same path text; `**` answers a route no other entry names
function pageOf(path: string, serverRoutes: readonly AngularServerRoute[]): AngularPage {
	const converted = toSpoolPattern('angular', path);
	if (converted.kind === 'network') return network(path, converted.reason);
	const declared =
		serverRoutes.find((entry) => entry.path === path) ??
		serverRoutes.find((entry) => entry.path === '**');
	if (declared === undefined) {
		return {
			path: `/${path}`,
			pattern: converted.pattern,
			register: 'network',
			reason: 'no server route declares a render mode'
		};
	}
	return {
		path: `/${path}`,
		pattern: converted.pattern,
		...registrationOf(declared, converted.pattern)
	};
}

function classify(
	flat: Flat,
	serverRoutes: readonly AngularServerRoute[]
): AngularPage | undefined {
	const { path, route } = flat;
	if (route.redirectTo !== undefined)
		return network(path, 'redirect route: the router answers it');
	if (route.matcher !== undefined) return network(path, 'custom matcher route');
	if (route.loadChildren !== undefined) {
		return network(path, 'lazy child routes are not enumerated');
	}
	// a route with no component is a layout; it adds a page only through a child that has one
	if (route.component === undefined && route.loadComponent === undefined) return undefined;
	return pageOf(path, serverRoutes);
}

/**
 * Every page of an Angular `Routes` array as a registration, with each route's render mode read
 * from `serverRoutes`. Nested paths are joined first. A route with no server entry stays on the
 * network, because Angular's default for an unlisted route is not part of its types.
 */
export function angularPages(
	routes: readonly AngularRoute[],
	serverRoutes: readonly AngularServerRoute[]
): AngularPage[] {
	const pages = flatten(routes).flatMap((flat) => {
		const page = classify(flat, serverRoutes);
		return page === undefined ? [] : [page];
	});
	return pages.filter((page, at) => pages.findIndex((other) => other.path === page.path) === at);
}
