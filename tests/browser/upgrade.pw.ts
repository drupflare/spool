import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toNodeListener } from '../../src/node/listener';
import { datasetProof } from '../../src/protocol/index';
import type * as Server from '../../src/server/index';
import type * as Stores from '../../src/stores/index';
import { VERSION } from '../../src/version';

const BOUND = 2;
const OLD_TAG = 'v0.2.0';
const OLD_VERSION = '0.2.0';
const root = resolve(import.meta.dirname, '../..');
const tree = join(tmpdir(), `spool-${OLD_TAG}-tree`);

type Release = { server: typeof Server; stores: typeof Stores };
type Hit = { path: string; search: string; status: number };
type Client = {
	hello: { version: string; compatible: boolean };
	status(): Promise<{ artifacts: string[] }>;
};
type SpoolWindow = { spool?: { ready: Promise<Client | null> } };

const people = [
	{ name: 'Ada', department: 'math' },
	{ name: 'Bo', department: 'cs' }
];

let old: Release | undefined;
let current: Release;

test.beforeAll(async () => {
	current = {
		server: await import('../../src/server/index'),
		stores: await import('../../src/stores/index')
	};
	try {
		if (!existsSync(join(tree, 'src/server/index.ts'))) {
			mkdirSync(tree, { recursive: true });
			execFileSync(
				'sh',
				['-c', `git archive ${OLD_TAG} src package.json | tar -x -C '${tree}'`],
				{ cwd: root, stdio: 'ignore' }
			);
			symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'), 'dir');
		}
		old = {
			server: await import(join(tree, 'src/server/index.ts')),
			stores: await import(join(tree, 'src/stores/index.ts'))
		};
	} catch {
		old = undefined;
	}
});

const layout = (title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

/** a spool of `release` over the shared store; `withQuery` adds the route only v0.3 can declare */
function spoolOf(
	release: Release,
	store: ReturnType<typeof Stores.memoryStore>,
	withQuery: boolean
) {
	const { createSpool, defineRoute } = release.server;
	const routes = [
		defineRoute('/n/:id', {
			strategy: 'template',
			template: { source: layout('{{title}}', '{{body}}') },
			depends: (ctx) => [`node:${ctx.params['id']}`],
			load: (ctx) => ({
				title: `n ${ctx.params['id']}`,
				body: db.get(ctx.params['id'] as string)
			}),
			freshness: { maxStale: BOUND, mode: 'hard' }
		})
	];
	if (withQuery) {
		routes.push(
			defineRoute('/people', {
				strategy: 'template',
				template: {
					source: layout('people', '{{#each people}}{{name}} {{/each}}')
				},
				depends: () => ['people'],
				load: async () => ({ people, proof: await datasetProof(people) }),
				query: {
					list: 'people',
					filter: { department: 'string' },
					sort: ['name'],
					pageSize: 1
				}
			} as never)
		);
	}
	return createSpool({ routes, store });
}

const db = new Map<string, string>(['1', '2', '3'].map((id) => [id, `body of ${id}`]));

async function rig(first: Server.Spool) {
	let spool = first;
	const hits: Hit[] = [];
	const app = (request: Request) => {
		const { pathname, searchParams } = new URL(request.url);
		const [, kind, id = ''] = pathname.split('/');
		if (kind === 'n' && db.has(id)) return html(layout(`n ${id}`, db.get(id) as string));
		if (pathname === '/people')
			return html(layout('people', `page ${searchParams.get('page')}`));
		return new Response('not found', { status: 404 });
	};
	const html = (text: string) =>
		new Response(text, {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' }
		});
	const listener = toNodeListener(async (request) => {
		const url = new URL(request.url);
		const response = await spool.handle(request, app);
		hits.push({ path: url.pathname, search: url.search, status: response.status });
		return response;
	});
	const server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	return {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		hits,
		swap(next: Server.Spool) {
			spool = next;
		},
		stop: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			})
	};
}

const client = (page: Page) =>
	page.evaluate(async () => {
		const handle = await (window as unknown as SpoolWindow).spool?.ready;
		return handle
			? { version: handle.hello.version, compatible: handle.hello.compatible }
			: null;
	});

const held = (page: Page) =>
	page.evaluate(async () => {
		const handle = await (window as unknown as SpoolWindow).spool?.ready;
		return handle ? (await handle.status()).artifacts : null;
	});

async function install(page: Page, origin: string, version: string) {
	await page.goto(`${origin}/n/1`);
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	expect(await client(page)).toEqual({ version, compatible: true });
	await page.goto(`${origin}/n/2`);
	await expect.poll(() => held(page)).toContain('/n/2');
}

async function sleepPast(seconds: number) {
	await new Promise((r) => setTimeout(r, seconds * 1000 + 250));
}

