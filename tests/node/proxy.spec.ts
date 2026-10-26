import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { toNodeListener } from '../../src/node/listener';
import { decodeEnvelope, parseArtifact, ProtocolError, shellHash } from '../../src/protocol/index';
import {
	cookieNames,
	decline,
	equalSecrets,
	htmlCharset,
	isUtf8,
	pathTag,
	readTags,
	setsPrivateCookie,
	spoolProxy,
	stripTags,
	TRIM_PATH,
	type Candidate,
	type ProxyOptions
} from '../../src/proxy/index';
import { memorySink } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { createRuntime } from '../../src/sw/runtime';
import { memoryStorage } from '../../src/sw/storage';
import { buildTrimManifest } from '../../src/trim/index';
import { closeServers, fakeOrigin, HTML, listen, type Reply } from './exercise';
import { fakeCaches, nav } from './helpers';

const HOST = 'https://site.test';
const ORIGIN = 'https://origin.test';
const PAGE = '<!doctype html><html><head><title>t</title></head><body><p>body</p></body></html>';

function setup(over: Partial<ProxyOptions> = {}) {
	const origin = fakeOrigin();
	const store = memoryStore();
	const proxy = spoolProxy({
		origin: ORIGIN,
		spool: { store },
		fetch: origin.fetch,
		purgeSecret: 'hunter2',
		...over
	});
	origin.replies.set('/page', {
		body: PAGE,
		headers: { 'content-type': HTML, 'cache-tag': 't1,t2' }
	});
	const call = (path: string, init: RequestInit = {}) =>
		proxy(new Request(`${HOST}${path}`, init));
	return { ...origin, store, proxy, call };
}

const envelopeOf = (response: Response) => decodeEnvelope(response.headers);

describe('forwarding', () => {
	it('sends method, body and headers on, with the origin as host and the forwarded headers', async () => {
		const s = setup();
		s.replies.set('/form', { body: 'saved', headers: { 'content-type': 'text/plain' } });
		const response = await s.call('/form?x=1', {
			method: 'POST',
			body: 'a=b',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'x-custom': 'yes',
				connection: 'keep-alive',
				'spool-vector-seen': '4'
			}
		});
		expect(await response.text()).toBe('saved');
		const [hit] = s.hits;
		expect(hit?.request.method).toBe('POST');
		expect(hit?.body).toBe('a=b');
		expect(hit?.request.url).toBe(`${ORIGIN}/form?x=1`);
		expect(hit?.request.headers.get('x-custom')).toBe('yes');
		expect(hit?.request.headers.get('x-forwarded-host')).toBe('site.test');
		expect(hit?.request.headers.get('x-forwarded-proto')).toBe('https');
		expect(hit?.request.headers.has('connection')).toBe(false);
		expect(hit?.request.headers.has('spool-vector-seen')).toBe(false);
	});

	it('never decorates or answers a write', async () => {
		const s = setup();
		const response = await s.call('/page', { method: 'POST', body: 'x' });
		expect(response.headers.has('spool-artifact')).toBe(false);
		expect(response.headers.has('spool-protocol')).toBe(false);
		expect(await response.text()).toBe(PAGE);
		expect(s.hits).toHaveLength(1);
	});

	it('tells the worker to clear what it holds when any response sets a cookie', async () => {
		const s = setup();
		s.replies.set('/login', {
			status: 303,
			headers: { location: '/page', 'set-cookie': 'SESS=1; Path=/' }
		});
		const write = await s.call('/login', { method: 'POST', body: 'u=a' });
		expect(write.status).toBe(303);
		expect(write.headers.get('spool-clear')).toBe('*');
		expect(write.headers.get('set-cookie')).toBe('SESS=1; Path=/');
		s.replies.set('/hello', {
			body: PAGE,
			headers: { 'content-type': HTML, 'set-cookie': 'a=1' }
		});
		expect((await s.call('/hello')).headers.get('spool-clear')).toBe('*');
		expect((await s.call('/page')).headers.has('spool-clear')).toBe(false);
	});

	it('answers /.spool/* and the worker script without asking the origin', async () => {
		const s = setup();
		expect((await s.call('/spool-sw.js')).headers.get('content-type')).toContain('javascript');
		expect((await s.call('/.spool/sync?from=0')).status).toBe(200);
		expect((await s.call('/.spool/nothing')).status).toBe(404);
		expect(s.hits).toHaveLength(0);
	});

	it('passes a redirect on, with the origin host rewritten and nothing followed', async () => {
		const s = setup();
		s.replies.set('/old', { status: 302, headers: { location: `${ORIGIN}/page?a=1#z` } });
		s.replies.set('/away', { status: 301, headers: { location: 'https://other.test/x' } });
		s.replies.set('/rel', { status: 302, headers: { location: '/page' } });
		const old = await s.call('/old');
		expect(old.status).toBe(302);
		expect(old.headers.get('location')).toBe(`${HOST}/page?a=1#z`);
		expect((await s.call('/away')).headers.get('location')).toBe('https://other.test/x');
		expect((await s.call('/rel')).headers.get('location')).toBe('/page');
		expect(s.hits.map((h) => new URL(h.request.url).pathname)).toEqual([
			'/old',
			'/away',
			'/rel'
		]);
		expect(s.hits.every((h) => h.request.redirect === 'manual')).toBe(true);
	});

	it('answers 502 when the origin cannot be reached', async () => {
		const s = setup({
			fetch: async () => {
				throw new TypeError('connect ECONNREFUSED');
			}
		});
		const response = await s.call('/page');
		expect(response.status).toBe(502);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect((await s.call('/spool-sw.js')).status).toBe(200);
	});

	it('refuses an origin with a path and a bad limit', () => {
		const base = { spool: { store: memoryStore() } };
		expect(() => spoolProxy({ ...base, origin: 'https://o.test/base' })).toThrow(ProtocolError);
		expect(() => spoolProxy({ ...base, origin: 'https://o.test', maxTags: 0 })).toThrow(
			/maxTags/
		);
		expect(() => spoolProxy({ ...base, origin: 'https://o.test', maxBytes: 1.5 })).toThrow(
			/maxBytes/
		);
		expect(() => spoolProxy({ ...base, origin: 'https://o.test', maxRemembered: 0 })).toThrow(
			/maxRemembered/
		);
		expect(() =>
			spoolProxy({
				...base,
				origin: 'https://o.test',
				routes: [{ pattern: '/me', scope: 'principal' }]
			})
		).toThrow(/needs spool.identity/);
	});
});

