import { describe, expect, it } from 'vitest';
import {
	defineRoute,
	equivalent,
	injectClientTag,
	placeholder,
	viewsWithLoads,
	type SwConfig
} from '../../src/protocol/index';
import { createSpool, memorySink, viewsOf } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { renderLocal } from '../../src/sw/render';
import { classify } from '../../src/sw/router';
import { createRuntime } from '../../src/sw/runtime';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { artifact, fakeCaches, nav, ORIGIN, sub } from './helpers';

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const body = (id: string) => `<html><head></head><body>${id}</body></html>`;
const tpl = { source: '<html><head></head><body>{{id}}</body></html>' };
const dep = (ctx: { params: Record<string, string> }) => [`node:${ctx.params['id']}`];
const load = (ctx: { params: Record<string, string> }) => ({ id: ctx.params['id'] });

const routes = [
	defineRoute('/soft/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'soft' }
	}),
	defineRoute('/hard/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'hard' }
	}),
	defineRoute('/strict/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'hard' },
		offline: 'refuse'
	}),
	defineRoute('/volatile/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		persist: false
	}),
	defineRoute('/page/:slug', {
		strategy: 'assembly',
		depends: () => ['menu'],
		load: (ctx) => ({
			shell: `<html><head></head><body>${placeholder('nav')}${ctx.params['slug']}</body></html>`,
			fragments: { nav: '<nav></nav>' }
		})
	}),
	defineRoute('/badpage', {
		strategy: 'assembly',
		load: () => ({ shell: `<html><body>${placeholder('missing')}</body></html>` })
	}),
	defineRoute('/acct', {
		strategy: 'template',
		scope: 'principal',
		template: { source: 'x' },
		load: () => ({})
	})
];

