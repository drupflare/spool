import { HttpRequest } from '@azure/functions';
import { getTestServer } from '@google-cloud/functions-framework/testing';
import { createApp, toWebHandler } from 'h3';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { couplingReport, decodeEnvelope, HEADERS, readBundle } from '../../src/protocol/index';
import { shapeRows, type QuerySchema } from '../../src/protocol/query';
import { closeServers, listen, overFetch, overHttp, type Fetcher } from './exercise';

afterEach(closeServers);

async function exercise(get: Fetcher): Promise<void> {
	const list = await get('/courses');
	expect(list.status).toBe(200);
	expect((await list.text()).match(/<li>/g)).toHaveLength(3);

	const item = await get('/courses/101');
	const itemHtml = await item.text();
	expect(item.status).toBe(200);
	expect(itemHtml).toContain('<h1>Intro to Drupal</h1>');
	expect(itemHtml.match(/data-spool-gate/g)).toHaveLength(1);
	expect(decodeEnvelope(item.headers).artifact?.id).toBe('/courses/101');
	expect((await get('/courses/999')).status).toBe(404);

	const home = await get('/');
	expect(home.status).toBe(200);
	expect((await home.text()).match(/<h1>Courses<\/h1>/g)).toHaveLength(1);

	const sw = await get('/spool-sw.js');
	expect(sw.status).toBe(200);
	expect(sw.headers.get('etag')).toMatch(/^"[\w-]+"$/);
	expect(await sw.text()).toContain('__SPOOL_CONFIG__');

	const pack = await get('/.spool/bundle/1');
	expect(pack.status).toBe(200);
	const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
	expect(state.tables['courses']).toHaveLength(3);
	expect(state.tables['path:courses']).toHaveLength(3);

	const ping = await get('/ping');
	expect(ping.status).toBe(200);
	expect(ping.headers.get('content-type')).toBe('text/plain');
	expect(ping.headers.get('spool-artifact')).toBeNull();
	expect(await ping.text()).toBe('pong');
}

const site = (path: string) => new Request(`https://site.test${path}`);

// the proxy and the middleware answer the worker script and the pack; they do not answer pages
async function exerciseSpoolPaths(answer: (request: Request) => Promise<Response | undefined>) {
	const sw = await answer(site('/spool-sw.js'));
	expect(sw?.status).toBe(200);
	expect(await sw?.text()).toContain('__SPOOL_CONFIG__');
	const etag = sw?.headers.get('etag') ?? '';
	expect(etag).toMatch(/^"[\w-]+"$/);
	const same = await answer(
		new Request('https://site.test/spool-sw.js', { headers: { 'if-none-match': etag } })
	);
	expect(same?.status).toBe(304);

	const pack = await answer(site('/.spool/bundle/1'));
	expect(pack?.status).toBe(200);
	const { state } = await readBundle(new Uint8Array(await pack!.arrayBuffer()));
	expect(state.tables['courses']).toHaveLength(3);
	expect(state.tables['path:courses']).toHaveLength(3);
}

type LambdaResult = {
	statusCode: number;
	headers?: Record<string, string>;
	body?: string;
	isBase64Encoded?: boolean;
};

function functionUrlEvent(path: string) {
	const [rawPath = '/', rawQueryString = ''] = path.split('?');
	return {
		version: '2.0',
		routeKey: '$default',
		rawPath,
		rawQueryString,
		headers: { host: 'site.test' },
		requestContext: {
			domainName: 'site.test',
			http: { method: 'GET', path: rawPath, protocol: 'HTTP/1.1', sourceIp: '1.1.1.1' }
		},
		isBase64Encoded: false
	};
}

// the most 'close' listeners any one reply holds while the server writes it
function trackCloseListeners(server: Server): () => number {
	let peak = 0;
	server.prependListener('request', (_req, res) => {
		res.on('newListener', (event) => {
			if (event === 'close') peak = Math.max(peak, res.listenerCount('close') + 1);
		});
	});
	return () => peak;
}

describe('the examples serve the same site', () => {
	it('node:http through toNodeListener', async () => {
		const { server } = await import('../../examples/courses/node/server');
		await exercise(overHttp(await listen(server)));
	});

	it('Express through spoolExpress', async () => {
		const { app } = await import('../../examples/courses/express/app');
		await exercise(overHttp(await listen(createServer(app))));
	});

	it('Hono through spoolHono, through app.fetch', async () => {
		const app = (await import('../../examples/courses/hono/app')).default;
		await exercise(overFetch((request) => app.fetch(request)));
	});

	it('Vercel Functions through the default fetch export', async () => {
		const vercel = (await import('../../examples/courses/vercel/vercel')).default;
		await exercise(overFetch((request) => vercel.fetch(request)));
	});

	it('Next.js route handler through GET', async () => {
		const { GET } = await import('../../examples/courses/next-route/next-route');
		await exercise(overFetch(GET));
	});

	it('Next.js proxy answers the worker script and the pack, and passes pages on', async () => {
		const { proxy } = await import('../../examples/courses/next-proxy/next-proxy');
		await exerciseSpoolPaths(async (request) => proxy(request));
		expect(await proxy(site('/courses'))).toBeUndefined();
		expect(await proxy(site('/courses/101'))).toBeUndefined();
		expect(await proxy(site('/ping'))).toBeUndefined();
	});

	it('Nuxt route through toWebRequest', async () => {
		const handler = (await import('../../examples/courses/nuxt-route/nuxt-route')).default;
		const web = toWebHandler(createApp().use(handler));
		await exercise(overFetch((request) => web(request)));
	});

	it('Nuxt middleware answers the worker script and the pack, and passes pages on', async () => {
		const { default: handler } =
			await import('../../examples/courses/nuxt-middleware/nuxt-middleware');
		const web = toWebHandler(
			createApp()
				.use(handler)
				.use(() => new Response('origin'))
		);
		await exerciseSpoolPaths(web);
		for (const path of ['/courses', '/courses/101', '/ping']) {
			expect(await (await web(site(path))).text()).toBe('origin');
		}
	});

	it('AWS Lambda, through the Hono adapter and a Function URL event', async () => {
		const { handler: lambda } = await import('../../examples/courses/aws-lambda/lambda');
		await exercise(async (path) => {
			const result = (await lambda(
				functionUrlEvent(path) as never,
				{} as never
			)) as LambdaResult;
			const body = result.isBase64Encoded
				? Buffer.from(result.body ?? '', 'base64')
				: (result.body ?? '');
			return new Response(body, { status: result.statusCode, headers: result.headers });
		});
	});

	it('Azure Functions converts an HttpRequest and returns an HttpResponseInit', async () => {
		const { handler: azure } = await import('../../examples/courses/azure-functions/azure');
		await exercise(async (path) => {
			const result = await azure(
				new HttpRequest({ url: `https://site.test${path}`, method: 'GET' })
			);
			return new Response(result.body as ArrayBuffer, {
				status: result.status,
				headers: result.headers as HeadersInit
			});
		});
	});

	it('Google Cloud Functions, through the Functions Framework test server', async () => {
		await import('../../examples/courses/google-cloud-functions/google-cloud');
		const server = getTestServer('spool') as ReturnType<typeof createServer>;
		await exercise(overHttp(await listen(server)));
	});

	it('Express and hapi write each reply within the default listener limit', async () => {
		const { app } = await import('../../examples/courses/express/app');
		const express = createServer(app);
		const expressPeak = trackCloseListeners(express);
		await exercise(overHttp(await listen(express)));
		expect(expressPeak()).toBeLessThanOrEqual(EventEmitter.defaultMaxListeners);

		const { server } = await import('../../examples/courses/hapi/hapi');
		const hapiPeak = trackCloseListeners(server.listener);
		await server.start();
		try {
			await exercise(overHttp(server.info.uri));
		} finally {
			await server.stop();
		}
		expect(hapiPeak()).toBeLessThanOrEqual(EventEmitter.defaultMaxListeners);
	});

	it('Cloudflare Worker through its exported fetch', async () => {
		const worker = (await import('../../examples/courses/cloudflare-worker/worker')).default;
		await exercise(overFetch((request) => worker.fetch(request)));
	});

	it('Cloudflare Pages Functions through onRequest, with the site as next', async () => {
		const mod = await import('../../examples/courses/cloudflare-pages/cloudflare-pages');
		const { courseSpool } = await import('../../examples/courses/shared/site');
		const { page } = await courseSpool();
		await exercise(
			overFetch((request) => mod.onRequest({ request, next: async () => page(request) }))
		);
	});

	it('Netlify Functions through the default export', async () => {
		const mod = await import('../../examples/courses/netlify-functions/netlify-functions');
		await exercise(overFetch((request) => mod.default(request, {} as never)));
	});

	it('Netlify Edge Functions through the default export, with the site as next', async () => {
		const { default: edge } = await import('../../examples/courses/netlify-edge/netlify-edge');
		const { courseSpool } = await import('../../examples/courses/shared/site');
		const { page } = await courseSpool();
		await exercise(
			overFetch((request) => edge(request, { next: async () => page(request) } as never))
		);
	});

	it('Bun through its exported fetch', async () => {
		const bun = (await import('../../examples/courses/bun/bun')).default;
		await exercise(overFetch((request) => bun.fetch(request)));
	});

	it('Deno through its exported fetch', async () => {
		const deno = (await import('../../examples/courses/deno/deno')).default;
		await exercise(overFetch((request) => deno.fetch(request)));
	});

	it('Elysia through onRequest and the route handlers', async () => {
		const { app } = await import('../../examples/courses/elysia/elysia');
		await exercise(overFetch((request) => app.handle(request)));
	});

	it('itty-router through its exported fetch', async () => {
		const router = (await import('../../examples/courses/itty-router/itty-router')).default;
		await exercise(overFetch((request) => router.fetch(request)));
	});
});

