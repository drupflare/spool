import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDevReport } from '../plugins/report.js';
import type { Spool } from '../server/spool.js';
import { nextPages } from './pages.js';

export { nextPages } from './pages.js';
export type { NextBuildInput, NextPageRegistration } from './pages.js';

/** the file the adapter writes into Next's dist directory; the app reads it when it starts */
export const SPOOL_PAGES_FILE = 'spool-pages.json';

export type BuildContext = {
	distDir: string;
	config: { cacheComponents?: boolean };
	outputs: {
		appPages: Array<{ pathname: string }>;
		prerenders: Array<{ pathname: string }>;
	};
};

/**
 * The Next adapter. Point `adapterPath` in `next.config` at this subpath; after `next build` it
 * writes the page registrations to `SPOOL_PAGES_FILE` and prints the report. Next runs no adapter
 * in `next dev`, so the report is a build report and lists no uncovered GETs.
 */
export default {
	name: '@drupflare/spool/next',
	onBuildComplete(ctx: BuildContext): void {
		// next also lists each page's rsc payload and its own /_ routes, which are not pages
		const isPage = (pathname: string) =>
			!pathname.endsWith('.rsc') && !pathname.startsWith('/_');
		const pages = nextPages({
			pages: ctx.outputs.appPages.map((output) => output.pathname).filter(isPage),
			prerendered: ctx.outputs.prerenders.map((output) => output.pathname).filter(isPage),
			cacheComponents: ctx.config.cacheComponents === true
		});
		writeFileSync(join(ctx.distDir, SPOOL_PAGES_FILE), JSON.stringify(pages));
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
};

/** the page runtime script tag, for the app layout; spool adds it to a page at most once */
export function spoolTag(spool: Spool): string {
	return spool.config.clientTag;
}

/** a route handler for `/spool-sw.js` and `/.spool/**`; any other request it sees gets a 404 */
export function spoolRouteHandler(spool: Spool): (request: Request) => Promise<Response> {
	return (request) => spool.handle(request, () => new Response('not found', { status: 404 }));
}
