import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

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