function rig(options: { storage?: ReplicaStorage; fetchWrap?: (r: Response) => Response } = {}) {
	const store = memoryStore();
	const sink = memorySink();
	const spool = createSpool({
		routes,
		store,
		sink,
		beacons: ['/cdn-cgi/rum'],
		identity: {
			secret: 's',
			resolve: (r) => (r.headers.has('x-user') ? { principal: 'u' } : null)
		}
	});
	const log: string[] = [];
	let online = true;
	let gate: Promise<void> | null = null;
	const requests: Request[] = [];
	const received: Array<{ body: string; type: string | null; search: string }> = [];

	const app = async (request: Request): Promise<Response> => {
		const { pathname, search } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/cdn-cgi/rum') {
			received.push({
				body: await request.text(),
				type: request.headers.get('content-type'),
				search
			});
			return new Response(null, { status: 204 });
		}
		if (request.method === 'POST' && pathname === '/form') {
			await spool.invalidate(['node:1']);
			return new Response('saved');
		}
		const [, first, second] = pathname.split('/');
		if (['soft', 'hard', 'strict', 'volatile'].includes(first ?? '')) {
			return new Response(body(second ?? ''), { headers: HTML });
		}
		if (first === 'page') {
			return new Response(`<html><head></head><body><nav></nav>${second}</body></html>`, {
				headers: HTML
			});
		}
		if (pathname === '/badpage' || pathname === '/acct') {
			return new Response(body(pathname), { headers: HTML });
		}
		if (pathname === '/site.css') {
			return new Response('css', {
				headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
			});
		}
		if (pathname === '/asset.js') {
			return new Response('js', {
				headers: { 'content-type': 'text/javascript', 'cache-control': 'public, immutable' }
			});
		}
		if (pathname === '/app.js') {
			return new Response('js', { headers: { 'cache-control': 'max-age=60' } });
		}
		if (pathname === '/aged.js') {
			return new Response('js', { headers: { age: '30' } });
		}
		return new Response('missing', { status: 404, headers: HTML });
	};

	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		const url = new URL(request.url);
		log.push(`${request.method} ${url.pathname}`);
		requests.push(request);
		if (!online) throw new TypeError('offline');
		if (gate && url.pathname === '/.spool/sync') await gate;
		const response = await spool.handle(request, app);
		return options.fetchWrap ? options.fetchWrap(response) : response;
	};

	let t = 1_700_000_000_000;
	const caches = fakeCaches();
	const storage = options.storage ?? memoryStorage();
	const make = (renderers?: Parameters<typeof createRuntime>[0]['renderers']) =>
		createRuntime({
			config: spool.config,
			storage,
			fetch: fetchImpl,
			caches,
			origin: ORIGIN,
			now: () => t,
			renderers
		});
	const runtime = make();

	async function drive(request: Request, target = runtime): Promise<Response> {
		const waited: Promise<unknown>[] = [];
		const pending = target.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('request was ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}

	return {
		spool,
		sink,
		store,
		log,
		requests,
		received,
		runtime,
		storage,
		caches,
		make,
		drive,
		advance: (seconds: number) => void (t += seconds * 1000),
		offline: (value: boolean) => void (online = !value),
		hold: () => {
			let release: () => void = () => {};
			gate = new Promise<void>((resolve) => (release = resolve));
			return () => {
				gate = null;
				release();
			};
		}
	};
}

const rum = (r: { received: Array<{ body: string }> }) => r.received;

const visit = async (r: ReturnType<typeof rig>, path: string) => {
	const response = await r.drive(nav(path));
	return response.text();
};

describe('a route served from the replica', () => {
	it('goes to the network on first sight, provisions the artifact once, then makes 0 requests', async () => {
		const r = rig();
		const first = await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'GET /.spool/artifact']);
		expect(await r.runtime.replica.ids()).toEqual(['/soft/1']);

		r.log.length = 0;
		const second = await visit(r, '/soft/1');
		expect(r.log).toEqual([]);
		expect(equivalent(second, first).equal).toBe(true);
		expect(second).toContain('data-spool-client');
	});

	it('renders the same page locally as the network does, for template and assembly routes', async () => {
		const r = rig();
		for (const path of ['/soft/9', '/page/about']) {
			const network = await visit(r, path);
			r.log.length = 0;
			const local = await visit(r, path);
			expect(r.log).toEqual([]);
			const verdict = equivalent(local, network);
			expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
		}
	});

	it('shares one artifact request between two first visits at once', async () => {
		const r = rig();
		await Promise.all([visit(r, '/soft/5'), visit(r, '/soft/5')]);
		expect(r.log.filter((l) => l === 'GET /.spool/artifact')).toHaveLength(1);
	});

	it('does not provision a route the server did not describe, or a failed page', async () => {
		const r = rig();
		await visit(r, '/nothing');
		await visit(r, '/soft');
		expect(r.log).toEqual(['GET /nothing', 'GET /soft']);
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('leaves a principal route to the network', async () => {
		const r = rig();
		await r.drive(nav('/acct', { headers: { 'x-user': 'u' } }));
		await r.drive(nav('/acct', { headers: { 'x-user': 'u' } }));
		expect(r.log).toEqual(['GET /acct', 'GET /acct']);
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('falls back to the network when the local render is refused', async () => {
		const r = rig();
		await visit(r, '/badpage');
		r.log.length = 0;
		const html = await visit(r, '/badpage');
		expect(r.log).toEqual(['GET /badpage']);
		expect(html).toContain('/badpage');
	});

	it('serves a persist:false artifact until the worker restarts', async () => {
		const r = rig();
		await visit(r, '/volatile/1');
		r.log.length = 0;
		await visit(r, '/volatile/1');
		expect(r.log).toEqual([]);
		const restarted = r.make();
		await r.drive(nav('/volatile/1'), restarted);
		expect(r.log).toEqual(['GET /volatile/1', 'GET /.spool/artifact']);
	});

	it('uses a custom renderer for its route pattern', async () => {
		const r = rig();
		const custom = r.make({ '/soft/:id': (a) => `<p>custom ${JSON.stringify(a.body)}</p>` });
		await r.drive(nav('/soft/3'), custom);
		const html = await (await r.drive(nav('/soft/3'), custom)).text();
		expect(html).toContain('custom {"data":{"id":"3"}}');
	});
});

describe('hard freshness', () => {
	it('past the bound, shows nothing until a required sync completes, then shows the local page', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.log.length = 0;
		r.advance(61);

		const release = r.hold();
		let shown = false;
		const pending = r.drive(nav('/hard/1')).then((response) => {
			shown = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(shown).toBe(false);
		expect(r.log).toEqual(['GET /.spool/sync']);

		release();
		const html = await (await pending).text();
		expect(html).toContain('1');
		expect(r.log).toEqual(['GET /.spool/sync']);
	});

	it('past the bound, a sync that reports a change drops the artifact and the network answers', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		await r.spool.invalidate(['node:1']);
		r.log.length = 0;
		r.advance(61);
		await visit(r, '/hard/1');
		expect(r.log).toEqual(['GET /.spool/sync', 'GET /hard/1', 'GET /.spool/artifact']);

		r.log.length = 0;
		await visit(r, '/hard/1');
		expect(r.log).toEqual([]);
	});

	it('syncs once for a burst of navigations past the bound', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		await visit(r, '/hard/2');
		r.log.length = 0;
		r.advance(61);
		await Promise.all([visit(r, '/hard/1'), visit(r, '/hard/2'), visit(r, '/hard/1')]);
		expect(r.log).toEqual(['GET /.spool/sync']);
	});

	it('stays local, with no sync, inside the bound', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.log.length = 0;
		r.advance(60);
		await visit(r, '/hard/1');
		expect(r.log).toEqual([]);
	});

	it('serves the stale page when the sync fails and the route allows offline', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.advance(61);
		r.offline(true);
		const html = await visit(r, '/hard/1');
		expect(html).toContain('1');
	});

	it('refuses the stale page when the sync fails and the route says refuse', async () => {
		const r = rig();
		await visit(r, '/strict/1');
		r.advance(61);
		r.offline(true);
		await expect(visit(r, '/strict/1')).rejects.toThrow('offline');
		r.offline(false);
		r.log.length = 0;
		await visit(r, '/strict/1');
		expect(r.log).toEqual(['GET /.spool/sync']);
	});
});

