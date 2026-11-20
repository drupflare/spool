import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
	bootPath,
	clientPath,
	compileTemplate,
	defineDataset,
	interpretTemplate,
	navigatePath,
	type DatasetRow
} from '../../src/protocol/index';
import { GATE_CORE } from '../../src/server/embedded';
import {
	buildBundle,
	createSpool,
	defineRoute,
	memoryBundleStore,
	memorySink
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';
import { listen, type Hit } from './fixture';

const DEPTS = ['cs', 'math', 'art'];
const SOURCE =
	'<!doctype html><html><head><meta charset="utf-8"><title>{{row.title}}</title></head><body><main data-spool-swap><h1>{{row.title}}</h1><p>{{row.dept}}</p><a href="/courses">all</a> <a href="{{row.next}}">next</a></main></body></html>';
const FAMILY = compileTemplate({ source: SOURCE });
const LIST =
	'<!doctype html><html><head><meta charset="utf-8"><title>Courses</title></head><body><main data-spool-swap><h1>Courses</h1><ul>{{#each courses}}<li>{{title}}</li>{{/each}}</ul><a href="/courses/c00000">first</a></main></body></html>';

/** a chain of rows, each linking to the next, with a body that makes the pack larger than a small ring */
function rowsOf(count: number, pad: number): DatasetRow[] {
	return Array.from({ length: count }, (_, i) => {
		const next = i + 1 < count ? `/courses/c${String(i + 1).padStart(5, '0')}` : '';
		return {
			id: `c${String(i).padStart(5, '0')}`,
			title: `Title ${i}`,
			dept: DEPTS[i % 3],
			next,
			links: next ? [next] : [],
			body: 'x'.repeat(pad)
		};
	});
}

function courses(rows: DatasetRow[]) {
	return defineDataset('courses', {
		scope: 'public',
		key: (row) => String(row['id']),
		seed: () => rows,
		read: async () => [],
		changes: async () => 'reset' as const,
		horizon: async () => 0,
		head: async () => ({ cursor: 0 }),
		schema: '1',
		maxRows: 100_000,
		maxBytes: 100_000_000
	});
}

const log: Hit[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 1600));
/** spool's own page scripts, which a baseline page does not have */
const RUNTIME = [clientPath(VERSION), navigatePath(VERSION)];
/** every request to the origin except spool's page scripts */
const counted = (from: number) => log.slice(from).filter((hit) => !RUNTIME.includes(hit.path));
/** the page scripts requested since `from`, in request order */
const runtime = (from: number) =>
	log
		.slice(from)
		.map((hit) => hit.path)
		.filter((path) => RUNTIME.includes(path));

type Site = { origin: string; version: number; stop: () => Promise<void> };

