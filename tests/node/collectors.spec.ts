import { describe, expect, it } from 'vitest';
import {
	applyStamp,
	checkCollectors,
	defineRoute,
	GA4_COLLECTOR,
	GA4_HARD_MS,
	matchCollector,
	type BeaconEvent
} from '../../src/protocol/index';
import {
	combineSinks,
	eventsOf,
	ga4Requests,
	ga4Sink,
	memorySink,
	MP_MAX_EVENTS,
	mpViolations
} from '../../src/server/index';
import { classify } from '../../src/sw/router';
import { nav, ORIGIN, sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const HOUR = 3_600_000;
const GA = 'https://www.google-analytics.com/g/collect';
const hit = (search: string) => `${GA}?v=2&tid=G-TEST&cid=123.456&sid=1700000000${search}`;

const routes = [
	defineRoute('/page/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{id}}</body></html>' },
		load: (ctx) => ({ id: ctx.params['id'] })
	})
];

const credentials: string[] = [];
const received: Array<{ url: string; method: string; body: string; type: string | null }> = [];

const app: RigOptions['app'] = async (request) => {
	const url = new URL(request.url);
	if (url.hostname === 'collect.example') {
		credentials.push(request.credentials);
		received.push({
			url: `${url.pathname}${url.search}`,
			method: request.method,
			body: await request.text(),
			type: request.headers.get('content-type')
		});
		return new Response(null, { status: 204 });
	}
	if (url.pathname === '/cdn-cgi/rum') {
		received.push({
			url: `${url.pathname}${url.search}`,
			method: request.method,
			body: await request.text(),
			type: request.headers.get('content-type')
		});
		return new Response(null, { status: 204 });
	}
	if (url.pathname.startsWith('/page/')) {
		return new Response('<html><head></head><body>x</body></html>', { headers: HTML });
	}
	return new Response('missing', { status: 404, headers: HTML });
};

function ga4World(maxAgeMs?: number) {
	const mp: Array<{ url: string; body: { client_id: string; events: unknown[] } }> = [];
	const clock = { t: 0 };
	const sink = memorySink();
	const analytics = ga4Sink({
		measurementId: 'G-TEST',
		apiSecret: 'secret',
		maxAgeMs,
		now: () => clock.t,
		fetch: (async (url: string, init: RequestInit) => {
			mp.push({ url, body: JSON.parse(init.body as string) });
			return new Response(null, { status: 204 });
		}) as typeof fetch
	});
	const r = rig({
		routes,
		app,
		spool: { collectors: [GA4_COLLECTOR], sink: combineSinks(sink, analytics) }
	});
	const sync = () => void (clock.t = r.t());
	return { r, mp, sink, analytics, sync };
}