describe('the shared course site', () => {
	it('courses(200) builds a 200-row pack, and the item page carries a ring of its entry row', async () => {
		const { courseSpool } = await import('../../examples/courses/shared/site');
		const { spool, page } = await courseSpool(200);

		const pack = await spool.handle(site('/.spool/bundle/1'), page);
		expect(pack.status).toBe(200);
		const bytes = new Uint8Array(await pack.arrayBuffer());
		const { state } = await readBundle(bytes);
		expect(state.tables['courses']).toHaveLength(200);
		expect(state.tables['path:courses']).toHaveLength(200);

		const html = await (await spool.handle(site('/courses/101'), page)).text();
		expect(html.match(/id="spool-ring"/g)).toHaveLength(1);
		const element = /<script type="application\/json" id="spool-ring">(.*?)<\/script>/s;
		const match = element.exec(html);
		const ring = JSON.parse(match![1]!);
		expect(ring.complete).toBe(false);
		expect(ring.pack).toEqual({ url: '/.spool/bundle/1', bytes: bytes.length });
		// the boot script carries the pack, so the gate page's ring holds no rows
		expect(ring.tables).toEqual({});
	});
});

type Call = (path: string, init?: RequestInit) => Promise<Response>;

const withCookie = (user: string): RequestInit => ({ headers: { cookie: `user=${user}` } });

const firstMatch = (text: string, pattern: RegExp) => pattern.exec(text)?.[0];

async function heldKeys(call: Call, user: string): Promise<string[]> {
	const response = await call('/.spool/dataset?name=profiles', withCookie(user));
	expect(response.status).toBe(200);
	const seed = (await response.json()) as { puts: Array<{ key: string }> };
	return seed.puts.map((put) => put.key);
}

async function exerciseAdvanced(call: Call): Promise<void> {
	const { COURSES, PEOPLE, ARTICLES, PAGE_SIZE } =
		await import('../../examples/campus/shared/site');
	const CATALOGUE_QUERY: QuerySchema = {
		list: 'courses',
		filter: { department: 'string' },
		sort: ['title'],
		pageSize: PAGE_SIZE
	};
	const linkedCourses = (html: string) =>
		[...html.matchAll(/<a href="\/courses\/(\w+)">([^<]+)<\/a>/g)].map((match) => [
			match[1],
			match[2]
		]);
	const webCourses = (page: number) =>
		COURSES.filter((course) => course.department === 'web')
			.sort((a, b) => (a.title < b.title ? -1 : 1))
			.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
			.map((course) => [course.id, course.title]);

	const list = await call('/courses');
	expect(list.status).toBe(200);
	expect(linkedCourses(await list.text())).toEqual(
		COURSES.map((course) => [course.id, course.title])
	);

	const item = await call('/courses/101');
	const itemHtml = await item.text();
	expect(item.status).toBe(200);
	expect(firstMatch(itemHtml, /<h1>.*?<\/h1>/)).toBe('<h1>Intro to Drupal</h1>');
	expect(itemHtml.match(/data-spool-gate/g)).toHaveLength(1);
	expect(itemHtml.match(/id="spool-ring"/g)).toHaveLength(1);
	expect(decodeEnvelope(item.headers).artifact?.id).toBe('/courses/101');
	expect((await call('/courses/999')).status).toBe(404);

	const plain = await (await call('/catalogue')).text();
	expect(firstMatch(plain, /<p>.*?<\/p>/)).toBe('<p>Add a department to the address.</p>');
	const web = await (await call('/catalogue?department=web&sort=title')).text();
	expect(firstMatch(web, /<p>.*?<\/p>/)).toBe('<p>3 courses, page 1 of 2</p>');
	expect(linkedCourses(web)).toEqual(webCourses(1));
	const second = await (await call('/catalogue?department=web&sort=title&page=2')).text();
	expect(firstMatch(second, /<p>.*?<\/p>/)).toBe('<p>3 courses, page 2 of 2</p>');
	expect(linkedCourses(second)).toEqual(webCourses(2));

	const heldIds = (search: string) => {
		const shaped = shapeRows(CATALOGUE_QUERY, { courses: COURSES }, search);
		if (!shaped.ok) throw new Error(shaped.reason);
		return (shaped.data as { courses: Array<{ id: string }> }).courses.map(
			(course) => course.id
		);
	};
	const originIds = async (path: string) =>
		linkedCourses(await (await call(path)).text()).map(([id]) => id);
	expect(await originIds('/catalogue?department=web')).toEqual(heldIds('?department=web'));
	expect(await originIds('/catalogue?department=web&sort=title')).toEqual(
		heldIds('?department=web&sort=title')
	);

	expect(firstMatch(await (await call('/people/dee')).text(), /<h1>.*?<\/h1>/)).toBe(
		'<h1>Dee Shah</h1>'
	);
	expect((await call('/people/zed')).status).toBe(404);

	const article = await call('/news/2026/ring-budget');
	expect(firstMatch(await article.text(), /<h1>.*?<\/h1>/)).toBe('<h1>The ring budget</h1>');
	expect(decodeEnvelope(article.headers).artifact?.id).toBe('/news/2026/ring-budget');
	expect((await call('/news/2025/ring-budget')).status).toBe(404);

	const team = await call('/teams/web');
	expect(firstMatch(await team.text(), /<ul>.*<\/ul>/s)).toBe(
		'<ul><li>Ada Park</li><li>Bo Lin</li></ul>'
	);

	const data = await call('/api/courses/202');
	expect(await data.json()).toEqual({ id: '202', title: 'Linear Algebra', department: 'math' });
	expect(decodeEnvelope(data.headers).artifact?.id).toBe('/api/courses/202');

	const css = await call('/site.css');
	expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
	expect(await css.text()).toBe('body{margin:0}');
	expect(decodeEnvelope(css.headers).artifact?.id).toBe('/site.css');

	const sw = await call('/spool-sw.js');
	expect(sw.status).toBe(200);
	expect(await sw.text()).toContain('__SPOOL_CONFIG__');

	const pack = await call('/.spool/bundle/1');
	expect(pack.status).toBe(200);
	const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
	expect(state.tables['courses']).toHaveLength(COURSES.length);
	// /courses/:id and /api/courses/:id are both one-param family routes, so each course has two paths
	expect(state.tables['path:courses']).toHaveLength(2 * COURSES.length);
	expect(state.tables['query:courses']).toHaveLength(COURSES.length);
	expect(state.tables['people']).toHaveLength(PEOPLE.length);
	expect(state.tables['path:people']).toHaveLength(PEOPLE.length);
	expect(state.tables['news']).toHaveLength(ARTICLES.length);
	expect(state.tables['path:news']).toBeUndefined();
	expect(state.tables['profiles']).toBeUndefined();

	const anon = await call('/account');
	expect(anon.status).toBe(401);
	expect(await anon.text()).toBe('sign in');
	expect(anon.headers.get('spool-artifact')).toBeNull();

	const login = await call('/login?as=ada', { method: 'POST' });
	expect(login.status).toBe(200);
	expect(login.headers.get('set-cookie')).toBe('user=ada; Path=/');
	const adaPartition = login.headers.get('spool-partition');
	expect(adaPartition).toBeTruthy();

	const account = await call('/account', withCookie('ada'));
	const accountHtml = await account.text();
	expect(account.status).toBe(200);
	expect(firstMatch(accountHtml, /<h1>.*?<\/h1>/)).toBe('<h1>Ada Park</h1>');
	expect(firstMatch(accountHtml, /<p>.*?<\/p>/)).toBe('<p><span>101</span><span>102</span></p>');
	expect(decodeEnvelope(account.headers).artifact?.id).toBe('/account');
	expect(account.headers.get('spool-partition')).toBe(adaPartition);
	const adaKeys = await heldKeys(call, 'ada');
	expect(adaKeys).toEqual(['ada', 'cy']);

	const bo = await call('/account', withCookie('bo'));
	const boHtml = await bo.text();
	expect(firstMatch(boHtml, /<h1>.*?<\/h1>/)).toBe('<h1>Bo Lin</h1>');
	expect(boHtml).not.toContain('Ada Park');
	expect(bo.headers.get('spool-partition')).not.toBe(adaPartition);
	const boKeys = await heldKeys(call, 'bo');
	expect(boKeys).toEqual(['bo', 'dee']);
	expect(boKeys.filter((key) => adaKeys.includes(key))).toEqual([]);

	const classmate = await call('/classmates/cy', withCookie('ada'));
	expect(firstMatch(await classmate.text(), /<h1>.*?<\/h1>/)).toBe('<h1>Cy Ortiz</h1>');
	expect((await call('/classmates/cy', withCookie('bo'))).status).toBe(404);
	expect((await call('/classmates/cy')).status).toBe(401);

	const logout = await call('/logout', withCookie('ada'));
	expect(logout.status).toBe(200);
	expect(logout.headers.get('spool-clear')).toBe('*');
	expect(logout.headers.get('set-cookie')).toBe('user=; Max-Age=0; Path=/');
	expect((await call('/account')).status).toBe(401);
	expect((await call('/.spool/dataset?name=profiles')).status).toBe(401);
}

