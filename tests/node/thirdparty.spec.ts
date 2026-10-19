import { describe, expect, it } from 'vitest';
import { crossOriginLoads, crossOriginOrigins } from '../../src/client/loads';
import {
	defineRoute,
	loadsFromBeacon,
	loadsToBeacon,
	MAX_LOAD_ORIGINS,
	viewToBeacon,
	type ThirdPartyConfig,
	type ViewEvent
} from '../../src/protocol/index';
import { classifyOrigin, thirdPartyReport } from '../../src/report/index';
import { viewsOf } from '../../src/server/index';
import { THIRD_HEADERS, versionClass } from '../../src/sw/thirdparty';
import { sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const FONT = 'https://fonts.gstatic.com/s/inter/v12/abc.woff2';
const CDN = 'https://cdn.example/lib.js';

const routes = [
	defineRoute('/page/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{id}}</body></html>' },
		load: (ctx) => ({ id: ctx.params['id'] })
	})
];

const served = { version: 1 };

const app: RigOptions['app'] = (request) => {
	const url = new URL(request.url);
	if (url.hostname === 'fonts.gstatic.com') {
		return new Response('font-bytes', {
			headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' }
		});
	}
	if (url.hostname === 'cdn.example') {
		return new Response(`js-${served.version}`, {
			headers: {
				'content-type': 'text/javascript',
				'access-control-allow-origin': '*',
				...(url.pathname === '/immutable.js'
					? { 'cache-control': 'public, max-age=31536000, immutable' }
					: {})
			}
		});
	}
	if (url.pathname.startsWith('/page/')) {
		return new Response('<html><head></head><body>x</body></html>', { headers: HTML });
	}
	return new Response('missing', { status: 404, headers: HTML });
};

const make = (over: Partial<ThirdPartyConfig> = {}) =>
	rig({
		routes,
		app,
		spool: {
			thirdParty: { allow: ['https://fonts.gstatic.com', 'https://cdn.example'], ...over }
		}
	});

const held = async (r: ReturnType<typeof make>) =>
	((await r.runtime.message({ type: 'spool:held' })) as { third: string[] }).third;

describe('versionClass', () => {
	const at = (url: string, cache = '') =>
		versionClass(new URL(url), new Headers(cache ? { 'cache-control': cache } : {}));

	it('calls a hash, a semver, a /v12/ segment or an immutable header a name for the bytes', () => {
		expect(at('https://x.test/app.3f9a1c2b.js')).toBe('immutable');
		expect(at('https://x.test/app-3f9a1c2b4d.css')).toBe('immutable');
		expect(at('https://x.test/lib@1.4.2/dist.js')).toBe('immutable');
		expect(at('https://x.test/s/inter/v12/a.woff2')).toBe('immutable');
		expect(at('https://x.test/plain.js', 'public, immutable')).toBe('immutable');
		expect(at('https://x.test/plain.js', 'max-age=31536000')).toBe('immutable');
	});

	it('calls a version in the query, or a site pattern, a weaker claim', () => {
		expect(at('https://x.test/a.js?v=3')).toBe('revalidate');
		expect(at('https://x.test/a.js?ver=3&x=1')).toBe('revalidate');
		const own = versionClass(new URL('https://x.test/widget/current.js'), new Headers(), [
			'widget/current'
		]);
		expect(own).toBe('revalidate');
	});

	it('keeps nothing else, and skips a bad site pattern', () => {
		expect(at('https://x.test/plain.js')).toBeNull();
		expect(at('https://x.test/plain.js', 'max-age=3600')).toBeNull();
		expect(at('https://x.test/a.js?x=1')).toBeNull();
		expect(versionClass(new URL('https://x.test/a.js'), new Headers(), ['('])).toBeNull();
	});
});

