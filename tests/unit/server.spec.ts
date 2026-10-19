import { describe, expect, it } from 'vitest';
import { cdnClientUrl } from '../../src/cdn/location';
import {
	artifactTag,
	clientPath,
	decodeEnvelope,
	defineRoute,
	encodeHeld,
	HEADERS,
	loadsToBeacon,
	parseArtifact,
	parseSyncResponse,
	placeholder,
	viewToBeacon,
	type SwConfig,
	type ViewEvent
} from '../../src/protocol/index';
import { CLIENT_CORE, SW_CORE } from '../../src/server/embedded';
import {
	analyticsEngineSink,
	createSpool,
	jsonLinesSink,
	memorySink,
	partitionId,
	viewsOf,
	workSeries,
	type AnalyticsEngineLike,
	type SpoolOptions
} from '../../src/server/index';
import { MAX_PIGGYBACK } from '../../src/server/spool';
import { workerScript } from '../../src/server/stub';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';
import { campus } from '../fixtures/graph';

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const ORIGIN = 'https://site.test';
const get = (path: string, headers: Record<string, string> = {}) =>
	new Request(`${ORIGIN}${path}`, { headers });

const routes = [
	defineRoute('/node/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{id}}</body></html>' },
		depends: (ctx) => [`node:${ctx.params['id']}`],
		load: (ctx) => ({ id: ctx.params['id'] })
	}),
	defineRoute('/page/:slug', {
		strategy: 'assembly',
		depends: () => ['menu'],
		load: (ctx) => ({
			shell: `<body>${placeholder('menu')}${ctx.params['slug']}</body>`,
			fragments: { menu: '<nav></nav>' }
		})
	}),
	defineRoute('/account', {
		strategy: 'template',
		scope: 'principal',
		template: { source: '{{who}}' },
		load: (ctx) => ({ who: ctx.identity?.principal })
	}),
	defineRoute('/broken', {
		strategy: 'assembly',
		load: () => ({ shell: 5 }) as never
	}),
	defineRoute('/throws', {
		strategy: 'template',
		template: { source: 'x' },
		load: () => {
			throw new Error('secret detail');
		}
	})
];

function setup(overrides: Partial<SpoolOptions> = {}) {
	const store = memoryStore();
	const sink = memorySink();
	const spool = createSpool({
		routes,
		store,
		sink,
		beacons: ['/cdn-cgi/rum'],
		identity: {
			secret: 'test-secret',
			resolve: (request) => {
				const who = request.headers.get('x-user');
				return who ? { principal: who } : null;
			}
		},
		...overrides
	});
	return { spool, store, sink };
}

const page = (body = '<html><head></head><body>hi</body></html>', headers: HeadersInit = HTML) =>
	new Response(body, { headers });

describe('createSpool', () => {
	it('builds the worker config from the routes', () => {
		const { spool } = setup();
		const config = spool.config;
		expect(config.protocol).toBe(1);
		expect(config.version).toBe(VERSION);
		expect(config.routes.map((r) => r.pattern)).toEqual([
			'/node/:id',
			'/page/:slug',
			'/account',
			'/broken',
			'/throws'
		]);
		expect(Object.keys(config.templates)).toEqual(['/node/:id', '/account', '/throws']);
		expect(config.beacons).toEqual(['/cdn-cgi/rum']);
		expect(config.clientTag).toContain(clientPath(VERSION));
	});

	it('uses the CDN script with its integrity hash when configured', () => {
		const { spool } = setup({
			cdn: { url: 'https://cdn.test/client.js', integrity: 'sha384-x' }
		});
		expect(spool.config.clientTag).toContain('src="https://cdn.test/client.js"');
		expect(spool.config.clientTag).toContain('integrity="sha384-x"');
	});

	it('points the tag at this version on the CDN when only the integrity is given', () => {
		const { spool } = setup({ cdn: { integrity: 'sha384-x' } });
		expect(spool.config.clientTag).toContain(`src="${cdnClientUrl(VERSION)}"`);
		expect(cdnClientUrl(VERSION)).toBe(`https://cdn.drupflare.com/spool/${VERSION}/client.js`);
		expect(spool.config.clientTag).toContain('crossorigin="anonymous"');
	});

	it('refuses a pattern declared twice and a beacon path under /.spool/', () => {
		expect(() =>
			createSpool({ routes: [routes[0]!, routes[0]!], store: memoryStore() })
		).toThrow(/declared twice/);
		expect(() => createSpool({ routes, store: memoryStore(), beacons: ['/.spool/x'] })).toThrow(
			/outside/
		);
		expect(() => createSpool({ routes, store: memoryStore(), beacons: ['rum'] })).toThrow(
			/outside/
		);
	});

	it('serves the worker script a day-cacheable, from stub() and from handle()', async () => {
		const { spool } = setup();
		for (const response of [
			spool.stub(),
			await spool.handle(get('/spool-sw.js'), () => page())
		]) {
			expect(response.headers.get('cache-control')).toBe('max-age=86400');
			expect(response.headers.get('content-type')).toContain('text/javascript');
			expect(response.headers.get('service-worker-allowed')).toBe('/');
		}
		const text = await spool.stub().text();
		expect(text.startsWith('self.__SPOOL_CONFIG__=')).toBe(true);
		expect(text).toContain(JSON.stringify(spool.config.version));
		expect(text.endsWith(SW_CORE)).toBe(true);
		expect(SW_CORE.length).toBeGreaterThan(1000);
		expect(workerScript(spool.config)).toBe(text);
	});

	it('hands a request that is not under /.spool/ to the app', async () => {
		const { spool } = setup();
		expect(await spool.respond(get('/node/1'))).toBeUndefined();
		const response = await spool.handle(
			get('/other'),
			() => new Response('app', { status: 201 })
		);
		expect(response.status).toBe(201);
		expect(response.headers.get(HEADERS.protocol)).toBe('1');
	});
});

