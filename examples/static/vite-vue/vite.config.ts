import { spoolVue } from '@drupflare/spool/vue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { appSpool } from './server/spool.ts';
import { memoryRouter } from './src/routes.ts';

// the source index.html is only the dev template; the static tier is made from the built shell
const spool = appSpool(readFileSync(new URL('./index.html', import.meta.url), 'utf8'));

export default defineConfig({
	plugins: [
		spoolVue({
			spool,
			router: memoryRouter(),
			static: {
				spool: ({ outDir }) => appSpool(readFileSync(join(outDir, 'index.html'), 'utf8'))
			}
		})
	]
});
