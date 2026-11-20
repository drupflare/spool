import { getRequestListener } from '@hono/node-server';
import express from 'express';
import { Hono, type Context } from 'hono';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { spoolExpress } from '../../src/express/index';
import { spoolHono } from '../../src/hono/index';
import { toRequest, writeResponse } from '../../src/node/listener';
import {
	decodeEnvelope,
	defineDataset,
	defineResource,
	HEADERS,
	shellHash,
	WRITE_HEADERS
} from '../../src/protocol/index';
import { DECLINE_PATH } from '../../src/proxy/index';
import {
	createSpool,
	defineRoute,
	memoryBundleStore,
	memorySink,
	type Sink
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { closeServers, exercise, listen } from './exercise';
import { spool } from './readme/spool';

afterEach(closeServers);

type Send = (path: string, init?: RequestInit) => Promise<Response>;
type Backend = { name: string; serve: (withSpool: boolean) => Promise<Send> };

const pageFor = (id: string) =>
	`<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`;

function expressApp(withSpool: boolean) {
	const app = express();
	if (withSpool) app.use(spoolExpress(spool));
	app.get('/node/:id', (req, res) => {
		res.type('html').send(pageFor(req.params['id'] ?? ''));
	});
	app.get('/sized', (_req, res) => {
		res.type('html').send(pageFor('sized'));
	});
	app.get('/json', (_req, res) => {
		res.json({ ok: true });
	});
	app.get('/missing', (_req, res) => {
		res.status(404).type('html').send('<!doctype html><h1>Not found</h1>');
	});
	app.post('/form', express.text(), (req, res) => {
		res.type('text').send(String(req.body));
	});
	app.get('/throws', () => {
		throw new Error('boom');
	});
	app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => {
		res.status(500).type('text').send(`caught: ${error.message}`);
	});
	return app;
}

function honoApp(withSpool: boolean) {
	const app = new Hono();
	if (withSpool) app.use('*', spoolHono(spool));
	app.get('/node/:id', (c) => c.html(pageFor(c.req.param('id'))));
	app.get('/sized', (c) => {
		c.header('content-length', String(new TextEncoder().encode(pageFor('sized')).length));
		return c.html(pageFor('sized'));
	});
	app.get('/json', (c) => c.json({ ok: true }));
	app.get('/missing', (c) => c.html('<!doctype html><h1>Not found</h1>', 404));
	app.post('/form', async (c) => c.text(await c.req.text()));
	app.get('/throws', () => {
		throw new Error('boom');
	});
	app.onError((error, c) => c.text(`caught: ${error.message}`, 500));
	return app;
}