describe('soft freshness', () => {
	it('past the bound, shows the local page and makes exactly one sync', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(61);
		const html = await visit(r, '/soft/1');
		expect(html).toContain('1');
		expect(r.log).toEqual(['GET /.spool/sync']);

		await visit(r, '/soft/1');
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /.spool/sync']);
	});

	it('shows the stale page one last time when that sync reports a change, then goes to the network', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.spool.invalidate(['node:1']);
		r.log.length = 0;
		r.advance(61);
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /.spool/sync']);
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /.spool/sync', 'GET /soft/1', 'GET /.spool/artifact']);
	});

	it('survives a failed background sync', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.advance(61);
		r.offline(true);
		expect(await visit(r, '/soft/1')).toContain('1');
	});
});

describe('beacons', () => {
	const post = (body: string, type = 'application/json') =>
		sub('/cdn-cgi/rum', { method: 'POST', body, headers: { 'content-type': type } });

	it('queues them with 0 requests and sends them in one flush on the next network moment', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		for (const n of [1, 2, 3, 4]) {
			const response = await r.drive(post(`{"n":${n}}`));
			expect(response.status).toBe(204);
		}
		await visit(r, '/soft/1');
		expect(r.log).toEqual([]);

		await visit(r, '/soft/2');
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toHaveLength(1);
		expect(r.log.filter((l) => l === 'POST /cdn-cgi/rum')).toHaveLength(4);
		expect(rum(r).map((e) => e.body)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
		expect(r.received.every((e) => e.type === 'application/json')).toBe(true);
		expect(r.received.every((e) => e.search === '')).toBe(true);
		expect(r.sink.events.some((e) => e.path === '/cdn-cgi/rum')).toBe(false);
		expect(viewsOf(r.sink.events).map((v) => v.reason)).toEqual(['cold', 'fresh', 'cold']);
	});

	it('keeps them when the flush fails and sends them on a later moment', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.drive(post('{"n":1}'));
		const write = () => sub('/form', { method: 'POST', body: 'x' });
		r.offline(true);
		await visit(r, '/soft/1');
		await r.drive(write()).catch(() => undefined);
		expect(r.sink.events).toEqual([]);

		r.offline(false);
		await r.drive(write());
		expect(rum(r)).toHaveLength(1);
	});

	it('does not treat a cacheable GET as a network moment, since the HTTP cache may answer it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.drive(post('{"n":1}'));
		r.log.length = 0;
		await r.drive(sub('/app.js'));
		expect(r.log).toEqual(['GET /app.js']);
		expect(r.sink.events).toEqual([]);
	});

	it('sends a binary beacon straight to the network', async () => {
		const r = rig();
		await r.drive(post('x', 'application/octet-stream'));
		expect(r.log).toEqual(['POST /cdn-cgi/rum']);
	});

	it('sends a held beacon on its own once it is a day old', async () => {
		const r = rig();
		await r.drive(post('{"n":1}'));
		r.advance(25 * 60 * 60);
		await r.drive(nav('/soft/1'));
		expect(r.log.filter((l) => l === 'POST /cdn-cgi/rum')).toHaveLength(1);
		expect(rum(r).map((e) => e.body)).toEqual(['{"n":1}']);
	});
});