describe('collector config', () => {
	it('matches by origin and path prefix and nothing else', () => {
		const list = [GA4_COLLECTOR];
		expect(matchCollector(list, `${GA}?v=2`)?.vendor).toBe('ga4');
		expect(matchCollector(list, 'https://www.google-analytics.com/g/collect/x')?.vendor).toBe(
			'ga4'
		);
		expect(matchCollector(list, 'https://www.google-analytics.com/other')).toBeUndefined();
		expect(matchCollector(list, 'http://www.google-analytics.com/g/collect')).toBeUndefined();
		expect(matchCollector(list, 'not a url')).toBeUndefined();
		expect(matchCollector(undefined, GA)).toBeUndefined();
	});

	it('refuses a GA4 cap past the 72 hour limit and other malformed collectors', () => {
		const ok = { ...GA4_COLLECTOR };
		expect(() => checkCollectors([ok])).not.toThrow();
		expect(() => checkCollectors([{ ...ok, maxAgeMs: GA4_HARD_MS + 1 }])).toThrow(/72 hour/);
		expect(() => checkCollectors([{ ...ok, maxAgeMs: 0 }])).toThrow(/maxAgeMs/);
		expect(() => checkCollectors([{ ...ok, match: '/relative' }])).toThrow(/absolute/);
		expect(() => checkCollectors([{ ...ok, match: 'ftp://x/y' }])).toThrow(/http/);
		expect(() => checkCollectors([{ ...ok, vendor: '' }])).toThrow(/vendor/);
		expect(() => checkCollectors([ok, ok])).toThrow(/twice/);
		expect(() => checkCollectors([{ ...ok, delivery: 'push' as never }])).toThrow(/delivery/);
		expect(() =>
			checkCollectors([{ ...ok, vendor: 'x', stamp: { param: 'a', kind: 'bad' as never } }])
		).toThrow(/stamp/);
	});

	it('writes a stamp in each unit and keeps the other parameters', () => {
		const at = Date.UTC(2026, 9, 19, 12, 30, 5);
		const now = at + 10_000;
		const stamp = (kind: Parameters<typeof applyStamp>[1]['kind']) =>
			applyStamp('?cid=1', { param: 't', kind }, at, now);
		expect(stamp('age-ms')).toBe('?cid=1&t=10000');
		expect(stamp('epoch-ms')).toBe(`?cid=1&t=${at}`);
		expect(stamp('epoch-s')).toBe(`?cid=1&t=${Math.floor(at / 1000)}`);
		expect(stamp('datetime-utc')).toBe('?cid=1&t=2026-10-19+12%3A30%3A05');
		expect(applyStamp('?t=9&x=1', { param: 't', kind: 'age-ms' }, 5, 6)).toBe('?t=1&x=1');
		expect(applyStamp('', { param: 't', kind: 'age-ms' }, 9, 5)).toBe('?t=0');
	});

	it('sorts a cross-origin request as a collector, a third-party file or ignored', () => {
		const config = rig({
			routes,
			app,
			spool: {
				collectors: [GA4_COLLECTOR],
				thirdParty: { allow: ['https://fonts.gstatic.com'] }
			}
		}).spool.config;
		expect(classify(config, sub(hit('&en=x'), { method: 'POST' }), ORIGIN).kind).toBe(
			'collector'
		);
		expect(classify(config, sub(hit('&en=x')), ORIGIN).kind).toBe('collector');
		expect(classify(config, sub(hit('&en=x'), { method: 'PUT' }), ORIGIN).kind).toBe('ignore');
		expect(classify(config, sub('https://fonts.gstatic.com/a.woff2'), ORIGIN).kind).toBe(
			'thirdparty'
		);
		expect(
			classify(config, sub('https://fonts.gstatic.com/a', { method: 'POST' }), ORIGIN).kind
		).toBe('ignore');
		expect(classify(config, sub('https://elsewhere.test/a'), ORIGIN).kind).toBe('ignore');
	});
});

