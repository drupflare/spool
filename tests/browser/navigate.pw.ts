import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import type { NavigateOptions } from '../../src/client/navigate';
import { compileTemplate, interpretTemplate } from '../../src/protocol/index';
import { createSpool, defineRoute, memorySink } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { listen, type Hit } from './fixture';

type Row = { id: string; title: string; dept: string };
type Win = {
	protocol: typeof import('../../src/protocol/index');
	pack: typeof import('../../src/sw/pack/store');
	navigate: typeof import('../../src/client/navigate');
	opts: NavigateOptions;
};

const DEPTS = ['cs', 'math', 'art'];
const ROWS: Row[] = Array.from({ length: 10_000 }, (_, i) => ({
	id: `c${String(i).padStart(5, '0')}`,
	title: `Title ${i}`,
	dept: DEPTS[i % 3] as string
}));
/** 1000 ids spread across the pack, none of them fetched by the page */
const IDS = Array.from({ length: 1000 }, (_, i) => (i * 7919) % ROWS.length);

const FAMILY =
	'<!doctype html><html><head><meta charset="utf-8"><title>{{row.title}}</title></head><body><main data-spool-swap><h1>{{row.title}}</h1><p>{{row.dept}}</p></main></body></html>';
const LIST =
	'<!doctype html><html><head><meta charset="utf-8"><title>Courses</title></head><body><main data-spool-swap><h1>Courses</h1><ul>{{#each items}}<li>{{id}} {{title}}</li>{{/each}}</ul></main></body></html>';