/** a window of server traffic has settled once no request arrives for a moment */
async function quiet(hits: Hit[]) {
	for (let last = -1; hits.length !== last;) {
		last = hits.length;
		await new Promise((r) => setTimeout(r, 300));
	}
}

const refused = (hits: Hit[]) =>
	hits.filter((h) => h.path.startsWith('/.spool/') && h.status >= 400);

function watch(page: Page) {
	const problems: string[] = [];
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	page.on('console', (message) => {
		if (message.type() === 'error' && !message.text().includes('404'))
			problems.push(`console: ${message.text()}`);
	});
	return problems;
}

test.describe('a site upgrading from v0.2 to v0.3', () => {
	test.beforeEach(() => test.skip(!old, `needs the ${OLD_TAG} tag to extract the old release`));

	test('a v0.2 worker keeps working against a v0.3 server, query routes included', async ({
		page
	}) => {
		const store = (old as Release).stores.memoryStore();
		const fx = await rig(spoolOf(old as Release, store, false));
		const problems = watch(page);
		try {
			await install(page, fx.origin, OLD_VERSION);
			await quiet(fx.hits);

			const newer = spoolOf(current, store as never, true);
			fx.swap(newer);
			fx.hits.length = 0;
			db.set('2', 'changed on the new server');
			await newer.invalidate(['node:2']);

			await sleepPast(BOUND);
			await page.goto(`${fx.origin}/n/2`);
			await expect(page.locator('main p')).toHaveText('changed on the new server');
			await page.goto(`${fx.origin}/people?page=2`);
			await expect(page.locator('main p')).toHaveText('page 2');
			await quiet(fx.hits);

			expect(refused(fx.hits)).toEqual([]);
			expect(await held(page)).toContain('/n/2');
			expect(problems).toEqual([]);
		} finally {
			db.set('2', 'body of 2');
			await fx.stop();
		}
	});

	test('a v0.3 worker keeps working against a site still serving v0.2', async ({ page }) => {
		const store = current.stores.memoryStore();
		const fx = await rig(spoolOf(current, store, true));
		const problems = watch(page);
		try {
			await install(page, fx.origin, VERSION);
			await quiet(fx.hits);

			const older = spoolOf(old as Release, store as never, false);
			fx.swap(older);
			fx.hits.length = 0;
			db.set('2', 'changed on the old server');
			await older.invalidate(['node:2']);

			await sleepPast(BOUND);
			await page.goto(`${fx.origin}/n/2`);
			await expect(page.locator('main p')).toHaveText('changed on the old server');
			await quiet(fx.hits);

			expect(refused(fx.hits)).toEqual([]);
			expect(fx.hits.filter((h) => h.path === '/.spool/artifact').length).toBeGreaterThan(0);
			expect(await held(page)).toContain('/n/2');
			expect(problems).toEqual([]);
		} finally {
			db.set('2', 'body of 2');
			await fx.stop();
		}
	});

	test('the v0.3 worker replaces a v0.2 worker, empties its replica and drops its caches', async ({
		page
	}) => {
		const store = (old as Release).stores.memoryStore();
		const fx = await rig(spoolOf(old as Release, store, false));
		const problems = watch(page);
		try {
			await install(page, fx.origin, OLD_VERSION);
			await page.evaluate(async (version) => {
				const cache = await caches.open(`spool-assets-${version}`);
				await cache.put('/stale.css', new Response('a{b:c}'));
			}, OLD_VERSION);
			await quiet(fx.hits);

			fx.swap(spoolOf(current, store as never, true));
			const taken = page.evaluate(
				() =>
					new Promise<boolean>((done) => {
						navigator.serviceWorker.addEventListener(
							'controllerchange',
							() => done(true),
							{
								once: true
							}
						);
						setTimeout(() => done(false), 20_000);
					})
			);
			await page.evaluate(async () => {
				await navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'none' });
				await (await navigator.serviceWorker.getRegistration())?.update();
			});
			expect(await taken, 'the new worker took over the page').toBe(true);
			expect(
				await page.evaluate(async () => {
					const worker = (await navigator.serviceWorker.getRegistration())?.active;
					const channel = new MessageChannel();
					const reply = new Promise<{ version: string }>((done) => {
						channel.port1.onmessage = (event) => done(event.data);
					});
					worker?.postMessage({ type: 'spool:hello', protocol: 1 }, [channel.port2]);
					return (await reply).version;
				})
			).toBe(VERSION);

			await expect
				.poll(() =>
					page.evaluate(async () =>
						(await caches.keys()).filter((name) => name.startsWith('spool-assets-'))
					)
				)
				.not.toContain(`spool-assets-${OLD_VERSION}`);
			await page.goto(`${fx.origin}/n/1`);
			await expect.poll(() => held(page)).toContain('/n/1');
			expect(await held(page)).not.toContain('/n/2');
			expect(refused(fx.hits)).toEqual([]);
			expect(problems).toEqual([]);
		} finally {
			await fx.stop();
		}
	});
});
