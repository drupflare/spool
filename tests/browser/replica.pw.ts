import { expect, test, type Page } from '@playwright/test';
import {
	datasetProof,
	evaluateQuery,
	LOADS_PATH,
	normalise,
	VIEW_PATH,
	type QuerySchema
} from '../../src/protocol/index';
import { createSpool, defineRoute, viewsOf } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';
import { BOUND, listen, startFixture, type Fixture, type Hit } from './fixture';

const PATHS = ['/n/1', '/n/2', '/n/3', '/hard/1', '/soft/1', '/asm/about'];

type Client = {
	status(): Promise<{ artifacts: string[]; beacons: number }>;
	hello: unknown;
	track(db: { close(): void }): () => void;
};
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startFixture();
});

test.afterAll(() => fx.stop());

/** server hits that are neither the worker script (WebKit re-checks it) nor a flush: spool's batch or a held beacon replayed */
const hits = () =>
	fx.hits
		.filter(
			(h) =>
				h.path !== '/spool-sw.js' &&
				h.path !== '/.spool/beacon' &&
				h.path !== '/cdn-cgi/rum'
		)
		.map((h) => h.path);

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

async function sleepPast(seconds: number): Promise<void> {
	const until = Date.now() + seconds * 1000 + 250;
	while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

/** waits until the server has seen no new request for a moment, so a flush started by the last view has landed */
async function quiet(): Promise<void> {
	for (let last = -1; fx.hits.length !== last;) {
		last = fx.hits.length;
		await new Promise((r) => setTimeout(r, 300));
	}
}

/** registers the worker through the page runtime, then visits every fixture path so each is provisioned */
async function warm(page: Page): Promise<void> {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	for (const path of PATHS) {
		await page.goto(`${fx.origin}${path}`);
		await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	}
	await quiet();
}

test('the page runtime registers the worker with updateViaCache all and the handshake agrees', async ({
	page
}) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	const result = await page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		const registration = await navigator.serviceWorker.getRegistration();
		return { hello: (client as Client).hello, cache: registration?.updateViaCache };
	});
	expect(result.cache).toBe('all');
	expect(result.hello).toEqual({
		type: 'spool:hello',
		protocol: 1,
		version: VERSION,
		compatible: true
	});
});

test('a provisioned route makes 0 server hits per local navigation', async ({
	page,
	context,
	browserName
}) => {
	await warm(page);
	await page.goto(`${fx.origin}${PATHS[0]}`);
	fx.hits.length = 0;

	for (const path of PATHS.slice(1)) {
		await Promise.all([page.waitForURL(`**${path}`), page.click(`a[href="${path}"]`)]);
		await expect(page.locator('h1')).toContainText(path.split('/')[1] as string);
	}
	for (const path of PATHS) await page.goto(`${fx.origin}${path}`);
	const tab = await context.newPage();
	await tab.goto(`${fx.origin}${PATHS[2]}`);
	await expect(tab.locator('h1')).toHaveText('n 3');

	expect(fx.hits.filter((h) => h.path !== '/spool-sw.js')).toEqual([]);
	if (browserName !== 'webkit') expect(fx.hits).toEqual([]);
});

test('the local render equals the network render on every fixture route', async ({
	page,
	browser
}) => {
	await warm(page);
	const blocked = await browser.newContext({ serviceWorkers: 'block' });
	const network = await blocked.newPage();

	for (const path of PATHS) {
		await network.goto(`${fx.origin}${path}`);
		const expected = await network.evaluate(() => document.documentElement.outerHTML);

		fx.hits.length = 0;
		await page.goto(`${fx.origin}${path}`);
		expect(hits(), `${path} reached the server`).toEqual([]);
		const local = await page.evaluate(() => document.documentElement.outerHTML);
		expect(normalise(local), path).toBe(normalise(expected));
	}
	await blocked.close();
});

test('hard: past the bound nothing is displayed before a required sync, then a change is seen', async ({
	page
}) => {
	await warm(page);
	await sleepPast(BOUND);
	const before = page.url();

	fx.hits.length = 0;
	const release = fx.holdSync();
	const navigation = page.goto(`${fx.origin}/hard/1`);
	await expect.poll(() => fx.hits.some((h) => h.path === '/.spool/sync')).toBe(true);
	expect(page.url()).toBe(before);
	expect(
		await Promise.race([
			navigation.then(() => 'displayed'),
			new Promise((resolve) => setTimeout(() => resolve('pending'), 300))
		])
	).toBe('pending');
	expect(hits()).toEqual(['/.spool/sync']);

	release();
	await navigation;
	await expect(page.locator('h1')).toHaveText('hard 1');
	expect(hits()).toEqual(['/.spool/sync']);

	fx.db.set('1', 'edited body');
	await fx.spool.invalidate(['node:1']);
	await sleepPast(BOUND);
	fx.hits.length = 0;
	await page.goto(`${fx.origin}/hard/1`);
	await expect(page.locator('main p')).toHaveText('edited body');
	await expect.poll(hits).toEqual(['/.spool/sync', '/hard/1', '/.spool/artifact']);
});