/** a site whose family pages carry a ring of `ringBytes`; its pack is the whole dataset */
async function site(rows: DatasetRow[], ringBytes: number, csp?: string): Promise<Site> {
	const versions = memoryStore();
	const bundles = memoryBundleStore();
	const routes = [
		defineRoute('/courses/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			family: { dataset: 'courses', key: 'id' },
			load: (ctx) => rows.find((row) => row['id'] === ctx.params['id'])
		}),
		defineRoute('/courses', {
			strategy: 'template',
			template: { source: LIST },
			depends: () => ['courses'],
			load: () => ({ courses: rows }),
			query: { list: 'courses', dataset: 'courses', sort: ['title'] }
		})
	];
	const spool = createSpool({
		routes,
		store: versions,
		datasets: [courses(rows)],
		bundles,
		bundle: { ringBytes },
		bootstrap: 'second-view',
		sink: memorySink()
	});
	const version = await versions.cursor();
	await buildBundle({
		store: bundles,
		datasets: [courses(rows)],
		routes,
		version,
		url: new URL('http://127.0.0.1/')
	});
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const row = rows.find((r) => r['id'] === pathname.slice('/courses/'.length));
		if (pathname.startsWith('/courses/') && row) {
			const html = interpretTemplate(FAMILY, { params: { id: row['id'] }, row });
			return new Response(html, {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					...(csp ? { 'content-security-policy': csp } : {})
				}
			});
		}
		if (pathname === '/courses') {
			return new Response('<main>server list</main>', {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		return new Response('not found', { status: 404 });
	};
	const started = await listen(log, spool, app);
	return { origin: started.origin, version, stop: started.stop };
}

/** a policy that allows scripts from the site and, when `gate` is true, the inline gate by its hash */
const policy = (gate: boolean) =>
	`script-src 'self'${gate ? ` 'sha256-${createHash('sha256').update(GATE_CORE).digest('base64')}'` : ''}`;

let main: Site;
let whole: Site;
let hashed: Site;
let strict: Site;

test.beforeAll(async () => {
	main = await site(rowsOf(300, 200), 8192);
	whole = await site(rowsOf(5, 200), 16 * 1024 * 1024);
	hashed = await site(rowsOf(300, 200), 8192, policy(true));
	strict = await site(rowsOf(300, 200), 8192, policy(false));
});

test.afterAll(async () => {
	await main?.stop();
	await whole?.stop();
	await hashed?.stop();
	await strict?.stop();
});

/** a document navigation to `path`, after the pause the WebKit script check needs */
async function view(page: Page, at: Site, path: string, count: number): Promise<void> {
	await pause();
	await page.goto(`${at.origin}${path}`);
	await page.waitForFunction((n) => localStorage.getItem('spool:views') === String(n), count);
}

/** lets the page finish its install: the pack the boot script carried reaches the store */
async function settled(page: Page, lifetimes: number): Promise<void> {
	await page.waitForFunction(
		(n) => (localStorage.getItem('spool:lifetimes') ?? '0') === String(n),
		lifetimes
	);
	await page.waitForTimeout(500);
}

test('one view makes exactly the baseline requests', async ({ page }) => {
	const from = log.length;
	await view(page, main, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	expect(counted(from).map((hit) => hit.path)).toEqual(['/courses/c00000']);
	// the inline gate loads no runtime script on view 1 (A5)
	expect(runtime(from)).toEqual([]);
});

test('a click on view 1 makes the boot script in place of the document it would have fetched', async ({
	page
}) => {
	const from = log.length;
	await view(page, main, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	await page.getByRole('link', { name: 'next' }).click();
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Title 1');
	await settled(page, 1);
	expect(counted(from).map((hit) => hit.path)).toEqual([
		'/courses/c00000',
		bootPath(VERSION, main.version)
	]);
	expect(new URL(page.url()).pathname).toBe('/courses/c00001');
});

test('two typed views after a click make the baseline plus the stub on the third (the runtime comes from the cache; WebKit registers no worker, so no stub)', async ({
	page,
	browserName
}) => {
	const from = log.length;
	await view(page, main, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	await page.getByRole('link', { name: 'next' }).click();
	await settled(page, 1);
	await view(page, main, '/courses/c00000', 2);
	await view(page, main, '/courses/c00000', 3);
	await page.waitForTimeout(2000);
	expect(
		counted(from)
			.map((hit) => hit.path)
			.sort()
	).toEqual(
		[
			'/courses/c00000',
			bootPath(VERSION, main.version),
			'/courses/c00000',
			'/courses/c00000',
			...(browserName === 'webkit' ? [] : ['/spool-sw.js'])
		].sort()
	);
});

test('five views one lease apart make no boot script and no stub; three inside one lease install on the third', async ({
	page,
	browserName
}) => {
	const DAY = 86_400_000;
	const start = Date.UTC(2026, 10, 1, 9);
	await page.clock.install({ time: start });
	const from = log.length;
	for (let day = 0; day < 5; day++) {
		await page.clock.setSystemTime(start + day * DAY);
		await view(page, main, '/courses/c00000', day + 1);
	}
	await page.waitForTimeout(1500);
	expect(counted(from).map((hit) => hit.path)).toEqual(Array(5).fill('/courses/c00000'));
	expect(runtime(from)).toEqual([]);
	const inside = log.length;
	for (let step = 0; step < 3; step++) {
		await page.clock.setSystemTime(start + 10 * DAY + step * 3_600_000);
		await view(page, main, '/courses/c00000', 6 + step);
	}
	await page.waitForTimeout(2000);
	expect(
		counted(inside)
			.map((hit) => hit.path)
			.sort()
	).toEqual(
		[
			'/courses/c00000',
			'/courses/c00000',
			'/courses/c00000',
			...(browserName === 'webkit' ? [] : [bootPath(VERSION, main.version), '/spool-sw.js'])
		].sort()
	);
});

test('with a complete ring, two typed views make no request beyond the baseline', async ({
	page
}) => {
	const from = log.length;
	await view(page, whole, '/courses/c00000', 1);
	await view(page, whole, '/courses/c00000', 2);
	await page.waitForTimeout(1500);
	expect(counted(from).map((hit) => hit.path)).toEqual(['/courses/c00000', '/courses/c00000']);
});

test('after the boot script, a click to a held URL the page never saw makes 0 requests', async ({
	page
}) => {
	await view(page, main, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	await page.getByRole('link', { name: 'next' }).click();
	await settled(page, 1);
	const from = log.length;
	await page.getByRole('link', { name: 'next' }).click();
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Title 2');
	expect(counted(from)).toEqual([]);
});

test('under script-src self with the gate allowed by its hash, the click loads the boot script as it does with no policy', async ({
	page
}) => {
	const from = log.length;
	await view(page, hashed, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	await page.getByRole('link', { name: 'next' }).click();
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Title 1');
	expect(counted(from).map((hit) => hit.path)).toEqual([
		'/courses/c00000',
		bootPath(VERSION, hashed.version)
	]);
	expect(new URL(page.url()).pathname).toBe('/courses/c00001');
});

test('under script-src self with no hash for the gate, the browser blocks it and the click is a document load', async ({
	page
}) => {
	const from = log.length;
	// a blocked gate counts nothing, so the view helper has no count to wait for
	await pause();
	await page.goto(`${strict.origin}/courses/c00000`);
	await page.waitForTimeout(1500);
	await page.getByRole('link', { name: 'next' }).click();
	await page.waitForURL('**/courses/c00001');
	await page.waitForTimeout(1500);
	expect(counted(from).map((hit) => hit.path)).toEqual(['/courses/c00000', '/courses/c00001']);
});

// a list page carries the ring too, so its gate waits for a click and asks for no worker script
test('before the pack, a click to a list route makes the document and nothing else', async ({
	page
}) => {
	await view(page, main, '/courses/c00000', 1);
	await page.waitForTimeout(1500);
	const from = log.length;
	await page.getByRole('link', { name: 'all' }).click();
	await page.waitForURL('**/courses');
	await page.waitForTimeout(1500);
	expect(
		counted(from)
			.map((hit) => hit.path)
			.sort()
	).toEqual(['/courses']);
});