const backends: Backend[] = [
	{
		name: 'Express on node:http',
		serve: async (withSpool) => {
			const base = await listen(createServer(expressApp(withSpool)));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	},
	{
		name: 'Hono on @hono/node-server',
		serve: async (withSpool) => {
			const base = await listen(createServer(getRequestListener(honoApp(withSpool).fetch)));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	},
	{
		name: 'Hono through fetch',
		serve: async (withSpool) => {
			const app = honoApp(withSpool);
			return async (path, init) => app.fetch(new Request(`https://site.test${path}`, init));
		}
	}
];

const headerList = (response: Response) =>
	[...response.headers].filter(([name]) => !['date', 'connection', 'keep-alive'].includes(name));

const passThrough: Array<[string, RequestInit | undefined]> = [
	['/form', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }],
	['/node/4', { method: 'HEAD' }],
	['/json', undefined],
	['/missing', undefined]
];

describe.each(backends)('spool middleware on $name', ({ serve }) => {
	it('answers spool paths and tags an eligible page the way the readme fixtures do', async () => {
		await exercise(await serve(true));
	});

	it('answers a POST to a spool path with spool, not the application', async () => {
		const send = await serve(true);
		const response = await send('/.spool/beacon', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toHaveProperty('error');
	});

	it('drops the Content-Length the envelope changes instead of sending a stale one', async () => {
		const served = await (await serve(true))('/sized');
		const body = await served.text();
		const bytes = new TextEncoder().encode(body).length;
		expect(body).toContain('data-spool-gate');
		expect(Number(served.headers.get('content-length') ?? bytes)).toBe(bytes);
	});

	it('gives an eligible page the body and envelope spool.handle gives', async () => {
		const served = await (await serve(true))('/node/3');
		const direct = await spool.handle(
			new Request('https://site.test/node/3'),
			async () =>
				new Response(pageFor('3'), {
					headers: { 'content-type': 'text/html; charset=utf-8' }
				})
		);
		expect(await served.text()).toBe(await direct.text());
		expect(decodeEnvelope(served.headers)).toEqual(decodeEnvelope(direct.headers));
	});

	it('passes a POST, HEAD, JSON and 404 request through unchanged', async () => {
		const collect = async (send: Send) => {
			const out = [];
			for (const [path, init] of passThrough) {
				const response = await send(path, init);
				out.push({
					status: response.status,
					headers: headerList(response),
					body: await response.text()
				});
			}
			return out;
		};
		const wrapped = await collect(await serve(true));
		expect(wrapped).toEqual(await collect(await serve(false)));
		expect(wrapped.map((r) => r.status)).toEqual([200, 200, 200, 404]);
		expect(wrapped[0]?.body).toBe('hello');
	});

	it('decorates a JSON answer to a request that names a held pack, and no other', async () => {
		const send = await serve(true);
		const plain = await send('/json');
		expect(plain.headers.get('spool-protocol')).toBeNull();
		const held = await send('/json', { headers: { 'spool-have': '0' } });
		expect(held.headers.get('spool-protocol')).not.toBeNull();
		expect(held.headers.get('vary')).toContain('spool-have');
		expect(await held.json()).toEqual({ ok: true });
	});

	it('serves the worker script with a validator and answers a match with 304', async () => {
		const send = await serve(true);
		const full = await send('/spool-sw.js');
		const etag = full.headers.get('etag');
		expect(full.status).toBe(200);
		expect(etag).toBe(`"${await shellHash(await full.text())}"`);
		const same = await send('/spool-sw.js', { headers: { 'if-none-match': etag! } });
		expect(same.status).toBe(304);
		expect(await same.text()).toBe('');
		expect(same.headers.get('etag')).toBe(etag);
		expect(same.headers.get('cache-control')).toBe(full.headers.get('cache-control'));
		expect(same.headers.get('service-worker-allowed')).toBe('/');
		const other = await send('/spool-sw.js', { headers: { 'if-none-match': '"stale"' } });
		expect(other.status).toBe(200);
		expect(other.headers.get('etag')).toBe(etag);
	});

	it('lets an error the application throws reach its own error handler', async () => {
		const throws = async (send: Send) => {
			const response = await send('/throws');
			return [response.status, await response.text()];
		};
		expect(await throws(await serve(true))).toEqual([500, 'caught: boom']);
		expect(await throws(await serve(false))).toEqual([500, 'caught: boom']);
	});
});

it('adds one close listener to the response for a GET and emits no listener warning', async () => {
	const app = express();
	app.use(spoolExpress(spool));
	const seen: number[] = [];
	app.use((_req, res) => {
		seen.push(res.listenerCount('close'));
		res.type('html').send(pageFor('7'));
	});
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on('warning', onWarning);
	try {
		const base = await listen(createServer(app));
		expect((await fetch(`${base}/node/7`)).status).toBe(200);
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off('warning', onWarning);
	}
	expect(seen).toEqual([1]);
	expect(warnings).toEqual([]);
});

type Row = { id: string; title: string };
type Site = ReturnType<typeof rowsSite>;

/** a site with one resource over public rows; `page` is the application as a fetch handler */
function rowsSite() {
	const store = memoryStore();
	const current = new Map<string, Row>([['1', { id: '1', title: 'first' }]]);
	const log: string[] = [];
	const dataset = defineDataset<Row>('rows', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => [...current.values()],
		read: (ids) => ids.flatMap((id) => (current.has(id) ? [current.get(id) as Row] : [])),
		changes: (since) => {
			const keys = [...new Set(log.slice(since))];
			return {
				cursor: log.length,
				puts: keys.filter((key) => current.has(key)),
				deletes: keys
					.filter((key) => !current.has(key))
					.map((key) => ({ key, cursor: log.length }))
			};
		},
		horizon: () => 0,
		head: () => ({ cursor: log.length }),
		schema: 'rows-1',
		maxRows: 100,
		maxBytes: 100_000
	});
	const spool = createSpool({
		routes: [],
		resources: [defineResource('/rows', { dataset: 'rows', key: 'id' })],
		datasets: [dataset],
		store,
		bundles: memoryBundleStore()
	});
	const page = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const id = url.pathname.slice('/rows/'.length);
		if (request.method === 'GET' && url.pathname.startsWith('/rows/')) {
			const row = current.get(id);
			return row ? Response.json(row) : new Response('not found', { status: 404 });
		}
		if (request.method === 'POST' && url.pathname === '/rows') {
			const row = (await request.json()) as Row;
			current.set(row.id, row);
			log.push(row.id);
			return Response.json(row, { status: 201 });
		}
		if (request.method === 'PATCH' && url.pathname.startsWith('/rows/')) {
			const body = (await request.json()) as { title: string };
			if (body.title === 'boom') return new Response('boom', { status: 500 });
			current.set(id, { id, title: body.title });
			log.push(id);
			return Response.json({ id, title: body.title });
		}
		if (request.method === 'POST' && url.pathname === '/other') return new Response('hello');
		return new Response('not found', { status: 404 });
	};
	return { spool, store, page };
}

