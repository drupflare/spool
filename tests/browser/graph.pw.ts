import { expect, test, type Page } from '@playwright/test';
import { normalise, parseArtifact } from '../../src/protocol/index';
import { BOUND, startCampus, type Fixture } from './fixture';

const PATHS = ['/c/101', '/t/ada', '/d'];

type Client = { status(): Promise<{ artifacts: string[] }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let fx: Fixture;

test.beforeAll(async () => {
	fx = await startCampus();
});

test.afterAll(() => fx.stop());

const hits = () => fx.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');

const status = (page: Page) =>
	page.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (client as Client).status();
	});

/** how many records and projections the worker's IndexedDB holds, read from the page */
const stored = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<{ records: string[]; projections: string[] }>((resolve, reject) => {
				const open = indexedDB.open('spool');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const read = (name: string) =>
						new Promise<string[]>((done, fail) => {
							const request = db.transaction(name).objectStore(name).getAllKeys();
							request.onsuccess = () => done((request.result as string[]).sort());
							request.onerror = () => fail(request.error);
						});
					Promise.all([read('records'), read('projections')]).then(
						([records, projections]) => {
							db.close();
							resolve({ records, projections });
						},
						reject
					);
				};
			})
	);

async function warm(page: Page): Promise<void> {
	await page.goto(`${fx.origin}${PATHS[0]}`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	for (const path of PATHS) {
		await page.goto(`${fx.origin}${path}`);
		await expect.poll(async () => (await status(page)).artifacts).toContain(path);
	}
}

async function sleepPast(seconds: number): Promise<void> {
	const until = Date.now() + seconds * 1000 + 250;
	while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

test('three routes over shared records store each record once in IndexedDB', async ({ page }) => {
	await warm(page);
	expect(await stored(page)).toEqual({
		records: ['course:101', 'course:102', 'site:name', 'teacher:ada'],
		projections: ['menu', 'roster:ada', 'roster:bo']
	});
	expect(fx.hits.filter((h) => h.path === '/.spool/artifact')).toHaveLength(PATHS.length);

	const shipped = fx.responses
		.filter((r) => r.path === '/.spool/artifact')
		.map((r) => parseArtifact(JSON.parse(r.text)));
	const records = shipped.flatMap((a) => (a.records ?? []).map((r) => r.id)).sort();
	expect(records).toEqual(['course:101', 'course:102', 'site:name', 'teacher:ada']);
});

test('the graph pages render locally with 0 server hits, equal to the network render', async ({
	page,
	browser,
	browserName
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
		if (browserName !== 'webkit') expect(fx.hits).toEqual([]);
		const local = await page.evaluate(() => document.documentElement.outerHTML);
		expect(normalise(local), path).toBe(normalise(expected));
	}
	await blocked.close();
});

test('a record change costs one need-sync for the next page and a refetch of only what changed', async ({
	page
}) => {
	await warm(page);
	await sleepPast(BOUND);
	const campus = fx.campus as NonNullable<Fixture['campus']>;
	campus.teachers['ada'] = 'Ada II';
	campus.courses['102'] = 'Advanced II';
	await fx.spool.invalidate(['teacher:ada', 'course:102']);

	fx.hits.length = 0;
	fx.responses.length = 0;
	await page.goto(`${fx.origin}/c/101`);
	await expect(page.locator('h1')).toHaveText('Intro');
	await expect.poll(() => hits().map((h) => h.path)).toEqual(['/.spool/sync']);
	expect(hits()[0]?.search).toContain('need=');
	expect(hits()[0]?.search).not.toContain('from=');
	const sync = JSON.parse(fx.responses[0]?.text as string) as { changed: Record<string, number> };
	expect(Object.keys(sync.changed)).toEqual(['course:102']);

	fx.hits.length = 0;
	fx.responses.length = 0;
	await page.goto(`${fx.origin}/c/101`);
	await expect(page.locator('nav')).toContainText('Advanced II');
	await expect.poll(() => hits().map((h) => h.path)).toEqual(['/c/101', '/.spool/artifact']);
	expect(hits()[1]?.search).toContain('have=');
	const shipped = parseArtifact(JSON.parse(fx.responses[0]?.text as string));
	expect(shipped.records?.map((r) => r.id)).toEqual(['course:102']);
	expect(shipped.projections?.map((p) => p.id)).toEqual(['menu']);
	expect((await stored(page)).records).toEqual([
		'course:101',
		'course:102',
		'site:name',
		'teacher:ada'
	]);

	fx.hits.length = 0;
	await page.goto(`${fx.origin}/c/101`);
	await expect(page.locator('nav')).toContainText('Advanced II');
	expect(hits()).toEqual([]);
});
