import { expect, test } from '@playwright/test';
import { viewsOf } from '../../src/server/index';
import { startFixture, type Fixture } from './fixture';

type SpoolWindow = { spool: { ready: Promise<unknown> } };

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startFixture();
});

test.afterAll(() => fx.stop());

test('a page reports the cross-origin resources it loaded, and one that loaded none reports 0', async ({
	page
}) => {
	await page.goto(`${fx.origin}/n/1`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);

	await page.goto(`${fx.origin}/n/1`);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await page.goto(`${fx.origin}/xo/1`);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await page.waitForFunction(() =>
		performance.getEntriesByType('resource').some((e) => e.name.includes('/pixel.gif'))
	);
	await page.goto(`${fx.origin}/n/2`);
	await page.goto(`${fx.origin}/n/3`);

	await expect
		.poll(() => viewsOf(fx.sink.events).map((v) => [v.route, v.crossOriginLoads]))
		.toEqual(expect.arrayContaining([['/xo/:id', 1]]));
	const views = viewsOf(fx.sink.events);
	expect(views.filter((v) => v.route === '/xo/:id').map((v) => v.crossOriginLoads)).toEqual([1]);
	expect(views.some((v) => v.route === '/n/:id' && v.crossOriginLoads === 1)).toBe(false);
	expect(views.some((v) => v.route === '/n/:id' && v.crossOriginLoads === 0)).toBe(true);
});