describe('the campus examples', () => {
	it('node:http through toNodeListener', async () => {
		const { server } = await import('../../examples/campus/node/server');
		const base = await listen(server);
		await exerciseAdvanced((path, init) => fetch(`${base}${path}`, init));
	});

	it('Cloudflare Worker through its exported fetch', async () => {
		const worker = (await import('../../examples/campus/cloudflare-worker/worker')).default;
		await exerciseAdvanced((path, init) =>
			worker.fetch(new Request(`https://site.test${path}`, init))
		);
	});

	it('declares the per-route freshness and the logout path', async () => {
		const { campusSite, NEWS_FRESHNESS } = await import('../../examples/campus/shared/site');
		const { spool } = await campusSite();
		const route = spool.config.routes.find((r) => r.pattern === '/news/:year/:slug');
		expect(route?.freshness).toEqual({ ...NEWS_FRESHNESS });
		expect(spool.config.logout).toEqual(['/logout']);
	});

	it('answers a list URL with a query from the held rows, and leaves the bare list URL to the network', async () => {
		const { campusSite } = await import('../../examples/campus/shared/site');
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createNavigator } = await import('../../src/client/navigate');
		const { freshIndexedDB } = await import('./helpers');
		const { spool, page } = await campusSite();
		const bundle = await spool.handle(site('/.spool/bundle/1'), page);
		const store = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await store.installPack(once());
		await store.putRoutes(spool.config.routes, spool.config.templates);
		const navigator = createNavigator({
			store,
			templates: spool.config.templates,
			clientTag: ''
		});
		await navigator.ready;
		const bare = new URL('https://site.test/catalogue');
		const web = new URL('https://site.test/catalogue?department=web');
		expect(navigator.offers(bare)).toBe(false);
		expect(await navigator.render(bare)).toBeNull();
		expect(navigator.offers(web)).toBe(true);
		expect(firstMatch((await navigator.render(web)) ?? '', /<p>.*?<\/p>/)).toBe(
			'<p>3 courses, page 1 of 2</p>'
		);
	});

	it('through the device worker: a bare list URL renders the origin page from the stored artifact', async () => {
		const { campusSite } = await import('../../examples/campus/shared/site');
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createRuntime } = await import('../../src/sw/runtime');
		const { memoryStorage } = await import('../../src/sw/storage');
		const { fakeCaches, freshIndexedDB, nav } = await import('./helpers');
		const { spool, page } = await campusSite();
		const bundle = await spool.handle(site('/.spool/bundle/1'), page);
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				asked.push(`${request.method} ${url.pathname}${url.search}`);
				const answer = await spool.handle(request, page);
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: 'https://site.test',
			pack
		});
		const background: Promise<unknown>[] = [];
		const send = (path: string) =>
			runtime.handle(
				nav(`https://site.test${path}`),
				(promise) => void background.push(promise)
			);
		const settle = () => Promise.all(background.splice(0));
		const main = (html: string) => firstMatch(html, /<main[\s\S]*?<\/main>/);

		const origin = main(await (await send('/catalogue'))!.text());
		expect(origin).toContain('Add a department to the address.');
		await settle();
		await send('/catalogue');
		await settle();
		asked.length = 0;
		const local = await send('/catalogue');
		expect(main(await local!.text())).toBe(origin);
		expect(asked).toEqual([]);
	});

	it('through the device worker: a query on a list route is read from the held pack, with no request', async () => {
		const { campusSite } = await import('../../examples/campus/shared/site');
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createRuntime } = await import('../../src/sw/runtime');
		const { memoryStorage } = await import('../../src/sw/storage');
		const { fakeCaches, freshIndexedDB, nav } = await import('./helpers');
		const { spool, page } = await campusSite();
		const bundle = await spool.handle(site('/.spool/bundle/1'), page);
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				asked.push(`${request.method} ${url.pathname}${url.search}`);
				const answer = await spool.handle(request, page);
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: 'https://site.test',
			pack
		});
		const background: Promise<unknown>[] = [];
		const send = (path: string) =>
			runtime.handle(
				nav(`https://site.test${path}`),
				(promise) => void background.push(promise)
			);
		const settle = () => Promise.all(background.splice(0));

		await send('/catalogue');
		await settle();
		asked.length = 0;
		const web = await send('/catalogue?department=web');
		expect(firstMatch(await web!.text(), /<p>.*?<\/p>/)).toBe('<p>3 courses, page 1 of 2</p>');
		expect(asked).toEqual([]);
	});
});

describe('the blog examples', () => {
	async function exerciseBlog(get: (path: string) => Promise<Response>, version: number) {
		const { posts, AUTHORS, PAGE_SIZE } = await import('../../examples/blog/shared/site');
		const all = posts();
		const newest = [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
		const pages = Math.ceil(all.length / PAGE_SIZE);
		const items = (rows: typeof all) =>
			rows.map((post) => `<li><a href="/posts/${post.id}">${post.title}</a></li>`).join('');

		const home = await (await get('/')).text();
		expect(firstMatch(home, /<h1>.*?<\/h1>/)).toBe('<h1>Newest Posts</h1>');
		expect(firstMatch(home, /<ul>.*?<\/ul>/s)).toBe(
			`<ul>${items(newest.slice(0, PAGE_SIZE))}</ul>`
		);

		const second = await (await get('/?page=2')).text();
		expect(firstMatch(second, /<h1>.*?<\/h1>/)).toBe(`<h1>Page 2 of ${pages}</h1>`);
		expect(firstMatch(second, /<ul>.*?<\/ul>/s)).toBe(
			`<ul>${items(newest.slice(PAGE_SIZE, 2 * PAGE_SIZE))}</ul>`
		);

		const undeclared = await (await get('/?utm=spring')).text();
		expect(firstMatch(undeclared, /<h1>.*?<\/h1>/)).toBe(`<h1>Page 1 of ${pages}</h1>`);

		const [latest] = newest;
		const post = await get(`/posts/${latest!.id}`);
		expect(firstMatch(await post.text(), /<h1>.*?<\/h1>/)).toBe(`<h1>${latest!.title}</h1>`);
		expect(decodeEnvelope(post.headers).artifact?.id).toBe(`/posts/${latest!.id}`);
		expect((await get('/posts/00000')).status).toBe(404);

		const tagged = all.filter((entry) => entry.tag === 'web');
		const tag = await (await get('/tags?tag=web')).text();
		expect(firstMatch(tag, /<h1>.*?<\/h1>/)).toBe('<h1>Tagged Posts</h1>');
		expect(firstMatch(tag, /<p>.*?<\/p>/)).toBe(
			`<p>${tagged.length} posts, page 1 of ${Math.ceil(tagged.length / PAGE_SIZE)}</p>`
		);
		expect(firstMatch(tag, /<ul>.*?<\/ul>/s)).toBe(
			`<ul>${items(newest.filter((entry) => entry.tag === 'web').slice(0, PAGE_SIZE))}</ul>`
		);

		const matches = newest.filter((entry) => entry.title.startsWith('Caching'));
		const search = await (await get('/search?q=Caching')).text();
		expect(firstMatch(search, /<h1>.*?<\/h1>/)).toBe('<h1>Search Results</h1>');
		expect(firstMatch(search, /<p>.*?<\/p>/)).toBe(
			`<p>${matches.length} matches, page 1 of ${Math.ceil(matches.length / PAGE_SIZE)}</p>`
		);
		expect(firstMatch(search, /<ul>.*?<\/ul>/s)).toBe(
			`<ul>${items(matches.slice(0, PAGE_SIZE))}</ul>`
		);

		const [ada] = AUTHORS;
		const author = await (await get(`/authors/${ada!.id}`)).text();
		expect(firstMatch(author, /<h1>.*?<\/h1>/)).toBe(`<h1>${ada!.name}</h1>`);
		expect(firstMatch(author, /<p>.*?<\/p>/)).toBe(`<p>${ada!.bio}</p>`);

		const month = latest!.date.slice(0, 7);
		const archive = await (await get(`/archive/${month.slice(0, 4)}/${month.slice(5)}`)).text();
		expect(firstMatch(archive, /<h1>.*?<\/h1>/)).toBe(`<h1>Archive ${month}</h1>`);
		expect(firstMatch(archive, /<ul>.*?<\/ul>/s)).toBe(
			`<ul>${items(newest.filter((entry) => entry.date.startsWith(month)))}</ul>`
		);

		const robots = await get('/robots.txt');
		expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await robots.text()).toBe('User-agent: *\nAllow: /\n');
		expect(robots.headers.get('spool-artifact')).toBeNull();

		const pack = await get(`/.spool/bundle/${version}`);
		expect(pack.status).toBe(200);
		const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
		expect(state.tables['posts']).toHaveLength(all.length);
		expect(state.tables['path:posts']).toHaveLength(all.length);
		expect(state.tables['path:authors']).toHaveLength(AUTHORS.length);

		const css = await get('/site.css');
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(await css.text()).toBe('body{margin:0}');
	}

	async function firstVersion(): Promise<number> {
		const { blogSite } = await import('../../examples/blog/shared/site');
		return (await blogSite()).version;
	}

	it('node:http through toNodeListener', async () => {
		const { server } = await import('../../examples/blog/node/server');
		const base = await listen(server);
		await exerciseBlog((path) => fetch(`${base}${path}`), await firstVersion());
	});

	it('Cloudflare Worker through its exported fetch', async () => {
		const worker = (await import('../../examples/blog/cloudflare-worker/worker')).default;
		await exerciseBlog((path) => worker.fetch(site(path)), await firstVersion());
	});

	it('a post added with addPost is in the next pack delta and not in the first pack', async () => {
		const { blogSite, posts, postId } = await import('../../examples/blog/shared/site');
		const { spool, page, addPost, version } = await blogSite();
		const added = await addPost({
			title: 'Forms notes',
			author: 'bo',
			tag: 'design',
			date: '2024-12-01',
			body: 'Forms, in short.'
		});
		const newId = postId(posts().length + 1);

		const delta = await spool.handle(
			site(`/.spool/bundle/delta/${version}/${added.version}`),
			page
		);
		expect(delta.status).toBe(200);
		const change = (await delta.json()) as {
			tables: Record<string, { puts: Array<[string, unknown]> }>;
		};
		expect(change.tables['posts']!.puts.map(([key]) => key)).toEqual([newId]);
		expect(change.tables['path:posts']!.puts.map(([key]) => key)).toEqual([`/posts/${newId}`]);

		const earlier = await spool.handle(site(`/.spool/bundle/${version}`), page);
		const before = await readBundle(new Uint8Array(await earlier.arrayBuffer()));
		expect(before.state.tables['posts']!.map(([key]) => key)).not.toContain(newId);

		const later = await spool.handle(site(`/.spool/bundle/${added.version}`), page);
		const after = await readBundle(new Uint8Array(await later.arrayBuffer()));
		expect(after.state.tables['posts']!.map(([key]) => key)).toContain(newId);

		const patch = await spool.handle(
			site('/.spool/dataset?name=posts&since=1&schema=post-1'),
			page
		);
		const body = (await patch.json()) as { puts: Array<{ key: string }> };
		expect(body.puts.map((put) => put.key)).toEqual([newId]);
	});

	it('through the device worker: a bare plan URL goes to the network, never a local query view', async () => {
		const { blogSite } = await import('../../examples/blog/shared/site');
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createRuntime } = await import('../../src/sw/runtime');
		const { memoryStorage } = await import('../../src/sw/storage');
		const { fakeCaches, freshIndexedDB, nav } = await import('./helpers');
		const { spool, page, version } = await blogSite();
		const bundle = await spool.handle(site(`/.spool/bundle/${version}`), page);
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				asked.push(`${request.method} ${url.pathname}${url.search}`);
				const answer = await spool.handle(request, page);
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: 'https://site.test',
			pack
		});
		const background: Promise<unknown>[] = [];
		const send = (path: string) =>
			runtime.handle(
				nav(`https://site.test${path}`),
				(promise) => void background.push(promise)
			);
		const settle = () => Promise.all(background.splice(0));
		const main = (html: string) => firstMatch(html, /<main[\s\S]*?<\/main>/);

		const origin = main(await (await send('/search'))!.text());
		expect(origin).toContain('Search the post titles.');
		await settle();
		await send('/search');
		await settle();
		asked.length = 0;
		const again = await send('/search');
		expect(main(await again!.text())).toBe(origin);
		expect(asked).toEqual(['GET /search']);
	});
});

