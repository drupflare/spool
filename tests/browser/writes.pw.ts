import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeListener } from '../../src/node/listener';
import {
	buildPack,
	defineDataset,
	defineResource,
	HEADERS,
	type BundleDelta,
	type BundleRows
} from '../../src/protocol/index';
import { createSpool, defineRoute, memoryBundleStore } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled } from './fixture';

/**
 * A declared resource write reaches the server once, and the device applies the rows the server reports
 * before the page gets the answer. The next local read of the item costs nothing. A forced digest
 * mismatch costs one delta fetch; a refused write changes no local row. A write past the byte limit
 * has no delta; its digest confirms the rows the device predicted, so it costs no delta fetch.
 */
const ROWS = 12;
const ROWS_TABLE = 'rows';
const NOTES_TABLE = 'notes';
const STUB = '/spool-sw.js';
const DWELL_MS = 300;
const SETTLE_MS = 1_500;
const CHECK_MS = 10_000;
const LEASE_MS = 6_000;
const HTML = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' };

type Row = { id: string; title: string };
type Hit = { method: string; path: string };
type PackWindow = {
	pack: {
		createPackStore(factory: IDBFactory): {
			installPack(
				source: AsyncIterable<Uint8Array<ArrayBuffer>>
			): Promise<{ installed: boolean; version: number }>;
		};
	};
};