const writeBackends: Array<{ name: string; serve: (site: Site) => Promise<Send> }> = [
	{
		name: 'Express on node:http',
		serve: async ({ spool, page }) => {
			const app = express();
			app.use(spoolExpress(spool));
			app.use(async (req, res) => {
				await writeResponse(res, await page(toRequest(req, res)));
			});
			const base = await listen(createServer(app));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	},
	{
		name: 'Hono on @hono/node-server',
		serve: async ({ spool, page }) => {
			const app = new Hono();
			app.use('*', spoolHono(spool));
			app.all('*', (c) => page(c.req.raw));
			const base = await listen(createServer(getRequestListener(app.fetch)));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	},
	{
		name: 'Hono through fetch',
		serve: async ({ spool, page }) => {
			const app = new Hono();
			app.use('*', spoolHono(spool));
			app.all('*', (c) => page(c.req.raw));
			return async (path, init) => app.fetch(new Request(`https://site.test${path}`, init));
		}
	}
];

const patch = (title: string): RequestInit => ({
	method: 'PATCH',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ title })
});

describe.each(writeBackends)('declared writes through the adapter on $name', ({ serve }) => {
	it('answers Spool-Delta, moves the version by one, and a Spool-Have GET gets only what it lacks', async () => {
		const site = rowsSite();
		const send = await serve(site);
		const response = await send('/rows/1', patch('changed'));
		expect(response.status).toBe(200);
		const delta = JSON.parse(response.headers.get(HEADERS.delta) ?? 'null') as {
			from: number;
			to: number;
		};
		expect([delta.from, delta.to]).toEqual([0, 1]);
		expect(await site.store.cursor()).toBe(1);
		const held = await send('/rows/1', { headers: { [HEADERS.have]: '1' } });
		expect(held.headers.get(HEADERS.delta)).toBeNull();
		const behind = await send('/rows/1', { headers: { [HEADERS.have]: '0' } });
		expect(behind.headers.get(HEADERS.delta)).not.toBeNull();
	});

	it('answers the digest and no delta when the delta is past 16,384 bytes', async () => {
		const site = rowsSite();
		const send = await serve(site);
		const response = await send('/rows/1', patch('x'.repeat(20_000)));
		expect(response.status).toBe(200);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		expect(response.headers.get(WRITE_HEADERS.digest)).not.toBeNull();
		expect(await site.store.cursor()).toBe(1);
	});

	it('leaves a POST that no resource declares untouched', async () => {
		const site = rowsSite();
		const send = await serve(site);
		const response = await send('/other', { method: 'POST', body: 'hello' });
		expect(await response.text()).toBe('hello');
		expect([...response.headers.keys()].filter((name) => name.startsWith('spool-'))).toEqual(
			[]
		);
		expect(await site.store.cursor()).toBe(0);
	});

	it('moves no version and sends no delta when the application answers 5xx', async () => {
		const site = rowsSite();
		const send = await serve(site);
		const response = await send('/rows/1', patch('boom'));
		expect(response.status).toBe(500);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		expect(await site.store.cursor()).toBe(0);
	});
});