describe('GA4 requests', () => {
	const at = 1_700_000_000_000;
	const event = (search: string, body = '', over: Partial<BeaconEvent> = {}): BeaconEvent => ({
		path: '/g/collect',
		search,
		body,
		contentType: 'text/plain;charset=UTF-8',
		at,
		origin: 'https://www.google-analytics.com',
		vendor: 'ga4',
		deliver: 'sink',
		...over
	});

	it('keeps the original time of each event in microseconds', () => {
		const plan = ga4Requests([event('?cid=1.2&en=page_view')], at + HOUR);
		expect(plan.bodies).toEqual([
			{
				client_id: '1.2',
				events: [{ name: 'page_view', params: {}, timestamp_micros: at * 1000 }]
			}
		]);
		expect(plan.dropped).toBe(0);
	});

	it('maps the gtag parameters and splits a batched body into one event per line', () => {
		const parsed = eventsOf(
			event(
				'?cid=1.2&sid=77&dl=https%3A%2F%2Fa.test%2F&dt=Home&en=page_view&_et=250',
				'en=scroll&epn.percent=90&ep.label=hero\nen=click&ep.label=go'
			)
		);
		expect(parsed.map((p) => p.body.name)).toEqual(['scroll', 'click']);
		expect(parsed[0]?.body.params).toEqual({
			page_location: 'https://a.test/',
			page_title: 'Home',
			session_id: 77,
			engagement_time_msec: 250,
			percent: 90,
			label: 'hero'
		});
		expect(parsed[1]?.body.params['label']).toBe('go');
	});

	it('skips an event with no client, no name or an invalid name', () => {
		expect(eventsOf(event('?en=page_view'))).toEqual([]);
		expect(eventsOf(event('?cid=1'))).toEqual([]);
		expect(eventsOf(event('?cid=1&en=1bad'))).toEqual([]);
		expect(eventsOf(event('?cid=1&en=ok&ep.bad-name=x&epn.n=NaN'))[0]?.body.params).toEqual({});
	});

	it('groups by client and cuts requests at 25 events', () => {
		const many = Array.from({ length: 60 }, (_, i) => event(`?cid=a&en=e${i}`));
		const other = event('?cid=b&en=solo');
		const plan = ga4Requests([...many, other], at);
		expect(plan.bodies.map((b) => [b.client_id, b.events.length])).toEqual([
			['a', MP_MAX_EVENTS],
			['a', MP_MAX_EVENTS],
			['a', 10],
			['b', 1]
		]);
		expect(plan.bodies[0]?.events[0]?.name).toBe('e0');
		expect(plan.bodies.every((b) => mpViolations(b, at).length === 0)).toBe(true);
	});

	it('drops and counts an event older than the cap and ignores other vendors', () => {
		const old = event('?cid=1&en=old', '', { at: at - 49 * HOUR });
		const fresh = event('?cid=1&en=new');
		const other = event('?cid=1&en=other', '', { vendor: 'matomo' });
		const plan = ga4Requests([old, fresh, other], at);
		expect(plan.dropped).toBe(1);
		expect(plan.bodies[0]?.events.map((e) => e.name)).toEqual(['new']);
		expect(ga4Requests([old], at, 72 * HOUR).dropped).toBe(0);
	});

	it('checks a body the way the debug endpoint would: client, count, names and age', () => {
		const good = {
			client_id: 'c',
			events: [{ name: 'a', params: {}, timestamp_micros: at * 1000 }]
		};
		expect(mpViolations(good, at)).toEqual([]);
		expect(mpViolations({ ...good, client_id: '' }, at)).toContain('client_id is empty');
		expect(mpViolations({ ...good, events: [] }, at)).toContain('no events');
		expect(
			mpViolations(
				{
					client_id: 'c',
					events: Array.from({ length: 26 }, () => good.events[0] as never)
				},
				at
			)
		).toContain('more than 25 events');
		expect(
			mpViolations({ ...good, events: [{ ...good.events[0], name: '1x' } as never] }, at)
		).toEqual(['bad event name 1x']);
		expect(mpViolations(good, at + 73 * HOUR)).toEqual(['a is older than 72 hours']);
		expect(mpViolations(good, at - 10 * 60_000)).toEqual(['a is in the future']);
	});

	it('refuses a sink cap past 72 hours', () => {
		expect(() => ga4Sink({ measurementId: 'G', apiSecret: 's', maxAgeMs: 73 * HOUR })).toThrow(
			/72 hours/
		);
		expect(() => ga4Sink({ measurementId: 'G', apiSecret: 's', maxAgeMs: 0 })).toThrow();
	});

	it('posts to the debug endpoint when asked and throws on a refusal so the worker retries', async () => {
		const urls: string[] = [];
		const sink = ga4Sink({
			measurementId: 'G-1',
			apiSecret: 'k',
			debug: true,
			now: () => at,
			fetch: (async (url: string) => {
				urls.push(url);
				return new Response('no', { status: 500 });
			}) as typeof fetch
		});
		await expect(sink.write([event('?cid=1&en=a')])).rejects.toThrow(/500/);
		expect(urls).toEqual([
			'https://www.google-analytics.com/debug/mp/collect?measurement_id=G-1&api_secret=k'
		]);
		expect(sink.sent).toBe(0);
	});
});

