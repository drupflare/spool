import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	defineRoute,
	MANIFEST_SCHEMA,
	manifestRoutes,
	parseArtifact,
	parseManifest,
	type ManifestRoute
} from '../../src/protocol/index';
import { classify } from '../../src/sw/router';
import { createRuntime } from '../../src/sw/runtime';
import { manifestConfig } from '../../src/sw/serve';
import { matchesVersion, MAX_STATIC_BYTES, readCapped, replayHeaders } from '../../src/sw/static';
import { memoryStorage } from '../../src/sw/storage';
import { fakeCaches, nav, ORIGIN, sub } from './helpers';
import { HTML, rig } from './rig';

const PAGE = '<!doctype html><html><head><title>About</title></head><body>about 1</body></html>';
const CSP = "default-src 'self'";

describe('a static route on the server half', () => {
	const routes = [
		defineRoute('/about', {
			strategy: 'static',
			depends: () => ['site'],
			freshness: { maxStale: 60, mode: 'hard' }
		}),
		defineRoute('/site.css', { strategy: 'static', depends: () => ['site'] }),
		defineRoute('/big.bin', { strategy: 'static', depends: () => ['site'] }),
		defineRoute('/gone', { strategy: 'static', depends: () => ['site'] }),
		defineRoute('/moved', { strategy: 'static', depends: () => ['site'] })
	];
	let page = PAGE;
	const app = (request: Request) => {
		const { pathname } = new URL(request.url);
		if (pathname === '/about') {
			return new Response(page, {
				headers: { ...HTML, 'content-security-policy': CSP, vary: 'accept-encoding' }
			});
		}
		if (pathname === '/site.css') {
			return new Response('main{color:red}', { headers: { 'content-type': 'text/css' } });
		}
		if (pathname === '/big.bin') {
			return new Response(new Uint8Array(MAX_STATIC_BYTES + 1), {
				headers: { 'content-type': 'application/octet-stream' }
			});
		}
		if (pathname === '/moved') {
			return new Response(null, { status: 302, headers: { location: '/about' } });
		}
		return new Response('missing', { status: 404 });
	};

	it('answers the second view with no request and the same bytes and headers', async () => {
		page = PAGE;
		const r = rig({ routes, app });
		const first = await r.drive(nav('/about'));
		const network = await first.text();
		expect(network).toContain('about 1');
		expect(network).toContain('data-spool-client');
		expect(r.log).toContain('GET /about');
		r.reset();

		const second = await r.drive(nav('/about'));
		expect(await second.text()).toBe(network);
		expect(second.headers.get('content-type')).toContain('text/html');
		expect(second.headers.get('content-security-policy')).toBe(CSP);
		expect(second.headers.has('vary')).toBe(false);
		expect(r.log).toEqual([]);
	});

	it('keeps an asset fetched as a subresource', async () => {
		const r = rig({ routes, app });
		await r.drive(sub('/site.css'));
		r.reset();
		const again = await r.drive(sub('/site.css'));
		expect(await again.text()).toBe('main{color:red}');
		expect(again.headers.get('content-type')).toBe('text/css');
		expect(r.log).toEqual([]);
	});

	it('leaves a ranged request to the network', async () => {
		const r = rig({ routes, app });
		await r.drive(sub('/site.css'));
		r.reset();
		await r.drive(sub('/site.css', { headers: { range: 'bytes=0-3' } }));
		expect(r.log).toEqual(['GET /site.css']);
	});

	it('lists the stored file in the worker status', async () => {
		const r = rig({ routes, app });
		await r.drive(nav('/about'));
		await r.drive(nav('/about'));
		await r.runtime.message({ type: 'spool:status' });
		const status = await r.runtime.message({ type: 'spool:status' });
		expect(status).toMatchObject({ type: 'spool:status', artifacts: ['/about'] });
	});

	it('drops the stored file when a tag it depends on changes, past the hard bound', async () => {
		page = PAGE;
		const r = rig({ routes, app });
		await r.drive(nav('/about'));
		await r.drive(nav('/about'));
		page = PAGE.replace('about 1', 'about 2');
		await r.spool.invalidate(['site']);
		r.advance(61);
		r.reset();
		const fresh = await r.drive(nav('/about'));
		expect(await fresh.text()).toContain('about 2');
		expect(r.log).toContain('GET /about');
		expect(r.log.some((line) => line.startsWith('GET /.spool/sync'))).toBe(true);
		r.reset();
		await r.drive(nav('/about'));
		expect(r.log).toEqual([]);
	});

	it('keeps nothing for an error, a redirect or a file over the cap', async () => {
		const r = rig({ routes, app });
		await r.drive(sub('/gone'));
		await r.drive(sub('/moved'));
		const big = await r.drive(sub('/big.bin'));
		expect((await big.arrayBuffer()).byteLength).toBe(MAX_STATIC_BYTES + 1);
		const status = await r.runtime.message({ type: 'spool:status' });
		expect(status).toMatchObject({ artifacts: [] });
		r.reset();
		await r.drive(sub('/gone'));
		expect(r.log).toEqual(['GET /gone']);
	});

	it('is never sent as an artifact, and a worker in shadow still serves it', async () => {
		const r = rig({ routes, app, spool: { mode: 'shadow' } });
		const response = await r.spool.respond(
			new Request(`${ORIGIN}/.spool/artifact?path=/about`)
		);
		expect(response?.status).toBe(404);
		await r.drive(nav('/about'));
		r.reset();
		await r.drive(nav('/about'));
		expect(r.log).toEqual([]);
	});

	it('refuses the options a static route cannot honour', () => {
		expect(() =>
			defineRoute('/a', { strategy: 'static', scope: 'principal' } as never)
		).toThrow('always public');
		expect(() => defineRoute('/a', { strategy: 'static', persist: false } as never)).toThrow(
			'always kept'
		);
		expect(() => defineRoute('/a', { strategy: 'static', mode: 'shadow' } as never)).toThrow(
			'no mode'
		);
		expect(() => defineRoute('/a', { strategy: 'static', load: () => 1 } as never)).toThrow(
			'no load'
		);
		const route = defineRoute('/a', { strategy: 'static' });
		expect(route.scope).toBe('public');
		expect(route.freshness).toEqual({ maxStale: 900, mode: 'soft' });
		expect(route.load({} as never)).toBeUndefined();
	});
});