describe('eligibility', () => {
	const declined: Array<[string, RequestInit, Reply, string | null]> = [
		['a cookie', { headers: { cookie: 'SESS=1' } }, {}, 'cookie'],
		[
			'one cookie off the allowlist beside an allowed one',
			{ headers: { cookie: 'ok=1; SESS=1' } },
			{},
			'cookie'
		],
		['Authorization', { headers: { authorization: 'Basic eDp5' } }, {}, 'authorization'],
		[
			'Set-Cookie',
			{},
			{ headers: { 'content-type': HTML, 'set-cookie': 'a=1' } },
			'set-cookie'
		],
		[
			'private',
			{},
			{ headers: { 'content-type': HTML, 'cache-control': 'max-age=60, private' } },
			'private'
		],
		[
			'a qualified private',
			{},
			{ headers: { 'content-type': HTML, 'cache-control': 'private="set-cookie"' } },
			'private'
		],
		[
			'no-store',
			{},
			{ headers: { 'content-type': HTML, 'cache-control': 'No-Store' } },
			'no-store'
		],
		[
			'Vary: Accept-Language',
			{},
			{ headers: { 'content-type': HTML, vary: 'Accept-Encoding, Accept-Language' } },
			'vary'
		],
		['Vary: *', {}, { headers: { 'content-type': HTML, vary: '*' } }, 'vary'],
		['a 404', {}, { status: 404, headers: { 'content-type': HTML } }, 'status'],
		['a 302', {}, { status: 302, headers: { location: '/x' } }, 'status'],
		[
			'a JSON body on an HTML route',
			{},
			{ headers: { 'content-type': 'application/json' } },
			'type'
		],
		[
			'more tags than the limit',
			{},
			{ headers: { 'content-type': HTML, 'cache-tag': 'a,b,c,d' } },
			'tags'
		],
		[
			'a body past the limit',
			{},
			{ headers: { 'content-type': HTML, 'content-length': '999' } },
			'size'
		]
	];

	it.each(declined)(
		'declines %s and tells the worker to drop its copy',
		async (_name, init, reply, why) => {
			const s = setup({ publicCookies: ['ok'], maxTags: 3, maxBytes: 500 });
			s.replies.set('/p', { body: PAGE, ...reply });
			const response = await s.call('/p', init);
			expect(response.headers.has('spool-artifact'), why ?? '').toBe(false);
			expect(response.headers.get('spool-vector')).toBeNull();
			const html = reply.headers?.['content-type'] === HTML || reply.headers === undefined;
			const page = (reply.status ?? 200) === 200 && html;
			const drop = response.headers.get('spool-invalidate');
			if (page) expect(drop).toContain(encodeURIComponent('spool:artifact:/p'));
			else expect(drop).toBeNull();
			expect(await response.text()).not.toContain('data-spool-client');
		}
	);

	it('declines a page that ends up past maxBytes after it is read', async () => {
		const s = setup({ maxBytes: 20 });
		const response = await s.call('/page');
		expect(response.headers.has('spool-artifact')).toBe(false);
		expect(response.headers.get('spool-invalidate')).toContain('artifact');
		expect(await response.text()).toBe(PAGE);
	});

	it('declines a query string without a drop, so the plain page keeps its copy', async () => {
		const s = setup();
		const response = await s.call('/page?utm=1');
		expect(response.headers.has('spool-artifact')).toBe(false);
		expect(response.headers.has('spool-invalidate')).toBe(false);
	});

	it('passes no hop-by-hop header of the origin on, whatever the page is', async () => {
		const s = setup();
		const hops = {
			connection: 'keep-alive',
			'keep-alive': 'timeout=5',
			'transfer-encoding': 'chunked',
			te: 'trailers',
			upgrade: 'h2c'
		};
		s.replies.set('/hop', { body: PAGE, headers: { 'content-type': HTML, ...hops } });
		s.replies.set('/a.css', {
			body: 'a{}',
			headers: { 'content-type': 'text/css', ...hops }
		});
		for (const path of ['/hop', '/a.css']) {
			const response = await s.call(path);
			for (const name of Object.keys(hops)) {
				expect(response.headers.has(name), `${path} ${name}`).toBe(false);
			}
			expect(response.headers.get('content-type')).toContain(
				path === '/hop' ? 'html' : 'css'
			);
		}
	});

	it('declines a non-HTML asset without a drop', async () => {
		const s = setup();
		s.replies.set('/a.css', { body: 'a{}', headers: { 'content-type': 'text/css' } });
		const response = await s.call('/a.css');
		expect(response.headers.has('spool-artifact')).toBe(false);
		expect(response.headers.has('spool-invalidate')).toBe(false);
	});

	it('keeps a GET and a HEAD', async () => {
		const s = setup();
		const get = await s.call('/page');
		expect(envelopeOf(get).artifact).toMatchObject({ id: '/page', scope: 'public' });
		expect(await get.text()).toContain('data-spool-client');
		const head = await s.call('/page', { method: 'HEAD' });
		expect(envelopeOf(head).artifact?.id).toBe('/page');
	});

	it('keeps a page whose cookies are all on the allowlist, and a Vary on encoding and cookies', async () => {
		const s = setup({ publicCookies: ['consent', 'lang'] });
		s.replies.set('/p', {
			body: PAGE,
			headers: { 'content-type': HTML, vary: 'Accept-Encoding, Cookie' }
		});
		const response = await s.call('/p', { headers: { cookie: 'consent=1; lang=en' } });
		expect(envelopeOf(response).artifact?.id).toBe('/p');
	});

	it('keeps a page that sends max-age with public and no-cache', async () => {
		const s = setup();
		s.replies.set('/p', {
			body: PAGE,
			headers: { 'content-type': HTML, 'cache-control': 'public, max-age=60, no-cache' }
		});
		expect(envelopeOf(await s.call('/p')).artifact?.id).toBe('/p');
	});

	it('keeps a data route and refuses other bodies on it', async () => {
		const s = setup({
			routes: [
				{ pattern: '/api/:id', strategy: 'data', provision: { reuse: 1, futureViews: 10 } }
			]
		});
		s.replies.set('/api/1', {
			body: '{"a":1}',
			headers: { 'content-type': 'application/json', 'cache-tag': 'api:1' }
		});
		const response = await s.call('/api/1');
		expect(envelopeOf(response).artifact?.deps).toEqual(['api:1']);
		expect(await response.text()).toBe('{"a":1}');
		const artifact = await s.call('/.spool/artifact?path=/api/1');
		expect(parseArtifact(await artifact.json())).toMatchObject({
			strategy: 'data',
			body: { data: { a: 1 } }
		});
		s.replies.set('/api/2', {
			body: 'not json',
			headers: { 'content-type': 'application/json' }
		});
		const broken = await s.call('/.spool/artifact?path=/api/2');
		expect(broken.status).toBe(400);
		expect(await broken.text()).toContain('no JSON');
	});

	describe('principal routes', () => {
		const identity = {
			secret: 'k',
			resolve: (request: Request) => {
				const who = /who=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1];
				return who ? { principal: who } : null;
			}
		};
		const make = () => {
			const s = setup({
				spool: { store: memoryStore(), identity },
				routes: [{ pattern: '/me', scope: 'principal' }]
			});
			s.replies.set('/me', {
				body: PAGE,
				headers: { 'content-type': HTML, 'cache-control': 'private', 'cache-tag': 'user:7' }
			});
			return s;
		};

		it('keeps a signed-in visitor despite the cookie and private, with a partition', async () => {
			const s = make();
			const response = await s.call('/me', { headers: { cookie: 'who=ann' } });
			const envelope = envelopeOf(response);
			expect(envelope.artifact).toMatchObject({
				id: '/me',
				scope: 'principal',
				deps: ['user:7']
			});
			expect(envelope.partition).toBe(await s.proxy.spool.partition('ann'));
		});

		it('still refuses Set-Cookie and no-store, and a visitor identity does not resolve', async () => {
			const s = make();
			s.replies.set('/me', {
				body: PAGE,
				headers: { 'content-type': HTML, 'set-cookie': 'x=1' }
			});
			expect(
				envelopeOf(await s.call('/me', { headers: { cookie: 'who=ann' } })).artifact
			).toBeUndefined();
			s.replies.set('/me', {
				body: PAGE,
				headers: { 'content-type': HTML, 'cache-control': 'no-store' }
			});
			expect(
				envelopeOf(await s.call('/me', { headers: { cookie: 'who=ann' } })).artifact
			).toBeUndefined();
			s.replies.set('/me', { body: PAGE });
			expect(
				envelopeOf(await s.call('/me', { headers: { cookie: 'who=' } })).artifact
			).toBeUndefined();
		});

		it('builds a principal artifact for the signed-in visitor only, and never hashes it', async () => {
			const s = make();
			const mine = await s.call('/.spool/artifact?path=/me', {
				headers: { cookie: 'who=ann' }
			});
			expect(mine.status).toBe(200);
			expect(mine.headers.get('cache-control')).toContain('no-store');
			expect((await s.call('/.spool/artifact?path=/me')).status).toBe(401);
			s.replies.set('/me', {
				body: `${PAGE}<i>changed</i>`,
				headers: { 'content-type': HTML, 'cache-tag': 'user:7' }
			});
			await s.call('/me', { headers: { cookie: 'who=ann' } });
			expect(await s.store.cursor()).toBe(0);
		});
	});
});

