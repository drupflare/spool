import { createSpool, defineRoute, memoryBundleStore } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { vuePages } from '@drupflare/spool/vue';
import { memoryRouter } from '../src/routes.ts';

export const ORIGIN = 'https://field-notes.test/';
// advance by one on each publish; the stub's bytes change and devices make a forced check
export const STAMP = 1;

/** one shell route per page the plugin registers; `shell` is the built index.html */
export function appSpool(shell: string, lease = 86_400, stamp: number | (() => number) = STAMP) {
	const shells = vuePages(memoryRouter()).flatMap((page) =>
		page.pattern && page.register !== 'network'
			? [
					defineRoute(page.pattern, {
						strategy: 'template',
						template: { source: shell },
						depends: () => [page.path],
						load: () => ({})
					})
				]
			: []
	);
	return createSpool({
		routes: shells,
		store: memoryStore(),
		bundles: memoryBundleStore(),
		// the stub is written before any page is answered, so the site policy is named here
		policy: {},
		stamp,
		freshness: { maxAge: lease }
	});
}