describe('the homepage examples', () => {
	const ringOf = (html: string) => {
		const element = /<script type="application\/json" id="spool-ring">(.*?)<\/script>/s;
		return JSON.parse(element.exec(html)![1]!) as {
			boot?: string;
			pack: { url: string; bytes: number };
			tables: Record<string, Array<[string, Record<string, unknown>]>>;
		};
	};

	async function exerciseHomepage(call: (path: string) => Promise<Response>): Promise<void> {
		const site = await import('../../examples/homepage/shared/site');
		const { ARTICLES, DEPARTMENTS, EVENTS, PAGES, PEOPLE, PROGRAMS, PAGE_SIZE, HOME_ITEMS } =
			site;
		const newest = [...ARTICLES].sort((a, b) => (a.published < b.published ? 1 : -1));

		const sw = await call('/spool-sw.js');
		expect(sw.status).toBe(200);
		expect(await sw.text()).toContain('__SPOOL_CONFIG__');

		const home = await (await call('/')).text();
		expect(firstMatch(home, /<h1>.*?<\/h1>/)).toBe('<h1>Larkspur College</h1>');
		for (const row of newest.slice(0, HOME_ITEMS)) {
			expect(home).toContain(`<a href="/news/${row.slug}">${row.title}</a>`);
		}
		for (const row of EVENTS.slice(0, HOME_ITEMS)) {
			expect(home).toContain(`<a href="/events/${row.id}">${row.title}</a>`);
		}

		expect(firstMatch(await (await call('/news')).text(), /<p>.*?<\/p>/)).toBe(
			'<p><a href="/news?page=1">Latest stories</a></p>'
		);
		const newsPage = await (await call('/news?sort=-published&page=1')).text();
		expect(firstMatch(newsPage, /<p>.*?<\/p>/)).toBe(
			`<p>${ARTICLES.length} stories, page 1 of ${Math.ceil(ARTICLES.length / PAGE_SIZE)}</p>`
		);
		expect(firstMatch(newsPage, /<ul>.*<\/ul>/s)).toBe(
			`<ul>${newest
				.slice(0, PAGE_SIZE)
				.map((row) => `<li><a href="/news/${row.slug}">${row.title}</a></li>`)
				.join('')}</ul>`
		);
		const article = await call(`/news/${newest[0]!.slug}`);
		expect(firstMatch(await article.text(), /<h1>.*?<\/h1>/)).toBe(
			`<h1>${newest[0]!.title}</h1>`
		);
		expect(decodeEnvelope(article.headers).artifact?.id).toBe(`/news/${newest[0]!.slug}`);

		const eventsPage = await (await call('/events?page=2')).text();
		expect(firstMatch(eventsPage, /<ul>.*<\/ul>/s)).toBe(
			`<ul>${EVENTS.slice(PAGE_SIZE, 2 * PAGE_SIZE)
				.map(
					(row) =>
						`<li><a href="/events/${row.id}">${row.title}</a>, ${row.starts}, ${row.place}</li>`
				)
				.join('')}</ul>`
		);
		const lastPage = Math.ceil(EVENTS.length / PAGE_SIZE);
		expect((await call(`/events?page=${lastPage + 1}`)).status).toBe(404);
		const event = await call(`/events/${EVENTS[0]!.id}`);
		expect(firstMatch(await event.text(), /<h1>.*?<\/h1>/)).toBe(
			`<h1>${EVENTS[0]!.title}</h1>`
		);
		expect(decodeEnvelope(event.headers).artifact?.id).toBe(`/events/${EVENTS[0]!.id}`);

		const department = DEPARTMENTS[0]!;
		expect(
			firstMatch(await (await call(`/departments/${department.id}`)).text(), /<h1>.*?<\/h1>/)
		).toBe(`<h1>${department.name}</h1>`);
		const program = PROGRAMS[0]!;
		expect(
			firstMatch(await (await call(`/programs/${program.id}`)).text(), /<h1>.*?<\/h1>/)
		).toBe(`<h1>${program.name}</h1>`);
		expect(
			firstMatch(await (await call(`/people/${PEOPLE[0]!.id}`)).text(), /<h1>.*?<\/h1>/)
		).toBe(`<h1>${PEOPLE[0]!.name}</h1>`);
		expect(
			firstMatch(await (await call(`/about/${PAGES[0]!.slug}`)).text(), /<h1>.*?<\/h1>/)
		).toBe(`<h1>${PAGES[0]!.title}</h1>`);

		const matching = PROGRAMS.filter((row) => row.department === department.id);
		const search = await (await call(`/programs?department=${department.id}&page=1`)).text();
		expect(firstMatch(search, /<p>.*?<\/p>/)).toBe(
			`<p>${matching.length} programs, page 1 of ${Math.ceil(matching.length / PAGE_SIZE)}</p>`
		);
		const byName = [...matching].sort((a, b) => (a.name < b.name ? -1 : 1));
		expect(firstMatch(search, /<ul>.*<\/ul>/s)).toBe(
			`<ul>${byName
				.slice(0, PAGE_SIZE)
				.map(
					(row) => `<li><a href="/programs/${row.id}">${row.name}</a> (${row.level})</li>`
				)
				.join('')}</ul>`
		);

		const css = await call('/site.css');
		expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(await css.text()).toBe(site.SITE_CSS);

		const ring = ringOf(await (await call(`/events/${EVENTS[0]!.id}`)).text());
		// the boot script carries the pack, so the gate page's ring holds no rows
		expect(ring.tables).toEqual({});
		// a visitor can start on any page: the landing page and a list page name the same boot script
		expect(ring.boot).toMatch(/^\/\.spool\/[^/]+\/boot\/\d+\.js\?r=[0-9a-f]+$/);
		expect(ringOf(home).boot).toBe(ring.boot);
		expect(ringOf(newsPage).boot).toBe(ring.boot);
		const boot = await call(ring.boot!);
		expect(boot.status).toBe(200);
		expect(boot.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		const pack = await call(ring.pack.url);
		expect(pack.status).toBe(200);
		const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
		expect(state.tables['events']).toHaveLength(EVENTS.length);
		expect(state.tables['path:events']).toHaveLength(EVENTS.length);
		expect(state.tables['news']).toHaveLength(ARTICLES.length);
		expect(state.tables['path:news']).toHaveLength(ARTICLES.length);
		expect(state.tables['path:people']).toHaveLength(PEOPLE.length);
		expect(state.tables['profiles']).toBeUndefined();

		const passthrough = await call('/robots.txt');
		expect(await passthrough.text()).toBe('User-agent: *\nAllow: /');
		expect(passthrough.headers.get('spool-artifact')).toBeNull();
	}

	it('node:http through toNodeListener', async () => {
		const { server } = await import('../../examples/homepage/node/server');
		const base = await listen(server);
		await exerciseHomepage((path) => fetch(`${base}${path}`));
	});

	it('Cloudflare Worker through its exported fetch', async () => {
		const worker = (await import('../../examples/homepage/cloudflare-worker/worker')).default;
		await exerciseHomepage((path) => worker.fetch(new Request(`https://site.test${path}`)));
	});

	it('declares the freshness of each route as the site exports it', async () => {
		const site = await import('../../examples/homepage/shared/site');
		const { spool } = await site.homepageSite();
		const freshness = (pattern: string) =>
			spool.config.routes.find((route) => route.pattern === pattern)?.freshness;
		expect(freshness('/news')).toEqual({ ...site.NEWS_FRESHNESS });
		expect(freshness('/news/:slug')).toEqual({ ...site.NEWS_FRESHNESS });
		expect(freshness('/events')).toEqual({ ...site.EVENTS_FRESHNESS });
		expect(freshness('/events/:id')).toEqual({ ...site.EVENTS_FRESHNESS });
		expect(freshness('/programs')).toEqual({ ...site.PROGRAMS_FRESHNESS });
		expect(freshness('/programs/:id')).toEqual({ ...site.PROGRAMS_FRESHNESS });
		expect(freshness('/about/:slug')).toEqual({ ...site.ABOUT_FRESHNESS });
	});

	// the worker of a device that installed the first pack and asks the site for the rest
	async function deviceOf(
		made: Awaited<
			ReturnType<(typeof import('../../examples/homepage/shared/site'))['homepageSite']>
		>
	) {
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createRuntime } = await import('../../src/sw/runtime');
		const { memoryStorage } = await import('../../src/sw/storage');
		const { fakeCaches, freshIndexedDB, nav, sub } = await import('./helpers');
		const bundle = await made.spool.handle(site('/.spool/bundle/1'), made.page);
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: made.spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				asked.push(`${request.method} ${url.pathname}${url.search}`);
				const answer = await made.spool.handle(request, made.page);
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: 'https://site.test',
			pack
		});
		const background: Promise<unknown>[] = [];
		const run = (request: Request) =>
			runtime.handle(request, (promise) => void background.push(promise));
		return {
			asked,
			settle: () => Promise.all(background.splice(0)),
			page: (path: string) => run(nav(`https://site.test${path}`)),
			read: (path: string) => run(sub(`https://site.test${path}`))
		};
	}

	it('the home page is a template over held news and events, and the device renders the origin bytes from its copy', async () => {
		const { homepageSite } = await import('../../examples/homepage/shared/site');
		const made = await homepageSite();
		expect(made.spool.config.routes.find((route) => route.pattern === '/')?.strategy).toBe(
			'template'
		);
		const device = await deviceOf(made);
		const origin = await (await device.page('/'))!.text();
		await device.settle();
		await device.page('/');
		await device.settle();
		device.asked.length = 0;
		const local = await (await device.page('/'))!.text();
		const main = (html: string) => firstMatch(html, /<main[\s\S]*?<\/main>/);
		expect(main(local)).toBe(main(origin));
		expect(main(local)).toBe(main(await (await made.page(site('/'))).text()));
		expect(device.asked).toEqual([]);
	});

	it('the data routes over /api/news and /api/events answer every row and every page with the origin JSON', async () => {
		const { homepageSite, apiBody, ARTICLES, EVENTS, PAGE_SIZE } =
			await import('../../examples/homepage/shared/site');
		const made = await homepageSite({ api: true });
		// the pack stores a row with its keys sorted, so the two bodies match as JSON, not as bytes
		const origin = async (path: string) => {
			const response = await made.page(site(path));
			expect(response.status).toBe(200);
			return response.json();
		};
		const device = await deviceOf(made);
		// the first paged read of a list goes to the network and brings the artifact the rest run over
		// the page that made these reads is a network navigation first, which gives the site policy
		await device.page('/');
		// the first read brings the artifact, the second seeds the dataset
		for (let round = 0; round < 3; round++) {
			await device.read('/api/news?page=1');
			await device.read('/api/events?page=1');
			await device.settle();
		}
		device.asked.length = 0;

		for (const row of ARTICLES) {
			const path = `/api/news/${row.slug}`;
			expect(await (await device.read(path))!.json()).toEqual(await origin(path));
		}
		for (const row of EVENTS) {
			const path = `/api/events/${row.id}`;
			expect(await (await device.read(path))!.json()).toEqual(await origin(path));
		}
		for (const [name, count] of [
			['news', ARTICLES.length],
			['events', EVENTS.length]
		] as const) {
			for (let page = 1; page <= Math.ceil(count / PAGE_SIZE); page++) {
				const path = `/api/${name}?page=${page}`;
				expect(await (await device.read(path))!.json()).toEqual(await origin(path));
			}
		}
		expect(device.asked).toEqual([]);
		expect(apiBody('news/nope', new URLSearchParams(), new Map())).toBeNull();
		expect((await made.page(site('/api/news/nope'))).status).toBe(404);
		expect(
			(await made.page(site(`/api/events?page=${Math.ceil(EVENTS.length / PAGE_SIZE) + 1}`)))
				.status
		).toBe(404);
	});

	it('a paged list read of a held pack answers with no request, before any artifact or seed', async () => {
		const { homepageSite, ARTICLES, PAGE_SIZE } =
			await import('../../examples/homepage/shared/site');
		expect(Math.ceil(ARTICLES.length / PAGE_SIZE)).toBeGreaterThanOrEqual(2);
		const made = await homepageSite({ api: true });
		const device = await deviceOf(made);
		await device.page('/');
		await device.settle();
		device.asked.length = 0;
		const local = await (await device.read('/api/news?page=2'))!.json();
		expect(device.asked).toEqual([]);
		expect(local).toEqual(await (await made.page(site('/api/news?page=2'))).json());
	});

	it('one changed event is a patch of one row, and the pages that show it read that row', async () => {
		const { applyChanges, encodeDatasetRequest, parseDatasetResponse } =
			await import('../../src/protocol/index');
		const { homepageSite, EVENTS } = await import('../../examples/homepage/shared/site');
		const site = await homepageSite();
		const answer = async (request: Parameters<typeof encodeDatasetRequest>[0]) => {
			const url = `https://site.test/.spool/dataset?${encodeDatasetRequest(request)}`;
			const response = (await site.spool.respond(new Request(url))) as Response;
			expect(response.status).toBe(200);
			return parseDatasetResponse(await response.json());
		};

		const seed = await answer({ name: 'events' });
		expect(seed.reset).toBe(true);
		expect(seed.puts).toHaveLength(EVENTS.length);
		const held = await applyChanges(new Map(), seed);
		expect(held.matches).toBe(true);

		const id = EVENTS[0]!.id;
		const title = 'Chapel talk, moved to Main Hall';
		const published = await site.updateEvent(id, { title });

		const patch = await answer({ name: 'events', since: seed.cursor, schema: seed.schema });
		expect(patch.reset).toBe(false);
		expect(patch.puts.map((put) => put.key)).toEqual([id]);
		expect(patch.deletes).toEqual([]);
		const applied = await applyChanges(held.rows, patch, held.digest);
		expect(applied.matches).toBe(true);
		expect(applied.rows.size).toBe(EVENTS.length);
		expect(applied.rows.get(id)?.['title']).toBe(title);

		const home = await (await site.page(new Request('https://site.test/'))).text();
		expect(home).toContain(`<a href="/events/${id}">${title}</a>`);

		const eventPage = await site.spool.handle(
			new Request(`https://site.test/events/${id}`),
			site.page
		);
		const ring = ringOf(await eventPage.text());
		expect(ring.tables).toEqual({});
		expect(ring.pack.url).toBe(`/.spool/bundle/${published.version}`);
		const pack = (await site.spool.respond(
			new Request(`https://site.test${ring.pack.url}`)
		)) as Response;
		const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
		expect(state.tables['events']).toHaveLength(EVENTS.length);
		expect(state.tables['events']?.find(([key]) => key === id)?.[1]).toMatchObject({ title });
	});
});