/** the application's answer to a rows request, as a Fetch request built from what Express parsed */
const rowsRequest = (req: express.Request): Request =>
	new Request(`https://site.test${req.url}`, {
		method: req.method,
		headers: { 'content-type': 'application/json' },
		body: req.body === undefined ? undefined : JSON.stringify(req.body)
	});

describe('declared writes behind an Express body parser', () => {
	it('hands the parsed body to the route, and the answer carries Spool-Delta', async () => {
		const site = rowsSite();
		const app = express();
		app.use(spoolExpress(site.spool));
		app.use(express.json());
		app.use(async (req, res) => {
			await writeResponse(res, await site.page(rowsRequest(req)));
		});
		const base = await listen(createServer(app));
		const response = await fetch(`${base}/rows/1`, patch('changed'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: '1', title: 'changed' });
		expect(response.headers.get(HEADERS.delta)).not.toBeNull();
		expect(await site.store.cursor()).toBe(1);
	});

	it('captures the headers of a write answered with res.writeHead(status, headers)', async () => {
		const site = rowsSite();
		const app = express();
		app.use(spoolExpress(site.spool));
		app.use(express.json());
		app.use(async (req, res) => {
			const answer = await site.page(rowsRequest(req));
			res.writeHead(answer.status, { 'content-type': 'application/json', 'x-site': 'yes' });
			res.end(await answer.text());
		});
		const base = await listen(createServer(app));
		const response = await fetch(`${base}/rows/1`, patch('changed'));
		expect(response.status).toBe(200);
		expect(response.headers.get('x-site')).toBe('yes');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get(HEADERS.delta)).not.toBeNull();
		expect(await site.store.cursor()).toBe(1);
	});

	it('captures the headers of a page answered with res.writeHead(status, headers)', async () => {
		const app = express();
		app.use(spoolExpress(spool));
		app.get('/node/:id', (req, res) => {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-site': 'yes' });
			res.end(pageFor(req.params['id'] ?? ''));
		});
		const base = await listen(createServer(app));
		const response = await fetch(`${base}/node/5`);
		expect(response.headers.get('x-site')).toBe('yes');
		expect(await response.text()).toContain('data-spool-gate');
	});

	it('hands a failed write to the error handler, without the headers the site set', async () => {
		const site = rowsSite();
		const broken = {
			...site.spool,
			handle: async (request: Request, next: (inner: Request) => Promise<Response>) => {
				await next(request);
				throw new Error('handle failed');
			}
		};
		const app = express();
		app.use(spoolExpress(broken));
		app.use((_req, res) => {
			res.setHeader('x-site', 'leak');
			res.end('ok');
		});
		app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => {
			res.status(500).type('text').send(`caught: ${error.message}`);
		});
		const base = await listen(createServer(app));
		const response = await fetch(`${base}/rows/1`, patch('changed'));
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('caught: handle failed');
		expect(response.headers.get('x-site')).toBeNull();
	});
});

