import { registerMode, type Registration, type RenderMode } from '../plugins/mode.js';
import { toSpoolPattern } from '../plugins/path.js';

/** the fields of a React Router route entry the registration reads; `RouteConfigEntry` fits this shape */
export type RouteEntryInput = {
	id?: string;
	path?: string;
	index?: boolean;
	file?: string;
	children?: RouteEntryInput[];
};

/** a `prerender` path list, a boolean, or a function that the plugin cannot evaluate */
export type PrerenderPaths = boolean | readonly string[] | ((args: never) => unknown);

/** the `react-router.config.ts` settings that set how routes render; the other keys are not read */
export type ReactRouterSettings = {
	/** `unstable_api-only` is a React Router 8 value that spool does not map */
	ssr?: boolean | 'unstable_api-only';
	prerender?: PrerenderPaths | { paths: PrerenderPaths; concurrency?: number };
	appDirectory?: string;
};

/** how one route is registered; `pattern` is set only when the path converts */
export type RouteRegistration = Registration & { path: string; pattern?: string };

function joinPath(parent: string, child: string): string {
	if (child.startsWith('/')) return child;
	const base = parent.replace(/\/+$/, '');
	return child === '' ? base || '/' : `${base}/${child}`;
}

/** every route path of the tree, parents before children; a layout adds no path of its own */
export function flattenRoutes(entries: readonly RouteEntryInput[], parent = ''): string[] {
	return entries.flatMap((entry) => {
		const path =
			entry.index === true
				? parent || '/'
				: entry.path === undefined
					? undefined
					: joinPath(parent, entry.path);
		const below = path ?? parent;
		return [
			...(path === undefined ? [] : [path]),
			...flattenRoutes(entry.children ?? [], below)
		];
	});
}

function prerenderPaths(prerender: ReactRouterSettings['prerender']): PrerenderPaths | undefined {
	if (prerender !== undefined && typeof prerender === 'object' && 'paths' in prerender) {
		return (prerender as { paths: PrerenderPaths }).paths;
	}
	return prerender as PrerenderPaths | undefined;
}

function prerendered(settings: ReactRouterSettings, path: string): boolean | undefined {
	const setting = prerenderPaths(settings.prerender);
	if (setting === undefined || setting === false) return false;
	if (setting === true) return true;
	if (Array.isArray(setting)) return setting.includes(path);
	return undefined;
}

function registerRoute(path: string, settings: ReactRouterSettings): RouteRegistration {
	const converted = toSpoolPattern('react-router', path);
	if (converted.kind === 'network')
		return { path, register: 'network', reason: converted.reason };
	const { pattern } = converted;
	if (settings.ssr === 'unstable_api-only') {
		return {
			path,
			pattern,
			register: 'network',
			reason: 'ssr unstable_api-only is not mapped'
		};
	}
	if (settings.ssr === false) {
		return { path, pattern, ...registerMode({ rendering: 'client', enumerable: false }) };
	}
	const isPrerendered = prerendered(settings, path);
	if (isPrerendered === undefined) {
		return {
			path,
			pattern,
			register: 'network',
			reason: 'prerender function is not evaluated'
		};
	}
	const enumerable = !pattern.includes(':');
	const mode: RenderMode = {
		rendering: isPrerendered && enumerable ? 'prerender' : 'server',
		enumerable
	};
	const registration = registerMode(mode);
	if (registration.register === 'network' && !enumerable) {
		registration.reason = `params not enumerable: declare a dataset family for ${pattern}`;
	}
	return { path, pattern, ...registration };
}

/**
 * Registers every route of a React Router route array (`app/routes.ts`). Nested paths are joined
 * first. A dynamic route stays on the network until the app declares its family; `ssr` and
 * `prerender` are global settings, so they apply to every route.
 */
export function reactRouterPages(
	entries: readonly RouteEntryInput[],
	settings: ReactRouterSettings = {}
): RouteRegistration[] {
	return [...new Set(flattenRoutes(entries))].map((path) => registerRoute(path, settings));
}
