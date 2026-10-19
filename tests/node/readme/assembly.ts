import { placeholder, slot } from '../../../src/protocol/index';
import { defineRoute } from '../../../src/server/index';

export const about = defineRoute('/about', {
	strategy: 'assembly',
	depends: () => ['menu'],
	load: () => ({
		shell: `<!doctype html><html><head><title>About</title></head><body>${placeholder('menu')}<main>Updated ${slot('updated')}</main></body></html>`,
		fragments: { menu: '<nav><a href="/">Home</a></nav>' },
		slots: { updated: '2026-10-19' }
	})
});