describe('the pure verdict', () => {
	const gate = { publicCookies: new Set(['ok']), maxTags: 2, maxBytes: 10 };
	const candidate = (over: Partial<Candidate> = {}): Candidate => ({
		method: 'GET',
		search: '',
		requestHeaders: new Headers(),
		response: new Response('x', { headers: { 'content-type': 'text/html' } }),
		tags: [],
		data: false,
		principal: false,
		...over
	});

	it('names the method, and reads cookie names and directives as the specification says', () => {
		expect(decline(candidate(), gate)).toBeNull();
		expect(decline(candidate({ method: 'POST' }), gate)).toBe('method');
		expect(decline(candidate({ method: 'DELETE' }), gate)).toBe('method');
		expect(cookieNames(null)).toEqual([]);
		expect(cookieNames('')).toEqual([]);
		expect(cookieNames('a=1; b; ; c=x=y')).toEqual(['a', 'b', 'c']);
	});

	it('lets a principal route past the cookie, Authorization and private rules only', () => {
		const requestHeaders = new Headers({ cookie: 's=1', authorization: 'x' });
		const response = new Response('x', {
			headers: { 'content-type': 'text/html', 'cache-control': 'private' }
		});
		expect(decline(candidate({ requestHeaders, response }), gate)).toBe('authorization');
		expect(decline(candidate({ requestHeaders, response, principal: true }), gate)).toBeNull();
		const stored = new Response('x', {
			headers: { 'content-type': 'text/html', 'cache-control': 'private, no-store' }
		});
		expect(decline(candidate({ response: stored, principal: true }), gate)).toBe('no-store');
	});

	it('declines a page whose header names a charset other than UTF-8', () => {
		const page = (type: string) =>
			candidate({ response: new Response('x', { headers: { 'content-type': type } }) });
		expect(decline(page('text/html; charset=windows-1252'), gate)).toBe('charset');
		expect(decline(page('text/html; charset="ISO-8859-1"'), gate)).toBe('charset');
		expect(decline(page('text/html; charset=UTF-8'), gate)).toBeNull();
		expect(decline(page('text/html'), gate)).toBeNull();
		expect(
			decline(
				candidate({
					data: true,
					response: new Response('x', {
						headers: { 'content-type': 'application/json; charset=latin1' }
					})
				}),
				gate
			)
		).toBeNull();
	});

	it('reads a charset from the header first, then a meta tag in the first 1024 bytes', () => {
		const bytes = (text: string) => new TextEncoder().encode(text);
		const none = new Headers({ 'content-type': 'text/html' });
		expect(
			htmlCharset(
				new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
				bytes('<meta charset="iso-8859-1">')
			)
		).toBe('utf-8');
		expect(htmlCharset(none, bytes('<meta charset="ISO-8859-1">'))).toBe('iso-8859-1');
		expect(
			htmlCharset(
				none,
				bytes('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">')
			)
		).toBe('windows-1252');
		expect(
			htmlCharset(none, bytes(`${' '.repeat(1024)}<meta charset="iso-8859-1">`))
		).toBeNull();
		expect([null, 'utf-8', 'utf8'].map(isUtf8)).toEqual([true, true, true]);
		expect(isUtf8('windows-1252')).toBe(false);
	});
});

