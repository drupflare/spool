import { chromium, expect, firefox, test, webkit, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeListener } from '../../src/node/listener';
import {
	bootPath,
	clientPath,
	compileTemplate,
	defineDataset,
	interpretTemplate,
	navigatePath,
	type DatasetRow
} from '../../src/protocol/index';
import {
	buildBundle,
	createSpool,
	defineResource,
	defineRoute,
	memoryBundleStore,
	memorySink,
	type Spool
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';

const ENGINES = { chromium, firefox, webkit };
const SOURCE =
	'<!doctype html><html><head><meta charset="utf-8"><title>{{row.title}}</title></head><body><main data-spool-swap><h1>{{row.title}}</h1><p>{{row.body}}</p><a href="/courses">all</a> <a href="{{row.next}}">next</a></main></body></html>';
const FAMILY = compileTemplate({ source: SOURCE });
const RUNTIME = [clientPath(VERSION), navigatePath(VERSION)];
const TITLES = ['Title 0', 'Title 1', 'Title 2', 'Title 3', 'Title 4'];
const ABOUT =
	'<!doctype html><html><head><meta charset="utf-8"><title>About</title></head><body><main data-spool-swap><h1>About</h1><a href="/courses/c00001">first</a></main></body></html>';

type Hit = { method: string; path: string };
type Data = { rows: DatasetRow[] };

/** five linked rows; the whole site fits the ring, so a held view never fetches a pack */
function rowsOf(titles: string[]): DatasetRow[] {
	return titles.map((title, i) => ({
		id: `c${String(i).padStart(5, '0')}`,
		title,
		body: 'x'.repeat(200),
		next: i + 1 < titles.length ? `/courses/c${String(i + 1).padStart(5, '0')}` : ''
	}));
}

function courses(data: Data) {
	return defineDataset('courses', {
		scope: 'public',
		key: (row) => String(row['id']),
		seed: () => data.rows,
		read: async () => [],
		changes: async () => 'reset' as const,
		horizon: async () => 0,
		head: async () => ({ cursor: 0 }),
		schema: '1',
		maxRows: 100_000,
		maxBytes: 100_000_000
	});
}

/** the family page for a row, rendered from the rows as they stand */
async function page(data: Data, request: Request): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === '/about') {
		return new Response(ABOUT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
	}
	const row = data.rows.find((r) => `/courses/${String(r['id'])}` === pathname);
	if (!row) return new Response('not found', { status: 404 });
	if (request.method === 'PATCH') {
		return Response.json(Object.assign(row, (await request.json()) as DatasetRow));
	}
	const html = interpretTemplate(FAMILY, { params: { id: row['id'] }, row });
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

type Site = {
	origin: string;
	hits: Hit[];
	/** the store version the origin serves now */
	version: () => Promise<number>;
	/** changes the titles and publishes the new version; the baseline only changes its rows */
	publish: (titles: string[]) => Promise<void>;
	stop: () => Promise<void>;
};

async function site(
	spooled: boolean,
	workerMode: 'never' | 'auto' | 'always' = 'never'
): Promise<Site> {
	const data: Data = { rows: rowsOf(TITLES) };
	const versions = memoryStore();
	const bundles = memoryBundleStore();
	const routes = [
		defineRoute('/courses/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			family: { dataset: 'courses', key: 'id' },
			load: (ctx) => data.rows.find((r) => r['id'] === ctx.params['id'])
		})
	];
	const datasets = [courses(data)];
	const spool: Spool | undefined = spooled
		? createSpool({
				routes,
				resources: [
					{ ...defineResource('/courses', { dataset: 'courses', key: 'id' }), routes: [] }
				],
				store: versions,
				datasets,
				bundles,
				bundle: { ringBytes: 16 * 1024 * 1024 },
				workerMode,
				sink: memorySink()
			})
		: undefined;
	const build = async () =>
		buildBundle({
			store: bundles,
			datasets,
			routes,
			version: await versions.cursor(),
			url: new URL('http://127.0.0.1/')
		});
	if (spool) await build();

	const hits: Hit[] = [];
	const listener = toNodeListener(async (request) => {
		const { pathname } = new URL(request.url);
		if (pathname !== '/favicon.ico') hits.push({ method: request.method, path: pathname });
		if (!spool) return page(data, request);
		return spool.handle(request, async (inner) => page(data, inner));
	});
	const server: Server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		hits,
		version: () => versions.cursor(),
		async publish(titles) {
			data.rows = rowsOf(titles);
			if (!spool) return;
			await versions.bump(['courses']);
			await build();
		},
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

/** the requests the origin saw since `from`, minus spool's own page scripts */
const counted = (hits: Hit[], from: number) =>
	hits
		.slice(from)
		.filter((hit) => !RUNTIME.includes(hit.path))
		.map((hit) => `${hit.method} ${hit.path}`);

/** a document navigation, after the 1.5 s pause the browser checks need between navigations */
async function go(browserPage: Page, at: Site, path: string): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1600));
	await browserPage.goto(`${at.origin}${path}`);
	await browserPage.waitForFunction(() => document.querySelector('h1') !== null);
}