type Site = {
	files: Map<string, { body: string | Uint8Array; headers?: Record<string, string> }>;
	routes: ManifestRoute[];
};

const sha = (body: string, algorithm = 'sha256') =>
	`${algorithm}-${createHash(algorithm).update(body).digest('base64')}`;

function site(): Site {
	return {
		files: new Map([
			['/', { body: PAGE, headers: HTML }],
			['/app.js', { body: 'console.log(1)', headers: { 'content-type': 'text/javascript' } }]
		]),
		routes: [
			{ pattern: '/', strategy: 'static', version: sha(PAGE) },
			{ pattern: '/app.js', strategy: 'static', version: 'build-1' }
		]
	};
}

/** a worker with no server: a static site, its manifest and a clock the test moves */
function plain(world: Site = site()) {
	const log: string[] = [];
	const seen: Request[] = [];
	let online = true;
	let t = 1_700_000_000_000;
	const storage = memoryStorage();
	const caches = fakeCaches();
	const fetchImpl = async (input: Request | string, init?: RequestInit) => {
		const request = new Request(input as string, init);
		const { pathname } = new URL(request.url);
		log.push(`${request.method} ${pathname}`);
		seen.push(request);
		if (!online) throw new TypeError('offline');
		if (pathname === '/spool.json') {
			return new Response(JSON.stringify({ schema: MANIFEST_SCHEMA, routes: world.routes }), {
				headers: { 'content-type': 'application/json' }
			});
		}
		const file = world.files.get(pathname);
		if (!file) return new Response('missing', { status: 404 });
		return new Response(file.body as BodyInit, { headers: file.headers });
	};
	const make = () =>
		createRuntime({
			config: manifestConfig(`${ORIGIN}/spool-sw.js`),
			storage,
			fetch: fetchImpl,
			caches,
			origin: ORIGIN,
			now: () => t
		});
	let runtime = make();
	const drive = async (request: Request) => {
		const waited: Promise<unknown>[] = [];
		const pending = runtime.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	};
	return {
		world,
		log,
		seen,
		storage,
		caches,
		drive,
		visit: async (path: string) => (await drive(nav(path))).text(),
		advance: (seconds: number) => void (t += seconds * 1000),
		offline: (value: boolean) => void (online = !value),
		restart: () => void (runtime = make()),
		reset: () => void (log.length = 0),
		runtime: () => runtime
	};
}