describe('subresources', () => {
	it('serves an immutable asset from the cache after the first fetch', async () => {
		const r = rig();
		for (const path of ['/site.css', '/asset.js']) {
			await r.drive(sub(path));
			r.log.length = 0;
			expect(await (await r.drive(sub(path))).text()).not.toBe('');
			expect(r.log).toEqual([]);
		}
	});

	it('does not cache a short-lived asset, a Range request, or a failure', async () => {
		const r = rig();
		await r.drive(sub('/app.js'));
		await r.drive(sub('/app.js'));
		await r.drive(sub('/asset.js', { headers: { range: 'bytes=0-1' } }));
		await r.drive(sub('/asset.js', { headers: { range: 'bytes=0-1' } }));
		await r.drive(sub('/gone'));
		await r.drive(sub('/gone'));
		expect(r.log).toEqual([
			'GET /app.js',
			'GET /app.js',
			'GET /asset.js',
			'GET /asset.js',
			'GET /gone',
			'GET /gone'
		]);
	});

	it('lets the browser handle cross-origin requests', () => {
		const r = rig();
		expect(r.runtime.handle(new Request('https://other.test/x.js'), () => {})).toBeUndefined();
	});
});

describe('piggybacked sync', () => {
	it('evicts stale artifacts and moves the cursor from a response to a request that was happening anyway', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await visit(r, '/page/a');
		const syncedBefore = r.runtime.replica.syncedAt;
		await r.spool.invalidate(['node:1']);
		r.advance(10);

		await r.drive(sub('/app.js'));
		const request = r.requests[r.requests.length - 1] as Request;
		expect(request.headers.get('spool-vector-seen')).toBe('0');
		expect(r.runtime.replica.cursor).toBe(1);
		expect(r.runtime.replica.syncedAt).toBeGreaterThan(syncedBefore);
		expect(await r.runtime.replica.ids()).toEqual(['/page/a']);
	});

	it('applies the invalidation but does not extend freshness when the response is aged', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-vector')) headers.set('age', '30');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		const syncedBefore = r.runtime.replica.syncedAt;
		await r.spool.invalidate(['node:1']);
		r.advance(10);
		await r.drive(sub('/app.js'));
		expect(await r.runtime.replica.ids()).toEqual([]);
		expect(r.runtime.replica.syncedAt).toBe(syncedBefore);
	});

	it('learns of a write the app made while answering it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(await r.runtime.replica.ids()).toEqual([]);
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['POST /form', 'GET /soft/1', 'GET /.spool/artifact']);
	});

	it('ignores spool headers from another protocol version', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-protocol')) headers.set('spool-protocol', '2');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('ignores malformed spool headers', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-protocol')) headers.set('spool-vector', 'junk');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});
});