type Delta = {
	tables: Record<string, { puts: Array<[string, Record<string, unknown>]>; deletes: string[] }>;
};

const deltaOf = (response: Response): Delta | null => {
	const text = response.headers.get(HEADERS.delta);
	return text === null ? null : (JSON.parse(text) as Delta);
};

const writing = (method: string, body?: unknown, user?: string): RequestInit => ({
	method,
	headers: {
		'content-type': 'application/json',
		...(user === undefined ? {} : { cookie: `user=${user}` })
	},
	body: body === undefined ? undefined : JSON.stringify(body)
});

/** the dataset tables of a delta; index tables carry a `path:` or `query:` prefix */
const dataTables = (delta: Delta | null): string[] =>
	Object.keys(delta?.tables ?? {})
		.filter((name) => !name.includes(':'))
		.sort();

/** the puts of one table as a key-to-row map, so the order of the puts does not matter */
const putsOf = (delta: Delta | null, name: string) =>
	Object.fromEntries(delta?.tables[name]?.puts ?? []);

async function exerciseBoard(call: Call): Promise<void> {
	const health = await call('/healthz');
	expect(await health.text()).toBe('ok');
	expect(deltaOf(health)).toBeNull();
	expect(decodeEnvelope(health.headers).artifact).toBeUndefined();

	const login = await call('/login?as=ada', { method: 'POST' });
	expect(login.status).toBe(200);
	const adaPartition = login.headers.get('spool-partition');

	const created = await call(
		'/tasks',
		writing(
			'POST',
			{ project: 'site', title: 'Write the FAQ', due: '2999-12-05', assignee: 'bo' },
			'ada'
		)
	);
	expect(created.status).toBe(201);
	expect(await created.json()).toMatchObject({ id: 't6', project: 'site', status: 'todo' });
	const create = deltaOf(created);
	expect(dataTables(create)).toEqual(['projects', 'tasks']);
	expect(Object.keys(putsOf(create, 'tasks'))).toEqual(['t6']);
	expect(putsOf(create, 'projects')).toEqual({
		site: { id: 'site', name: 'Website refresh', open: 3, done: 1, overdue: 1 }
	});

	const patched = await call('/tasks/t1', writing('PATCH', { status: 'done' }, 'ada'));
	expect(patched.status).toBe(200);
	expect(Object.keys(putsOf(deltaOf(patched), 'tasks'))).toEqual(['t1']);
	expect(putsOf(deltaOf(patched), 'projects')).toEqual({
		site: { id: 'site', name: 'Website refresh', open: 2, done: 2, overdue: 0 }
	});

	const completed = await call('/tasks/t2/complete', writing('POST', undefined, 'ada'));
	expect(await completed.json()).toMatchObject({ id: 't2', status: 'done' });
	expect(Object.keys(putsOf(deltaOf(completed), 'tasks'))).toEqual(['t2']);
	expect(putsOf(deltaOf(completed), 'projects')).toEqual({
		site: { id: 'site', name: 'Website refresh', open: 1, done: 3, overdue: 0 }
	});

	const removed = await call('/tasks/t3', writing('DELETE', undefined, 'ada'));
	expect(removed.status).toBe(204);
	expect(deltaOf(removed)?.tables['tasks']).toEqual({ puts: [], deletes: ['t3'] });
	expect(putsOf(deltaOf(removed), 'projects')).toEqual({
		site: { id: 'site', name: 'Website refresh', open: 1, done: 2, overdue: 0 }
	});

	const moved = await call('/tasks/t4', writing('PATCH', { project: 'site' }, 'ada'));
	expect(moved.status).toBe(200);
	expect(Object.keys(putsOf(deltaOf(moved), 'tasks'))).toEqual(['t4']);
	expect(putsOf(deltaOf(moved), 'projects')).toEqual({
		app: { id: 'app', name: 'Campus app', open: 0, done: 1, overdue: 0 },
		site: { id: 'site', name: 'Website refresh', open: 2, done: 2, overdue: 0 }
	});

	const byBo = await call('/tasks/t6', writing('PATCH', { status: 'doing' }, 'bo'));
	expect(byBo.status).toBe(200);
	expect(dataTables(deltaOf(byBo))).toEqual(['tasks']);

	expect(
		(await call('/tasks', writing('POST', { project: 'site', title: 'No' }, 'cy'))).status
	).toBe(403);
	expect((await call('/tasks/t6', writing('PATCH', { status: 'done' }, 'cy'))).status).toBe(403);
	const anon = await call('/tasks', writing('POST', { project: 'site', title: 'No' }));
	expect(anon.status).toBe(401);
	expect(deltaOf(anon)).toBeNull();
	const put = await call('/tasks/t6', writing('PUT', { title: 'No' }, 'ada'));
	expect(put.status).toBe(405);
	expect(deltaOf(put)).toBeNull();
	expect((await call('/tasks/zz', writing('PATCH', { status: 'done' }, 'ada'))).status).toBe(404);

	const counter = await call('/projects/site');
	expect(await counter.json()).toEqual({
		id: 'site',
		name: 'Website refresh',
		open: 2,
		done: 2,
		overdue: 0
	});

	const me = await call('/me', withCookie('ada'));
	const meHtml = await me.text();
	expect(me.status).toBe(200);
	expect(firstMatch(meHtml, /<h1>.*?<\/h1>/)).toBe('<h1>Ada Park</h1>');
	expect(meHtml).not.toContain('<li>');
	expect(me.headers.get('spool-partition')).toBe(adaPartition);
	expect(decodeEnvelope(me.headers).artifact?.id).toBe('/me');

	const cy = await call('/me', withCookie('cy'));
	const cyHtml = await cy.text();
	expect(firstMatch(cyHtml, /<h1>.*?<\/h1>/)).toBe('<h1>Cy Ortiz</h1>');
	expect(cyHtml).not.toContain('<li>');
	expect(cyHtml).not.toContain('Ada Park');
	expect(cyHtml).not.toContain('Write the FAQ');
	expect((await call('/me')).status).toBe(401);

	const logout = await call('/logout', withCookie('ada'));
	expect(logout.headers.get('spool-clear')).toBe('*');
	expect((await call('/me')).status).toBe(401);
}

