import { describe, expect, it } from 'vitest';
import { defineRoute } from '../../src/protocol/index';
import { installRoutes, staticRoutingRules } from '../../src/sw/routing';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { nav, ORIGIN, sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const routes = [
	defineRoute('/page/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{id}}</body></html>' },
		load: (ctx) => ({ id: ctx.params['id'] })
	}),
	defineRoute('/files/:name', { strategy: 'static' }),
	defineRoute('/api/:id', { strategy: 'data', load: () => ({}) })
];

const app: RigOptions['app'] = (request) => {
	const { pathname } = new URL(request.url);
	if (pathname === '/site.css') {
		return new Response('css', {
			headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
		});
	}
	if (pathname.startsWith('/page/')) {
		return new Response('<html><head></head><body>x</body></html>', { headers: HTML });
	}
	return new Response('missing', { status: 404, headers: HTML });
};

const config = (over: NonNullable<RigOptions['spool']> = {}) =>
	rig({ routes, app, spool: over }).spool.config;

function counted(): { storage: ReplicaStorage; calls: () => number } {
	const inner = memoryStorage();
	let calls = 0;
	const storage = new Proxy(inner, {
		get(target, name) {
			const value = Reflect.get(target, name) as unknown;
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				calls += 1;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		}
	});
	return { storage, calls: () => calls };
}

describe('assets: cache (the default)', () => {
	it('opens the asset cache once and reads no storage and makes no analytics check on a hit', async () => {
		const { storage, calls } = counted();
		const opened: string[] = [];
		const r = rig({ routes, app, storage });
		const caches = r.caches;
		const open = caches.open.bind(caches);
		caches.open = async (name) => {
			opened.push(name);
			return open(name);
		};
		const worker = r.make();
		await r.drive(sub('/site.css'), worker);
		expect(opened.filter((n) => n.startsWith('spool-assets-'))).toHaveLength(1);

		const before = calls();
		for (let i = 0; i < 20; i++) {
			expect(await (await r.drive(sub('/site.css'), worker)).text()).toBe('css');
		}
		expect(calls()).toBe(before);
		expect(opened.filter((n) => n.startsWith('spool-assets-'))).toHaveLength(1);
		expect(r.log.filter((l) => l === 'GET /site.css')).toHaveLength(1);
	});

	it('still sends the cursor on a cache miss, so the server can piggyback invalidations', async () => {
		const r = rig({ routes, app });
		await r.visit('/page/1');
		r.reset();
		await r.drive(sub('/uncached.js'));
		expect(r.log).toEqual(['GET /uncached.js']);
	});
});

describe('assets: passthrough', () => {
	const asPassthrough = () => rig({ routes, app, spool: { assets: 'passthrough' } });

	it('leaves a subresource to the browser cache and still handles navigations, beacons and routes', async () => {
		const r = asPassthrough();
		expect(r.runtime.handle(sub('/site.css'), () => undefined)).toBeUndefined();
		expect(r.runtime.handle(sub('/app.js'), () => undefined)).toBeUndefined();
		await r.visit('/page/1');
		r.reset();
		expect(await r.visit('/page/1')).toContain('<body>1</body>');
		expect(r.log).toEqual([]);
		expect(r.runtime.handle(sub('/api/x'), () => undefined)).toBeDefined();
		expect(r.runtime.handle(sub('/files/a'), () => undefined)).toBeDefined();
		expect(
			r.runtime.handle(sub('/cdn-cgi/rum', { method: 'POST', body: 'x' }), () => undefined)
		).toBeDefined();
	});

	it('reports the mode and that no routing took effect', async () => {
		const r = asPassthrough();
		expect(await r.runtime.message({ type: 'spool:assets' })).toEqual({
			type: 'spool:assets',
			mode: 'passthrough',
			routed: false
		});
		const plain = rig({ routes, app });
		expect(await plain.runtime.message({ type: 'spool:assets' })).toMatchObject({
			mode: 'cache'
		});
	});
});

describe('assets: static routing', () => {
	const rules = (over: NonNullable<RigOptions['spool']> = {}) =>
		staticRoutingRules(config({ assets: 'static-routing', ...over }), ORIGIN);

	it('sends navigations, the beacon and routed paths to the fetch event and the rest of the origin to the network', () => {
		expect(rules()).toEqual([
			{ condition: { requestMode: 'navigate' }, source: 'fetch-event' },
			{
				condition: { urlPattern: `${ORIGIN}/cdn-cgi/rum`, requestMethod: 'POST' },
				source: 'fetch-event'
			},
			{ condition: { urlPattern: `${ORIGIN}/files/:name` }, source: 'fetch-event' },
			{ condition: { urlPattern: `${ORIGIN}/api/:id` }, source: 'fetch-event' },
			{ condition: { urlPattern: `${ORIGIN}/*` }, source: 'network' }
		]);
	});

	it('adds logout paths, and cross-origin requests when collectors or a third-party cache are set', () => {
		const withLogout = rules({ logout: ['/logout'] });
		expect(withLogout).toContainEqual({
			condition: { urlPattern: `${ORIGIN}/logout` },
			source: 'fetch-event'
		});
		const cross = rules({ thirdParty: { allow: ['https://fonts.gstatic.com'] } });
		const at = cross.findIndex((rule) => 'not' in rule.condition);
		expect(cross[at]?.source).toBe('fetch-event');
		expect(cross[at + 1]?.source).toBe('network');
		expect(rules().some((rule) => 'not' in rule.condition)).toBe(false);
	});

	it('registers the rules at install where the browser has the API', async () => {
		const r = rig({ routes, app, spool: { assets: 'static-routing' } });
		const seen: unknown[] = [];
		await r.runtime.install({ addRoutes: async (list) => void seen.push(list) });
		expect(seen).toEqual([staticRoutingRules(r.spool.config, ORIGIN)]);
		expect(await r.runtime.message({ type: 'spool:assets' })).toMatchObject({
			mode: 'static-routing',
			routed: true
		});
	});

	it('acts as passthrough where the API is missing or refuses the rules', async () => {
		for (const event of [
			{},
			{
				addRoutes: async () => {
					throw new TypeError('bad rule');
				}
			}
		]) {
			const r = rig({ routes, app, spool: { assets: 'static-routing' } });
			await r.runtime.install(event);
			expect(await r.runtime.message({ type: 'spool:assets' })).toMatchObject({
				routed: false
			});
			expect(r.runtime.handle(sub('/site.css'), () => undefined)).toBeUndefined();
		}
		expect(await installRoutes({}, config(), ORIGIN)).toBe(false);
	});

	it('does not ask for routing in another mode', async () => {
		const r = rig({ routes, app });
		const seen: unknown[] = [];
		await r.runtime.install({ addRoutes: async (list) => void seen.push(list) });
		expect(seen).toEqual([]);
	});
});

describe('hot path before the routes load', () => {
	it('still waits for a manifest worker to know its routes before it sorts a request', async () => {
		const r = rig({ routes: [], app });
		const worker = r.make({ config: { ...r.spool.config, manifest: `${ORIGIN}/spool.json` } });
		expect(worker.handle(nav('/page/1'), () => undefined)).toBeDefined();
	});
});