describe('/.spool/sync', () => {
	it('returns the tags changed after the cursor and the artifacts dropped', async () => {
		const { spool } = setup();
		await spool.invalidate(['node:1', 'menu']);
		await spool.invalidate(['node:2'], { drop: ['/page/x'] });
		const response = await spool.respond(get('/.spool/sync?from=1'));
		expect(response?.headers.get('cache-control')).toBe('no-store');
		expect(response?.headers.get(HEADERS.vector)).toBe('2');
		const body = parseSyncResponse(await response?.json());
		expect(body).toEqual({
			protocol: 1,
			cursor: 2,
			changed: { 'node:2': 2 },
			dropped: ['/page/x'],
			reset: false
		});
	});

	it('names the partition of the request identity, and none for a request with no identity', async () => {
		const { spool } = setup();
		for (const query of ['?from=0', `?need=${encodeURIComponent(encodeHeld({ a: 0 }))}`]) {
			const ann = await spool.respond(get(`/.spool/sync${query}`, { 'x-user': 'ann' }));
			expect(ann?.headers.get(HEADERS.partition)).toBe(
				await partitionId('test-secret', 'ann')
			);
			expect(ann?.headers.get(HEADERS.protocol)).toBe('1');
			const nobody = await spool.respond(get(`/.spool/sync${query}`));
			expect(nobody?.headers.has(HEADERS.partition)).toBe(false);
			expect(nobody?.headers.get(HEADERS.protocol)).toBe('1');
		}
	});

	it('sends no partition when the server has no identity option', async () => {
		const spool = createSpool({ routes, store: memoryStore() });
		const response = await spool.respond(get('/.spool/sync?from=0', { 'x-user': 'ann' }));
		expect(response?.headers.has(HEADERS.partition)).toBe(false);
	});

	it('says reset when the client is ahead of the server', async () => {
		const { spool } = setup();
		await spool.invalidate(['a']);
		const body = parseSyncResponse(
			await (await spool.respond(get('/.spool/sync?from=40')))?.json()
		);
		expect(body.reset).toBe(true);
		expect(body.changed).toEqual({ a: 1 });
	});

	it.each(['', '?from=', '?from=-1', '?from=1.5', '?from=abc'])(
		'answers 400 for %j',
		async (query) => {
			const { spool } = setup();
			expect((await spool.respond(get(`/.spool/sync${query}`)))?.status).toBe(400);
		}
	);

	it('answers 404 for an unknown path and for a POST to sync', async () => {
		const { spool } = setup();
		expect((await spool.respond(get('/.spool/nothing')))?.status).toBe(404);
		const post = new Request(`${ORIGIN}/.spool/sync?from=0`, { method: 'POST' });
		expect((await spool.respond(post))?.status).toBe(404);
	});

	it('invalidate returns the new cursor and an empty list changes nothing', async () => {
		const { spool, store } = setup();
		expect(await spool.invalidate(['a'])).toBe(1);
		expect(await spool.invalidate([])).toBe(1);
		expect(await store.cursor()).toBe(1);
	});
});

