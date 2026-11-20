import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import {
	buildPack,
	compileTemplate,
	defineDataset,
	digestAdd,
	digestSub,
	equivalent,
	interpretTemplate,
	rowHash,
	setProof,
	type QuerySchema
} from '../../src/protocol/index';
import { createSpool, defineRoute } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled, listen, type Hit } from './fixture';

type Row = { id: string; title: string; dept: string };
type SpoolWindow = { spool: { ready: Promise<unknown> } };
type DatasetStatus = {
	datasets: Array<{ name: string; count: number; cursor: number; digest: string }>;
	outcomes: Record<string, number>;
};

const NAME = 'directory';
const DEPTS = ['cs', 'math', 'art'];
const SCHEMA: QuerySchema = {
	list: 'items',
	dataset: NAME,
	filter: { dept: 'string' },
	pageSize: 5
};

const rows = new Map<string, Row>(
	Array.from({ length: 100 }, (_, i): [string, Row] => {
		const id = `r${String(i).padStart(3, '0')}`;
		return [id, { id, title: `Title ${i}`, dept: DEPTS[i % 3] as string }];
	})
);
const sorted = () => [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
let cursor = 0;
let digest = '';
const events: Array<{ cursor: number; key: string }> = [];

async function edit(id: string, title: string): Promise<void> {
	const old = rows.get(id) as Row;
	const next = { ...old, title };
	digest = digestAdd(digestSub(digest, await rowHash(id, old)), await rowHash(id, next));
	rows.set(id, next);
	cursor += 1;
	events.push({ cursor, key: id });
}

const dataset = defineDataset<Row>(NAME, {
	scope: 'public',
	schema: 'v1',
	maxRows: 1000,
	maxBytes: 1_000_000,
	key: (row) => row.id,
	seed: () => sorted(),
	read: (ids) => ids.flatMap((id) => (rows.has(id) ? [rows.get(id) as Row] : [])),
	changes: (since) => {
		if (since > cursor) return 'reset';
		const keys = new Set(events.filter((e) => e.cursor > since).map((e) => e.key));
		return {
			cursor,
			puts: [...keys],
			deletes: [],
			proof: { kind: 'set', count: rows.size, digest }
		};
	},
	horizon: () => 0,
	head: () => ({ cursor, proof: { kind: 'set', count: rows.size, digest } })
});

const layout = (summary: string, items: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>Directory</title></head><body><main><h1>Directory</h1><p id="summary">${summary}</p><ul>${items}</ul></main></body></html>`;

const rowTemplate = {
	source: layout('row {{params.id}}', '<li>{{row.id}} {{row.title}}</li>')
};
const compiledRow = compileTemplate(rowTemplate);

const page = (dept: string | null, n: number) => {
	const all = sorted().filter((r) => dept === null || r.dept === dept);
	return {
		items: all.slice((n - 1) * 5, n * 5),
		total: all.length,
		pages: Math.ceil(all.length / 5)
	};
};

/** the pack store as one browser module, bundled from the working tree by bun */
function bundle(entry: string): string {
	const built = spawnSync('bun', ['build', entry, '--target', 'browser', '--format', 'esm'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
	return built.stdout;
}

const PACK_HOST = `<!doctype html><meta charset="utf-8"><title>pack host</title><script type="module">import * as pack from '/pack.js';window.pack=pack;</script>`;

let packJs = '';
let origin: string;
let stop: () => Promise<void>;
const log: Hit[] = [];
const own = () =>
	log
		.map((h) => `${h.path}${h.search}`)
		.filter((path) => !['/spool-sw.js', '/.spool/beacon', '/cdn-cgi/rum'].includes(path));

test.beforeAll(async () => {
	packJs = bundle('src/sw/pack/store.ts');
	digest = (await setProof(rows)).digest;
	const spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/browse', {
				strategy: 'template',
				template: {
					source: layout(
						'{{query.page}} of {{query.pages}}, {{query.total}} found',
						'{{#each items}}<li>{{id}} {{title}}</li>{{/each}}'
					)
				},
				query: SCHEMA,
				freshness: { maxStale: 2, mode: 'soft' },
				load: () => ({})
			}),
			defineRoute('/plan', {
				strategy: 'template',
				template: {
					source: '<main><ul>{{#each rows}}<li>{{dept}} {{n}}</li>{{/each}}</ul></main>'
				},
				query: {
					list: 'rows',
					dataset: NAME,
					plan: {
						from: ['id', 'dept'],
						where: [{ field: 'dept', op: 'eq', param: 'dept', type: 'string' }],
						group: { by: ['dept'], aggregates: { n: 'count' } },
						pageSize: 5,
						limit: 100
					}
				},
				load: () => ({})
			}),
			defineRoute('/rows/:id', {
				strategy: 'template',
				template: rowTemplate,
				family: { dataset: NAME, key: 'id' },
				load: (ctx) => rows.get(ctx.params['id'] as string)
			})
		],
		store: memoryStore(),
		datasets: [dataset]
	});
	const app = (request: Request) => {
		const url = new URL(request.url);
		if (url.pathname === '/pack.js') {
			return new Response(packJs, {
				headers: { 'content-type': 'text/javascript; charset=utf-8' }
			});
		}
		if (url.pathname === '/pack-host') {
			return new Response(PACK_HOST, {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		if (url.pathname === '/plan') {
			const dept = url.searchParams.get('dept');
			const groups = [...DEPTS]
				.sort()
				.filter((d) => dept === null || d === dept)
				.map((d) => `<li>${d} ${sorted().filter((r) => r.dept === d).length}</li>`)
				.join('');
			return new Response(`<main><ul>${groups}</ul></main>`, {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		if (url.pathname.startsWith('/rows/')) {
			const id = url.pathname.slice('/rows/'.length);
			const row = rows.get(id);
			if (!row) return new Response('not found', { status: 404 });
			const html = interpretTemplate(compiledRow, { params: { id }, row });
			return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
		}
		if (url.pathname !== '/browse') return new Response('not found', { status: 404 });
		const dept = url.searchParams.get('dept');
		const n = Number(url.searchParams.get('page') ?? '1');
		const result = page(dept, n);
		const list = result.items.map((r) => `<li>${r.id} ${r.title}</li>`).join('');
		return new Response(layout(`${n} of ${result.pages}, ${result.total} found`, list), {
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	};
	const started = await listen(log, spool, app);
	origin = started.origin;
	stop = started.stop;
});

test.afterAll(() => stop());

const datasets = (p: Page) =>
	p.evaluate(
		() =>
			new Promise<DatasetStatus>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data as DatasetStatus);
				navigator.serviceWorker.controller?.postMessage({ type: 'spool:datasets' }, [
					channel.port2
				]);
			})
	);

const artifacts = (p: Page) =>
	p.evaluate(async () => {
		const client = (await (window as unknown as SpoolWindow).spool.ready) as {
			status(): Promise<{ artifacts: string[] }>;
		};
		return (await client.status()).artifacts;
	});

const expected = (dept: string, n: number) => page(dept, n).items.map((r) => `${r.id} ${r.title}`);

async function seed(p: Page): Promise<void> {
	await p.goto(`${origin}/browse`);
	// a page with no ring loads the runtime from the second view, so view 1 costs the baseline
	await p.waitForTimeout(1600);
	await p.goto(`${origin}/browse`);
	await controlled(p);
	await p.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await p.goto(`${origin}/browse`);
	await expect.poll(() => artifacts(p)).toContain('/browse');
	await p.goto(`${origin}/browse`);
	await expect.poll(async () => (await datasets(p)).datasets.map((d) => d.count)).toEqual([100]);
}

async function clearSiteData(p: Page): Promise<void> {
	await p.evaluate(async () => {
		for (const registration of await navigator.serviceWorker.getRegistrations()) {
			await registration.unregister();
		}
		for (const name of await caches.keys()) await caches.delete(name);
		await new Promise<void>((resolve) => {
			const request = indexedDB.deleteDatabase('spool');
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		});
	});
}

test('holds a dataset, answers queries from it offline, applies a patch, and recovers from cleared site data', async ({
	page: tab,
	context,
	browserName
}) => {
	await seed(tab);
	expect(own().filter((p) => p.startsWith('/.spool/dataset'))).toEqual([
		'/.spool/dataset?name=directory'
	]);
	await new Promise((r) => setTimeout(r, 600));

	log.length = 0;
	await tab.goto(`${origin}/browse?dept=cs&page=2`);
	await expect(tab.locator('li')).toHaveText(expected('cs', 2));
	await expect(tab.locator('#summary')).toHaveText('2 of 7, 34 found');
	expect(own()).toEqual([]);
	if (browserName !== 'webkit') expect(log.map((h) => h.path)).toEqual([]);

	await context.setOffline(true);
	await tab.goto(`${origin}/browse?dept=math&page=3`);
	await expect(tab.locator('li')).toHaveText(expected('math', 3));
	await context.setOffline(false);

	await edit('r015', 'Patched 15');
	await new Promise((r) => setTimeout(r, 2300));
	log.length = 0;
	await tab.goto(`${origin}/browse?dept=cs&page=2`);
	await new Promise((r) => setTimeout(r, 1500));
	expect(own()).toEqual([]);
	expect((await datasets(tab)).datasets[0]?.cursor).toBe(cursor - 1);
	await tab.goto(`${origin}/nowhere`);
	await expect.poll(async () => (await datasets(tab)).datasets[0]?.cursor).toBe(cursor);
	await tab.goto(`${origin}/browse?dept=cs&page=2`);
	await expect(tab.locator('li').first()).toHaveText('r015 Patched 15');
	expect(own().filter((p) => p.startsWith('/.spool/dataset'))).toEqual([
		`/.spool/dataset?name=directory&since=${cursor - 1}&schema=v1`
	]);
	expect((await datasets(tab)).datasets[0]?.digest).toBe(digest);

	await clearSiteData(tab);
	const fresh = await context.newPage();
	await tab.close();
	await seed(fresh);
	await new Promise((r) => setTimeout(r, 600));
	log.length = 0;
	await fresh.goto(`${origin}/browse?dept=art&page=1`);
	await expect(fresh.locator('li')).toHaveText(expected('art', 1));
	expect(own()).toEqual([]);
	expect((await datasets(fresh)).datasets[0]?.digest).toBe(digest);
});

test('answers a plan route from the held rows with no server request', async ({ page: tab }) => {
	await seed(tab);
	await new Promise((r) => setTimeout(r, 600));
	await tab.goto(`${origin}/plan`);
	await expect.poll(() => artifacts(tab)).toContain('/plan');
	await tab.goto(`${origin}/plan`);
	await new Promise((r) => setTimeout(r, 600));
	log.length = 0;
	await tab.goto(`${origin}/plan?dept=cs`);
	await expect(tab.locator('li')).toHaveText(['cs 34']);
	expect(own()).toEqual([]);
});

test('renders a family row the page never fetched from the held rows, equal to the server page', async ({
	page: tab,
	browser
}) => {
	const pause = () => new Promise((r) => setTimeout(r, 1600));
	await seed(tab);
	const packed = await buildPack({
		version: 1,
		tables: { [NAME]: sorted().map((row): [string, Row] => [row.id, row]) }
	});
	await tab.goto(`${origin}/pack-host`);
	await tab.waitForFunction(() => 'pack' in window);
	const installed = await tab.evaluate(async (bytes: number[]) => {
		const { pack } = window as unknown as {
			pack: {
				createPackStore(factory: IDBFactory): {
					installPack(
						source: AsyncIterable<Uint8Array<ArrayBuffer>>
					): Promise<{ installed: boolean }>;
				};
			};
		};
		async function* once() {
			yield new Uint8Array(bytes);
		}
		return pack.createPackStore(indexedDB).installPack(once());
	}, Array.from(packed.bytes));
	expect(installed.installed).toBe(true);
	await pause();
	await tab.goto(`${origin}/rows/r001`);
	await pause();
	log.length = 0;
	await tab.goto(`${origin}/rows/r042`);
	await expect(tab.locator('li')).toHaveText('r042 Title 42');
	expect(own()).toEqual([]);
	// both sides go through the browser's own serialiser, with no worker, to compare like with like
	const plain = await browser.newContext({ serviceWorkers: 'block' });
	const server = await plain.newPage();
	await server.goto(`${origin}/rows/r042`);
	const strip = (html: string) =>
		html.replace(/<script src="\/\.spool\/[^"]*"[^>]*><\/script>/g, '');
	const verdict = equivalent(strip(await tab.content()), strip(await server.content()));
	await plain.close();
	expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
});

test('sends a family row to the network when the device holds no pack', async ({ page: tab }) => {
	await seed(tab);
	await new Promise((r) => setTimeout(r, 1600));
	log.length = 0;
	await tab.goto(`${origin}/rows/r007`);
	await expect(tab.locator('li')).toHaveText('r007 Title 7');
	expect(own()[0]).toBe('/rows/r007');
});