describe('a failed declared write on Hono', () => {
	it('hands the error to onError', async () => {
		const site = rowsSite();
		const broken = {
			...site.spool,
			handle: async (request: Request, next: (inner: Request) => Promise<Response>) => {
				await next(request);
				throw new Error('handle failed');
			}
		};
		const app = new Hono();
		app.use('*', spoolHono(broken));
		app.all('*', (c) => c.text('ok'));
		app.onError((error, c) => c.text(`caught: ${error.message}`, 500));
		const response = await app.fetch(new Request('https://site.test/rows/1', patch('changed')));
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('caught: handle failed');
	});
});

const gatedHeaders: Record<string, Record<string, string>> = {
	cookie: { 'set-cookie': 'sid=1; Path=/' },
	private: { 'cache-control': 'private, max-age=0' },
	'no-store': { 'cache-control': 'no-store' },
	'vary-star': { vary: '*' },
	clean: {}
};

const gatedTemplate = {
	strategy: 'template' as const,
	template: {
		source: '<!doctype html><html><head><title>{{kind}}</title></head><body><h1>{{kind}}</h1></body></html>'
	},
	load: (ctx: { params: Record<string, string> }) => ({ kind: ctx.params['kind'] })
};

const gatedSpool = () =>
	createSpool({
		routes: [
			defineRoute('/gated/:kind', gatedTemplate),
			defineRoute('/member/:kind', { ...gatedTemplate, auth: 'principal' })
		],
		store: memoryStore(),
		identity: {
			secret: 'gate-test-secret',
			resolve: (request) =>
				/\buser=ana\b/.test(request.headers.get('cookie') ?? '')
					? { principal: 'ana' }
					: null
		}
	});

function gatedExpress(withSpool: boolean) {
	const app = express();
	if (withSpool) app.use(spoolExpress(gatedSpool()));
	const page = (req: express.Request, res: express.Response) => {
		const kind = String(req.params['kind'] ?? '');
		res.set(gatedHeaders[kind] ?? {});
		res.type('html').send(pageFor(kind));
	};
	app.get('/gated/:kind', page);
	app.get('/member/:kind', page);
	return app;
}

function gatedHono(withSpool: boolean) {
	const app = new Hono();
	if (withSpool) app.use('*', spoolHono(gatedSpool()));
	const page = (c: Context) => {
		const kind = c.req.param('kind') ?? '';
		const headers: Record<string, string> = gatedHeaders[kind] ?? {};
		for (const [name, value] of Object.entries(headers)) c.header(name, value);
		return c.html(pageFor(kind));
	};
	app.get('/gated/:kind', page);
	app.get('/member/:kind', page);
	return app;
}