describe('/.spool/artifact', () => {
	it('returns a valid template artifact stamped with the cursor read before it was built', async () => {
		const { spool } = setup();
		await spool.invalidate(['x']);
		const response = await spool.respond(get('/.spool/artifact?path=/node/7'));
		expect(response?.status).toBe(200);
		const artifact = parseArtifact(await response?.json());
		expect(artifact).toEqual({
			protocol: 1,
			id: '/node/7',
			scope: 'public',
			strategy: 'template',
			deps: ['node:7'],
			vector: 1,
			body: { data: { id: '7' } }
		});
	});

	it('returns an assembly artifact', async () => {
		const { spool } = setup();
		const artifact = parseArtifact(
			await (await spool.respond(get('/.spool/artifact?path=/page/a')))?.json()
		);
		expect(artifact.strategy).toBe('assembly');
		expect(artifact.deps).toEqual(['menu']);
	});

	it('refuses a missing path with 400, an unknown route with 404', async () => {
		const { spool } = setup();
		expect((await spool.respond(get('/.spool/artifact')))?.status).toBe(400);
		expect((await spool.respond(get('/.spool/artifact?path=nope')))?.status).toBe(400);
		expect((await spool.respond(get('/.spool/artifact?path=/zzz')))?.status).toBe(404);
	});

	it('refuses a principal route without an identity and serves it, privately, with one', async () => {
		const { spool } = setup();
		expect((await spool.respond(get('/.spool/artifact?path=/account')))?.status).toBe(401);
		const ok = await spool.respond(get('/.spool/artifact?path=/account', { 'x-user': 'ann' }));
		expect(ok?.headers.get('cache-control')).toBe('private, no-store');
		expect(parseArtifact(await ok?.json()).body).toEqual({ data: { who: 'ann' } });
	});

	it('answers 500 without leaking the error when load throws or returns a bad body', async () => {
		const { spool } = setup();
		for (const path of ['/throws', '/broken']) {
			const response = await spool.respond(get(`/.spool/artifact?path=${path}`));
			expect(response?.status).toBe(path === '/broken' ? 400 : 500);
			expect(await response?.text()).not.toContain('secret detail');
		}
	});
});

describe('/.spool/beacon', () => {
	const event = { path: '/cdn-cgi/rum', body: '{"a":1}', contentType: 'application/json', at: 5 };
	const post = (body: string) => new Request(`${ORIGIN}/.spool/beacon`, { method: 'POST', body });

	it('hands a batch to the sink and answers 204', async () => {
		const { spool, sink } = setup();
		const response = await spool.respond(
			post(JSON.stringify({ protocol: 1, events: [event, event] }))
		);
		expect(response?.status).toBe(204);
		expect(sink.events).toEqual([event, event]);
	});

	it('accepts an empty batch and a missing sink', async () => {
		const { spool, sink } = setup();
		expect(
			(await spool.respond(post(JSON.stringify({ protocol: 1, events: [] }))))?.status
		).toBe(204);
		expect(sink.events).toEqual([]);
		const bare = createSpool({ routes, store: memoryStore() });
		const batch = JSON.stringify({ protocol: 1, events: [event] });
		expect((await bare.respond(post(batch)))?.status).toBe(204);
	});

	it('refuses a GET with 405, bad JSON and a bad batch with 400, a huge body with 413', async () => {
		const { spool } = setup();
		const getResponse = await spool.respond(get('/.spool/beacon'));
		expect(getResponse?.status).toBe(405);
		expect(getResponse?.headers.get('allow')).toBe('POST');
		expect((await spool.respond(post('not json')))?.status).toBe(400);
		expect((await spool.respond(post('{"protocol":1}')))?.status).toBe(400);
		expect((await spool.respond(post('x'.repeat(262_145))))?.status).toBe(413);
	});

	it('writes jsonl through jsonLinesSink', async () => {
		const lines: string[] = [];
		const sink = jsonLinesSink((line) => lines.push(line));
		await sink.write([event]);
		expect(JSON.parse(lines[0] as string)).toEqual(event);
	});
});