describe('a static site with no server', () => {
	it('reads spool.json beside the worker script', () => {
		const config = manifestConfig('https://site.test/sub/spool-sw.js?x=1');
		expect(config.manifest).toBe('https://site.test/sub/spool.json');
		expect(config.views).toBe(false);
		expect(config.routes).toEqual([]);
	});

	it('answers a repeat page view and asset load with no request at all', async () => {
		const p = plain();
		expect(await p.visit('/')).toBe(PAGE);
		await p.drive(sub('/app.js'));
		expect(p.log).toEqual(['GET /spool.json', 'GET /', 'GET /app.js']);
		p.reset();

		expect(await p.visit('/')).toBe(PAGE);
		const js = await p.drive(sub('/app.js'));
		expect(await js.text()).toBe('console.log(1)');
		expect(js.headers.get('content-type')).toBe('text/javascript');
		expect(p.log).toEqual([]);
	});

	it('sends no spool header and makes no /.spool request', async () => {
		const p = plain();
		await p.visit('/');
		await p.drive(sub('/app.js'));
		await p.drive(sub('/other.css'));
		p.advance(7200);
		await p.visit('/');
		expect(p.log.some((line) => line.includes('/.spool/'))).toBe(false);
		expect(p.seen.every((request) => !request.headers.has('spool-vector-seen'))).toBe(true);
	});

	it('serves from the Cache after the worker restarts, without fetching spool.json', async () => {
		const p = plain();
		await p.visit('/');
		p.restart();
		p.reset();
		expect(await p.visit('/')).toBe(PAGE);
		expect(p.log).toEqual([]);
	});

	it('checks a sha256 version against the bytes', async () => {
		const p = plain();
		p.world.routes[0] = { pattern: '/', strategy: 'static', version: sha('something else') };
		await p.visit('/');
		p.reset();
		await p.visit('/');
		expect(p.log).toEqual(['GET /']);
	});

	it('accepts sha384 and sha512 versions', async () => {
		for (const algorithm of ['sha384', 'sha512']) {
			const p = plain();
			p.world.routes[0] = { pattern: '/', strategy: 'static', version: sha(PAGE, algorithm) };
			await p.visit('/');
			p.reset();
			await p.visit('/');
			expect(p.log, algorithm).toEqual([]);
		}
	});

	it('checks an entity tag version against the response', async () => {
		const good = plain();
		good.world.files.set('/', { body: PAGE, headers: { ...HTML, etag: 'W/"abc"' } });
		good.world.routes[0] = { pattern: '/', strategy: 'static', version: '"abc"' };
		await good.visit('/');
		good.reset();
		await good.visit('/');
		expect(good.log).toEqual([]);

		const wrong = plain();
		wrong.world.files.set('/', { body: PAGE, headers: { ...HTML, etag: '"zzz"' } });
		wrong.world.routes[0] = { pattern: '/', strategy: 'static', version: '"abc"' };
		await wrong.visit('/');
		wrong.reset();
		await wrong.visit('/');
		expect(wrong.log).toEqual(['GET /']);

		const none = plain();
		none.world.routes[0] = { pattern: '/', strategy: 'static', version: '"abc"' };
		await none.visit('/');
		none.reset();
		await none.visit('/');
		expect(none.log).toEqual(['GET /']);
	});

	it('picks up a changed file once spool.json changes, past the hard bound', async () => {
		const p = plain();
		p.world.routes[0] = {
			pattern: '/',
			strategy: 'static',
			version: sha(PAGE),
			freshness: { maxStale: 60, mode: 'hard' }
		};
		await p.visit('/');
		await p.visit('/');
		const next = PAGE.replace('about 1', 'about 2');
		p.world.files.set('/', { body: next, headers: HTML });
		p.world.routes[0] = {
			pattern: '/',
			strategy: 'static',
			version: sha(next),
			freshness: { maxStale: 60, mode: 'hard' }
		};
		p.reset();
		expect(await p.visit('/')).toBe(PAGE);
		expect(p.log).toEqual([]);

		p.advance(61);
		expect(await p.visit('/')).toBe(next);
		expect(p.log).toEqual(['GET /spool.json', 'GET /']);
		p.reset();
		expect(await p.visit('/')).toBe(next);
		expect(p.log).toEqual([]);
	});

	it('shows a soft file at once and revalidates after it', async () => {
		const p = plain();
		await p.visit('/');
		const next = PAGE.replace('about 1', 'about 2');
		p.world.files.set('/', { body: next, headers: HTML });
		p.world.routes[0] = { pattern: '/', strategy: 'static', version: sha(next) };
		p.advance(901);
		p.reset();
		expect(await p.visit('/')).toBe(PAGE);
		expect(p.log).toEqual(['GET /spool.json']);
		p.reset();
		expect(await p.visit('/')).toBe(next);
		expect(p.log).toEqual(['GET /']);
	});

	it('drops a file whose route left the manifest', async () => {
		const p = plain();
		p.world.routes[0] = {
			pattern: '/',
			strategy: 'static',
			version: sha(PAGE),
			freshness: { maxStale: 60, mode: 'hard' }
		};
		await p.visit('/');
		p.world.routes.splice(0, 1);
		p.advance(61);
		await p.visit('/');
		const status = await p.runtime().message({ type: 'spool:status' });
		expect(status).toMatchObject({ artifacts: [] });
	});

	it('refuses offline when the route says so and serves stale when it does not', async () => {
		const p = plain();
		p.world.routes[0] = {
			pattern: '/',
			strategy: 'static',
			version: sha(PAGE),
			freshness: { maxStale: 60, mode: 'hard' },
			offline: 'refuse'
		};
		p.world.routes[1] = {
			pattern: '/app.js',
			strategy: 'static',
			version: 'build-1',
			freshness: { maxStale: 60, mode: 'hard' }
		};
		await p.visit('/');
		await p.drive(sub('/app.js'));
		p.advance(61);
		p.offline(true);
		await expect(p.drive(nav('/'))).rejects.toThrow();
		const js = await p.drive(sub('/app.js'));
		expect(await js.text()).toBe('console.log(1)');
	});

	it('still passes pages through when the manifest cannot be fetched', async () => {
		const p = plain();
		p.offline(true);
		await expect(p.drive(nav('/'))).rejects.toThrow();
		p.offline(false);
		expect(await p.visit('/')).toBe(PAGE);
		p.reset();
		expect(await p.visit('/')).toBe(PAGE);
		expect(p.log).toEqual([]);
	});

	it('ignores a malformed manifest and keeps going on the network', async () => {
		const p = plain();
		p.world.routes = [{ pattern: 'nope', strategy: 'static', version: 'x' }];
		expect(await p.visit('/')).toBe(PAGE);
		p.reset();
		expect(await p.visit('/')).toBe(PAGE);
		expect(p.log).toContain('GET /');
	});

	it('leaves a path the manifest does not name to the network', async () => {
		const p = plain();
		p.world.files.set('/free.css', { body: 'x', headers: { 'content-type': 'text/css' } });
		await p.drive(sub('/free.css'));
		p.reset();
		await p.drive(sub('/free.css'));
		expect(p.log).toEqual(['GET /free.css']);
	});

	it('deletes the Cache of an older runtime on activation', async () => {
		const p = plain();
		await p.visit('/');
		await p.caches.open('spool-static-old');
		await p.runtime().activate();
		expect(p.caches.names().some((name) => name === 'spool-static-old')).toBe(false);
		expect(p.caches.names().some((name) => name === 'spool-static-static-1')).toBe(true);
	});
});

