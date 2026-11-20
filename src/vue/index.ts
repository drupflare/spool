import type { Plugin, ResolvedConfig } from 'vite';
import { registerMode, type Registration } from '../plugins/mode.js';
import { toSpoolPattern } from '../plugins/path.js';
import { formatDevReport } from '../plugins/report.js';
import type { Spool } from '../server/spool.js';
import { spoolVite, type StaticOption } from '../vite/index.js';

/** the fields of a vue-router route record the plugin reads; `RouteRecordNormalized` has them */
export type VueRouteRecord = { path: string };

/** the router the plugin reads: `getRoutes()` of a vue-router instance */
export type VueRouter = { getRoutes(): readonly VueRouteRecord[] };

/** one route as the plugin registers it; `pattern` is set only when the path converts */
export type VuePage = Registration & { path: string; pattern?: string };

/**
 * Every route of `router` as a registration. The app is a single-page app, so each route renders on
 * the client and registers as the app shell. A path spool cannot express stays a network route.
 */
export function vuePages(router: VueRouter): VuePage[] {
	return router.getRoutes().map((record) => {
		const converted = toSpoolPattern('vue-router', record.path);
		if (converted.kind === 'network') {
			return { path: record.path, register: 'network', reason: converted.reason };
		}
		const registration = registerMode({ rendering: 'client', enumerable: true });
		return { path: record.path, pattern: converted.pattern, ...registration };
	});
}

/** what `spoolVue` takes */
export type SpoolVueOptions = {
	/** the instance the app's routes were declared for; the dev server answers from it */
	spool: Spool;
	/** the vue-router instance whose routes the development report lists */
	router: VueRouter;
	/** the build-time static tier, as `spoolVite` takes it; on by default, `false` turns it off */
	static?: StaticOption;
};

/**
 * A Vite plugin for a Vue single-page app. It is `spoolVite` plus a development report: at
 * startup it logs the routes that register, and each route that stays on the network with its reason.
 */
export function spoolVue(options: SpoolVueOptions): Plugin {
	const base = spoolVite({
		spool: options.spool,
		...(options.static === undefined ? {} : { static: options.static })
	});
	return {
		...base,
		name: '@drupflare/spool/vue',
		configResolved(config: ResolvedConfig) {
			base.configResolved(config);
			if (config.command !== 'serve') return;
			const pages = vuePages(options.router);
			config.logger.info(
				formatDevReport({
					registered: pages.flatMap((page) =>
						page.pattern && page.register !== 'network'
							? [
									{
										pattern: page.pattern,
										register: page.register,
										maxAge: page.maxAge
									}
								]
							: []
					),
					network: pages
						.filter((page) => page.register === 'network')
						.map((page) => ({ path: page.path, reason: page.reason })),
					uncovered: []
				})
			);
		}
	};
}