describe('the runtime itself', () => {
	it('falls back to the network when its storage fails', async () => {
		const broken: ReplicaStorage = {
			...memoryStorage(),
			getMeta: async () => {
				throw new Error('quota');
			}
		};
		const r = rig({ storage: broken });
		const html = await visit(r, '/soft/1');
		expect(html).toContain('1');
		expect(r.log).toContain('GET /soft/1');
	});

	it('wipes the replica when the runtime version changes', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const next = createRuntime({
			config: { ...r.spool.config, version: 'next' } as SwConfig,
			storage: r.storage,
			fetch: async () => new Response('x'),
			caches: r.caches,
			origin: ORIGIN
		});
		await next.activate();
		expect(await next.replica.ids()).toEqual([]);
	});

	it('drops asset caches from older versions on activate and keeps its own', async () => {
		const r = rig();
		await r.caches.open('spool-assets-old');
		await r.caches.open('unrelated');
		await r.drive(sub('/site.css'));
		await r.runtime.activate();
		expect(r.caches.names().sort()).toEqual([
			`spool-assets-${r.spool.config.version}`,
			'unrelated'
		]);
	});

	it('answers the version handshake and the status request, and ignores other messages', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		expect(await r.runtime.message({ type: 'spool:hello', protocol: 1 })).toEqual({
			type: 'spool:hello',
			protocol: 1,
			version: r.spool.config.version,
			compatible: true
		});
		expect(await r.runtime.message({ type: 'spool:hello', protocol: 9 })).toMatchObject({
			compatible: false
		});
		expect(await r.runtime.message({ type: 'spool:status' })).toEqual({
			type: 'spool:status',
			cursor: 0,
			syncedAt: 0,
			artifacts: ['/soft/1'],
			beacons: 1
		});
		expect(await r.runtime.message({ type: 'other' })).toBeUndefined();
		expect(await r.runtime.message(null)).toBeUndefined();
	});
});

describe('the view id and the loads report', () => {
	it('gives the page the id of its latest view and queues its report against it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const reply = (await r.runtime.message({ type: 'spool:view', path: '/soft/1' })) as {
			id: string | null;
		};
		expect(reply.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await r.runtime.message({ type: 'spool:view', path: '/never' })).toEqual({
			type: 'spool:view',
			id: null
		});
		expect(await r.runtime.message({ type: 'spool:view', path: 5 })).toEqual({
			type: 'spool:view',
			id: null
		});

		expect(
			await r.runtime.message({ type: 'spool:loads', view: reply.id, count: 2 })
		).toBeUndefined();
		await r.runtime.message({ type: 'spool:loads', view: 5, count: 2 });
		await r.runtime.message({ type: 'spool:loads', view: 'x', count: 'many' });
		const held = (await r.storage.readBeacons()).map((b) => b.event);
		const views = viewsWithLoads(held);
		expect(views.map((v) => [v.id, v.crossOriginLoads])).toEqual([[reply.id, 2]]);
		expect(held.filter((e) => e.path === '/.spool/loads')).toHaveLength(1);
	});

	it('names each view differently and the newest wins for a path', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await visit(r, '/soft/1');
		const ids = (await r.storage.readBeacons()).map((b) => JSON.parse(b.event.body).id);
		expect(new Set(ids).size).toBe(2);
		const latest = (await r.runtime.message({ type: 'spool:view', path: '/soft/1' })) as {
			id: string;
		};
		expect(latest.id).toBe(ids[1]);
	});

	it('does not queue a report when views are off', async () => {
		const r = rig();
		const off = createRuntime({
			config: { ...r.spool.config, views: false } as SwConfig,
			storage: r.storage,
			fetch: async () => new Response('x'),
			caches: r.caches,
			origin: ORIGIN
		});
		await off.message({ type: 'spool:loads', view: 'v', count: 1 });
		expect(await r.storage.readBeacons()).toEqual([]);
	});

	it('does not count a loads report as another site beacon when deciding to flush', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.runtime.message({ type: 'spool:loads', view: 'v', count: 1 });
		r.log.length = 0;
		await visit(r, '/soft/1');
		await visit(r, '/soft/2');
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toEqual([]);
	});
});

describe('defensive paths', () => {
	it('drops an artifact that is stored but already outdated, and asks the network', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.spool.invalidate(['node:1']);
		r.advance(61);
		await r.runtime.replica.applySync({
			protocol: 1,
			cursor: 1,
			changed: { 'node:1': 1 },
			dropped: [],
			reset: false
		});
		await r.storage.putArtifact({
			artifact: artifact({ id: '/soft/1', vector: 0 }),
			fetchedAt: 1
		});
		r.log.length = 0;
		await visit(r, '/soft/1');
		expect(r.log[0]).toBe('GET /soft/1');
		expect(await r.runtime.replica.get('/soft/1')).toBeDefined();
	});

	it('still answers when a background task fails', async () => {
		let saves = 0;
		const base = memoryStorage();
		const flaky: ReplicaStorage = {
			...base,
			setMeta: async (meta) => {
				if (saves++ > 0) throw new Error('quota');
				return base.setMeta(meta);
			}
		};
		const r = rig({ storage: flaky });
		expect(await visit(r, '/soft/1')).toContain('1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('sends a request unchanged when the cursor header cannot be added', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const hostile = sub('/app.js');
		Object.defineProperty(hostile, 'headers', {
			get() {
				throw new TypeError('locked');
			}
		});
		expect(await (await r.drive(hostile)).text()).toBe('js');
	});
});

