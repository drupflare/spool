import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { toNodeListener, type FetchHandler } from '../node/listener.js';
import { devCoverage } from '../plugins/coverage.js';
import { publishStaticBuild, type StaticOption } from '../plugins/static.js';
import { PATHS } from '../protocol/config.js';
import { injectClientTag } from '../protocol/tag.js';
import type { Spool } from '../server/spool.js';

export type { StaticBuildContext, StaticBuildOptions, StaticOption } from '../plugins/static.js';

/** what `spoolVite` takes */
export type SpoolViteOptions = {
	/** the instance the app's routes were declared for; the dev server answers from it */
	spool: Spool;
	/**
	 * Publishes the static tier into the build's output directory when a client build ends: the page
	 * runtime, the worker script, the packs and a `_headers` rule, all served by a static host with no
	 * Worker invocation. On by default; `false` turns it off, and an object sets `policy`, `url` or a
	 * `spool` made from the build output. The dev server does not publish.
	 */
	static?: StaticOption;
};

/** the shape of `this.environment` in a Vite 6 or later build hook, the part the plugin reads */
type BuildEnvironment = { config: { consumer: string; build: { outDir: string } } };

/**
 * A Vite plugin. In `serve` it injects the page runtime tag into HTML entries and serves the worker
 * script and spool's paths from `spool`, and logs each fetch or XHR GET of the dev server's own
 * origin that no data family covers. In a client `build` it publishes the static tier into the
 * output directory (see `static`). The built HTML gets no tag from the plugin: a build goes to the
 * app's spool server, which adds the same tag to each response.
 */
export function spoolVite(
	options: SpoolViteOptions
): Omit<Plugin, 'configResolved'> & { configResolved(config: ResolvedConfig): void } {
	const { spool } = options;
	let resolved: ResolvedConfig | undefined;
	const handle: FetchHandler = (request) => {
		const url = new URL(request.url);
		if (url.pathname === PATHS.worker && request.method === 'GET') return spool.stub(request);
		return spool.respond(request);
	};
	// registered before Vite's own middleware, so spool's paths are not caught by the SPA fallback
	const listener = toNodeListener(handle);
	return {
		name: '@drupflare/spool',
		configResolved(config) {
			resolved = config;
		},
		async closeBundle() {
			if (resolved === undefined || resolved.command !== 'build') return;
			const environment = (this as { environment?: BuildEnvironment }).environment;
			const client = environment
				? environment.config.consumer === 'client'
				: !resolved.build.ssr;
			if (!client) return;
			const { logger, root } = resolved;
			await publishStaticBuild({
				spool,
				option: options.static,
				outDir: resolve(root, (environment?.config ?? resolved).build.outDir),
				log: (line) => logger.info(line)
			});
		},
		configureServer(server) {
			server.middlewares.use(listener);
			const watch = devCoverage(spool.config.routes, (line) =>
				server.config.logger.info(line)
			);
			server.middlewares.use((req, _res, next) => {
				const fetchDest = req.headers['sec-fetch-dest'];
				watch({
					method: req.method ?? 'GET',
					url: `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`,
					fetchDest: typeof fetchDest === 'string' ? fetchDest : null
				});
				next();
			});
		},
		transformIndexHtml(html) {
			return resolved?.command === 'build'
				? html
				: injectClientTag(html, spool.config.clientTag);
		}
	};
}
