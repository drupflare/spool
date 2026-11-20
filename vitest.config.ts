import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const subpaths: Record<string, string> = {
	'': 'src/index.ts',
	'/angular': 'src/angular/index.ts',
	'/client': 'src/client/index.ts',
	'/express': 'src/express/index.ts',
	'/hono': 'src/hono/index.ts',
	'/media': 'src/media/index.ts',
	'/next': 'src/next/index.ts',
	'/node': 'src/node/listener.ts',
	'/nuxt': 'src/nuxt/index.ts',
	'/protocol': 'src/protocol/index.ts',
	'/react-router': 'src/react-router/index.ts',
	'/proxy': 'src/proxy/index.ts',
	'/report': 'src/report/index.ts',
	'/server': 'src/server/index.ts',
	'/stores': 'src/stores/index.ts',
	'/stores/durable-object': 'src/stores/durable-object.ts',
	'/sw': 'src/sw/index.ts',
	'/trim': 'src/trim/index.ts',
	'/vite': 'src/vite/index.ts'
};

const alias = Object.entries(subpaths).map(([subpath, file]) => ({
	find: new RegExp(`^@drupflare/spool${subpath}$`),
	replacement: resolve(file)
}));

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: { isolatedStorage: true }
					})
				],
				test: {
					name: 'unit',
					include: ['tests/unit/*.spec.ts'],
					alias,
					maxWorkers: process.env.CI ? 1 : 2,
					testTimeout: 15000
				}
			},
			{
				// what workerd cannot reach (the filesystem, package.json as data); still in the gate
				test: {
					name: 'node',
					include: ['tests/node/*.spec.ts'],
					environment: 'node',
					alias,
					maxWorkers: process.env.CI ? 1 : 2
				}
			}
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: ['src/**'],
			exclude: ['tests/**', '**/*.d.ts']
		}
	}
});