const manifest = (...routes: unknown[]) => ({ schema: MANIFEST_SCHEMA, routes: routes });
const route = (extra: Record<string, unknown> = {}) => ({
	pattern: '/about',
	strategy: 'static',
	version: 'v1',
	...extra
});

describe('the worker static helpers', () => {
	const config = {
		protocol: 1,
		version: 'x',
		routes: manifestRoutes(parseManifest(manifest(route()))),
		templates: {},
		beacons: [],
		clientTag: ''
	} as const;

	it('classifies a plain GET of a static path as a static load, a ranged one as an asset', () => {
		const get = (init: RequestInit = {}) => new Request('https://x.test/about', init);
		expect(classify(config as never, get(), 'https://x.test').kind).toBe('static');
		expect(
			classify(config as never, get({ headers: { range: 'bytes=0-1' } }), 'https://x.test')
				.kind
		).toBe('asset');
	});

	it('does not accept a static artifact from the wire', () => {
		expect(() =>
			parseArtifact({
				protocol: 1,
				id: '/about',
				scope: 'public',
				deps: [],
				vector: 0,
				strategy: 'static',
				body: { type: 'text/html', bytes: 1 }
			})
		).toThrow('unknown strategy');
	});

	it('replays the headers of the file and none of the transfer', () => {
		const out = replayHeaders(
			new Headers({
				'content-type': 'text/css',
				'content-security-policy': "default-src 'self'",
				'content-encoding': 'gzip',
				'content-length': '4',
				'set-cookie': 'a=b',
				vary: 'accept-encoding',
				age: '3',
				date: 'x'
			})
		);
		expect([...out.keys()].sort()).toEqual(['content-security-policy', 'content-type']);
	});

	it('reads a body up to the cap and refuses one over it', async () => {
		const body = new Uint8Array([1, 2, 3, 4]);
		expect(await readCapped(new Response(body), 4)).toEqual(body);
		expect(await readCapped(new Response(body), 3)).toBeNull();
		expect(await readCapped(new Response(null), 3)).toEqual(new Uint8Array());
		const announced = new Response(body, { headers: { 'content-length': '999' } });
		expect(await readCapped(announced, 10)).toBeNull();
	});

	it('checks a hash, a tag and a label', async () => {
		const bytes = new TextEncoder().encode('abc');
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		const good = `sha256-${btoa(String.fromCharCode(...digest))}`;
		expect(await matchesVersion(good, bytes, new Headers())).toBe(true);
		expect(await matchesVersion('sha256-AAAA', bytes, new Headers())).toBe(false);
		expect(await matchesVersion('"t"', bytes, new Headers({ etag: 'W/"t"' }))).toBe(true);
		expect(await matchesVersion('W/"t"', bytes, new Headers({ etag: '"t"' }))).toBe(true);
		expect(await matchesVersion('"t"', bytes, new Headers())).toBe(false);
		expect(await matchesVersion('build-7', bytes, new Headers())).toBe(true);
	});
});