describe('the dashboard examples', () => {
	it('declares the status change and complete as patches, and create and delete as response and delete', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { resource } = await dashboardSite();
		const applyOf = (method: string, pattern: string) =>
			resource.writes.find((write) => write.method === method && write.pattern === pattern)
				?.apply;
		expect(applyOf('PATCH', '/tasks/:id')).toEqual({ set: { status: { body: 'status' } } });
		expect(applyOf('POST', '/tasks/:id/complete')).toEqual({ set: { status: 'done' } });
		expect(applyOf('POST', '/tasks')).toBe('response');
		expect(applyOf('DELETE', '/tasks/:id')).toBe('delete');
	});

	it('holds the board page as a template when a framework registers it, and serves it from the origin otherwise', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const register = (pattern: string) => ({
			path: pattern,
			pattern,
			register: 'network' as const,
			reason: 'served by the app'
		});
		const framework = await dashboardSite({
			pages: ['/', '/board/tasks/:id', '/board/projects/:id'].map(register)
		});
		expect(framework.uncovered).toEqual([]);
		const board = framework.spool.config.routes.find((route) => route.pattern === '/');
		expect(board?.strategy).toBe('template');
		const plain = await dashboardSite();
		expect(plain.spool.config.routes.some((route) => route.pattern === '/')).toBe(false);
		const html = (made: typeof framework) =>
			made.page(site('/')).then((response) => response.text());
		expect(await html(framework)).toBe(await html(plain as unknown as typeof framework));
	});

	it('through the device worker: one request per declared write, none for the collection after', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { createPackStore } = await import('../../src/sw/pack/store');
		const { createRuntime } = await import('../../src/sw/runtime');
		const { memoryStorage } = await import('../../src/sw/storage');
		const { fakeCaches, freshIndexedDB } = await import('./helpers');
		const { spool, page, built } = await dashboardSite();
		const bundle = await spool.handle(site(`/.spool/bundle/${built.version}`), page);
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield new Uint8Array(await bundle.arrayBuffer());
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				asked.push(`${request.method} ${new URL(request.url).pathname}`);
				const answer = await spool.handle(request, page);
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: 'https://site.test',
			pack
		});
		const send = (path: string, init?: RequestInit) =>
			runtime.handle(new Request(`https://site.test${path}`, init), () => undefined);

		// the first collection read takes the site policy from the network
		expect((await send('/tasks'))?.status).toBe(200);
		expect(asked[0]).toBe('GET /tasks');
		const warm = asked.length;
		expect((await send('/tasks/t1', writing('PATCH', { status: 'done' }, 'ada')))?.status).toBe(
			200
		);
		expect(asked.slice(warm)).toEqual(['GET /.spool/artifact', 'PATCH /tasks/t1']);
		expect(await pack.getRow('tasks', 't1')).toMatchObject({ status: 'done' });
		expect(await pack.getRow('projects', 'site')).toEqual({
			id: 'site',
			name: 'Website refresh',
			open: 1,
			done: 2,
			overdue: 0
		});

		expect((await send('/tasks/t2/complete', writing('POST', undefined, 'ada')))?.status).toBe(
			200
		);
		expect(asked.slice(warm)).toEqual([
			'GET /.spool/artifact',
			'PATCH /tasks/t1',
			'POST /tasks/t2/complete'
		]);
		expect(await pack.getRow('projects', 'site')).toMatchObject({ open: 0, done: 3 });

		const collection = await send('/tasks');
		expect(collection?.status).toBe(200);
		expect(asked.slice(warm)).toHaveLength(3);
		// the held answer and the origin's are one JSON body, so a page reads either the same way
		expect(await collection?.json()).toEqual(await (await page(site('/tasks'))).json());
		expect((await pack.head())?.unconfirmed).toBe(0);
	});

	it('builds one pack of the public tables; the member rows stay out of it', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { TASKS, PROJECTS } = await import('../../examples/dashboard/shared/site');
		const { spool, page, built } = await dashboardSite();
		const pack = await spool.handle(site(`/.spool/bundle/${built.version}`), page);
		const bytes = new Uint8Array(await pack.arrayBuffer());
		expect(bytes.length).toBe(built.bytes);
		const { state } = await readBundle(bytes);
		expect(state.tables['tasks']).toHaveLength(TASKS.length);
		expect(state.tables['projects']).toHaveLength(PROJECTS.length);
		expect(state.tables['path:tasks']).toHaveLength(TASKS.length);
		expect(state.tables['members']).toBeUndefined();
	});

	it('couples a same-origin write to its resource and leaves another origin uncovered', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { resource } = await dashboardSite();
		const report = couplingReport(
			[
				{ method: 'PATCH', url: 'https://site.test/tasks/t1' },
				{ method: 'PATCH', url: 'https://other.test/tasks/t1' }
			],
			[resource],
			'https://site.test'
		);
		expect(report).toEqual([
			{
				method: 'PATCH',
				url: 'https://site.test/tasks/t1',
				resource: '/tasks',
				families: ['/tasks', '/tasks/:id']
			},
			{ method: 'PATCH', url: 'https://other.test/tasks/t1', resource: null, families: [] }
		]);
	});

	it('node:http through toNodeListener', async () => {
		const { server } = await import('../../examples/dashboard/node/server');
		const base = await listen(server);
		await exerciseBoard((path, init) => fetch(`${base}${path}`, init));
	});

	it('Cloudflare Worker through its exported fetch', async () => {
		const worker = (await import('../../examples/dashboard/cloudflare-worker/worker')).default;
		await exerciseBoard((path, init) =>
			worker.fetch(new Request(`https://site.test${path}`, init))
		);
	});

	it('Express through spoolExpress', async () => {
		const { app } = await import('../../examples/dashboard/express/app');
		const base = await listen(createServer(app));
		await exerciseBoard((path, init) => fetch(`${base}${path}`, init));
	});

	it('Hono through spoolHono', async () => {
		const app = (await import('../../examples/dashboard/hono/app')).default;
		await exerciseBoard(async (path, init) =>
			app.fetch(new Request(`https://site.test${path}`, init))
		);
	});

	it('Netlify Functions through the default export', async () => {
		const mod = await import('../../examples/dashboard/netlify-functions/netlify-functions');
		await exerciseBoard((path, init) =>
			mod.default(new Request(`https://site.test${path}`, init), {} as never)
		);
	});
});