describe('the opt-in third-party cache', () => {
	it('learns a versioned font from the first view and then answers it with no request', async () => {
		const r = make();
		const first = await r.drive(sub(FONT));
		expect(await first.text()).toBe('font-bytes');
		expect(r.urls).toEqual([`GET ${new URL(FONT).pathname}`]);
		expect(await held(r)).toEqual([FONT]);

		r.reset();
		const second = await r.drive(sub(FONT));
		expect(await second.text()).toBe('font-bytes');
		expect(second.headers.get('content-type')).toBe('font/woff2');
		expect(second.headers.get(THIRD_HEADERS.class)).toBe('immutable');
		expect(r.log).toEqual([]);
	});

	it('keeps the same file for a no-cors request and for a CORS one', async () => {
		const r = make();
		await r.drive(sub(FONT));
		r.reset();
		await r.drive(sub(FONT, { mode: 'no-cors' } as RequestInit));
		expect(r.log).toEqual([]);
	});

	it('goes to the network every time for a URL that does not name its bytes', async () => {
		const r = make();
		await r.drive(sub('https://cdn.example/plain.js'));
		await r.drive(sub('https://cdn.example/plain.js'));
		expect(r.log).toEqual(['GET /plain.js', 'GET /plain.js']);
		expect(await held(r)).toEqual([]);
	});

	it("trusts an origin's immutable header for a URL with no version in it", async () => {
		const r = make();
		await r.drive(sub('https://cdn.example/immutable.js'));
		r.reset();
		await r.drive(sub('https://cdn.example/immutable.js'));
		expect(r.log).toEqual([]);
	});

	it('leaves other origins, other methods and an origin that was not allowed to the browser', async () => {
		const r = make({ allow: ['https://fonts.gstatic.com'] });
		expect(r.runtime.handle(sub(CDN), () => undefined)).toBeUndefined();
		expect(
			r.runtime.handle(sub(FONT, { method: 'POST', body: 'x' }), () => undefined)
		).toBeUndefined();
		expect(
			r.runtime.handle(sub('https://elsewhere.test/a.woff2'), () => undefined)
		).toBeUndefined();
	});

	it('keeps an opaque response only when asked to', async () => {
		const opaque = (r: ReturnType<typeof make>) =>
			r.make({
				fetch: async (input: Request | string) => {
					const response = new Response('x', { status: 200 });
					Object.defineProperty(response, 'type', { value: 'opaque' });
					Object.defineProperty(response, 'url', { value: (input as Request).url });
					return response;
				}
			});
		const a = make();
		const refusing = opaque(a);
		await a.drive(sub(FONT), refusing);
		expect(await held(a)).toEqual([]);

		const b = make({ allowOpaque: true });
		await b.drive(sub(FONT), opaque(b));
		expect(await held(b)).toEqual([FONT]);
	});

	it('checks a weakly versioned file again only at a network moment once it is old, and replaces it when it changed', async () => {
		const r = make({ revalidateAfterMs: 1000 * 3600 });
		const url = 'https://cdn.example/a.js?v=3';
		await r.drive(sub(url));
		expect(await (await r.drive(sub(url))).text()).toBe('js-1');

		served.version = 2;
		r.reset();
		r.advance(1800);
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(r.log.filter((l) => l === 'GET /a.js')).toHaveLength(0);

		r.advance(3600);
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(r.log.filter((l) => l === 'GET /a.js')).toHaveLength(1);
		r.reset();
		expect(await (await r.drive(sub(url))).text()).toBe('js-2');
		expect(r.log).toEqual([]);
		served.version = 1;
	});

	it('does not check a strongly versioned file again, however old', async () => {
		const r = make({ revalidateAfterMs: 1 });
		await r.drive(sub(FONT));
		r.reset();
		r.advance(30 * 86_400);
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(r.log.filter((l) => l.includes('woff2'))).toEqual([]);
	});

	it('drops the oldest files past the limit', async () => {
		const r = make({ maxEntries: 2 });
		for (const n of [1, 2, 3]) {
			await r.drive(sub(`https://fonts.gstatic.com/s/f/v${n}/a.woff2`));
			r.advance(10);
		}
		const urls = await held(r);
		expect(urls).toHaveLength(2);
		expect(urls).not.toContain('https://fonts.gstatic.com/s/f/v1/a.woff2');
	});

	it('survives a worker restart', async () => {
		const r = make();
		await r.drive(sub(FONT));
		const restarted = r.make();
		r.reset();
		await r.drive(sub(FONT), restarted);
		expect(r.log).toEqual([]);
	});
});

