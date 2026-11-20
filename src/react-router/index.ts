import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { formatDevReport } from '../plugins/report.js';
import type { Spool } from '../server/spool.js';
import { spoolVite, type StaticOption } from '../vite/index.js';
import { reactRouterPages, type ReactRouterSettings, type RouteEntryInput } from './pages.js';

export { flattenRoutes, reactRouterPages } from './pages.js';
export type {
	PrerenderPaths,
	ReactRouterSettings,
	RouteEntryInput,
	RouteRegistration
} from './pages.js';

/** what `spoolReactRouter` takes */
export type SpoolReactRouterOptions = {
	/** the instance the app's routes were declared for; the dev server answers from it */
	spool: Spool;
	/** the build-time static tier, as `spoolVite` takes it; on by default, `false` turns it off */
	static?: StaticOption;
};

const CONFIG_FILES = [
	'react-router.config.ts',
	'react-router.config.mts',
	'react-router.config.js',
	'react-router.config.mjs'
];
const ROUTE_FILES = ['routes.ts', 'routes.tsx', 'routes.js', 'routes.mjs', 'routes.mts'];

function firstFile(dir: string, names: string[]): string | undefined {
	return names.map((name) => resolve(dir, name)).find((file) => existsSync(file));
}

async function reportRoutes(server: ViteDevServer): Promise<void> {
	const { root } = server.config;
	const configFile = firstFile(root, CONFIG_FILES);
	const settings: ReactRouterSettings = configFile
		? ((await server.ssrLoadModule(configFile)).default ?? {})
		: {};
	const routesFile = firstFile(resolve(root, settings.appDirectory ?? 'app'), ROUTE_FILES);
	if (routesFile === undefined) return;
	const entries = (await server.ssrLoadModule(routesFile)).default as
		RouteEntryInput[] | Promise<RouteEntryInput[]>;
	const pages = reactRouterPages(await entries, settings);
	server.config.logger.info(
		formatDevReport({
			registered: pages.flatMap((page) =>
				page.pattern && page.register !== 'network'
					? [{ pattern: page.pattern, register: page.register, maxAge: page.maxAge }]
					: []
			),
			network: pages
				.filter((page) => page.register === 'network')
				.map((page) => ({ path: page.path, reason: page.reason })),
			uncovered: []
		})
	);
}

/**
 * The React Router integration for the dev server. It serves the worker script and spool's paths
 * from `spool`, and prints the routes it registered, the ones it left to the network and why. A
 * production response gets spool's envelope and tag from `spool.handle`, which wraps the React
 * Router request handler; the Vite plugin does not reach server-rendered HTML. The client build
 * also publishes the static tier into its output directory (see `static`).
 */
export function spoolReactRouter(options: SpoolReactRouterOptions): Plugin[] {
	return [
		spoolVite(options),
		{
			name: '@drupflare/spool/react-router:report',
			apply: 'serve',
			configureServer(server) {
				return () => {
					reportRoutes(server).catch((error: unknown) => {
						server.config.logger.error(
							`spool: could not read the routes: ${String(error)}`
						);
					});
				};
			}
		}
	];
}