describe('classify', () => {
	const config = rig().spool.config;
	it('sorts requests', () => {
		expect(classify(config, new Request('https://other.test/'), ORIGIN).kind).toBe('ignore');
		expect(classify(config, sub('/cdn-cgi/rum', { method: 'POST' }), ORIGIN).kind).toBe(
			'beacon'
		);
		expect(classify(config, sub('/other', { method: 'POST' }), ORIGIN).kind).toBe('pass');
		expect(classify(config, sub('/app.js'), ORIGIN).kind).toBe('asset');
		expect(classify(config, nav('/nowhere'), ORIGIN).kind).toBe('pass');
		const hit = classify(config, nav('/soft/4'), ORIGIN);
		expect(hit).toMatchObject({ kind: 'navigation', path: '/soft/4', params: { id: '4' } });
	});

	it('never answers a query string from a path artifact', () => {
		expect(classify(config, nav('/soft/4?page=2'), ORIGIN).kind).toBe('pass');
		const data = {
			...config,
			routes: [
				...config.routes,
				{
					pattern: '/api/:id',
					strategy: 'data' as const,
					scope: 'public' as const,
					freshness: { maxStale: 60, mode: 'soft' as const },
					persist: true,
					offline: 'serve' as const,
					sync: 'background' as const
				}
			]
		};
		expect(classify(data, sub('/api/1'), ORIGIN).kind).toBe('data');
		expect(classify(data, sub('/api/1?q=x'), ORIGIN).kind).toBe('asset');
	});
});

describe('renderLocal', () => {
	const config = rig().spool.config;
	const route = (pattern: string) => config.routes.find((x) => x.pattern === pattern)!;
	const tagged = (html: string) => injectClientTag(html, config.clientTag);

	it('renders a template artifact and tags it', async () => {
		const result = await renderLocal(
			config,
			route('/soft/:id'),
			artifact({ body: { data: { id: 'z' } } })
		);
		expect(result).toEqual({ ok: true, html: tagged(body('z')) });
	});

	it('renders an assembly artifact', async () => {
		const result = await renderLocal(
			config,
			route('/page/:slug'),
			artifact({
				strategy: 'assembly',
				body: { shell: `<body>${placeholder('a')}</body>`, fragments: { a: 'A' } }
			})
		);
		expect(result).toEqual({ ok: true, html: tagged('<body>A</body>') });
	});

	it('refuses an unfilled assembly, a strategy mismatch and a missing template', async () => {
		const unfilled = await renderLocal(
			config,
			route('/page/:slug'),
			artifact({ strategy: 'assembly', body: { shell: placeholder('a') } })
		);
		expect(unfilled.ok).toBe(false);
		const mismatch = await renderLocal(config, route('/page/:slug'), artifact());
		expect(mismatch).toEqual({ ok: false, reason: 'artifact is template, route is assembly' });
		const noTemplate = await renderLocal(
			{ ...config, templates: {} },
			route('/soft/:id'),
			artifact()
		);
		expect(noTemplate).toEqual({ ok: false, reason: 'no template for /soft/:id' });
	});

	it('refuses when a custom renderer throws, with its message or a default', async () => {
		const thrown = await renderLocal(config, route('/soft/:id'), artifact(), {
			'/soft/:id': () => {
				throw new Error('nope');
			}
		});
		expect(thrown).toEqual({ ok: false, reason: 'nope' });
		const odd = await renderLocal(config, route('/soft/:id'), artifact(), {
			'/soft/:id': () => {
				throw 'text';
			}
		});
		expect(odd).toEqual({ ok: false, reason: 'render failed' });
	});

	it('prefers a custom renderer, even for an artifact of another strategy', async () => {
		const result = await renderLocal(config, route('/page/:slug'), artifact(), {
			'/page/:slug': () => '<p>mine</p>'
		});
		expect(result).toEqual({ ok: true, html: tagged('<p>mine</p>') });
	});
});