describe('the page runtime script', () => {
	it('is served immutable at its versioned path and 404s at another version', async () => {
		const { spool } = setup();
		const ok = await spool.respond(get(clientPath(VERSION)));
		expect(ok?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(await ok?.text()).toBe(CLIENT_CORE);
		expect((await spool.respond(get(clientPath('9.9.9'))))?.status).toBe(404);
	});
});

describe('decorate', () => {
	it('adds the protocol and vector headers to any response', async () => {
		const { spool } = setup();
		await spool.invalidate(['a']);
		const response = await spool.decorate(
			get('/x'),
			new Response('x', { headers: { 'content-length': '1' } })
		);
		expect(decodeEnvelope(response.headers)).toEqual({ protocol: 1, vector: 1 });
		expect(response.headers.get('content-length')).toBe('1');
	});

	it('describes the artifact of a routed HTML response and injects the client tag', async () => {
		const { spool } = setup();
		await spool.invalidate(['a']);
		const request = get('/node/3');
		const response = await spool.decorate(
			request,
			page('<html><head></head><body>3</body></html>', {
				...HTML,
				etag: '"abc"',
				'content-length': '40'
			})
		);
		const envelope = decodeEnvelope(response.headers);
		expect(envelope.artifact).toEqual({
			id: '/node/3',
			scope: 'public',
			deps: ['node:3'],
			version: 1
		});
		const html = await response.text();
		expect(html).toContain(`${spool.config.clientTag}</head>`);
		expect(response.headers.get('content-length')).toBeNull();
		expect(response.headers.get('etag')).toBe('W/"abc"');
	});

	it('leaves an already weak etag alone', async () => {
		const { spool } = setup();
		const response = await spool.decorate(
			get('/x'),
			page('<head></head>', { ...HTML, etag: 'W/"a"' })
		);
		expect(response.headers.get('etag')).toBe('W/"a"');
	});

	it('does not inject twice, and keeps length and etag when nothing changed', async () => {
		const { spool } = setup();
		const tagged = `<head>${spool.config.clientTag}</head>`;
		const response = await spool.decorate(
			get('/x'),
			page(tagged, { ...HTML, etag: '"a"', 'content-length': '9' })
		);
		expect(await response.text()).toBe(tagged);
		expect(response.headers.get('etag')).toBe('"a"');
		expect(response.headers.get('content-length')).toBe('9');
	});

	it('skips the body of a compressed, non-HTML, non-200 or HEAD response but still adds headers', async () => {
		const { spool } = setup();
		const compressed = await spool.decorate(
			get('/x'),
			page('<head></head>', { ...HTML, 'content-encoding': 'gzip' })
		);
		expect(await compressed.text()).toBe('<head></head>');
		expect(compressed.headers.get(HEADERS.protocol)).toBe('1');
		const json = await spool.decorate(
			get('/x'),
			new Response('{}', { headers: { 'content-type': 'application/json' } })
		);
		expect(await json.text()).toBe('{}');
		const missing = await spool.decorate(
			get('/node/1'),
			new Response('<head></head>', { status: 404, headers: HTML })
		);
		expect(await missing.text()).toBe('<head></head>');
		expect(decodeEnvelope(missing.headers).artifact).toBeUndefined();
		const head = await spool.decorate(
			new Request(`${ORIGIN}/node/1`, { method: 'HEAD' }),
			page()
		);
		expect(head.headers.get(HEADERS.artifact)).not.toBeNull();
	});

	it('returns a 101 response untouched', async () => {
		const { spool } = setup();
		const original = new Response(null, { status: 200 });
		Object.defineProperty(original, 'status', { value: 101 });
		expect(await spool.decorate(get('/x'), original)).toBe(original);
	});

	it('gives a principal route an artifact header only when the identity resolves', async () => {
		const { spool } = setup();
		const anon = await spool.decorate(get('/account'), page());
		expect(decodeEnvelope(anon.headers).artifact).toBeUndefined();
		const ann = await spool.decorate(get('/account', { 'x-user': 'ann' }), page());
		expect(decodeEnvelope(ann.headers).artifact?.scope).toBe('principal');
	});

	it('sends a partition id, never the principal, and a different one per principal', async () => {
		const { spool } = setup();
		const seen = new Set<string>();
		for (const who of ['ann', 'bob', 'ann2', 'Ann', '1', '01']) {
			const response = await spool.decorate(get('/x', { 'x-user': who }), page());
			const partition = response.headers.get(HEADERS.partition) as string;
			expect(partition).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(partition).toBe(await partitionId('test-secret', who));
			seen.add(partition);
		}
		expect(seen.size).toBe(6);
		const anon = await spool.decorate(get('/x'), page());
		expect(anon.headers.has(HEADERS.partition)).toBe(false);
	});

	it('piggybacks the diff on a non-navigation GET that sent its cursor', async () => {
		const { spool } = setup();
		await spool.invalidate(['a']);
		await spool.invalidate(['b']);
		const response = await spool.decorate(
			get('/api', { 'spool-vector-seen': '1' }),
			new Response('x')
		);
		expect(decodeEnvelope(response.headers)).toEqual({
			protocol: 1,
			vector: 2,
			seen: 1,
			invalidate: { b: 2 }
		});
		expect(response.headers.get('vary')).toBe(HEADERS.vectorSeen);
	});

	it('sends no vector when the diff is over the cap, and a clear when the client is ahead', async () => {
		const { spool } = setup();
		await spool.invalidate(Array.from({ length: MAX_PIGGYBACK + 1 }, (_, i) => `t${i}`));
		const over = await spool.decorate(
			get('/api', { 'spool-vector-seen': '0' }),
			new Response('x')
		);
		expect(decodeEnvelope(over.headers)).toEqual({ protocol: 1 });
		const ahead = await spool.decorate(
			get('/api', { 'spool-vector-seen': '50' }),
			new Response('x')
		);
		expect(decodeEnvelope(ahead.headers)).toEqual({
			protocol: 1,
			vector: 1,
			seen: 50,
			clear: ['*']
		});
		const junk = await spool.decorate(
			get('/api', { 'spool-vector-seen': 'abc' }),
			new Response('x')
		);
		expect(decodeEnvelope(junk.headers)).toEqual({ protocol: 1 });
	});

	it('reports what a write changed, or clears everything when the write changed too much', async () => {
		const { spool } = setup();
		const write = new Request(`${ORIGIN}/node/1`, { method: 'POST' });
		const small = await spool.handle(write, async () => {
			await spool.invalidate(['node:1']);
			return new Response('saved');
		});
		expect(decodeEnvelope(small.headers)).toEqual({
			protocol: 1,
			vector: 1,
			invalidate: { 'node:1': 1 }
		});
		const big = await spool.handle(write, async () => {
			await spool.invalidate(Array.from({ length: MAX_PIGGYBACK + 1 }, (_, i) => `t${i}`));
			return new Response('saved');
		});
		expect(decodeEnvelope(big.headers).clear).toEqual(['*']);
		const none = await spool.handle(write, () => new Response('noop'));
		expect(decodeEnvelope(none.headers)).toEqual({ protocol: 1, vector: 2 });
	});

	it('sends the clear tokens the app asks for', async () => {
		const { spool } = setup();
		const response = await spool.decorate(get('/logout'), new Response('bye'), {
			clear: ['*']
		});
		expect(decodeEnvelope(response.headers).clear).toEqual(['*']);
	});

	it('handle reads the cursor before the app runs, so a racing write is not claimed', async () => {
		const { spool } = setup();
		const response = await spool.handle(get('/node/9'), async () => {
			await spool.invalidate(['node:9']);
			return page();
		});
		expect(decodeEnvelope(response.headers).artifact?.version).toBe(0);
	});

	it('drops an artifact by id through invalidate', async () => {
		const { spool, store } = setup();
		await spool.invalidate([], { drop: ['/page/a'] });
		expect(await store.cursor()).toBe(1);
		await spool.invalidate(['t'], { drop: ['/page/a'] });
		const changed = (await store.diff(0)).changed;
		expect(changed[artifactTag('/page/a')]).toBe(2);
		expect(changed['t']).toBe(2);
	});
});

describe('partitionId', () => {
	it('is deterministic per secret and principal', async () => {
		expect(await partitionId('s', 'ann')).toBe(await partitionId('s', 'ann'));
		expect(await partitionId('s', 'ann')).not.toBe(await partitionId('t', 'ann'));
		expect(await partitionId(new TextEncoder().encode('s'), 'ann')).toBe(
			await partitionId('s', 'ann')
		);
	});

	it('never gives two principals the same id', async () => {
		const ids = await Promise.all(
			Array.from({ length: 500 }, (_, i) => partitionId('s', `user-${i}`))
		);
		expect(new Set(ids).size).toBe(500);
	});
});

describe('the embedded config type', () => {
	it('is plain JSON', () => {
		const { spool } = setup();
		const config: SwConfig = spool.config;
		expect(JSON.parse(JSON.stringify(config))).toEqual(config);
	});
});

const VIEW: ViewEvent = {
	id: 'v1',
	crossOriginLoads: null,
	tier: 'shadow',
	reason: 'fresh',
	staleSec: 12,
	engine: 'webkit',
	scope: 'public',
	strategy: 'template',
	route: '/node/:id',
	mismatch: false,
	swAgeMs: 4000,
	gapMs: null
};

describe('mode and sample', () => {
	it('defaults to serve with no sample and carries both into the worker config', () => {
		expect(setup().spool.config).toMatchObject({ mode: 'serve', shadowSample: 0 });
		const shadow = setup({ mode: 'shadow', shadowSample: 0.25 }).spool.config;
		expect(shadow).toMatchObject({ mode: 'shadow', shadowSample: 0.25 });
	});

	it('carries a route mode and sync rule into the serialised route', () => {
		const route = defineRoute('/m', {
			strategy: 'template',
			template: { source: 'x' },
			load: () => ({}),
			mode: 'shadow',
			sync: 'deferred'
		});
		const { spool } = setup({ routes: [route] });
		expect(spool.config.routes[0]).toMatchObject({ mode: 'shadow', sync: 'deferred' });
	});

	it.each([-0.1, 1.5, Number.NaN])('refuses a shadow sample of %s', (shadowSample) => {
		expect(() => createSpool({ routes, store: memoryStore(), shadowSample })).toThrow(
			/between 0 and 1/
		);
	});

	it('refuses an unknown mode, on the server and on a route', () => {
		expect(() => createSpool({ routes, store: memoryStore(), mode: 'x' as never })).toThrow(
			/unknown mode/
		);
		expect(() =>
			defineRoute('/m', {
				strategy: 'template',
				template: { source: 'x' },
				load: () => ({}),
				mode: 'x' as never
			})
		).toThrow(/unknown mode/);
		expect(() =>
			defineRoute('/m', {
				strategy: 'template',
				template: { source: 'x' },
				load: () => ({}),
				sync: 'x' as never
			})
		).toThrow(/unknown sync rule/);
	});

	it('labels a routed response with its route and mode', async () => {
		const { spool } = setup({ mode: 'shadow' });
		const response = await spool.decorate(get('/node/3'), page());
		expect(response.headers.get('x-spool-route')).toBe('/node/:id');
		expect(response.headers.get('x-spool-mode')).toBe('shadow');
		const plain = await spool.decorate(get('/other'), page());
		expect(plain.headers.has('x-spool-route')).toBe(false);
	});
});

describe('the work series', () => {
	it('buckets time and requests by route and interval, oldest first', () => {
		const series = workSeries({ intervalSeconds: 60, now: () => 130_000 });
		series.record('/a', 5, 1000);
		series.record('/a', 7, 59_999);
		series.record('/b', 2, 60_000);
		series.record('/a', 1);
		expect(series.samples()).toEqual([
			{ start: 0, seconds: 60, busyMs: { '/a': 12 }, requests: { '/a': 2 } },
			{ start: 60_000, seconds: 60, busyMs: { '/b': 2 }, requests: { '/b': 1 } },
			{ start: 120_000, seconds: 60, busyMs: { '/a': 1 }, requests: { '/a': 1 } }
		]);
		series.clear();
		expect(series.samples()).toEqual([]);
	});

	it('drops the oldest interval past `keep` and hands out copies', () => {
		const series = workSeries({ intervalSeconds: 1, keep: 2 });
		for (const at of [0, 1000, 2000]) series.record('/a', 1, at);
		expect(series.samples().map((s) => s.start)).toEqual([1000, 2000]);
		(series.samples()[0] as { busyMs: Record<string, number> }).busyMs['/a'] = 99;
		expect(series.samples()[0]?.busyMs['/a']).toBe(1);
	});

	it('records app routes through handle and spool routes through respond, by pattern', async () => {
		let t = 0;
		const work = workSeries({ intervalSeconds: 60, now: () => 0 });
		const { spool } = setup({ work, meter: () => (t += 5) });
		await spool.handle(get('/node/1'), () => page());
		await spool.handle(get('/node/2'), () => page());
		await spool.handle(get('/other'), () => page());
		await spool.handle(get('/.spool/sync?from=0'), () => page());
		await spool.respond(get('/.spool/artifact?path=/node/1'));
		await spool.respond(get('/.spool/beacon'));
		await spool.respond(get('/.spool/nothing'));
		const [sample] = work.samples();
		expect(sample?.requests).toEqual({
			'/node/:id': 2,
			other: 1,
			'/.spool/sync': 1,
			'/.spool/artifact': 1,
			'/.spool/beacon': 1,
			'/.spool/*': 1
		});
		expect(sample?.busyMs['/node/:id']).toBe(10);
	});
});

describe('sinks', () => {
	const rum = { path: '/cdn-cgi/rum', body: '{"a":1}', contentType: 'text/plain', at: 5 };

	it('reads views out of a batch and skips other requests and forged bodies', () => {
		const forged = { ...viewToBeacon(VIEW, 1), body: '{"tier":"x"}' };
		const broken = { ...viewToBeacon(VIEW, 1), body: 'nope' };
		const views = viewsOf([rum, viewToBeacon(VIEW, 9), forged, broken]);
		expect(views).toEqual([{ ...VIEW, at: 9 }]);
	});

	it('writes a view as one flat line and any other request as it was held', async () => {
		const lines: string[] = [];
		await jsonLinesSink((line) => lines.push(line)).write([viewToBeacon(VIEW, 9), rum]);
		expect(JSON.parse(lines[0] as string)).toEqual({ event: 'spool.view', ...VIEW, at: 9 });
		expect(JSON.parse(lines[1] as string)).toEqual(rum);
	});

	it('writes data points to an Analytics Engine dataset in the documented layout', async () => {
		const points: Parameters<AnalyticsEngineLike['writeDataPoint']>[0][] = [];
		const sink = analyticsEngineSink({ writeDataPoint: (point) => void points.push(point) });
		await sink.write([
			viewToBeacon(VIEW, 9),
			viewToBeacon({ ...VIEW, staleSec: null, mismatch: null, gapMs: 250 }, 10),
			{ ...rum, body: 'b'.repeat(5000) }
		]);
		expect(points[0]).toEqual({
			indexes: ['/node/:id'],
			blobs: ['view', 'shadow', 'fresh', 'webkit', 'public', 'template', '/node/:id', 'v1'],
			doubles: [9, 12, 4000, -1, 0, -1]
		});
		expect(points[1]?.doubles).toEqual([10, -1, 4000, 250, -1, -1]);
		expect(points).toHaveLength(4);
		expect(points.slice(2)).toEqual([
			{
				indexes: ['/cdn-cgi/rum'],
				blobs: ['beacon', 'text/plain', 'b'.repeat(4096), null],
				doubles: [5, 0, 2]
			},
			{
				indexes: ['/cdn-cgi/rum'],
				blobs: ['beacon', 'text/plain', 'b'.repeat(904), null],
				doubles: [5, 1, 2]
			}
		]);
	});

	it('joins a loads report that came in a later batch than its view', () => {
		const first = [viewToBeacon(VIEW, 1), viewToBeacon({ ...VIEW, id: 'v2' }, 2)];
		const later = [loadsToBeacon('v1', 3, 50), loadsToBeacon('v1', 4, 60), rum];
		expect(viewsOf(first).map((v) => v.crossOriginLoads)).toEqual([null, null]);
		expect(viewsOf([...first, ...later]).map((v) => [v.id, v.crossOriginLoads])).toEqual([
			['v1', 4],
			['v2', null]
		]);
	});

	it('writes a loads report as its own line and its own Analytics Engine row', async () => {
		const lines: string[] = [];
		const points: unknown[] = [];
		const report = loadsToBeacon('v1', 3, 50);
		await jsonLinesSink((line) => lines.push(line)).write([report]);
		await analyticsEngineSink({ writeDataPoint: (p) => void points.push(p) }).write([
			report,
			viewToBeacon({ ...VIEW, crossOriginLoads: 2 }, 9)
		]);
		expect(JSON.parse(lines[0] as string)).toEqual({
			event: 'spool.loads',
			view: 'v1',
			count: 3,
			at: 50
		});
		expect(points[0]).toEqual({
			indexes: ['/.spool/loads'],
			blobs: ['loads', 'v1'],
			doubles: [50, 3]
		});
		expect((points[1] as { doubles: number[] }).doubles[5]).toBe(2);
	});

	it('truncates a long route to the 96 bytes an index allows', async () => {
		const points: Array<{ indexes?: string[] }> = [];
		await analyticsEngineSink({ writeDataPoint: (p) => void points.push(p) }).write([
			viewToBeacon({ ...VIEW, route: `/${'r'.repeat(200)}` }, 1)
		]);
		expect(points[0]?.indexes?.[0]).toHaveLength(96);
	});
});

describe('/.spool/sync with need', () => {
	it('returns only the asked-for ids whose version passed the held one', async () => {
		const { spool } = setup();
		await spool.invalidate(['a', 'b']);
		await spool.invalidate(['c'], { drop: ['/page/x'] });
		await spool.invalidate(['a']);
		const need = encodeHeld({ a: 1, b: 1, c: 3, d: 0, [artifactTag('/page/x')]: 1 });
		const response = await spool.respond(get(`/.spool/sync?need=${encodeURIComponent(need)}`));
		expect(response?.headers.get(HEADERS.vector)).toBe('3');
		expect(parseSyncResponse(await response?.json())).toEqual({
			protocol: 1,
			cursor: 3,
			changed: { a: 3 },
			dropped: ['/page/x'],
			reset: false,
			partial: true
		});
	});

	it('answers with the cursor alone for an empty need and says reset for a holder ahead', async () => {
		const { spool } = setup();
		await spool.invalidate(['a']);
		const empty = parseSyncResponse(
			await (await spool.respond(get('/.spool/sync?need=')))?.json()
		);
		expect(empty).toEqual({
			protocol: 1,
			cursor: 1,
			changed: {},
			dropped: [],
			reset: false,
			partial: true
		});
		const ahead = encodeURIComponent(encodeHeld({ a: 50 }));
		const reset = parseSyncResponse(
			await (await spool.respond(get(`/.spool/sync?need=${ahead}`)))?.json()
		);
		expect(reset).toMatchObject({ reset: true, changed: {}, partial: true });
	});

	it.each(['x', 'a@', 'a@-1', '@3'])('answers 400 for need=%s', async (need) => {
		const { spool } = setup();
		expect((await spool.respond(get(`/.spool/sync?need=${need}`)))?.status).toBe(400);
	});

	it('refuses more than 64 ids', async () => {
		const { spool } = setup();
		const many = encodeHeld(
			Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`t${i}`, 0]))
		);
		const response = await spool.respond(get(`/.spool/sync?need=${encodeURIComponent(many)}`));
		expect(response?.status).toBe(400);
	});
});