const gatedBackends: Backend[] = [
	{
		name: 'Express on node:http',
		serve: async (withSpool) => {
			const base = await listen(createServer(gatedExpress(withSpool)));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	},
	{
		name: 'Hono on @hono/node-server',
		serve: async (withSpool) => {
			const base = await listen(createServer(getRequestListener(gatedHono(withSpool).fetch)));
			return (path, init) => fetch(`${base}${path}`, init);
		}
	}
];

describe.each(gatedBackends)('a public route the gate declines, on $name', ({ serve }) => {
	it.each(['cookie', 'private', 'no-store', 'vary-star'])(
		'returns a %s response as the application wrote it, with no spool header',
		async (kind) => {
			const bare = await (await serve(false))(`/gated/${kind}`);
			const served = await (await serve(true))(`/gated/${kind}`);
			expect(served.status).toBe(200);
			expect(served.headers.get('set-cookie')).toBe(bare.headers.get('set-cookie'));
			expect(served.headers.get('cache-control')).toBe(bare.headers.get('cache-control'));
			expect(served.headers.get('vary')).toBe(bare.headers.get('vary'));
			expect([...served.headers.keys()].filter((name) => name.startsWith('spool-'))).toEqual(
				[]
			);
			expect(await served.text()).toBe(await bare.text());
		}
	);

	it('decorates a clean public page as before', async () => {
		const served = await (await serve(true))('/gated/clean');
		expect(await served.text()).toContain('data-spool-gate');
		expect(decodeEnvelope(served.headers).artifact?.id).toBe('/gated/clean');
	});

	it('decorates a principal page that answers private, and keeps its cookie', async () => {
		const served = await (
			await serve(true)
		)('/member/private', {
			headers: { cookie: 'user=ana' }
		});
		expect(await served.text()).toContain('data-spool-gate');
		expect(decodeEnvelope(served.headers).artifact?.id).toBe('/member/private');
		expect(served.headers.get('cache-control')).toBe('private, max-age=0');
	});
});

describe('the decline record of the in-process gate', () => {
	const declining = (sink: Sink) =>
		createSpool({
			routes: [
				defineRoute('/gated/:kind', gatedTemplate),
				defineRoute('/member/:kind', { ...gatedTemplate, auth: 'principal' })
			],
			store: memoryStore(),
			sink,
			identity: { secret: 'gate-test-secret', resolve: () => ({ principal: 'ana' }) }
		});
	const answer = (kind: string, path = 'gated') => {
		const headers: Record<string, string> = {
			'content-type': 'text/html; charset=utf-8',
			...gatedHeaders[kind]
		};
		return [
			new Request(`https://site.test/${path}/${kind}`),
			new Response(pageFor(kind), { headers })
		] as const;
	};
	const bodies = (sink: ReturnType<typeof memorySink>) =>
		sink.events.map((event) => [event.path, JSON.parse(event.body)]);

	it.each([
		['cookie', 'set-cookie'],
		['private', 'private'],
		['no-store', 'no-store'],
		['vary-star', 'vary']
	])(
		'writes one event for a %s response, with the reason and the route pattern',
		async (kind, reason) => {
			const sink = memorySink();
			await declining(sink).decorate(...answer(kind));
			expect(bodies(sink)).toEqual([
				[DECLINE_PATH, { kind: 'decline', reason, route: '/gated/:kind', source: 'gate' }]
			]);
		}
	);

	it('writes none for a clean page, a principal page or a response the caller judged', async () => {
		const sink = memorySink();
		const spool = declining(sink);
		await spool.decorate(...answer('clean'));
		await spool.decorate(...answer('private', 'member'));
		await spool.decorate(...answer('cookie'), { judged: true });
		expect(sink.events).toEqual([]);
	});

	it("keeps a page that varies only on Next's RSC request headers, and still declines Accept-Language", async () => {
		const sink = memorySink();
		const spool = declining(sink);
		const respond = (vary: string) =>
			spool.decorate(
				new Request('https://site.test/gated/clean'),
				new Response(pageFor('clean'), {
					headers: { 'content-type': 'text/html; charset=utf-8', vary }
				})
			);
		const next = await respond(
			'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding'
		);
		expect(decodeEnvelope(next.headers).artifact?.id).toBe('/gated/clean');
		expect(sink.events).toEqual([]);
		await respond('rsc, Accept-Language');
		expect(bodies(sink)).toEqual([
			[
				DECLINE_PATH,
				{ kind: 'decline', reason: 'vary', route: '/gated/:kind', source: 'gate' }
			]
		]);
	});

	it('never carries the request path, only the pattern', async () => {
		const sink = memorySink();
		await declining(sink).decorate(...answer('cookie'));
		expect(sink.events[0]?.body).not.toContain('/gated/cookie');
		expect(sink.events[0]?.body).not.toContain('site.test');
	});

	it('returns the response unchanged when the sink throws or rejects', async () => {
		for (const write of [
			() => {
				throw new Error('sink down');
			},
			() => Promise.reject(new Error('sink down'))
		]) {
			const [request, response] = answer('cookie');
			const out = await declining({ write }).decorate(request, response);
			expect(out).toBe(response);
		}
	});
});