describe('the Netlify path lists reach the routes the shared site serves', () => {
	const sample = (pattern: string) => pattern.replace(/:\w+/g, '1');

	// the paths Netlify routes to a function whose config.path is `path`, in URLPattern syntax
	function reachedBy(path: string | string[] | undefined, paths: string[]): string[] {
		const patterns = [path ?? []].flat().map((item) => new URLPattern({ pathname: item }));
		return paths.filter((item) => patterns.some((pattern) => pattern.test({ pathname: item })));
	}

	it('courses: every declared route and the home page', async () => {
		const { config } =
			await import('../../examples/courses/netlify-functions/netlify-functions');
		const { courseSpool } = await import('../../examples/courses/shared/site');
		const { spool } = await courseSpool();
		const paths = [...spool.config.routes.map((route) => sample(route.pattern)), '/', '/ping'];
		expect(reachedBy(config.path, paths)).toEqual(paths);
	});

	it('dashboard: every declared route and the pages the board serves', async () => {
		const { config } =
			await import('../../examples/dashboard/netlify-functions/netlify-functions');
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { spool } = await dashboardSite();
		const paths = [
			...spool.config.routes.map((route) => sample(route.pattern)),
			'/',
			'/login',
			'/logout',
			'/healthz',
			'/board/tasks/t1',
			'/board/projects/p1'
		];
		expect(reachedBy(config.path, paths)).toEqual(paths);
	});
});

type Answer = (request: Request) => Response | Promise<Response>;
type Reply = { status: number; type: string | null; body: string };

const MAX_DEPTH = 6;

// the ring, the writes element and the client tag are the only markup a spool arm adds
const withoutArmMarkup = (html: string) =>
	html
		.replace(/<script type="application\/json" id="spool-(?:ring|writes)">.*?<\/script>/gs, '')
		.replace(/<script[^>]*data-spool-(?:client|gate)[^>]*>(?:.*?<\/script>)?/gs, '');

// breadth first over same-origin <a href> links from `/`, up to MAX_DEPTH levels
async function crawl(
	answer: Answer,
	cookie?: string
): Promise<{ seen: Map<string, Reply>; left: string[] }> {
	const seen = new Map<string, Reply>();
	const headers = cookie === undefined ? undefined : { cookie };
	let frontier = ['/'];
	for (let level = 0; level < MAX_DEPTH && frontier.length > 0; level++) {
		const found: string[] = [];
		for (const path of frontier) {
			if (seen.has(path)) continue;
			const response = await answer(new Request(`https://site.test${path}`, { headers }));
			const body = await response.text();
			seen.set(path, {
				status: response.status,
				type: response.headers.get('content-type'),
				body
			});
			found.push(...[...body.matchAll(/<a href="(\/[^"]*)"/g)].map((match) => match[1]!));
		}
		frontier = found.filter((path) => !seen.has(path));
	}
	return { seen, left: frontier };
}

async function assertNavigable(
	spooled: Answer,
	origin: Answer,
	pageTypes: RegExp[],
	cookie?: string
): Promise<void> {
	const arm = await crawl(spooled, cookie);
	const plain = await crawl(origin, cookie);
	expect(arm.left).toEqual([]);
	expect(plain.left).toEqual([]);
	const paths = [...arm.seen.keys()].sort();
	expect(paths).toEqual([...plain.seen.keys()].sort());
	for (const path of paths) {
		const reply = arm.seen.get(path)!;
		expect(reply.status, path).toBe(200);
		expect(reply.type, path).toContain('text/html');
		expect(withoutArmMarkup(reply.body), path).toBe(
			withoutArmMarkup(plain.seen.get(path)!.body)
		);
	}
	for (const type of pageTypes) {
		expect(
			paths.some((path) => type.test(path)),
			`no link reaches ${type}`
		).toBe(true);
	}
}

describe('the example sites are navigable', () => {
	it('courses: every link answers with HTML, and the list, item and home pages are reached', async () => {
		const { courseSpool } = await import('../../examples/courses/shared/site');
		const { spool, page } = await courseSpool(3);
		const origin = await courseSpool(3, { spool: false });
		await assertNavigable((request) => spool.handle(request, page), origin.page, [
			/^\/$/,
			/^\/courses$/,
			/^\/courses\/\d+$/
		]);
	});

	it('homepage: every link answers with HTML, and each section and its detail pages are reached', async () => {
		const { homepageSite } = await import('../../examples/homepage/shared/site');
		const { spool, page } = await homepageSite();
		const origin = await homepageSite({ spool: false });
		await assertNavigable((request) => spool.handle(request, page), origin.page, [
			/^\/$/,
			/^\/news\?page=1$/,
			/^\/news\/[\w-]+$/,
			/^\/events\?page=1$/,
			/^\/events\/[\w-]+$/,
			/^\/departments$/,
			/^\/departments\/\w+$/,
			/^\/programs\?page=1$/,
			/^\/programs\/[\w-]+$/,
			/^\/people$/,
			/^\/people\/[\w-]+$/,
			/^\/about\/[\w-]+$/
		]);
	});

	it('dashboard: every link answers with HTML, anonymous and signed in', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { spool, page } = await dashboardSite();
		const origin = await dashboardSite({ spool: false });
		const answer = (request: Request) => spool.handle(request, page);
		const pages = [/^\/$/, /^\/board\/tasks\/\w+$/, /^\/board\/projects\/\w+$/, /^\/login$/];
		await assertNavigable(answer, origin.page, pages);
		await assertNavigable(answer, origin.page, [...pages, /^\/me$/], 'user=ada');
	});

	it('campus: every link answers with HTML, anonymous and signed in', async () => {
		const { campusSite } = await import('../../examples/campus/shared/site');
		const { spool, page } = await campusSite();
		const origin = await campusSite({ spool: false });
		const answer = (request: Request) => spool.handle(request, page);
		const pages = [
			/^\/$/,
			/^\/courses$/,
			/^\/courses\/\d+$/,
			/^\/catalogue$/,
			/^\/catalogue\?department=\w+(&(amp;)?sort=title)?$/,
			/^\/teams\/\w+$/,
			/^\/people$/,
			/^\/people\/\w+$/,
			/^\/news$/,
			/^\/news\/\d{4}\/[\w-]+$/,
			/^\/login$/
		];
		await assertNavigable(answer, origin.page, pages);
		await assertNavigable(
			answer,
			origin.page,
			[...pages, /^\/account$/, /^\/classmates\/\w+$/],
			'user=ada'
		);
	});

	it('blog: every link answers with HTML, and each post, tag, author, archive and search page is reached', async () => {
		const { blogSite } = await import('../../examples/blog/shared/site');
		const { spool, page } = await blogSite();
		const origin = await blogSite({ spool: false });
		await assertNavigable((request) => spool.handle(request, page), origin.page, [
			/^\/$/,
			/^\/posts\/\w+$/,
			/^\/tags$/,
			/^\/tags\?tag=\w+$/,
			/^\/search$/,
			/^\/search\?q=\w+$/,
			/^\/authors\/\w+$/,
			/^\/authors\/\w+\/posts$/,
			/^\/archive\/\d{4}\/\d{2}$/
		]);
	});
});