describe('/.spool/artifact with records and projections', () => {
	const setupCampus = () => {
		const world = campus();
		const store = memoryStore();
		return { ...world, store, spool: createSpool({ routes: world.routes, store }) };
	};
	const fetchArtifact = async (
		spool: ReturnType<typeof setupCampus>['spool'],
		path: string,
		have = ''
	) => {
		const query = have ? `&have=${encodeURIComponent(have)}` : '';
		const response = await spool.respond(get(`/.spool/artifact?path=${path}${query}`));
		return parseArtifact(await response?.json());
	};

	it('sends the records and projections a page reads, once each, and lists them as deps', async () => {
		const { spool } = setupCampus();
		const artifact = await fetchArtifact(spool, '/t/ada');
		expect(artifact.records?.map((r) => r.id)).toEqual([
			'course:101',
			'course:102',
			'site:name',
			'teacher:ada'
		]);
		expect(artifact.projections?.map((p) => [p.id, p.deps])).toEqual([
			['menu', ['course:101', 'course:102', 'site:name']],
			['roster:ada', ['course:101']]
		]);
		expect(artifact.deps).toEqual(['course:101', 'course:102', 'site:name', 'teacher:ada']);
		expect(artifact.body).toEqual({
			data: {
				name: { $record: 'teacher:ada' },
				roster: { $projection: 'roster:ada' },
				menu: { $projection: 'menu' }
			}
		});
	});

	it('leaves out what the holder already has at a version no change has passed', async () => {
		const { spool } = setupCampus();
		await spool.invalidate(['course:102']);
		const have = encodeHeld({
			'site:name': 0,
			'course:101': 0,
			'course:102': 0,
			menu: 0,
			'teacher:ada': 0,
			'roster:ada': 0
		});
		const artifact = await fetchArtifact(spool, '/t/ada', have);
		expect(artifact.records?.map((r) => r.id)).toEqual(['course:102']);
		expect(artifact.projections?.map((p) => p.id)).toEqual(['menu']);
	});

	it('sends everything when the holder claims a version from the future', async () => {
		const { spool } = setupCampus();
		const artifact = await fetchArtifact(spool, '/c/101', encodeHeld({ 'course:101': 99 }));
		expect(artifact.records?.map((r) => r.id)).toContain('course:101');
	});

	it('refuses a reference the load did not register and a conflicting record', async () => {
		const bad = defineRoute('/bad', {
			strategy: 'template',
			template: { source: '{{x}}' },
			load: () => ({ x: { $record: 'ghost' } })
		});
		const missing = defineRoute('/missing-projection', {
			strategy: 'template',
			template: { source: '{{x}}' },
			load: () => ({ x: { $projection: 'ghost' } })
		});
		const twice = defineRoute('/twice', {
			strategy: 'template',
			template: { source: '{{x}}' },
			load: (ctx) => ({ x: [ctx.record('r', 'a'), ctx.record('r', 'b')] })
		});
		const spool = createSpool({ routes: [bad, missing, twice], store: memoryStore() });
		for (const path of ['/bad', '/missing-projection', '/twice']) {
			expect((await spool.respond(get(`/.spool/artifact?path=${path}`)))?.status).toBe(400);
		}
	});

	it('answers 400 for a malformed have list', async () => {
		const { spool } = setupCampus();
		expect((await spool.respond(get('/.spool/artifact?path=/d&have=x')))?.status).toBe(400);
	});
});

