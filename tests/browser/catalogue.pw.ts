import { expect, test, type Page } from '@playwright/test';
import { viewsOf } from '../../src/server/index';
import { startFixture, type Fixture } from './fixture';

type Client = { status(): Promise<{ artifacts: string[]; beacons: number }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

const fixtures: Fixture[] = [];

test.afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fx) => fx.stop()));
});

const open = async () => {
	const fx = await startFixture();
	fixtures.push(fx);
	return fx;
};

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

/** waits until the server has seen no new request for a moment, so a flush the last step started has landed */
async function quiet(fx: Fixture): Promise<void> {
	for (let last = -1; fx.hits.length !== last;) {
		last = fx.hits.length;
		await new Promise((r) => setTimeout(r, 300));
	}
}

/**
 * Silences the fixture page's own analytics post, whose timing against a view decides whether a
 * flush happens in the view's network moment. The test posts one itself, when it wants a flush due.
 */
const muteRum = (page: Page) =>
	page.addInitScript(() => {
		navigator.sendBeacon = () => true;
		const real = window.fetch.bind(window);
		window.fetch = (input, init) =>
			String(input).includes('/cdn-cgi/rum') && init?.body !== 'held'
				? Promise.resolve(new Response(null, { status: 204 }))
				: real(input, init);
	});

/** registers the worker, views `path` once through the network and waits for it to be stored */
async function warm(fx: Fixture, page: Page, path: string): Promise<void> {
	await muteRum(page);
	await page.goto(`${fx.origin}${path}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await page.goto(`${fx.origin}${path}`);
	await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	await quiet(fx);
}

/** a network moment with a held site beacon, so a flush is due: the held post, then a write the worker passes through */
const moment = (page: Page) =>
	page.evaluate(async () => {
		await fetch('/cdn-cgi/rum', { method: 'POST', body: 'held' });
		await fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text());
	});

/** what the server saw during the moment, minus the held beacon the flush replays */
async function seen(fx: Fixture, page: Page): Promise<string[]> {
	fx.hits.length = 0;
	await moment(page);
	await quiet(fx);
	return fx.hits
		.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/cdn-cgi/rum')
		.map((h) => `${h.method} ${h.path}`)
		.sort();
}

const posts = (fx: Fixture) => fx.hits.filter((h) => h.path === '/.spool/beacon').length;

test('a catalogue entry renders with 0 requests, and the ask sends the one beacon post a site would send later', async ({
	browser,
	browserName
}) => {
	const fx = await open();
	const page = await browser.newPage();
	await warm(fx, page, '/home');
	await expect
		.poll(async () => (await status(page)).artifacts)
		.toEqual(expect.arrayContaining(['/home', '/cat/1', '/cat/2']));
	const askPosts = posts(fx);
	const withCatalogue = await seen(fx, page);

	const control = await open();
	const other = await browser.newPage();
	await warm(control, other, '/n/1');
	const controlPosts = posts(control);
	const without = await seen(control, other);
	expect((await status(other)).artifacts).toEqual(['/n/1']);

	expect(askPosts).toBe(1);
	expect(controlPosts).toBe(0);
	expect(withCatalogue).toEqual(['POST /data.json']);
	expect(without).toEqual(['POST /.spool/beacon', 'POST /data.json']);

	fx.hits.length = 0;
	for (const path of ['/cat/1', '/cat/2']) {
		await page.goto(`${fx.origin}${path}`);
		await expect(page.locator('h1')).toHaveText(`cat ${path.slice(-1)}`);
	}
	expect(fx.hits.filter((h) => h.path !== '/spool-sw.js')).toEqual([]);
	if (browserName !== 'webkit') expect(fx.hits).toEqual([]);

	await moment(page);
	await quiet(fx);
	await expect
		.poll(() =>
			viewsOf(fx.sink.events)
				.filter((v) => v.route === '/cat/:id')
				.map((v) => [v.reason, v.tier])
		)
		.toEqual([
			['catalogue', 'local'],
			['catalogue', 'local']
		]);
	await page.close();
	await other.close();
});