const PAGE_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>writes</title><script type="module">import * as pack from '/pack.js';window.pack=pack;</script></head><body></body></html>`;
// the page registers the worker itself, which is the script check a lease waits for
const PAGE_TPL = `<!doctype html><html><head><meta charset="utf-8"><title>tpl</title><script>navigator.serviceWorker.register('/spool-sw.js',{updateViaCache:'all'})</script></head><body><main><h1>{{row.title}}</h1></main></body></html>`;

let packJs = '';

/** the pack store as one browser module, bundled from the working tree by bun */
function bundle(entry: string): string {
	const built = spawnSync('bun', ['build', entry, '--target', 'browser', '--format', 'esm'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
	return built.stdout;
}

/** a public dataset over `rows`, whose `changes` answers from a log of puts and removes */
function table(name: string, rows: Map<string, Row>) {
	const log: Array<{ key: string; deleted: boolean }> = [];
	const dataset = defineDataset(name, {
		scope: 'public',
		key: (row) => String((row as Row).id),
		seed: () => [...rows.values()],
		read: async (ids) => ids.flatMap((id) => (rows.has(id) ? [rows.get(id) as Row] : [])),
		changes: async (since) => {
			const latest = new Map<string, boolean>();
			for (const entry of log.slice(since)) latest.set(entry.key, entry.deleted);
			const puts = [...latest].filter(([, gone]) => !gone).map(([key]) => key);
			const deletes = [...latest]
				.filter(([, gone]) => gone)
				.map(([key]) => ({ key, cursor: log.length }));
			return { cursor: log.length, puts, deletes };
		},
		horizon: async () => 0,
		head: async () => ({ cursor: log.length }),
		schema: 'v1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});
	return {
		dataset,
		put(row: Row) {
			rows.set(row.id, row);
			log.push({ key: row.id, deleted: false });
		},
		remove(id: string) {
			rows.delete(id);
			log.push({ key: id, deleted: true });
		}
	};
}

/** the delta header with a digest that cannot match, so the device refuses it */
function corruptHeader(response: Response): Response {
	const header = response.headers.get(HEADERS.delta);
	if (header === null) return response;
	const delta = JSON.parse(header) as BundleDelta;
	delta.digest = '0'.repeat(64);
	const headers = new Headers(response.headers);
	headers.set(HEADERS.delta, JSON.stringify(delta));
	return new Response(response.body, { status: response.status, headers });
}

async function startSite(options: { lease?: number } = {}) {
	const rows = new Map<string, Row>(
		Array.from({ length: ROWS }, (_, i): [string, Row] => {
			const id = `r${String(i + 1).padStart(3, '0')}`;
			return [id, { id, title: `Title ${i + 1}` }];
		})
	);
	const notes = new Map<string, Row>([['n1', { id: 'n1', title: 'Note one' }]]);
	const rowsTable = table(ROWS_TABLE, rows);
	const notesTable = table(NOTES_TABLE, notes);
	const store = memoryStore();
	const bundles = memoryBundleStore();
	const spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/notes/:id', {
				strategy: 'data',
				family: { dataset: NOTES_TABLE, key: 'id' }
			}),
			defineRoute('/tpl/:id', {
				strategy: 'template',
				template: { source: PAGE_TPL },
				depends: () => [ROWS_TABLE],
				load: (ctx) => ({ row: rows.get(ctx.params['id'] as string) })
			})
		],
		resources: [defineResource('/rows', { dataset: ROWS_TABLE, key: 'id' })],
		datasets: [rowsTable.dataset, notesTable.dataset],
		store,
		bundles,
		...(options.lease === undefined ? {} : { freshness: { maxAge: options.lease } })
	});

	/** bumps the store and keeps the pack of that version, as the lease test does */
	const publish = async (): Promise<number> => {
		const version = await store.bump([ROWS_TABLE, NOTES_TABLE]);
		const sorted = (map: Map<string, Row>): BundleRows =>
			[...map.values()]
				.sort((a, b) => (a.id < b.id ? -1 : 1))
				.map((row): [string, Row] => [row.id, row]);
		const tables: Record<string, BundleRows> = {
			[ROWS_TABLE]: sorted(rows),
			[NOTES_TABLE]: sorted(notes)
		};
		await bundles.put(version, (await buildPack({ version, tables })).bytes);
		return version;
	};

	let corrupt = false;
	let reject = false;
	const hits: Hit[] = [];
	const app = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (pathname === '/') return new Response(PAGE_HOME, { headers: HTML });
		if (pathname === '/pack.js') {
			return new Response(packJs, {
				headers: { 'content-type': 'text/javascript; charset=utf-8' }
			});
		}
		const tplItem = /^\/tpl\/([^/]+)$/.exec(pathname)?.[1];
		const tplRow = tplItem === undefined ? undefined : rows.get(tplItem);
		if (request.method === 'GET' && tplRow) {
			return new Response(PAGE_TPL.replace('{{row.title}}', tplRow.title), { headers: HTML });
		}
		const item = /^\/rows\/([^/]+)$/.exec(pathname)?.[1];
		if (request.method === 'GET' && item) {
			const row = rows.get(item);
			return row ? Response.json(row) : new Response('gone', { status: 404 });
		}
		if (request.method === 'PATCH' && item) {
			if (reject) return new Response('refused', { status: 403 });
			const body = (await request.json()) as { title: string };
			rowsTable.put({ id: item, title: body.title });
			return Response.json({ id: item, title: body.title });
		}
		if (request.method === 'POST' && pathname === '/rows') {
			const body = (await request.json()) as Row;
			rowsTable.put(body);
			return Response.json(body, { status: 201 });
		}
		if (request.method === 'DELETE' && item) {
			rowsTable.remove(item);
			return new Response(null, { status: 204 });
		}
		return new Response('not found', { status: 404 });
	};
	const listener = toNodeListener(async (request) => {
		const { pathname } = new URL(request.url);
		hits.push({ method: request.method, path: pathname });
		const response = await spool.handle(request, app);
		return corrupt && request.method !== 'GET' ? corruptHeader(response) : response;
	});
	const server: Server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		hits,
		publish,
		packOf: (version: number) => bundles.get(version),
		/** a row the pack does not hold, so a read of it goes to the network */
		putRow: (row: Row) => void rowsTable.put(row),
		/** changes a row the server holds and bumps the pack to the new version */
		edit: (id: string, title: string) => {
			rowsTable.put({ id, title });
			return publish();
		},
		setCorrupt: (on: boolean) => {
			corrupt = on;
		},
		setReject: (on: boolean) => {
			reject = on;
		},
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

type Site = Awaited<ReturnType<typeof startSite>>;

/** the server requests since `from`, without the worker script check that a page's register may make */
const requestsSince = (site: Site, from: number) =>
	site.hits.slice(from).filter((hit) => hit.path !== STUB);

/** the version the device's pack store holds, read from IndexedDB without loading the module */
const headOf = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number | null>((resolve) => {
				const open = indexedDB.open('spool-bundle');
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('head').objectStore('head').get('active');
					get.onerror = () => resolve(null);
					get.onsuccess = () => {
						db.close();
						resolve((get.result as { version: number } | undefined)?.version ?? null);
					};
				};
			})
	);

/** a page-side request; returns the status and, for a 2xx JSON answer, the body */
const send = (page: Page, method: string, path: string, body?: unknown) =>
	page.evaluate(
		async ({ method, path, body }) => {
			const response = await fetch(path, {
				method,
				headers: body === undefined ? {} : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			return { status: response.status, text: await response.text() };
		},
		{ method, path, body }
	);

const titleOf = async (page: Page, path: string) => {
	const { text } = await send(page, 'GET', path);
	return (JSON.parse(text) as Row).title;
};

test.beforeAll(() => {
	packJs = bundle('src/sw/pack/store.ts');
});

test('a declared write reaches the server once, and the next local read costs nothing', async ({
	page,
	browserName
}) => {
	test.setTimeout(240_000);
	const site = await startSite();
	const { origin } = site;
	const checks: Record<string, number> = {};
	const count = (label: string, from: number) => {
		checks[label] = requestsSince(site, from).length;
	};

	try {
		expect(await site.publish()).toBe(1);
		const packed = await site.packOf(1);
		if (!packed) throw new Error('no pack for version 1');

		await page.goto(`${origin}/`);
		await page.waitForFunction(() => 'pack' in window);
		const installed = await page.evaluate(async (bytes: number[]) => {
			const { pack } = window as unknown as PackWindow;
			async function* once() {
				yield new Uint8Array(bytes);
			}
			return pack.createPackStore(indexedDB).installPack(once());
		}, Array.from(packed));
		expect(installed).toMatchObject({ installed: true, version: 1 });

		await page.evaluate(() =>
			navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
		);
		await controlled(page);
		await page.goto(`${origin}/`);
		await page.waitForTimeout(DWELL_MS);

		// a held read costs nothing
		let from = site.hits.length;
		expect(await titleOf(page, '/rows/r001')).toBe('Title 1');
		expect(requestsSince(site, from)).toEqual([]);

		// PATCH: one request, then the held row shows the change with no request
		from = site.hits.length;
		expect((await send(page, 'PATCH', '/rows/r002', { title: 'Patched 2' })).status).toBe(200);
		expect(requestsSince(site, from)).toEqual([{ method: 'PATCH', path: '/rows/r002' }]);
		count('patch', from);
		from = site.hits.length;
		expect(await titleOf(page, '/rows/r002')).toBe('Patched 2');
		expect(requestsSince(site, from)).toEqual([]);
		expect(await headOf(page)).toBe(2);

		// POST: one request, then the new row reads with no request
		from = site.hits.length;
		const posted = await send(page, 'POST', '/rows', { id: 'r013', title: 'Made 13' });
		expect(posted.status).toBe(201);
		expect(requestsSince(site, from)).toEqual([{ method: 'POST', path: '/rows' }]);
		count('post', from);
		from = site.hits.length;
		expect(await titleOf(page, '/rows/r013')).toBe('Made 13');
		expect(requestsSince(site, from)).toEqual([]);
		expect(await headOf(page)).toBe(3);

		// DELETE: one request; the removed row is no longer held, so its read goes to the network
		from = site.hits.length;
		expect((await send(page, 'DELETE', '/rows/r003')).status).toBe(204);
		expect(requestsSince(site, from)).toEqual([{ method: 'DELETE', path: '/rows/r003' }]);
		count('delete', from);
		from = site.hits.length;
		expect((await send(page, 'GET', '/rows/r003')).status).toBe(404);
		expect(requestsSince(site, from)).toEqual([{ method: 'GET', path: '/rows/r003' }]);
		expect(await headOf(page)).toBe(4);

		// a read of an unrelated family is still held
		from = site.hits.length;
		expect(await titleOf(page, '/notes/n1')).toBe('Note one');
		expect(requestsSince(site, from)).toEqual([]);

		// the collection reads from the pack, so the POST's row shows and the DELETE's row does not
		from = site.hits.length;
		const listed = JSON.parse((await send(page, 'GET', '/rows')).text) as { rows: Row[] };
		expect(requestsSince(site, from)).toEqual([]);
		const ids = listed.rows.map((row) => row.id);
		expect(ids).toContain('r013');
		expect(ids).not.toContain('r003');
		count('collection', from);

		// a forced digest mismatch: the write and exactly one delta fetch, then the held read is local
		site.setCorrupt(true);
		from = site.hits.length;
		expect((await send(page, 'PATCH', '/rows/r005', { title: 'Patched 5' })).status).toBe(200);
		site.setCorrupt(false);
		expect(requestsSince(site, from)).toEqual([
			{ method: 'PATCH', path: '/rows/r005' },
			{ method: 'GET', path: '/.spool/bundle/delta/4/5' }
		]);
		count('mismatch', from);
		from = site.hits.length;
		expect(await titleOf(page, '/rows/r005')).toBe('Patched 5');
		expect(requestsSince(site, from)).toEqual([]);
		expect(await headOf(page)).toBe(5);

		// a refused write changes no local row
		site.setReject(true);
		from = site.hits.length;
		expect((await send(page, 'PATCH', '/rows/r006', { title: 'Refused' })).status).toBe(403);
		site.setReject(false);
		expect(requestsSince(site, from)).toEqual([{ method: 'PATCH', path: '/rows/r006' }]);
		from = site.hits.length;
		expect(await titleOf(page, '/rows/r006')).toBe('Title 6');
		expect(requestsSince(site, from)).toEqual([]);
		expect(await headOf(page)).toBe(5);

		// a write past the delta's byte limit: the answer leaves the delta out, the digest confirms the
		// predicted rows, and the write and the reads after it cost one request
		from = site.hits.length;
		const wide = 'x'.repeat(20_000);
		expect((await send(page, 'POST', '/rows', { id: 'r014', title: wide })).status).toBe(201);
		expect(requestsSince(site, from)).toEqual([{ method: 'POST', path: '/rows' }]);
		count('post past limit', from);
		from = site.hits.length;
		expect(await titleOf(page, '/rows/r014')).toBe(wide);
		expect(requestsSince(site, from)).toEqual([]);
		from = site.hits.length;
		const relisted = JSON.parse((await send(page, 'GET', '/rows')).text) as { rows: Row[] };
		expect(requestsSince(site, from)).toEqual([]);
		expect(relisted.rows.map((row) => row.id)).toContain('r014');
		expect(await headOf(page)).toBe(6);
	} finally {
		console.log(JSON.stringify({ engine: browserName, requests: checks }));
		await site.stop();
	}
});

test('a resource item the pack does not hold goes to the network with no artifact request', async ({
	page,
	browserName
}) => {
	test.setTimeout(240_000);
	const site = await startSite();
	const { origin } = site;
	try {
		expect(await site.publish()).toBe(1);
		const packed = await site.packOf(1);
		if (!packed) throw new Error('no pack for version 1');

		await page.goto(`${origin}/`);
		await page.waitForFunction(() => 'pack' in window);
		await page.evaluate(async (bytes: number[]) => {
			const { pack } = window as unknown as PackWindow;
			async function* once() {
				yield new Uint8Array(bytes);
			}
			return pack.createPackStore(indexedDB).installPack(once());
		}, Array.from(packed));
		await page.evaluate(() =>
			navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
		);
		await controlled(page);
		await page.goto(`${origin}/`);
		await page.waitForTimeout(DWELL_MS);

		site.putRow({ id: 'r900', title: 'Title 900' });
		const from = site.hits.length;
		for (let i = 0; i < 3; i++) {
			expect(await titleOf(page, '/rows/r900')).toBe('Title 900');
		}
		expect(site.hits.slice(from).map((hit) => hit.path)).toEqual([
			'/rows/r900',
			'/rows/r900',
			'/rows/r900'
		]);
	} finally {
		console.log(JSON.stringify({ engine: browserName }));
		await site.stop();
	}
});

test('a stored template page shows a row the new worker moved, once its lease ends', async ({
	page,
	browserName
}) => {
	test.setTimeout(240_000);
	const site = await startSite({ lease: LEASE_MS / 1000 });
	const { origin } = site;
	/** the requests a view made, as paths; the script check a page's register makes is left out */
	const pageHits = (from: number) =>
		site.hits
			.slice(from)
			.filter((hit) => hit.path !== STUB)
			.map((hit) => hit.path);
	try {
		expect(await site.publish()).toBe(1);
		const packed = await site.packOf(1);
		if (!packed) throw new Error('no pack for version 1');

		await page.goto(`${origin}/`);
		await page.waitForFunction(() => 'pack' in window);
		await page.evaluate(async (bytes: number[]) => {
			const { pack } = window as unknown as PackWindow;
			async function* once() {
				yield new Uint8Array(bytes);
			}
			return pack.createPackStore(indexedDB).installPack(once());
		}, Array.from(packed));
		await page.evaluate(() =>
			navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
		);
		await controlled(page);
		await page.goto(`${origin}/`);
		await page.waitForTimeout(SETTLE_MS);
		await page.goto(`${origin}/tpl/r001`);
		expect(await page.textContent('main h1')).toBe('Title 1');
		// the artifact arrives after the page; the view after it is local
		await page.waitForTimeout(SETTLE_MS);
		const stored = site.hits.length;
		await page.goto(`${origin}/tpl/r001`);
		expect(await page.textContent('main h1')).toBe('Title 1');
		expect(pageHits(stored)).toEqual([]);

		await site.edit('r001', 'Changed One');
		// the first load after the lease checks the script; the new worker takes the page
		let from = 0;
		await expect
			.poll(
				async () => {
					await page.waitForTimeout(SETTLE_MS);
					from = site.hits.length;
					await page.goto(`${origin}/tpl/r001`);
					return page.textContent('main h1');
				},
				{ timeout: CHECK_MS * 3 }
			)
			.toBe('Changed One');
		// the navigation that showed the change fetched the page's artifact again
		await page.waitForTimeout(SETTLE_MS);
		expect(pageHits(from)).toEqual(['/tpl/r001', '/.spool/artifact']);

		await page.waitForTimeout(SETTLE_MS);
		const next = site.hits.length;
		await page.goto(`${origin}/tpl/r001`);
		expect(await page.textContent('main h1')).toBe('Changed One');
		expect(pageHits(next)).toEqual([]);
	} finally {
		console.log(JSON.stringify({ engine: browserName }));
		await site.stop();
	}
});