describe('held collector requests in the worker', () => {
	it('answers the page at once, sends nothing, and delivers to GA4 later with the original time', async () => {
		const w = ga4World();
		await w.r.visit('/page/1');
		w.r.reset();
		const first = await w.r.drive(
			sub(hit('&en=page_view&dt=Home'), { method: 'POST', body: '' })
		);
		expect(first.status).toBe(204);
		expect(first.headers.get('access-control-allow-origin')).toBe('*');
		expect(w.r.log).toEqual([]);
		const held = w.r.t();
		w.r.advance(3 * 3600);
		await w.r.visit('/page/2');
		w.sync();
		await w.r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(w.mp).toHaveLength(1);
		expect(w.mp[0]?.url).toBe(
			'https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=secret'
		);
		const body = w.mp[0]?.body as {
			client_id: string;
			events: Array<{ timestamp_micros: number; name: string }>;
		};
		expect(body.client_id).toBe('123.456');
		expect(body.events[0]).toMatchObject({ name: 'page_view', timestamp_micros: held * 1000 });
		expect(mpViolations(body as never, w.r.t())).toEqual([]);
		expect(w.r.log.some((l) => l.includes('/g/collect'))).toBe(false);
		expect(w.analytics.sent).toBe(1);
	});

	it('answers a credentialed CORS request with the page origin, and a GET with a pixel', async () => {
		const w = ga4World();
		const credentialed = sub(hit('&en=a'), {
			method: 'POST',
			body: '',
			credentials: 'include',
			headers: { origin: ORIGIN }
		});
		const response = await w.r.drive(credentialed);
		expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(response.headers.get('access-control-allow-credentials')).toBe('true');
		const pixel = await w.r.drive(sub(hit('&en=b'), { method: 'GET' }));
		expect(pixel.headers.get('content-type')).toBe('image/gif');
		expect((await pixel.arrayBuffer()).byteLength).toBeGreaterThan(20);
	});

	it('drops and counts events past the cap and reports the drop to the sink, without a request to GA4', async () => {
		const w = ga4World();
		await w.r.drive(sub(hit('&en=late'), { method: 'POST', body: '' }));
		w.r.advance(49 * 3600);
		await w.r.visit('/page/3');
		w.r.advance(3601);
		await w.r.drive(sub('/form', { method: 'POST', body: 'x' }));
		const held = (await w.r.runtime.message({ type: 'spool:held' })) as {
			dropped: Record<string, number>;
		};
		expect(held.dropped).toEqual({ ga4: 1 });
		expect(w.mp).toEqual([]);
		const dropped = w.sink.events.filter((e) => e.path === '/.spool/dropped');
		expect(dropped.map((e) => JSON.parse(e.body))).toEqual([{ vendor: 'ga4', count: 1 }]);
	});

	it('keeps the held events across a worker restart', async () => {
		const w = ga4World();
		await w.r.drive(sub(hit('&en=kept'), { method: 'POST', body: '' }));
		const restarted = w.r.make();
		w.r.advance(60);
		await w.r.visit('/page/4', restarted);
		await w.r.drive(sub('/form', { method: 'POST', body: 'x' }), restarted);
		w.sync();
		expect(w.mp).toHaveLength(1);
	});

	it('sends a request it cannot hold, a binary body, straight to the network', async () => {
		const w = ga4World();
		const response = await w.r.drive(
			sub(hit('&en=blob'), {
				method: 'POST',
				body: 'x',
				headers: { 'content-type': 'application/octet-stream' }
			})
		);
		expect(response.status).toBe(404);
		expect(w.r.log).toEqual(['POST /g/collect']);
	});
});

describe("replayed collectors and the site's own beacons", () => {
	const matomo = {
		vendor: 'matomo',
		match: 'https://collect.example/matomo',
		maxAgeMs: 24 * HOUR,
		delivery: 'replay' as const,
		stamp: { param: 'qt', kind: 'age-ms' as const }
	};

	it('replays a held pixel to the vendor with no cookies and the age of the hit in the stamp', async () => {
		received.length = 0;
		credentials.length = 0;
		const r = rig({ routes, app, spool: { collectors: [matomo] } });
		await r.drive(sub('https://collect.example/matomo?cid=1', { method: 'GET' }));
		expect(received).toEqual([]);
		r.advance(10);
		await r.visit('/page/1');
		expect(received).toEqual([
			{ url: '/matomo?cid=1&qt=10000', method: 'GET', body: '', type: null }
		]);
		expect(credentials).toEqual(['omit']);
	});

	it('replays a held POST with its content type and body, and a site beacon with its query', async () => {
		received.length = 0;
		const r = rig({ routes, app, spool: { collectors: [matomo] } });
		await r.drive(
			sub('https://collect.example/matomo', {
				method: 'POST',
				body: '{"a":1}',
				headers: { 'content-type': 'application/json' }
			})
		);
		await r.drive(
			sub('/cdn-cgi/rum?ver=2', {
				method: 'POST',
				body: 'rum-body',
				headers: { 'content-type': 'text/plain;charset=UTF-8' }
			})
		);
		await r.visit('/page/1');
		expect(received).toEqual([
			{ url: '/matomo?qt=0', method: 'POST', body: '{"a":1}', type: 'application/json' },
			{
				url: '/cdn-cgi/rum?ver=2',
				method: 'POST',
				body: 'rum-body',
				type: 'text/plain;charset=UTF-8'
			}
		]);
		const events = r.sink.events.map((e) => e.path);
		expect(events).not.toContain('/cdn-cgi/rum');
		expect(events).not.toContain('/matomo');
	});

	it('leaves a request to an origin with no collector to the browser', async () => {
		const r = rig({ routes, app, spool: { collectors: [matomo] } });
		expect(r.runtime.handle(sub('https://other.example/x'), () => undefined)).toBeUndefined();
	});

	it('keeps the held events when the vendor cannot be reached and sends them later', async () => {
		received.length = 0;
		const r = rig({ routes, app, spool: { collectors: [matomo] } });
		await r.drive(sub('https://collect.example/matomo?cid=2', { method: 'GET' }));
		r.offline(true);
		await r.drive(nav('/page/1')).catch(() => undefined);
		expect(received).toEqual([]);
		r.offline(false);
		await r.visit('/page/1');
		expect(received).toHaveLength(1);
	});
});