test('soft: past the bound the local page shows first and exactly one sync follows', async ({
	page
}) => {
	await warm(page);
	await sleepPast(BOUND);

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/soft/1`);
	await expect(page.locator('h1')).toHaveText('soft 1');
	await expect.poll(hits).toEqual(['/.spool/sync']);

	await page.goto(`${fx.origin}/soft/1`);
	await page.goto(`${fx.origin}/n/1`);
	await page.goto(`${fx.origin}/soft/1`);
	await expect(page.locator('h1')).toHaveText('soft 1');
	await new Promise((r) => setTimeout(r, 300));
	expect(hits()).toEqual(['/.spool/sync']);
});

test('held beacons reach their own endpoint with the bodies the page sent, after the flush', async ({
	page
}) => {
	await warm(page);
	for (let i = 0; i < 2; i++) {
		await page.evaluate(() =>
			fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text())
		);
		await expect.poll(async () => (await status(page)).beacons).toBe(0);
	}

	fx.hits.length = 0;
	fx.sink.events.length = 0;
	const walked = ['/n/1', '/n/2', '/n/3', '/n/1'];
	for (const path of walked) await page.goto(`${fx.origin}${path}`);
	let held = -1;
	await expect
		.poll(async () => {
			const now = (await status(page)).beacons;
			const stable = now === held;
			held = now;
			return stable && now > 0;
		})
		.toBe(true);
	expect(held).toBeGreaterThanOrEqual(8);
	expect(fx.hits.map((h) => h.path)).not.toContain('/cdn-cgi/rum');
	expect(fx.hits.filter((h) => h.path === '/.spool/beacon')).toEqual([]);
	expect(fx.sink.events).toEqual([]);

	await page.evaluate(() =>
		fetch('/data.json', { method: 'POST', body: 'x' }).then((r) => r.text())
	);
	await expect.poll(async () => (await status(page)).beacons).toBe(0);
	await expect.poll(() => fx.hits.filter((h) => h.path === '/cdn-cgi/rum').length).toBe(8);

	const rum = fx.hits.filter((h) => h.path === '/cdn-cgi/rum');
	const sent = walked
		.flatMap((path) => [1, 2].map((n) => JSON.stringify({ page: path, n })))
		.sort();
	expect(rum.map((h) => h.body).sort()).toEqual(sent);
	expect(rum.every((h) => h.method === 'POST')).toBe(true);
	expect(rum.every((h) => h.type === 'text/plain;charset=UTF-8')).toBe(true);

	expect(fx.hits.filter((h) => h.path === '/.spool/beacon')).toHaveLength(1);
	const own = [VIEW_PATH, LOADS_PATH];
	expect(fx.sink.events.every((e) => own.includes(e.path))).toBe(true);
	expect(viewsOf(fx.sink.events).length).toBeGreaterThan(0);
});

test('closing IndexedDB on pagehide makes the connection unusable', async ({ page }) => {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	const result = await page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('probe', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('s');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		(client as Client).track(db);
		const attempt = () => {
			try {
				db.transaction('s');
				return 'open';
			} catch (error) {
				return (error as Error).name;
			}
		};
		const before = attempt();
		window.dispatchEvent(new Event('pagehide'));
		return { before, after: attempt() };
	});
	expect(result).toEqual({ before: 'open', after: 'InvalidStateError' });
});

test.describe('a template page that carries its artifact', () => {
	const IDS = ['1', '2', '3'];
	const layout = (title: string, body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><nav>${IDS.map((id) => `<a href="/i/${id}">/i/${id}</a>`).join(' ')}</nav><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
	let origin: string;
	let stop: () => Promise<void>;
	const log: Hit[] = [];
	const own = () =>
		log
			.map((h) => h.path)
			.filter((path) => path !== '/spool-sw.js' && path !== '/.spool/beacon');

	test.beforeAll(async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/i/:id', {
					strategy: 'template',
					template: { source: layout('{{title}}', '{{body}}') },
					depends: (ctx) => [`node:${ctx.params['id']}`],
					load: (ctx) => ({
						title: `inline ${ctx.params['id']}`,
						body: '<small> & text'
					}),
					freshness: { maxStale: 3600, mode: 'soft' }
				})
			],
			store: memoryStore(),
			inlineMaxBytes: 2048
		});
		const app = (request: Request) => {
			const id = /^\/i\/(\d+)$/.exec(new URL(request.url).pathname)?.[1];
			return id
				? new Response(layout(`inline ${id}`, '&lt;small&gt; &amp; text'), {
						headers: { 'content-type': 'text/html; charset=utf-8' }
					})
				: new Response('not found', { status: 404 });
		};
		const started = await listen(log, spool, app);
		origin = started.origin;
		stop = started.stop;
	});

	test.afterAll(() => stop());

	test('is stored from the navigation with no artifact request, and the next view is local', async ({
		page,
		browserName
	}) => {
		await page.goto(`${origin}/i/1`);
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
		await page.goto(`${origin}/i/2`);
		await expect.poll(async () => (await status(page)).artifacts).toContain('/i/2');
		await new Promise((r) => setTimeout(r, 600));
		expect(log.map((h) => h.path)).not.toContain('/.spool/artifact');
		expect(own().filter((path) => path === '/i/2')).toEqual(['/i/2']);

		log.length = 0;
		await page.goto(`${origin}/i/2`);
		await expect(page.locator('h1')).toHaveText('inline 2');
		await expect(page.locator('main p')).toHaveText('<small> & text');
		expect(own()).toEqual([]);
		if (browserName !== 'webkit') expect(log.map((h) => h.path)).toEqual([]);
	});
});

test.describe('a query route', () => {
	const ROWS = [
		{ name: 'Ada', department: 'math' },
		{ name: 'Bo', department: 'cs' },
		{ name: 'Cy', department: 'math' },
		{ name: 'Di', department: 'art' },
		{ name: 'Ed', department: 'math' }
	];
	const query: QuerySchema = {
		list: 'people',
		filter: { department: 'string' },
		sort: ['name'],
		pageSize: 2
	};
	const layout = (summary: string, items: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>People</title></head><body><main><h1>People</h1><p id="summary">${summary}</p><ul>${items}</ul></main></body></html>`;
	let origin: string;
	let stop: () => Promise<void>;
	const log: Hit[] = [];
	const own = () =>
		log
			.map((h) => `${h.path}${h.search}`)
			.filter((path) => !['/spool-sw.js', '/.spool/beacon', '/cdn-cgi/rum'].includes(path));

	test.beforeAll(async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/people', {
					strategy: 'template',
					template: {
						source: layout(
							'{{#if query}}{{query.page}} of {{query.pages}}, {{query.total}} found{{else}}all{{/if}}',
							'{{#each people}}<li>{{name}}</li>{{/each}}'
						)
					},
					depends: () => ['people'],
					load: async () => ({ people: ROWS, proof: await datasetProof(ROWS) }),
					query
				})
			],
			store: memoryStore()
		});
		const app = (request: Request) => {
			const url = new URL(request.url);
			if (url.pathname !== '/people') return new Response('not found', { status: 404 });
			const result =
				url.search === '' ? null : evaluateQuery(query, { people: ROWS }, url.search);
			const summary = result
				? `${result.page} of ${result.pages}, ${result.total} found`
				: 'all';
			const items = (result ? result.items : ROWS)
				.map((p) => `<li>${p['name']}</li>`)
				.join('');
			return new Response(layout(summary, items), {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		};
		const started = await listen(log, spool, app);
		origin = started.origin;
		stop = started.stop;
	});

	test.afterAll(() => stop());

	test('answers a new filter, sort and page locally and sends an unknown parameter to the origin once', async ({
		page,
		browserName
	}) => {
		await page.goto(`${origin}/people`);
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
		await page.goto(`${origin}/people`);
		await expect.poll(async () => (await status(page)).artifacts).toContain('/people');
		await new Promise((r) => setTimeout(r, 600));

		log.length = 0;
		await page.goto(`${origin}/people?department=math&sort=name&page=2`);
		await expect(page.locator('#summary')).toHaveText('2 of 2, 3 found');
		await expect(page.locator('li')).toHaveText(['Ed']);
		await page.goto(`${origin}/people?department=math&sort=-name`);
		await expect(page.locator('#summary')).toHaveText('1 of 2, 3 found');
		await expect(page.locator('li')).toHaveText(['Ed', 'Cy']);
		expect(own()).toEqual([]);
		if (browserName !== 'webkit') expect(log.map((h) => h.path)).toEqual([]);

		log.length = 0;
		await page.goto(`${origin}/people?colour=red`);
		await expect(page.locator('#summary')).toHaveText('all');
		await expect.poll(own).toEqual(['/people?colour=red']);
		await new Promise((r) => setTimeout(r, 300));
		expect(own()).toEqual(['/people?colour=red']);
	});
});
