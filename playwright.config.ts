import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

const isCI = !!process.env.CI;
const reporters: ReporterDescription[] = [['list']];
if (isCI) {
	reporters.push(['github']);
	reporters.push(['json', { outputFile: 'playwright-report/results.json' }]);
}

export default defineConfig({
	testDir: './tests/browser',
	testMatch: '**/*.pw.ts',
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	retries: 0,
	timeout: 60_000,
	reporter: reporters,
	outputDir: 'playwright-results',
	use: { trace: 'retain-on-failure' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	]
});