/** the page has loaded its navigation script, so a click on a held row is answered locally */
async function navigable(browserPage: Page): Promise<void> {
	await browserPage.waitForFunction(() =>
		Boolean((globalThis as { spoolNavigate?: unknown }).spoolNavigate)
	);
	await browserPage.waitForTimeout(500);
}

/** waits until the page's cookie names the version the origin now serves */
async function held(browserPage: Page, version: number): Promise<void> {
	await browserPage.waitForFunction(
		(n) => document.cookie.split('; ').includes(`spool-held=${n}`),
		version
	);
}

test.describe.configure({ timeout: 180_000 });

/** a click on a link of the page, after the pause the browser checks need, until the title shows `title` */
async function click(browserPage: Page, href: string, title: string): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1600));
	await browserPage.click(`a[href="${href}"]`);
	await browserPage.waitForFunction(
		(want) => document.querySelector('h1')?.textContent === want,
		title
	);
}

test('typed documents cost exactly what the baseline costs, and the page loads no runtime and never asks for a worker', async ({
	browser
}) => {
	const spool = await site(true);
	const baseline = await site(false);
	try {
		const trail = async (at: Site) => {
			const context = await browser.newContext();
			const browserPage = await context.newPage();
			const paths: string[][] = [];
			for (const path of ['/courses/c00000', '/courses/c00001', '/courses/c00002']) {
				const from = at.hits.length;
				await go(browserPage, at, path);
				await browserPage.waitForTimeout(400);
				paths.push(counted(at.hits, from));
			}
			await context.close();
			return paths;
		};
		const spooled = await trail(spool);
		const plain = await trail(baseline);
		expect(spooled).toEqual(plain);
		expect(spool.hits.map((hit) => hit.path)).not.toContain(clientPath(VERSION));
		expect(spool.hits.some((hit) => hit.path === '/spool-sw.js')).toBe(false);
	} finally {
		await spool.stop();
		await baseline.stop();
	}
});

test('a click on view 1 makes the boot script in place of the document, so two views cost what the baseline costs, and the page never asks for a worker', async ({
	browser
}) => {
	const spool = await site(true);
	const baseline = await site(false);
	try {
		const trail = async (at: Site) => {
			const context = await browser.newContext();
			const browserPage = await context.newPage();
			await go(browserPage, at, '/courses/c00000');
			await click(browserPage, '/courses/c00001', 'Title 1');
			await browserPage.waitForTimeout(400);
			await context.close();
			return counted(at.hits, 0);
		};
		const spooled = await trail(spool);
		const plain = await trail(baseline);
		expect(spooled).toEqual([
			'GET /courses/c00000',
			`GET ${bootPath(VERSION, await spool.version())}`
		]);
		expect(plain).toEqual(['GET /courses/c00000', 'GET /courses/c00001']);
		expect(spool.hits.some((hit) => hit.path === '/spool-sw.js')).toBe(false);
	} finally {
		await spool.stop();
		await baseline.stop();
	}
});

