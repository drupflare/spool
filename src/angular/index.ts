import { formatDevReport } from '../plugins/report.js';
import {
	angularPages,
	type AngularPage,
	type AngularRoute,
	type AngularServerRoute
} from './pages.js';

export type { AngularPage, AngularRoute, AngularServerRoute } from './pages.js';

/**
 * The registrations for an Angular app's `Routes` array and its `serverRoutes`. Each page registers
 * under the mode its server route declares; a dynamic page stays on the network until the app
 * declares its family. In development (`NODE_ENV` is not `production`) it prints the routes it
 * registered, the ones it left to the network and why. Angular's dev server has no plugin hook, so
 * the report is printed here, not by the dev server, and it cannot list uncovered GETs.
 */
export function spoolAngular(options: {
	routes: readonly AngularRoute[];
	serverRoutes: readonly AngularServerRoute[];
}): AngularPage[] {
	const pages = angularPages(options.routes, options.serverRoutes);
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	if (env !== undefined && env['NODE_ENV'] !== 'production') {
		console.info(
			formatDevReport({
				registered: pages.flatMap((page) =>
					page.pattern && page.register !== 'network'
						? [{ pattern: page.pattern, register: page.register, maxAge: page.maxAge }]
						: []
				),
				network: pages
					.filter((page) => page.register === 'network')
					.map((page) => ({ path: page.path, reason: page.reason }))
			})
		);
	}
	return pages;
}