describe('/.spool/beacon with want', () => {
	const post = (body: unknown) =>
		new Request(`${ORIGIN}/.spool/beacon`, { method: 'POST', body: JSON.stringify(body) });

	it('answers a flush that asked for artifacts with the public ones it can build', async () => {
		const { spool, sink } = setup();
		const response = await spool.respond(
			post({
				protocol: 1,
				events: [viewToBeacon(VIEW, 1)],
				want: ['/node/1', '/page/a', '/account', '/nothing', '/throws']
			})
		);
		expect(response?.status).toBe(200);
		const body = (await response?.json()) as { artifacts: unknown[] };
		expect(body.artifacts.map((a) => parseArtifact(a).id)).toEqual(['/node/1', '/page/a']);
		expect(viewsOf(sink.events)).toHaveLength(1);
	});

	it('answers 204 for a flush that wants nothing, and 400 for a bad want', async () => {
		const { spool } = setup();
		expect((await spool.respond(post({ protocol: 1, events: [], want: [] })))?.status).toBe(
			204
		);
		expect((await spool.respond(post({ protocol: 1, events: [], want: ['x'] })))?.status).toBe(
			400
		);
		const nine = Array.from({ length: 9 }, (_, i) => `/p${i}`);
		expect((await spool.respond(post({ protocol: 1, events: [], want: nine })))?.status).toBe(
			400
		);
	});
});