for (const mode of ['auto', 'always'] as const) {
	test(`workerMode ${mode} ${mode === 'auto' ? 'registers no worker in WebKit and one elsewhere' : 'registers a worker in every engine'}, and a held read costs nothing`, async ({
		browser,
		browserName
	}) => {
		const at = await site(true, mode);
		const context = await browser.newContext();
		const browserPage = await context.newPage();
		try {
			await go(browserPage, at, '/courses/c00000');
			await click(browserPage, '/courses/c00001', 'Title 1');
			await browserPage.waitForFunction(
				() => localStorage.getItem('spool:lifetimes') === '1'
			);
			await go(browserPage, at, '/courses/c00002');
			await go(browserPage, at, '/courses/c00003');
			await browserPage.waitForTimeout(1500);
			const registered = await browserPage.evaluate(
				async () => (await navigator.serviceWorker.getRegistration()) !== undefined
			);
			expect(registered).toBe(mode === 'always' || browserName !== 'webkit');
			if (browserName === 'webkit' && mode === 'auto') {
				expect(at.hits.some((hit) => hit.path === '/spool-sw.js')).toBe(false);
			}
			await navigable(browserPage);
			await browserPage.waitForTimeout(1500);
			const from = at.hits.length;
			await click(browserPage, '/courses/c00004', 'Title 4');
			expect(counted(at.hits, from)).toEqual([]);
		} finally {
			await context.close();
			await at.stop();
		}
	});
}

test('an in-page view of a held row makes no request', async ({ browser }) => {
	const at = await site(true);
	const context = await browser.newContext();
	const browserPage = await context.newPage();
	try {
		await go(browserPage, at, '/courses/c00000');
		// the click carries the boot script, so the held rows exist from there on
		await click(browserPage, '/courses/c00001', 'Title 1');
		await held(browserPage, await at.version());
		await navigable(browserPage);
		const from = at.hits.length;
		await click(browserPage, '/courses/c00002', 'Title 2');
		expect(counted(at.hits, from)).toEqual([]);
		expect(new URL(browserPage.url()).pathname).toBe('/courses/c00002');
	} finally {
		await context.close();
		await at.stop();
	}
});

test('after a restart the document costs the baseline and a held read costs nothing', async ({
	browserName
}) => {
	const engine = ENGINES[browserName as keyof typeof ENGINES];
	const spoolProfile = await mkdtemp(join(tmpdir(), 'spool-never-'));
	const plainProfile = await mkdtemp(join(tmpdir(), 'spool-plain-'));
	const spool = await site(true);
	const baseline = await site(false);
	/** one run: a view, a restart, then the next document and a held read when the site spools */
	const restart = async (at: Site, profile: string, spooled: boolean) => {
		let context = await engine.launchPersistentContext(profile, { headless: true });
		let browserPage = context.pages()[0] ?? (await context.newPage());
		await go(browserPage, at, '/courses/c00000');
		if (spooled) {
			await click(browserPage, '/courses/c00001', 'Title 1');
			await held(browserPage, await at.version());
		} else {
			await go(browserPage, at, '/courses/c00000');
		}
		await context.close();

		context = await engine.launchPersistentContext(profile, { headless: true });
		browserPage = context.pages()[0] ?? (await context.newPage());
		const from = at.hits.length;
		await go(browserPage, at, '/courses/c00001');
		await browserPage.waitForTimeout(400);
		const documents = counted(at.hits, from);
		let reads: string[] = [];
		if (spooled) {
			await navigable(browserPage);
			const next = at.hits.length;
			await browserPage.click('a[href="/courses/c00002"]');
			await browserPage.waitForFunction(
				() => document.querySelector('h1')?.textContent === 'Title 2'
			);
			reads = counted(at.hits, next);
		}
		await context.close();
		return { documents, reads };
	};
	try {
		const never = await restart(spool, spoolProfile, true);
		const plain = await restart(baseline, plainProfile, false);
		expect(plain.documents).toEqual(['GET /courses/c00001']);
		// WebKit keeps no HTTP cache across a restart, so the boot script comes again
		const again =
			browserName === 'webkit' ? [`GET ${bootPath(VERSION, await spool.version())}`] : [];
		expect(never.documents).toEqual([...plain.documents, ...again]);
		expect(never.reads).toEqual([]);
		expect(spool.hits.some((hit) => hit.path === '/spool-sw.js')).toBe(false);
	} finally {
		await spool.stop();
		await baseline.stop();
		await rm(spoolProfile, { recursive: true, force: true });
		await rm(plainProfile, { recursive: true, force: true });
	}
});

