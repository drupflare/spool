import { createSpool, defineRoute } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { vuePages } from '@drupflare/spool/vue';
import { memoryRouter } from '../src/routes.ts';

/** a spool with one shell template per route the plugin registers; `shell` is the app's index.html */
export function appSpool(shell: string) {
	const statics = vuePages(memoryRouter()).flatMap((page) =>
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
	return createSpool({ routes: statics, store: memoryStore() });
}