describe('loads reports with origins', () => {
	const entries = [
		'https://site.test/a.css',
		'https://fonts.gstatic.com/x.woff2',
		'https://fonts.gstatic.com/y.woff2',
		'https://www.google-analytics.com/g/collect?z=1',
		'https://cdn.example/self-script.js',
		'data:image/png;base64,AAAA'
	].map((name) => ({ name }));

	it('counts origins busiest first, never keeping a path or query string', () => {
		expect(
			crossOriginOrigins(entries, 'https://site.test', ['https://cdn.example/self-script.js'])
		).toEqual({
			'https://fonts.gstatic.com': 2,
			'https://www.google-analytics.com': 1
		});
		expect(
			crossOriginLoads(entries, 'https://site.test', ['https://cdn.example/self-script.js'])
		).toBe(4);
		expect(crossOriginOrigins(entries, 'https://site.test', [], 1)).toEqual({
			'https://fonts.gstatic.com': 2
		});
		expect(crossOriginOrigins([{ name: 'not a url' }], 'https://site.test')).toEqual({});
	});

	it('round-trips through a beacon and refuses a malformed origins field', () => {
		const origins = { 'https://a.test': 2 };
		const event = loadsToBeacon('v1', 2, 7, origins);
		expect(loadsFromBeacon(event)).toEqual({ view: 'v1', count: 2, at: 7, origins });
		expect(loadsFromBeacon(loadsToBeacon('v1', 2, 7))).toEqual({ view: 'v1', count: 2, at: 7 });
		expect(JSON.parse(loadsToBeacon('v1', 0, 7, {}).body)).toEqual({ view: 'v1', count: 0 });
		const bad = (value: unknown) =>
			loadsFromBeacon({
				...event,
				body: JSON.stringify({ view: 'v1', count: 1, origins: value })
			});
		expect(bad([])).toBeNull();
		expect(bad({ 'https://a.test': 0 })).toBeNull();
		expect(bad({ 'https://a.test': 'x' })).toBeNull();
		const many = Object.fromEntries(
			Array.from({ length: MAX_LOAD_ORIGINS + 1 }, (_, i) => [`https://o${i}.test`, 1])
		);
		expect(bad(many)).toBeNull();
	});
});

describe('thirdPartyReport', () => {
	const view = (id: string): ViewEvent => ({
		id,
		crossOriginLoads: null,
		tier: 'local',
		reason: 'fresh',
		staleSec: 1,
		engine: 'chromium',
		scope: 'public',
		strategy: 'template',
		route: '/a',
		mismatch: null,
		swAgeMs: 1,
		gapMs: null
	});
	const stream = (loads: Array<[string, number, Record<string, number>?]>) =>
		viewsOf(
			loads.flatMap(([id, count, origins], i) => [
				viewToBeacon(view(id), i),
				loadsToBeacon(id, count, i, origins)
			])
		);

	it('names the origins that block, ranked by the views each one alone blocks', () => {
		const report = thirdPartyReport(
			stream([
				['a', 0],
				['b', 1, { 'https://fonts.gstatic.com': 1 }],
				['c', 3, { 'https://fonts.gstatic.com': 1, 'https://www.google-analytics.com': 2 }],
				['d', 1, { 'https://www.google-analytics.com': 1 }],
				['e', 2],
				['f', 1, { 'https://doubleclick.net': 1 }]
			]).concat(viewsOf([viewToBeacon(view('unreported'), 99)]))
		);
		expect(report).toMatchObject({ views: 7, reported: 6, clean: 1, blocked: 5, unnamed: 1 });
		expect(report.rows.map((r) => [r.origin, r.views, r.loads, r.soloViews])).toEqual([
			['https://fonts.gstatic.com', 2, 2, 1],
			['https://www.google-analytics.com', 2, 3, 1],
			['https://doubleclick.net', 1, 1, 1]
		]);
		expect(report.rows[0]?.share).toBeCloseTo(2 / 6);
		expect(report.rows.map((r) => [r.class, r.remedy])).toEqual([
			['fonts', 'cache'],
			['analytics', 'defer'],
			['ads', 'network']
		]);
	});

	it('classifies by host suffix, longest first, and calls an unknown host unknown', () => {
		expect(classifyOrigin('https://fonts.googleapis.com')).toEqual({
			class: 'fonts',
			remedy: 'self-host'
		});
		expect(classifyOrigin('https://stats.g.doubleclick.net')).toEqual({
			class: 'ads',
			remedy: 'network'
		});
		expect(classifyOrigin('https://evildoubleclick.net')).toEqual({
			class: 'unknown',
			remedy: 'review'
		});
		expect(classifyOrigin('nonsense')).toEqual({ class: 'unknown', remedy: 'review' });
		expect(
			classifyOrigin('https://x.my.test', [
				{ suffix: 'my.test', class: 'cdn', remedy: 'cache' }
			])
		).toEqual({ class: 'cdn', remedy: 'cache' });
	});

	it('reports nothing for an empty stream', () => {
		expect(thirdPartyReport([])).toEqual({
			views: 0,
			reported: 0,
			clean: 0,
			blocked: 0,
			unnamed: 0,
			rows: []
		});
	});
});