describe('the example pages escape the values they print', () => {
	const hostile = '<script>alert(1)</script> "q"';
	const escaped = '&lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot;';
	const expectEscaped = (html: string) => {
		expect(html).toContain(escaped);
		expect(html).not.toContain('<script>alert(1)');
	};

	it('dashboard: a created task title on the board and on its task page', async () => {
		const { dashboardSite } = await import('../../examples/dashboard/shared/site');
		const { page } = await dashboardSite({ spool: false });
		const created = await page(
			new Request('https://site.test/tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: 'user=ada' },
				body: JSON.stringify({ title: hostile, project: 'site', due: '2999-01-01' })
			})
		);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expectEscaped(await (await page(new Request('https://site.test/'))).text());
		expectEscaped(
			await (await page(new Request(`https://site.test/board/tasks/${id}`))).text()
		);
	});

	it('homepage: an updated event title on the home page and on its event page', async () => {
		const { homepageSite, EVENTS } = await import('../../examples/homepage/shared/site');
		const { page, updateEvent } = await homepageSite();
		await updateEvent(EVENTS[0]!.id, { title: hostile });
		expectEscaped(await (await page(new Request('https://site.test/'))).text());
		expectEscaped(
			await (await page(new Request(`https://site.test/events/${EVENTS[0]!.id}`))).text()
		);
	});

	it('blog: an added post title on the home page and on its post page', async () => {
		const { blogSite, postId, posts } = await import('../../examples/blog/shared/site');
		const { page, addPost } = await blogSite();
		await addPost({ title: hostile, author: 'ada', tag: 'web', date: '2025-01-01', body: 'b' });
		const id = postId(posts().length + 1);
		expectEscaped(await (await page(new Request('https://site.test/'))).text());
		expectEscaped(await (await page(new Request(`https://site.test/posts/${id}`))).text());
	});

	it('campus: a person name on the people list', async () => {
		const { campusSite, PEOPLE } = await import('../../examples/campus/shared/site');
		const { page } = await campusSite({ spool: false });
		const saved = PEOPLE[0]!.name;
		PEOPLE[0]!.name = hostile;
		try {
			expectEscaped(await (await page(new Request('https://site.test/people'))).text());
		} finally {
			PEOPLE[0]!.name = saved;
		}
	});
});

describe('the Node framework and proxy examples', () => {
	it('Fastify, through an onRequest hook and reply.send(Response)', async () => {
		const { app } = await import('../../examples/courses/fastify/fastify');
		await app.listen({ port: 0, host: '127.0.0.1' });
		try {
			const { port } = app.server.address() as AddressInfo;
			await exercise(overHttp(`http://127.0.0.1:${port}`));
		} finally {
			await app.close();
		}
	});

	it('Koa, with ctx.respond off for what spool writes', async () => {
		const { app } = await import('../../examples/courses/koa/koa');
		await exercise(overHttp(await listen(createServer(app.callback()))));
	});

	it('hapi, through onRequest and h.abandon', async () => {
		const { server } = await import('../../examples/courses/hapi/hapi');
		await server.start();
		try {
			await exercise(overHttp(server.info.uri));
		} finally {
			await server.stop();
		}
	});

	it('NestJS on Express, through app.use and a controller', async () => {
		const app = await (await import('../../examples/courses/nestjs/nest')).bootstrap();
		await app.listen(0, '127.0.0.1');
		try {
			const { port } = app.getHttpServer().address() as AddressInfo;
			await exercise(overHttp(`http://127.0.0.1:${port}`));
		} finally {
			await app.close();
		}
	});

	it('the proxy forwards a request with a cookie and decorates a plain one', async () => {
		const { server, origin } = await import('../../examples/courses/proxy/proxy-node');
		const base = await listen(server);
		const { port } = origin.address() as AddressInfo;
		const originHtml = await (await fetch(`http://127.0.0.1:${port}/courses/101`)).text();
		let hits = 0;
		origin.on('request', () => {
			hits += 1;
		});
		try {
			const cookied = await fetch(`${base}/courses/101`, { headers: { cookie: 'SESS=1' } });
			expect(cookied.status).toBe(200);
			expect(cookied.headers.get('spool-artifact')).toBeNull();
			expect(await cookied.text()).toBe(originHtml);
			expect(hits).toBe(1);

			const plain = await fetch(`${base}/courses/101`);
			const html = await plain.text();
			expect(plain.status).toBe(200);
			expect(plain.headers.get('spool-artifact')).not.toBeNull();
			expect(html).toContain('<h1>Intro to Drupal</h1>');
			expect(html.match(/data-spool-gate/g)).toHaveLength(1);
			expect(hits).toBe(2);
		} finally {
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});
});

describe('the static examples', () => {
	const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

	it('publishes the exact file list, then only the stub, the new pack, its delta and the headers', async () => {
		const { staticSite } = await import('../../examples/static/shared/site');
		const { memoryStaticSink } = await import('../../src/server/index');
		const { bootPath, clientPath, navigatePath } = await import('../../src/protocol/index');
		const { VERSION } = await import('../../src/version');
		const { publish, addEntry } = await staticSite();
		const sink = memoryStaticSink();
		await publish(sink);
		expect([...sink.files.keys()].sort()).toEqual(
			[
				clientPath(VERSION),
				navigatePath(VERSION),
				'/spool-sw.js',
				'/.spool/bundle/1',
				bootPath(VERSION, 1),
				'/_headers'
			].sort()
		);
		sink.puts.length = 0;
		const added = await addEntry({
			title: 'Added the export command in 2.0',
			area: 'cli',
			date: '2026-01-05',
			body: 'Release 2.0 of the library.'
		});
		expect(added.version).toBe(2);
		await publish(sink);
		expect([...sink.puts].sort()).toEqual(
			[
				'/spool-sw.js',
				'/.spool/bundle/2',
				bootPath(VERSION, 2),
				'/.spool/bundle/delta/1/2',
				'/_headers'
			].sort()
		);
	});

	it('writes identical bytes at the same stamp and changes only the stub at a new one', async () => {
		const { staticSite } = await import('../../examples/static/shared/site');
		const { memoryStaticSink } = await import('../../src/server/index');
		const { spool, publish } = await staticSite();
		const first = memoryStaticSink();
		const again = memoryStaticSink();
		await spool.publishStatic(first);
		await spool.publishStatic(again);
		expect([...again.files.keys()].sort()).toEqual([...first.files.keys()].sort());
		for (const [path, file] of first.files) {
			expect(text(again.files.get(path)!.bytes)).toBe(text(file.bytes));
		}
		const next = memoryStaticSink();
		await publish(next);
		const changed = [...first.files.keys()].filter(
			(path) => text(next.files.get(path)!.bytes) !== text(first.files.get(path)!.bytes)
		);
		expect(changed).toEqual(['/spool-sw.js']);
	});

	it('the node server answers the stub, the runtime and the pack as files, with no page call', async () => {
		const { staticSite } = await import('../../examples/static/shared/site');
		const { handle, staticFiles } = await import('../../examples/static/node/server');
		const { fileStaticSink, toNodeListener } = await import('../../src/node/listener');
		const { clientPath } = await import('../../src/protocol/index');
		const { VERSION } = await import('../../src/version');
		const root = await mkdtemp(join(tmpdir(), 'spool-static-spec-'));
		try {
			const { spool, page, publish } = await staticSite();
			await publish(fileStaticSink(root));
			const pageCalls: string[] = [];
			const counted = (request: Request) => {
				pageCalls.push(new URL(request.url).pathname);
				return page(request);
			};
			const base = await listen(
				createServer(toNodeListener(handle(staticFiles(root), spool, counted)))
			);

			const stub = await fetch(`${base}/spool-sw.js`);
			expect(stub.status).toBe(200);
			expect(stub.headers.get('cache-control')).toBe('max-age=86400');
			expect(stub.headers.get('service-worker-allowed')).toBe('/');
			expect(stub.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
			expect(await stub.text()).toBe(await (await spool.stub()).text());

			const client = await fetch(`${base}${clientPath(VERSION)}`);
			expect(client.status).toBe(200);
			expect(client.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
			expect(client.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

			const pack = await fetch(`${base}/.spool/bundle/1`);
			expect(pack.status).toBe(200);
			expect(pack.headers.get('content-type')).toBe('application/octet-stream');
			const { state } = await readBundle(new Uint8Array(await pack.arrayBuffer()));
			expect(state.tables['entries']).toHaveLength(40);
			expect(pageCalls).toEqual([]);

			const home = await fetch(`${base}/`);
			expect(home.status).toBe(200);
			expect(await home.text()).toContain('Newest Entries');
			expect(pageCalls).toEqual(['/']);

			expect((await fetch(`${base}/_headers`)).status).toBe(404);
			expect(pageCalls).toEqual(['/', '/_headers']);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('the Worker serves the site and the stub itself when no assets answer first', async () => {
		const worker = (await import('../../examples/static/cloudflare-worker/worker')).default;
		const home = await worker.fetch(site('/'));
		expect(home.status).toBe(200);
		expect(await home.text()).toContain('Newest Entries');
		const stub = await worker.fetch(site('/spool-sw.js'));
		expect(stub.status).toBe(200);
		expect(await stub.text()).toContain('__SPOOL_CONFIG__');
	});
});