const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body><main data-spool-swap><h1>host</h1>
<form method="get" action="/courses"><input name="dept" value="cs"><button>declared</button></form>
<form id="odd" method="get" action="/courses"><input name="color" value="red"><button>undeclared</button></form>
</main><script type="module">
import * as protocol from '/protocol.js';
import * as pack from '/pack.js';
import * as navigate from '/navigate.js';
window.protocol = protocol;
window.pack = pack;
window.navigate = navigate;
</script></body></html>`;

/** the module as one browser file, bundled from the working tree by bun */
function bundle(entry: string): string {
	const built = spawnSync('bun', ['build', entry, '--target', 'browser', '--format', 'esm'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
	return built.stdout;
}

/** the tag the server injects, so a local render carries what a network page does */
let TAG = '';
const pause = () => new Promise((resolve) => setTimeout(resolve, 1600));

let origin: string;
let stop: () => Promise<void>;
const log: Hit[] = [];

test.beforeAll(async () => {
	const files: Record<string, string> = {
		'/protocol.js': bundle('src/protocol/index.ts'),
		'/pack.js': bundle('src/sw/pack/store.ts'),
		'/navigate.js': bundle('src/client/navigate.ts')
	};
	const byId = new Map(ROWS.map((row) => [row.id, row]));
	const familyTemplate = compileTemplate({ source: FAMILY });
	const spool = createSpool({
		routes: [
			defineRoute('/courses/:id', {
				strategy: 'template',
				template: { source: FAMILY },
				family: { dataset: 'courses', key: 'id' },
				load: (ctx) => byId.get(ctx.params['id'] as string)
			})
		],
		store: memoryStore(),
		sink: memorySink()
	});
	TAG = spool.config.clientTag;
	const app = (request: Request): Response => {
		const url = new URL(request.url);
		if (url.pathname === '/host') {
			return new Response(HOST, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}
		if (url.pathname in files) {
			return new Response(files[url.pathname], {
				headers: { 'content-type': 'text/javascript' }
			});
		}
		if (url.pathname.startsWith('/courses/')) {
			const id = url.pathname.slice('/courses/'.length);
			const row = byId.get(id);
			if (!row) return new Response('not found', { status: 404 });
			const html = interpretTemplate(familyTemplate, { params: { id }, row });
			return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}
		if (url.pathname === '/courses') {
			return new Response('<main>server list</main>', {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		return new Response('not found', { status: 404 });
	};
	const started = await listen(log, spool, app);
	origin = started.origin;
	stop = started.stop;
});

test.afterAll(() => stop());

/** the host page with the pack installed, the routes held and in-page navigation on */
async function open(page: Page): Promise<void> {
	await pause();
	await page.goto(`${origin}/host`);
	await page.waitForFunction(() => 'navigate' in window);
	await page.evaluate(
		async ({ rows, family, list, tag }) => {
			const { protocol, pack, navigate } = window as unknown as Win;
			const store = pack.createPackStore(indexedDB);
			const { bytes } = await protocol.buildPack({
				version: 1,
				tables: { courses: rows.map((row) => [row.id, row]) }
			});
			async function* once() {
				yield bytes;
			}
			await store.installPack(once(), { bytes: bytes.length });
			const familyRoute = protocol.defineRoute('/courses/:id', {
				strategy: 'template',
				template: { source: family },
				family: { dataset: 'courses', key: 'id' }
			});
			const listRoute = protocol.defineRoute('/courses', {
				strategy: 'template',
				template: { source: list },
				query: {
					list: 'items',
					dataset: 'courses',
					filter: { dept: 'string' },
					pageSize: 20
				},
				load: () => ({})
			});
			await store.putRoutes([
				protocol.serializeRoute(familyRoute),
				protocol.serializeRoute(listRoute)
			]);
			const templates = {
				[familyRoute.pattern]: familyRoute.template,
				[listRoute.pattern]: listRoute.template
			} as NavigateOptions['templates'];
			const opts: NavigateOptions = { store, templates, clientTag: tag };
			(window as unknown as Win).opts = opts;
			await navigate.enableNavigation(opts).ready;
		},
		{ rows: ROWS, family: FAMILY, list: LIST, tag: TAG }
	);
}

/**
 * clicks in-page links to each path in turn; returns what went wrong: a view whose heading is not
 * the expected title, or a view that did not finish in the page (the document went away)
 */
async function clickThrough(page: Page, pairs: Array<[string, string]>): Promise<string[]> {
	const wrong: string[] = [];
	for (const [href, title] of pairs) {
		await spaced();
		const shown = await page
			.evaluate(async (target: string) => {
				const link = document.createElement('a');
				link.href = target;
				document.body.append(link);
				const done = new Promise((resolve) =>
					addEventListener('spool:navigated', resolve, { once: true })
				);
				link.click();
				await done;
				link.remove();
				return document.querySelector('h1')?.textContent ?? '';
			}, href)
			.catch((error: Error) => `error: ${error.message}`);
		if (shown !== title) wrong.push(`${href} shows "${shown}"`);
	}
	return wrong;
}

const pairOf = (i: number): [string, string] => [`/courses/${ROWS[i]?.id}`, ROWS[i]?.title ?? ''];

/** 120 ms between clicks keeps a run under the 90 history entries per 10 seconds */
const spaced = () => new Promise((resolve) => setTimeout(resolve, 120));

/** clicks each path back to back with no pause; returns the headings it saw, in order */
async function clickBurst(page: Page, hrefs: string[]): Promise<string[]> {
	return page.evaluate(async (targets: string[]) => {
		const seen: string[] = [];
		for (const target of targets) {
			const link = document.createElement('a');
			link.href = target;
			document.body.append(link);
			const done = new Promise((resolve) =>
				addEventListener('spool:navigated', resolve, { once: true })
			);
			link.click();
			await done;
			link.remove();
			seen.push(document.querySelector('h1')?.textContent ?? '');
		}
		return seen;
	}, hrefs);
}

test('answers in-page views of unfetched ids with 0 requests, at 10, 100 and 1,000 views', async ({
	page
}) => {
	test.setTimeout(300_000);
	await open(page);
	let loads = 0;
	page.on('load', () => void loads++);
	const before = log.length;
	let done = 0;
	for (const count of [10, 100, 1000]) {
		const wrong = await clickThrough(page, IDS.slice(done, count).map(pairOf));
		done = count;
		expect(wrong).toEqual([]);
		expect(log.length - before).toBe(0);
		expect(loads).toBe(0);
	}
});

test('a click past the 90 history entries in 10 seconds is a document request, the earlier ones none', async ({
	page
}) => {
	await open(page);
	const before = log.length;
	const burst = Array.from({ length: 90 }, (_, i) => pairOf(i + 1));
	const seen = await clickBurst(
		page,
		burst.map(([href]) => href)
	);
	expect(seen).toEqual(burst.map(([, title]) => title));
	expect(log.length - before).toBe(0);
	const over = pairOf(91);
	await Promise.all([
		page.waitForURL(`${origin}${over[0]}`),
		page
			.evaluate((href: string) => {
				const link = document.createElement('a');
				link.href = href;
				document.body.append(link);
				link.click();
			}, over[0])
			.catch(() => undefined)
	]);
	// the loaded page fetches its own artifact after the document; the click itself is one document GET
	expect(log.slice(before).filter((hit) => hit.path === over[0])).toEqual([
		{ method: 'GET', path: over[0], search: '' }
	]);
});

test('serves the same HTML as the server for held family pages', async ({ page }) => {
	await open(page);
	for (const id of ['c00042', 'c09999']) {
		const verdict = await page.evaluate(
			(path) =>
				(window as unknown as Win).navigate.compareToDocument(
					path,
					(window as unknown as Win).opts
				),
			`/courses/${id}`
		);
		expect(verdict, verdict ?? '').toBeNull();
	}
});

test('moves back and forward through in-page views without a request', async ({ page }) => {
	await open(page);
	await clickThrough(page, [pairOf(1), pairOf(2)]);
	const before = log.length;
	await page.evaluate(() => history.back());
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Title 1');
	await page.evaluate(() => history.forward());
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Title 2');
	expect(log.length - before).toBe(0);
});

test('answers in-page views offline from the held rows', async ({ page, context }) => {
	await open(page);
	await context.setOffline(true);
	try {
		await clickThrough(page, [pairOf(7)]);
		await expect(page.locator('h1')).toHaveText('Title 7');
	} finally {
		await context.setOffline(false);
	}
});

test('renders a declared GET form on a held list route locally, with no request', async ({
	page
}) => {
	await open(page);
	const before = log.length;
	await page.locator('form').first().locator('button').click();
	await expect(page.locator('h1')).toHaveText('Courses');
	await expect(page.locator('li')).toHaveCount(20);
	await expect(page.locator('li').first()).toHaveText('c00000 Title 0');
	expect(log.length - before).toBe(0);
});

test('sends a click on a list route with no query string to the network', async ({ page }) => {
	await open(page);
	await pause();
	const before = log.length;
	await Promise.all([
		page.waitForURL(`${origin}/courses`),
		page.evaluate(() => {
			const link = document.createElement('a');
			link.href = '/courses';
			document.body.append(link);
			link.click();
		})
	]);
	await expect(page.locator('main')).toHaveText('server list');
	expect(log.slice(before).filter((hit) => hit.path === '/courses')).toEqual([
		{ method: 'GET', path: '/courses', search: '' }
	]);
});

test('sends a GET form with an undeclared parameter to the network once', async ({ page }) => {
	await open(page);
	await pause();
	const before = log.length;
	await Promise.all([
		page.waitForURL(`${origin}/courses?color=red`),
		page.locator('#odd button').click()
	]);
	await expect(page.locator('main')).toHaveText('server list');
	expect(log.slice(before).filter((hit) => hit.path === '/courses')).toEqual([
		{ method: 'GET', path: '/courses', search: '?color=red' }
	]);
});
