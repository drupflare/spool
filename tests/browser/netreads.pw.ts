import { expect, test, type Page } from '@playwright/test';
import { defineDataset } from '../../src/protocol/index';
import { createSpool, defineRoute } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled, listen, type Hit } from './fixture';

type Article = { id: string; title: string };
type Held = { partition: string | null; datasets: Array<{ name: string }> };
type SpoolWindow = { spool: { ready: Promise<unknown> } };

const ARTICLES = new Map<string, Article>(
	Array.from({ length: 100 }, (_, i): [string, Article] => {
		const id = `r${String(i).padStart(3, '0')}`;
		return [id, { id, title: `Article ${i}` }];
	})
);
const rows = [...ARTICLES.values()];

let pageOrigin = '';
let apiOrigin = '';
let spool: ReturnType<typeof createSpool>;
let stopPage: (() => Promise<void>) | undefined;
let stopApi: () => Promise<void>;
const pageHits: Hit[] = [];
const apiHits: Hit[] = [];

const cookieUser = (request: Request) =>
	/(?:^|;\s*)user=([A-Za-z0-9]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;

const layout = (body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>articles</title></head><body><main><p>${body}</p></main></body></html>`;

const html = (text: string, headers: Record<string, string> = {}) =>
	new Response(text, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'max-age=0',
			...headers
		}
	});

// the API origin answers the page origin only, and takes the Bearer header through a preflight
const apiApp = (request: Request): Response => {
	const url = new URL(request.url);
	const cors = { 'access-control-allow-origin': pageOrigin, vary: 'origin' };
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				...cors,
				'access-control-allow-methods': 'GET',
				'access-control-allow-headers': 'authorization'
			}
		});
	}
	const row = ARTICLES.get(url.pathname.slice('/v2/articles/'.length));
	if (!row) return new Response('not found', { status: 404, headers: cors });
	return new Response(JSON.stringify(row), {
		headers: { ...cors, 'content-type': 'application/json' }
	});
};

const articles = defineDataset<Article>(
	'articles',
	{
		scope: 'principal',
		maxStaleMs: 3_600_000,
		schema: 'v1',
		maxRows: 1000,
		maxBytes: 1_000_000,
		key: (row) => row.id,
		fields: () => ['id', 'title'],
		seed: () => rows,
		read: () => [],
		changes: () => 'reset',
		horizon: () => 0,
		head: () => ({ cursor: 1 })
	},
	{ principalDatasets: true }
);

test.beforeAll(async () => {
	const api = await listen(apiHits, createSpool({ routes: [], store: memoryStore() }), apiApp);
	apiOrigin = api.origin;
	stopApi = api.stop;

	spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/about', {
				strategy: 'template',
				template: { source: layout('about') },
				load: () => ({})
			}),
			defineRoute('/v2/articles/:id', {
				strategy: 'data',
				scope: 'principal',
				origin: apiOrigin,
				family: { dataset: 'articles', key: 'id' }
			})
		],
		store: memoryStore(),
		datasets: [articles],
		principalDatasets: true,
		identity: {
			secret: 'netreads-fixture-secret',
			resolve: (request) => {
				const user = cookieUser(request);
				return user ? { principal: user } : null;
			}
		}
	});
	const app = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/login') {
			const as = url.searchParams.get('as') as string;
			return html(layout(`signed in as ${as}`), {
				'set-cookie': `user=${as}; Path=/`,
				'spool-partition': await spool.partition(as)
			});
		}
		if (url.pathname === '/about') return html(layout('about'));
		return new Response('not found', { status: 404 });
	};
	const page = await listen(pageHits, spool, app);
	pageOrigin = page.origin;
	stopPage = page.stop;
});

test.afterAll(async () => {
	await stopPage?.();
	await stopApi();
});

test.beforeEach(() => {
	pageHits.length = 0;
	apiHits.length = 0;
});

const own = () => pageHits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');
const apiGets = () => apiHits.filter((h) => h.method === 'GET');

/** asks the worker what its partition holds, through a message channel as the page runtime does */
const held = (page: Page): Promise<Held> =>
	page.evaluate(
		() =>
			new Promise<Held>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data as Held);
				(navigator.serviceWorker.controller as ServiceWorker).postMessage(
					{ type: 'spool:partition' },
					[channel.port2]
				);
			})
	);

async function register(page: Page): Promise<void> {
	await page.goto(`${pageOrigin}/about`);
	await controlled(page);
	await page.evaluate(() => (globalThis as unknown as SpoolWindow).spool.ready);
}

async function signIn(page: Page, as: string): Promise<void> {
	const id = await spool.partition(as);
	// WebKit coalesces its script check inside one second, so a navigation waits 1.5 s
	await new Promise((r) => setTimeout(r, 1600));
	await page.goto(`${pageOrigin}/login?as=${as}`);
	await expect.poll(async () => (await held(page)).partition).toBe(id);
}

/** the page's own fetch of an API item, with or without the Bearer header */
const article = (page: Page, id: string, bearer: boolean) =>
	page.evaluate(
		async ({ url, bearer }) => {
			const init = bearer ? { headers: { Authorization: 'Bearer test-token' } } : undefined;
			return (await fetch(url, init)).text();
		},
		{ url: `${apiOrigin}/v2/articles/${id}`, bearer }
	);

test('answers a held item the device never fetched from the signed-in partition, with 0 requests to either origin', async ({
	page: tab
}) => {
	await register(tab);
	await signIn(tab, 'A');
	// the first read misses: it reaches the API and seeds the principal dataset
	expect(await article(tab, 'r001', true)).toBe(JSON.stringify(ARTICLES.get('r001')));
	await expect
		.poll(async () => (await held(tab)).datasets.map((d) => d.name))
		.toEqual(['articles']);
	await new Promise((r) => setTimeout(r, 1600));

	pageHits.length = 0;
	apiHits.length = 0;
	expect(await article(tab, 'r042', true)).toBe(JSON.stringify(ARTICLES.get('r042')));
	expect(own()).toEqual([]);
	expect(apiHits).toEqual([]);

	// a request without the Bearer header never reads the signed-in partition
	expect(await article(tab, 'r007', false)).toBe(JSON.stringify(ARTICLES.get('r007')));
	expect(apiGets().map((h) => h.path)).toEqual(['/v2/articles/r007']);
});

test('a Bearer read with no signed-in partition goes to the API', async ({ page: tab }) => {
	await register(tab);
	await new Promise((r) => setTimeout(r, 1600));
	expect(await article(tab, 'r042', true)).toBe(JSON.stringify(ARTICLES.get('r042')));
	expect(apiGets().map((h) => h.path)).toEqual(['/v2/articles/r042']);
});