test('a PATCH through spool.fetch costs one request, and a held read of the changed row costs none', async ({
	browser
}) => {
	const at = await site(true);
	const context = await browser.newContext();
	const browserPage = await context.newPage();
	try {
		await go(browserPage, at, '/courses/c00000');
		// the click carries the boot script, so the held rows exist from there on
		await click(browserPage, '/courses/c00001', 'Title 1');
		await held(browserPage, await at.version());
		await navigable(browserPage);
		const from = at.hits.length;
		const status = await browserPage.evaluate(() =>
			(globalThis as unknown as { spool: { fetch: typeof fetch } }).spool
				.fetch('/courses/c00002', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Changed 2' })
				})
				.then((response) => response.status)
		);
		expect(status).toBe(200);
		expect(counted(at.hits, from)).toEqual(['PATCH /courses/c00002']);
		const next = at.hits.length;
		await click(browserPage, '/courses/c00002', 'Changed 2');
		expect(counted(at.hits, next)).toEqual([]);
	} finally {
		await context.close();
		await at.stop();
	}
});

test('a PATCH from a non-family page goes through spool.fetch with the writes its ring carries, and a held read after it costs none', async ({
	browser
}) => {
	const at = await site(true);
	const context = await browser.newContext();
	const browserPage = await context.newPage();
	try {
		await go(browserPage, at, '/courses/c00000');
		await click(browserPage, '/courses/c00001', 'Title 1');
		await held(browserPage, await at.version());
		await go(browserPage, at, '/about');
		await navigable(browserPage);
		const shape = await browserPage.evaluate(() => ({
			ring: document.getElementById('spool-ring') !== null,
			writes: document.getElementById('spool-writes') !== null
		}));
		expect(shape).toEqual({ ring: true, writes: false });
		const from = at.hits.length;
		const status = await browserPage.evaluate(() =>
			(globalThis as unknown as { spool: { fetch: typeof fetch } }).spool
				.fetch('/courses/c00001', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ title: 'Changed 1' })
				})
				.then((response) => response.status)
		);
		expect(status).toBe(200);
		expect(counted(at.hits, from)).toEqual(['PATCH /courses/c00001']);
		const next = at.hits.length;
		await browserPage.click('a[href="/courses/c00001"]');
		await browserPage.waitForFunction(
			() => document.querySelector('h1')?.textContent === 'Changed 1'
		);
		expect(counted(at.hits, next)).toEqual([]);
	} finally {
		await context.close();
		await at.stop();
	}
});

test('a change published between two navigations arrives with the document, and a held read of it costs nothing', async ({
	browser
}) => {
	const at = await site(true);
	const context = await browser.newContext();
	const browserPage = await context.newPage();
	try {
		await go(browserPage, at, '/courses/c00000');
		await click(browserPage, '/courses/c00001', 'Title 1');
		await held(browserPage, await at.version());
		await at.publish(['Title 0', 'Changed 1', 'Title 2', 'Title 3', 'Title 4']);
		const from = at.hits.length;
		await go(browserPage, at, '/courses/c00000');
		await held(browserPage, await at.version());
		await browserPage.waitForTimeout(400);
		expect(counted(at.hits, from)).toEqual(['GET /courses/c00000']);
		await navigable(browserPage);
		const next = at.hits.length;
		await browserPage.click('a[href="/courses/c00001"]');
		await browserPage.waitForFunction(
			() => document.querySelector('h1')?.textContent === 'Changed 1'
		);
		expect(counted(at.hits, next)).toEqual([]);
	} finally {
		await context.close();
		await at.stop();
	}
});
