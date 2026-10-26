import { expect, test, type Page } from '@playwright/test';
import { normalise } from '../../src/protocol/index';
import { BOUND, startProxy, type Kind, type ProxyFixture } from './fixture-proxy';

/**
 * Two origins that have never heard of spool, a `node:http` server and `php -S` sending
 * `X-Drupal-Cache-Tags`, each behind `spoolProxy`. The proxy log and the origin log are the
 * arbiters of what reached them.
 */

type Client = { status(): Promise<{ artifacts: string[]; beacons: number }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

async function sleepPast(seconds: number): Promise<void> {
	const until = Date.now() + seconds * 1000 + 250;
	while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

for (const kind of ['node', 'php'] as Kind[]) {
	test.describe(`${kind} origin behind spoolProxy`, () => {
		let fx: ProxyFixture;
		const paths = () => [1, 2, 3].map((id) => fx.pathOf(id));
		/** proxy hits that are not the worker script, which WebKit re-checks */
		const seen = () => fx.proxyHits.filter((path) => path !== '/spool-sw.js');
		const reset = () => {
			fx.proxyHits.length = 0;
			fx.originHits.length = 0;
		};

		test.beforeEach(async () => {
			fx = await startProxy(kind);
		});
		test.afterEach(() => fx.stop());

		/** waits until the proxy has seen no new request for a moment, so a flush started by the last view has landed */
		async function quiet(): Promise<void> {
			for (let last = -1; fx.proxyHits.length !== last;) {
				last = fx.proxyHits.length;
				await new Promise((r) => setTimeout(r, 300));
			}
		}

		/** registers the worker through the page runtime, then visits every page so each is provisioned */
		async function warm(page: Page): Promise<void> {
			await page.goto(`${fx.front}${paths()[0]}`);
			await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
			await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
			for (const path of paths()) {
				await page.goto(`${fx.front}${path}`);
				await expect.poll(async () => (await status(page)).artifacts).toContain(path);
			}
			await quiet();
		}

		test('a warm page makes 0 origin hits and 0 proxy hits per local navigation', async ({
			page,
			context,
			browserName
		}) => {
			const [first, ...rest] = paths();
			await warm(page);
			await page.goto(`${fx.front}${first}`);
			reset();

			for (const path of rest) {
				await Promise.all([page.waitForURL(`**${path}`), page.click(`a[href="${path}"]`)]);
				await expect(page.locator('h1')).toContainText(`Page ${path.split('/')[2]}`);
			}
			for (const path of paths()) await page.goto(`${fx.front}${path}`);
			const tab = await context.newPage();
			await tab.goto(`${fx.front}${paths()[2]}`);
			await expect(tab.locator('h1')).toHaveText('Page 3');

			expect(fx.originHits).toEqual([]);
			expect(seen()).toEqual([]);
			if (browserName !== 'webkit') expect(fx.proxyHits).toEqual([]);
		});

		test('the local page equals the page the proxy sends', async ({ page, browser }) => {
			await warm(page);
			const blocked = await browser.newContext({ serviceWorkers: 'block' });
			const network = await blocked.newPage();
			for (const path of paths()) {
				await network.goto(`${fx.front}${path}`);
				const expected = await network.evaluate(() => document.documentElement.outerHTML);
				reset();
				await page.goto(`${fx.front}${path}`);
				const local = await page.evaluate(() => document.documentElement.outerHTML);
				expect(normalise(local)).toBe(normalise(expected));
				expect(fx.originHits).toEqual([]);
			}
			await blocked.close();
		});

		test('a purge for one tag makes exactly the pages carrying it refetch on their next sync', async ({
			page
		}) => {
			const [p1, p2, p3] = paths() as [string, string, string];
			await warm(page);
			await sleepPast(BOUND);
			fx.edit(2, 'edited 2');
			expect((await fx.purge(['node:2'])).status).toBe(200);
			reset();

			await page.goto(`${fx.front}${p1}`);
			await expect(page.locator('#note')).toHaveText('original');
			expect(seen()).toEqual(['/.spool/sync']);
			await page.goto(`${fx.front}${p3}`);
			await expect(page.locator('#note')).toHaveText('original');
			expect(seen()).toEqual(['/.spool/sync']);
			expect(fx.originHits).toEqual([]);

			await page.goto(`${fx.front}${p2}`);
			await expect(page.locator('#note')).toHaveText('edited 2');
			await quiet();
			expect(seen()).toEqual(['/.spool/sync', p2]);
			expect(fx.originHits).toEqual([p2]);
		});

		test('a purge for a tag every page carries makes every page refetch', async ({ page }) => {
			await warm(page);
			await sleepPast(BOUND);
			expect((await fx.purge([fx.sharedTag])).status).toBe(200);
			reset();
			for (const path of paths()) await page.goto(`${fx.front}${path}`);
			await quiet();
			const [sync, ...rest] = seen();
			expect(sync).toBe('/.spool/sync');
			expect(rest.sort()).toEqual(paths());
			expect([...fx.originHits].sort()).toEqual(paths());
		});

		test('a change the proxy sees on any visitor request reaches the warm browser at its next sync', async ({
			page
		}) => {
			const [p1, , p3] = paths() as [string, string, string];
			await warm(page);
			await sleepPast(BOUND);
			fx.edit(3, 'edited 3');
			const plain = await fetch(`${fx.front}${p3}`);
			expect(await plain.text()).toContain('edited 3');
			reset();

			// the bump names every tag the changed page carries, the shared one included
			await page.goto(`${fx.front}${p1}`);
			await expect(page.locator('#note')).toHaveText('original');
			await quiet();
			expect(seen()).toEqual(['/.spool/sync', p1]);
			await page.goto(`${fx.front}${p3}`);
			await expect(page.locator('#note')).toHaveText('edited 3');
			await quiet();
			expect(seen()).toEqual(['/.spool/sync', p1, p3]);
			expect(fx.originHits).toEqual([p1, p3]);
		});

		test('a cold page is stored from its own response, with no artifact request, and the next view is local', async ({
			page,
			browserName
		}) => {
			const [p1, p2] = paths() as [string, string];
			await page.goto(`${fx.front}${p1}`);
			await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
			await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
			for (const path of [p1, p2]) {
				await page.goto(`${fx.front}${path}`);
				await expect.poll(async () => (await status(page)).artifacts).toContain(path);
			}
			await quiet();
			expect(fx.proxyHits.filter((path) => path === '/.spool/artifact')).toEqual([]);
			expect(fx.originHits.filter((path) => paths().includes(path)).sort()).toEqual([
				p1,
				p1,
				p2
			]);

			reset();
			await page.goto(`${fx.front}${p2}`);
			await expect(page.locator('h1')).toHaveText('Page 2');
			expect(fx.originHits).toEqual([]);
			expect(seen()).toEqual([]);
			if (browserName !== 'webkit') expect(fx.proxyHits).toEqual([]);
		});

		test('a cookie-bearing page is never served locally', async ({ page, context }) => {
			const [p1] = paths() as [string];
			await context.addCookies([{ name: 'SESS', value: '1', url: fx.front }]);
			for (let view = 0; view < 3; view++) await page.goto(`${fx.front}${p1}`);
			await expect(page.locator('h1')).toHaveText('Page 1');
			expect(fx.proxyHits.filter((path) => path === p1)).toHaveLength(3);
			expect(await page.locator('script[data-spool-client]').count()).toBe(0);
			expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
		});

		test('a login after warm-up drops every copy, and the pages then come from the origin', async ({
			page
		}) => {
			const [p1, p2, p3] = paths() as [string, string, string];
			await warm(page);
			await page.goto(`${fx.front}/login`);
			reset();
			await expect
				.poll(async () => {
					await page.goto(`${fx.front}${p1}`);
					return fx.proxyHits.includes(p1);
				})
				.toBe(true);
			expect(await page.locator('script[data-spool-client]').count()).toBe(0);
			reset();
			for (const path of [p2, p3, p1]) await page.goto(`${fx.front}${path}`);
			await quiet();
			expect(seen().filter((path) => !path.startsWith('/.spool/'))).toEqual([p2, p3, p1]);
			expect(seen().filter((path) => path === '/.spool/artifact')).toEqual([]);
		});
	});
}