describe('tags', () => {
	const tagsOf = async (headers: Record<string, string>) => {
		const s = setup();
		s.replies.set('/p', { body: PAGE, headers: { 'content-type': HTML, ...headers } });
		return envelopeOf(await s.call('/p')).artifact?.deps;
	};

	it('reads Cache-Tag as commas, trimming the spaces around them', async () => {
		expect(await tagsOf({ 'cache-tag': 'a, b ,c,,d,' })).toEqual(['a', 'b', 'c', 'd']);
	});

	it('reads Surrogate-Key and X-Drupal-Cache-Tags as spaces', async () => {
		expect(await tagsOf({ 'surrogate-key': 'node/1  menu\tfooter' })).toEqual([
			'node/1',
			'menu',
			'footer'
		]);
		expect(
			await tagsOf({ 'x-drupal-cache-tags': 'node:1 config:system.menu.main rendered' })
		).toEqual(['node:1', 'config:system.menu.main', 'rendered']);
	});

	it('reads xkey as spaces or commas or both', async () => {
		expect(await tagsOf({ xkey: 'a b,c, d' })).toEqual(['a', 'b', 'c', 'd']);
	});

	it('splits a space-separated header that arrived on two lines and joined with a comma', () => {
		const headers = new Headers();
		headers.append('surrogate-key', 'a b');
		headers.append('surrogate-key', 'c d');
		expect(readTags(headers)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('merges the four headers without repeats', async () => {
		expect(
			await tagsOf({
				'cache-tag': 'a,b',
				'surrogate-key': 'b c',
				'x-drupal-cache-tags': 'c d',
				xkey: 'd,e'
			})
		).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('gives a page with no tags one tag from its path', async () => {
		expect(await tagsOf({})).toEqual([pathTag('/p')]);
		expect(pathTag('/p')).toBe('proxy:path:/p');
	});

	it('strips the headers from the browser unless exposeTags is set', async () => {
		const all = {
			'cache-tag': 'a',
			'surrogate-key': 'a',
			'x-drupal-cache-tags': 'a',
			xkey: 'a'
		};
		const hidden = setup();
		hidden.replies.set('/p', { body: PAGE, headers: { 'content-type': HTML, ...all } });
		const response = await hidden.call('/p');
		for (const name of Object.keys(all)) expect(response.headers.has(name)).toBe(false);
		const shown = setup({ exposeTags: true });
		shown.replies.set('/p', { body: PAGE, headers: { 'content-type': HTML, ...all } });
		const open = await shown.call('/p');
		for (const name of Object.keys(all)) expect(open.headers.get(name)).toBe('a');
		const headers = new Headers(all);
		stripTags(headers);
		expect([...headers.keys()]).toEqual([]);
	});

	it('keeps a page that sets only allowlisted cookies, and clears for any other', async () => {
		const s = setup({ publicCookies: ['__cf_bm'] });
		s.replies.set('/bot', {
			body: PAGE,
			headers: { 'content-type': HTML, 'set-cookie': '__cf_bm=x; Path=/' }
		});
		const kept = await s.call('/bot');
		expect(envelopeOf(kept).artifact).toBeDefined();
		expect(envelopeOf(kept).clear).toBeUndefined();
		s.replies.set('/login', {
			body: PAGE,
			headers: { 'content-type': HTML, 'set-cookie': 'SESS=1; Path=/' }
		});
		expect(envelopeOf(await s.call('/login')).clear).toEqual(['*']);
		const both = new Headers([
			['set-cookie', '__cf_bm=x; Path=/'],
			['set-cookie', 'SESS=1; Path=/']
		]);
		expect(setsPrivateCookie(both, new Set(['__cf_bm']))).toBe(true);
		expect(setsPrivateCookie(both, new Set(['__cf_bm', 'SESS']))).toBe(false);
	});

	it('strips them from a page the proxy declines too', async () => {
		const s = setup();
		s.replies.set('/p', {
			body: PAGE,
			headers: { 'content-type': HTML, 'cache-tag': 'a', 'set-cookie': 'x=1' }
		});
		expect((await s.call('/p')).headers.has('cache-tag')).toBe(false);
	});

	it('adds the tags a route declares to the origin ones', async () => {
		const s = setup({ routes: [{ pattern: '/page', depends: () => ['extra'] }] });
		expect(envelopeOf(await s.call('/page')).artifact?.deps).toEqual(['t1', 't2', 'extra']);
	});
});

describe('the artifact', () => {
	it('is the origin page as the shell, loaded once more with the visitor cookies and nothing else', async () => {
		const s = setup({ publicCookies: ['ok'] });
		const first = await s.call('/page');
		expect(await first.text()).toContain('data-spool-client');
		expect(s.hits).toHaveLength(1);
		const response = await s.call('/.spool/artifact?path=/page&have=', {
			headers: { cookie: 'ok=1', accept: '*/*' }
		});
		expect(s.hits).toHaveLength(2);
		const second = s.hits[1];
		expect(second?.request.url).toBe(`${ORIGIN}/page`);
		expect(second?.request.headers.get('accept')).toBe('text/html');
		expect(second?.request.headers.get('cookie')).toBe('ok=1');
		const artifact = parseArtifact(await response.json());
		expect(artifact).toMatchObject({
			id: '/page',
			scope: 'public',
			strategy: 'assembly',
			deps: ['t1', 't2']
		});
		expect(artifact.strategy === 'assembly' && artifact.body.shell).toBe(PAGE);
	});

	it('refuses to build one for a visitor with a session cookie, or a page that is not kept', async () => {
		const s = setup();
		const cookie = await s.call('/.spool/artifact?path=/page', {
			headers: { cookie: 'SESS=1' }
		});
		expect(cookie.status).toBe(400);
		expect(await cookie.text()).toContain('not kept (cookie)');
		s.replies.set('/big', {
			body: PAGE,
			headers: { 'content-type': HTML, 'content-length': '5000000' }
		});
		expect((await s.call('/.spool/artifact?path=/big')).status).toBe(400);
		const small = setup({ maxBytes: 10 });
		small.replies.set('/lie', { body: 'x'.repeat(50) });
		expect(await (await small.call('/.spool/artifact?path=/lie')).text()).toContain('(size)');
	});

	it('is built from the same fetch the page view made, so a page view costs one origin request', async () => {
		const s = setup();
		await s.call('/page');
		await s.call('/page', { method: 'HEAD' });
		expect(s.hits).toHaveLength(2);
	});
});

describe('content change', () => {
	const change = (s: ReturnType<typeof setup>, path: string, body: string, tag: string) =>
		s.replies.set(path, { body, headers: { 'content-type': HTML, 'cache-tag': tag } });

	it('bumps the vector once, for that page tags only', async () => {
		const s = setup();
		change(s, '/a', '<p>a1</p>', 'ta');
		change(s, '/b', '<p>b1</p>', 'tb');
		await s.call('/a');
		await s.call('/b');
		await s.call('/a');
		expect(await s.store.cursor()).toBe(0);
		change(s, '/a', '<p>a2</p>', 'ta');
		const fresh = await s.call('/a');
		expect(await s.store.cursor()).toBe(1);
		expect(Object.keys((await s.store.diff(0)).changed)).toEqual(['ta']);
		expect(envelopeOf(fresh).artifact?.version).toBe(1);
		await s.call('/a');
		await s.call('/b');
		expect(await s.store.cursor()).toBe(1);
	});

	it('ignores whitespace, comments and the patterns it is told to ignore', async () => {
		const s = setup({ ignore: [/token=\w+/] });
		change(s, '/a', '<p>x</p> token=aaa', 'ta');
		await s.call('/a');
		change(s, '/a', '<!-- c -->\n<p>x</p>   token=bbb', 'ta');
		await s.call('/a');
		expect(await s.store.cursor()).toBe(0);
	});

	it('bumps the old and the new tags when the tag set changed with the body', async () => {
		const s = setup();
		change(s, '/a', '<p>1</p>', 'old');
		await s.call('/a');
		change(s, '/a', '<p>2</p>', 'new');
		await s.call('/a');
		expect(Object.keys((await s.store.diff(0)).changed).sort()).toEqual(['new', 'old']);
	});

	it('notices a change at the artifact fetch, and the artifact is then already stale', async () => {
		const s = setup();
		change(s, '/a', '<p>1</p>', 'ta');
		await s.call('/a');
		change(s, '/a', '<p>2</p>', 'ta');
		const artifact = parseArtifact(await (await s.call('/.spool/artifact?path=/a')).json());
		expect(await s.store.cursor()).toBe(1);
		expect(artifact.vector).toBe(0);
	});

	it('forgets the oldest page past maxRemembered, which then records afresh without a bump', async () => {
		const s = setup({ maxRemembered: 2 });
		for (const path of ['/a', '/b', '/c']) change(s, path, `<p>${path}1</p>`, `t${path}`);
		for (const path of ['/a', '/b', '/c']) await s.call(path);
		change(s, '/a', '<p>/a2</p>', 't/a');
		await s.call('/a');
		expect(await s.store.cursor()).toBe(0);
		change(s, '/c', '<p>/c2</p>', 't/c');
		await s.call('/c');
		expect(await s.store.cursor()).toBe(1);
	});

	it('does not hash a page the proxy declines', async () => {
		const s = setup();
		s.replies.set('/a', {
			body: '<p>1</p>',
			headers: { 'content-type': HTML, 'set-cookie': 'x=1' }
		});
		await s.call('/a');
		s.replies.set('/a', {
			body: '<p>2</p>',
			headers: { 'content-type': HTML, 'set-cookie': 'x=1' }
		});
		await s.call('/a');
		expect(await s.store.cursor()).toBe(0);
	});
});

describe('purge', () => {
	const purge = (s: ReturnType<typeof setup>, init: RequestInit = {}, path = '/.spool/purge') =>
		s.call(path, { method: 'POST', body: JSON.stringify({ tags: ['t1', 'x'] }), ...init });
	const bearer = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } });

	it('is refused when no secret is configured, even with a credential', async () => {
		const s = setup({ purgeSecret: undefined });
		expect((await purge(s)).status).toBe(403);
		expect((await purge(s, bearer('anything'))).status).toBe(403);
		expect(await s.store.cursor()).toBe(0);
	});

	it('is refused with no credential or a wrong one', async () => {
		const s = setup();
		const none = await purge(s);
		expect(none.status).toBe(401);
		expect(none.headers.get('www-authenticate')).toBe('Bearer');
		expect((await purge(s, bearer('hunter3'))).status).toBe(401);
		expect((await purge(s, bearer('hunter22'))).status).toBe(401);
		expect((await purge(s, { headers: { authorization: 'Basic aHVudGVyMg==' } })).status).toBe(
			401
		);
		expect(await s.store.cursor()).toBe(0);
	});

	it('bumps the vector once for the tags it names, with the right secret', async () => {
		const s = setup();
		const response = await purge(s, bearer('hunter2'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ vector: 1, tags: 2 });
		expect(Object.keys((await s.store.diff(0)).changed).sort()).toEqual(['t1', 'x']);
		expect(s.hits).toHaveLength(0);
	});

	it('takes only POST and a JSON body of 1 to 1000 tag strings', async () => {
		const s = setup();
		const send = (body: string, extra: RequestInit = {}) =>
			purge(s, { body, ...bearer('hunter2'), ...extra });
		expect((await s.call('/.spool/purge', bearer('hunter2'))).status).toBe(405);
		expect((await send('nope')).status).toBe(400);
		expect((await send('null')).status).toBe(400);
		expect((await send('{"tags":[]}')).status).toBe(400);
		expect((await send('{"tags":[1]}')).status).toBe(400);
		expect((await send('{"tags":[""]}')).status).toBe(400);
		expect((await send(JSON.stringify({ tags: ['x'.repeat(1025)] }))).status).toBe(400);
		const many = Array.from({ length: 1001 }, (_, i) => `t${i}`);
		expect((await send(JSON.stringify({ tags: many }))).status).toBe(400);
		expect((await send('x'.repeat(70_000))).status).toBe(413);
		const declared = {
			headers: { authorization: 'Bearer hunter2', 'content-length': '70000' }
		};
		expect((await send('x', declared)).status).toBe(413);
		expect(await s.store.cursor()).toBe(0);
		expect((await send('{"tags":["a","a"]}')).status).toBe(200);
		expect(await s.store.cursor()).toBe(1);
	});

	it('makes the next fetch of a purged page record afresh, so one edit bumps once', async () => {
		const s = setup();
		await s.call('/page');
		s.replies.set('/page', {
			body: `${PAGE}<i>edit</i>`,
			headers: { 'content-type': HTML, 'cache-tag': 't1,t2' }
		});
		await purge(s, bearer('hunter2'));
		await s.call('/page');
		expect(await s.store.cursor()).toBe(1);
	});

	it('compares secrets without trusting their length', async () => {
		expect(await equalSecrets('a', 'a')).toBe(true);
		expect(await equalSecrets('a', 'b')).toBe(false);
		expect(await equalSecrets('a', 'aa')).toBe(false);
		expect(await equalSecrets('', '')).toBe(true);
	});
});

describe('trimmed stylesheets', () => {
	const CSS = '.ok{a:b}\n.gone{c:d}';
	const LINK = '<link rel="stylesheet" href="/site.css">';
	const html = (cls: string) =>
		`<!doctype html><html><head>${LINK}</head><body class="${cls}"></body></html>`;
	const css = { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' };

	async function trimSetup(over: Partial<ProxyOptions> = {}) {
		const sink = memorySink();
		const trim = await buildTrimManifest({
			pages: [html('ok')],
			scripts: [],
			styles: [
				{ url: '/site.css', text: CSS },
				{ url: '/agg.css?delta=0&theme=t', text: CSS }
			]
		});
		const s = setup({ spool: { store: memoryStore(), sink }, trim, ...over });
		s.replies.set('/site.css', { body: CSS, headers: { ...css, etag: '"abc"' } });
		s.replies.set('/agg.css', { body: CSS, headers: css });
		s.replies.set('/ok', { body: html('ok') });
		s.replies.set('/gone', { body: html('gone') });
		return { ...s, sink, trim };
	}

	it('answers a stylesheet in the manifest with its trimmed text and keeps the caching headers', async () => {
		const s = await trimSetup();
		const response = await s.call('/site.css');
		expect(await response.text()).toBe('.ok{a:b}');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
		expect(response.headers.get('content-type')).toBe('text/css');
		expect(response.headers.get('etag')).toBe('W/"abc"');
		expect(response.headers.has('content-length')).toBe(false);
		expect({ ...s.proxy.trim }).toEqual({ served: 1, mismatched: 0, guarded: 0 });
	});

	it('keys a stylesheet by path and query', async () => {
		const s = await trimSetup();
		expect(await (await s.call('/agg.css?delta=0&theme=t')).text()).toBe('.ok{a:b}');
		expect(await (await s.call('/agg.css?delta=1&theme=t')).text()).toBe(CSS);
		expect(await (await s.call('/agg.css')).text()).toBe(CSS);
		expect(s.proxy.trim.served).toBe(1);
	});

	it('serves the origin file unchanged and counts it when its bytes no longer match', async () => {
		const s = await trimSetup();
		const changed = `${CSS}\n.new{e:f}`;
		s.replies.set('/site.css', { body: changed, headers: css });
		const response = await s.call('/site.css');
		expect(await response.text()).toBe(changed);
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
		expect({ ...s.proxy.trim }).toEqual({ served: 0, mismatched: 1, guarded: 0 });
		const [event] = s.sink.events;
		expect(event?.path).toBe(TRIM_PATH);
		expect(JSON.parse(event?.body as string)).toEqual({ kind: 'mismatch', file: '/site.css' });
	});

	it('serves the full file for spool-trim=0 and sends the origin the URL without it', async () => {
		const s = await trimSetup();
		const response = await s.call('/agg.css?delta=0&spool-trim=0&theme=t');
		expect(await response.text()).toBe(CSS);
		expect(s.hits.at(-1)?.request.url).toBe(`${ORIGIN}/agg.css?delta=0&theme=t`);
		expect({ ...s.proxy.trim }).toEqual({ served: 0, mismatched: 0, guarded: 0 });
	});

	it('never trims a response with no manifest entry, a HEAD, or a non-CSS body', async () => {
		const s = await trimSetup();
		s.replies.set('/other.css', { body: CSS, headers: css });
		expect(await (await s.call('/other.css')).text()).toBe(CSS);
		expect(await (await s.call('/site.css', { method: 'HEAD' })).text()).toBe(CSS);
		s.replies.set('/site.css', { body: CSS, headers: { 'content-type': 'text/plain' } });
		expect(await (await s.call('/site.css')).text()).toBe(CSS);
		s.replies.set('/site.css', { status: 404, body: 'none', headers: css });
		expect((await s.call('/site.css')).status).toBe(404);
		expect({ ...s.proxy.trim }).toEqual({ served: 0, mismatched: 0, guarded: 0 });
	});

	it('does nothing without a manifest', async () => {
		const s = setup();
		s.replies.set('/site.css', { body: CSS, headers: css });
		expect(await (await s.call('/site.css')).text()).toBe(CSS);
		expect({ ...s.proxy.trim }).toEqual({ served: 0, mismatched: 0, guarded: 0 });
	});

	it('leaves a page alone when none of its tokens is missing', async () => {
		const s = await trimSetup();
		const text = await (await s.call('/ok')).text();
		expect(text).toContain(LINK);
		expect(text).not.toContain('spool-trim');
		expect(s.proxy.trim.guarded).toBe(0);
	});

	it('points a page that needs a removed rule at the full file, and records it', async () => {
		const s = await trimSetup();
		const response = await s.call('/gone');
		const text = await response.text();
		expect(text).toContain('<link rel="stylesheet" href="/site.css?spool-trim=0">');
		expect(response.headers.has('content-length')).toBe(false);
		expect(s.proxy.trim.guarded).toBe(1);
		const [event] = s.sink.events;
		expect(event?.path).toBe(TRIM_PATH);
		expect(JSON.parse(event?.body as string)).toEqual({
			kind: 'guard',
			page: '/gone',
			reason: 'token',
			files: ['/site.css']
		});
	});

	it('guards a page the proxy does not keep, such as one with a query string or a cookie', async () => {
		const s = await trimSetup();
		const query = await (await s.call('/gone?page=2')).text();
		expect(query).toContain('href="/site.css?spool-trim=0"');
		const cookie = await (await s.call('/gone', { headers: { cookie: 'SESS=1' } })).text();
		expect(cookie).toContain('href="/site.css?spool-trim=0"');
		expect(s.proxy.trim.guarded).toBe(2);
	});

	it('guards a page that loads a script the manifest was not built with', async () => {
		const s = await trimSetup();
		s.replies.set('/scripted', {
			body: `<html><head>${LINK}<script src="/new.js"></script></head><body class="ok"></body></html>`
		});
		expect(await (await s.call('/scripted')).text()).toContain('href="/site.css?spool-trim=0"');
		expect(JSON.parse(s.sink.events[0]?.body as string).reason).toBe('script');
	});

	it('rewrites a page in another charset byte for byte and does not keep it', async () => {
		const s = await trimSetup();
		const latin = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
		const page = (link: string) =>
			`<html><head><meta charset="windows-1252">${link}</head><body class="gone">café \u0093x\u0094</body></html>`;
		s.replies.set('/latin', {
			body: latin(page(LINK)),
			headers: { 'content-type': 'text/html' }
		});
		const response = await s.call('/latin');
		const got = new Uint8Array(await response.arrayBuffer());
		expect([...got]).toEqual([
			...latin(page('<link rel="stylesheet" href="/site.css?spool-trim=0">'))
		]);
		expect(s.proxy.trim.guarded).toBe(1);
		const artifact = await s.call('/.spool/artifact?path=/latin&have=', {
			headers: { accept: '*/*' }
		});
		expect(artifact.status).not.toBe(200);
		expect(await artifact.text()).toContain('/latin is not kept (charset)');
	});

	it('builds the artifact shell from the guarded page', async () => {
		const s = await trimSetup();
		const response = await s.call('/.spool/artifact?path=/gone&have=', {
			headers: { accept: '*/*' }
		});
		const artifact = parseArtifact(await response.json());
		expect(artifact.strategy === 'assembly' && artifact.body.shell).toContain(
			'href="/site.css?spool-trim=0"'
		);
		expect(s.proxy.trim.guarded).toBe(1);
	});
});

describe('over a real origin', () => {
	afterEach(closeServers);

	it('decodes a compressed origin once, and passes its redirect without following it', async () => {
		const body = gzipSync(PAGE);
		const origin = createServer((req, res) => {
			if (req.url === '/moved') {
				res.writeHead(302, { location: `http://${req.headers.host}/page` });
				return res.end();
			}
			res.writeHead(200, {
				'content-type': HTML,
				'content-encoding': 'gzip',
				'content-length': body.length,
				'x-drupal-cache-tags': 'node:1 menu'
			});
			res.end(body);
		});
		const originUrl = await listen(origin);
		const proxy = spoolProxy({ origin: originUrl, spool: { store: memoryStore() } });
		const front = await listen(createServer(toNodeListener((request) => proxy(request))));

		const direct = await proxy(
			new Request(`${HOST}/page`, { headers: { 'accept-encoding': 'gzip' } })
		);
		expect(direct.headers.has('content-encoding')).toBe(false);
		expect(direct.headers.has('content-length')).toBe(false);
		expect(await direct.text()).toContain('<p>body</p>');
		expect(envelopeOf(direct).artifact?.deps).toEqual(['node:1', 'menu']);

		const page = await fetch(`${front}/page`);
		expect(page.headers.has('content-encoding')).toBe(false);
		const html = await page.text();
		expect(html).toContain('<p>body</p>');
		expect(html).toContain('data-spool-client');
		expect(html.match(/data-spool-client/g)).toHaveLength(1);

		const moved = await fetch(`${front}/moved`, { redirect: 'manual' });
		expect(moved.status).toBe(302);
		expect(moved.headers.get('location')).toBe(`${front}/page`);
	});

	it('streams a write to the origin intact', async () => {
		let seen = '';
		const origin = createServer((req, res) => {
			req.on('data', (chunk) => (seen += chunk));
			req.on('end', () => {
				res.writeHead(201, { 'content-type': 'text/plain' });
				res.end('made');
			});
		});
		const originUrl = await listen(origin);
		const proxy = spoolProxy({ origin: originUrl, spool: { store: memoryStore() } });
		const front = await listen(createServer(toNodeListener((request) => proxy(request))));
		const response = await fetch(`${front}/things`, { method: 'PUT', body: 'payload' });
		expect(response.status).toBe(201);
		expect(await response.text()).toBe('made');
		expect(seen).toBe('payload');
	});
});

describe('the first payload', () => {
	const T0 = 1_700_000_000_000;

	/** a proxy and a worker runtime on one logged fetch; `wrap` rewrites the proxy's page responses */
	function payload(
		over: Partial<ProxyOptions> = {},
		wrap?: (response: Response) => Response | Promise<Response>
	) {
		const s = setup(over);
		const artifactRequests: string[] = [];
		const fetchImpl = async (input: Request | string, init?: RequestInit) => {
			const request = new Request(input as string, init);
			const { pathname, search } = new URL(request.url);
			if (pathname === '/.spool/artifact') artifactRequests.push(search);
			const response = await s.proxy(request);
			const own = pathname.startsWith('/.spool/') || pathname === '/spool-sw.js';
			return wrap && !own ? wrap(response) : response;
		};
		const runtime = createRuntime({
			config: s.proxy.spool.config,
			storage: memoryStorage(),
			fetch: fetchImpl,
			caches: fakeCaches(),
			origin: HOST,
			now: () => T0
		});
		const drive = async (request: Request) => {
			const waited: Promise<unknown>[] = [];
			const pending = runtime.handle(request, (p) => void waited.push(p));
			if (!pending) throw new Error('request was ignored');
			const response = await pending;
			await Promise.all(waited);
			return response;
		};
		const built = async (path: string) =>
			parseArtifact(await (await s.call(`/.spool/artifact?path=${path}`)).json());
		return { ...s, runtime, artifactRequests, drive, built };
	}

	const rebody = (response: Response, body: BodyInit, headers: Record<string, string> = {}) => {
		const next = new Headers(response.headers);
		next.delete('content-length');
		for (const [name, value] of Object.entries(headers)) next.set(name, value);
		return new Response(body, { status: response.status, headers: next });
	};

	const MEDIA =
		'<!doctype html><html><head><title>m</title></head><body><video src="a.mp4"></video>' +
		'<iframe src="https://www.youtube.com/embed/abc123"></iframe></body></html>';

	it('names the hash of the shell without the client tag', async () => {
		const s = setup();
		const response = await s.call('/page');
		const hash = envelopeOf(response).artifact?.hash;
		expect(hash).toBe(await shellHash(PAGE));
		const tagged = await response.text();
		expect(tagged).not.toBe(PAGE);
		expect(tagged.replace(s.proxy.spool.config.clientTag, '')).toBe(PAGE);
		expect(await shellHash(tagged.replace(s.proxy.spool.config.clientTag, ''))).toBe(hash);
	});

	it('names no hash for a data route, a principal route, a decline or a HEAD', async () => {
		const s = setup({
			routes: [{ pattern: '/api/**', strategy: 'data' }],
			spool: {
				store: memoryStore(),
				identity: {
					secret: 's',
					resolve: (r) => (r.headers.has('x-user') ? { principal: 'u' } : null)
				}
			}
		});
		s.replies.set('/api/x', {
			body: '{"a":1}',
			headers: { 'content-type': 'application/json', 'cache-tag': 'x' }
		});
		const data = await s.call('/api/x');
		expect(envelopeOf(data).artifact?.id).toBe('/api/x');
		expect(envelopeOf(data).artifact?.hash).toBeUndefined();
		expect(
			envelopeOf(await s.call('/page', { method: 'HEAD' })).artifact?.hash
		).toBeUndefined();
		s.replies.set('/p', {
			body: PAGE,
			headers: { 'content-type': HTML, 'cache-control': 'private' }
		});
		expect(envelopeOf(await s.call('/p')).artifact).toBeUndefined();
		expect(envelopeOf(await s.call('/page?x=1')).artifact).toBeUndefined();
	});

	it('names the hash only for a public assembly route when a principal route exists', async () => {
		const s = setup({
			routes: [{ pattern: '/me', scope: 'principal' }],
			spool: {
				store: memoryStore(),
				identity: {
					secret: 's',
					resolve: (r) => (r.headers.has('cookie') ? { principal: 'u' } : null)
				}
			}
		});
		s.replies.set('/me', { body: PAGE, headers: { 'content-type': HTML, 'cache-tag': 'me' } });
		const signed = await s.call('/me', { headers: { cookie: 'SESS=1' } });
		expect(envelopeOf(signed).artifact).toMatchObject({ id: '/me', scope: 'principal' });
		expect(envelopeOf(signed).artifact?.hash).toBeUndefined();
		expect(envelopeOf(await s.call('/page')).artifact?.hash).toBeDefined();
	});

	it('keeps the navigation page as the artifact and asks the origin for it once', async () => {
		const s = payload();
		const first = await (await s.drive(nav('/page'))).text();
		expect(s.hits.map((h) => new URL(h.request.url).pathname)).toEqual(['/page']);
		expect(s.artifactRequests).toEqual([]);
		const stored = await s.runtime.replica.get('/page');
		expect(stored?.artifact).toEqual(await s.built('/page'));
		expect(s.runtime.ledger.entries()).toMatchObject([
			{ id: '/page', bytes: 0, requests: 0, views: 0 }
		]);

		s.hits.length = 0;
		const second = await (await s.drive(nav('/page'))).text();
		expect(s.hits).toHaveLength(0);
		expect(s.artifactRequests).toEqual([]);
		expect(second).toBe(first);
		expect(s.runtime.ledger.entries()).toMatchObject([{ id: '/page', views: 1 }]);
	});

	const fixtures: Array<[string, Partial<ProxyOptions>, string, Reply]> = [
		['a page with tags', {}, '/page', {}],
		['a page with no tags', {}, '/plain', { body: PAGE }],
		[
			'a route that adds a tag',
			{ routes: [{ pattern: '/news/:id', depends: () => ['extra', 't1'] }] },
			'/news/7',
			{ body: PAGE, headers: { 'content-type': HTML, 'cache-tag': 't1,t2,t1' } }
		],
		[
			'a page the video and embed rewrites change',
			{ video: {}, embeds: {} },
			'/media',
			{ body: MEDIA }
		],
		[
			'a page in a shell the guard leaves alone',
			{ ignore: [/t1/] },
			'/ignored',
			{ body: PAGE.replace('body', 'body t1') }
		]
	];

	it.each(fixtures)(
		'stores what /.spool/artifact returns for %s',
		async (_name, over, path, reply) => {
			const s = payload(over);
			s.replies.set(path, {
				headers: { 'content-type': HTML },
				...reply
			});
			const view = await (await s.drive(nav(path))).text();
			expect(s.hits).toHaveLength(1);
			expect(s.artifactRequests).toEqual([]);
			const stored = await s.runtime.replica.get(path);
			expect(stored).toBeDefined();
			expect(stored?.artifact).toEqual(await s.built(path));
			if (path === '/media') {
				expect(view).toContain('preload="none"');
				expect(view).toContain('srcdoc');
			}
		}
	);

	const fallbacks: Array<[string, (response: Response) => Promise<Response> | Response]> = [
		[
			'a body that does not match the hash',
			async (r) => rebody(r, (await r.text()).replace('body', 'bodz'))
		],
		[
			'a header with no hash',
			(r) =>
				rebody(r, r.body as ReadableStream, {
					'spool-artifact': (r.headers.get('spool-artifact') as string).replace(
						/; h=[\w-]+/,
						''
					)
				})
		],
		[
			'a compressed body',
			async (r) =>
				rebody(r, gzipSync(await r.text()), {
					'content-encoding': 'gzip'
				})
		],
		[
			'a body in another charset',
			async (r) =>
				rebody(
					r,
					Uint8Array.from(Buffer.from((await r.text()).replace('body', 'bédy'), 'latin1'))
				)
		]
	];

	it.each(fallbacks)('asks for the artifact once after %s', async (_name, wrap) => {
		const s = payload({}, wrap);
		await s.drive(nav('/page'));
		expect(s.hits.map((h) => new URL(h.request.url).pathname)).toEqual(['/page', '/page']);
		expect(s.artifactRequests).toEqual(['?path=%2Fpage']);
		const stored = await s.runtime.replica.get('/page');
		expect(stored?.artifact).toEqual(await s.built('/page'));
		expect(s.runtime.ledger.entries()).toMatchObject([{ id: '/page', requests: 1 }]);
		expect((s.runtime.ledger.entries()[0] as { bytes: number }).bytes).toBeGreaterThan(0);
	});

	it('asks for a page the origin answered for a signal that its copy lacks, and gets none', async () => {
		const s = payload({ video: { when: 'save-data' } });
		s.replies.set('/clip', { body: MEDIA });
		const saving = await s.drive(nav('/clip', { headers: { 'save-data': 'on' } }));
		expect(saving.headers.has('spool-artifact')).toBe(false);
		expect(await saving.text()).toContain('preload="none"');
		expect(s.artifactRequests).toEqual([]);
		expect(await s.runtime.replica.get('/clip')).toBeUndefined();

		const plain = await s.drive(nav('/clip'));
		expect(envelopeOf(plain).artifact?.hash).toBeDefined();
		expect(s.artifactRequests).toEqual([]);
		expect((await s.runtime.replica.get('/clip'))?.artifact).toEqual(await s.built('/clip'));
	});

	it('leaves a route in shadow mode to the beacon, as without the hash', async () => {
		const shadow = payload({ spool: { store: memoryStore(), mode: 'shadow' } });
		await shadow.drive(nav('/page'));
		expect(shadow.artifactRequests).toEqual([]);
		const withHash = shadow.hits.length;
		expect(withHash).toBe(2);
		expect((await shadow.runtime.replica.get('/page'))?.artifact.id).toBe('/page');
		const bare = payload({ spool: { store: memoryStore(), mode: 'shadow' } }, (r) =>
			rebody(r, r.body as ReadableStream, {
				'spool-artifact': (r.headers.get('spool-artifact') as string).replace(
					/; h=[\w-]+/,
					''
				)
			})
		);
		await bare.drive(nav('/page'));
		expect(bare.hits).toHaveLength(withHash);
		expect(await shadow.runtime.replica.get('/page')).toEqual(
			await bare.runtime.replica.get('/page')
		);
	});

	it('keeps nothing from a principal route a response advertises with a hash', async () => {
		const s = payload(
			{
				routes: [{ pattern: '/me', scope: 'principal' }],
				spool: {
					store: memoryStore(),
					identity: {
						secret: 's',
						resolve: (r) => (r.headers.has('cookie') ? { principal: 'u' } : null)
					}
				}
			},
			async (r) => {
				const text = await r.text();
				const shell = text.replace(/<script[^>]*data-spool-client[^>]*><\/script>/, '');
				const header = r.headers.get('spool-artifact') as string;
				return rebody(r, text, {
					'spool-artifact': `${header}; h=${await shellHash(shell)}`
				});
			}
		);
		s.replies.set('/me', { body: PAGE, headers: { 'content-type': HTML, 'cache-tag': 'me' } });
		await s.drive(nav('/me', { headers: { cookie: 'SESS=1' } }));
		expect(s.artifactRequests).toEqual([]);
		expect(await s.runtime.replica.get('/me')).toBeUndefined();
	});
});
