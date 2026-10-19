import { describe, expect, it } from 'vitest';
import { defineRoute, type TimedView } from '../../src/protocol/index';
import { viewsOf } from '../../src/server/index';
import { VIEW_BATCH, VIEW_HOLD_MS } from '../../src/sw/analytics';
import type { ReplicaStorage } from '../../src/sw/storage';
import { nav, sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const body = (text: string) => `<html><head></head><body>${text}</body></html>`;
const template = { source: '<html><head></head><body>{{id}}</body></html>' };
const load = (ctx: { params: Record<string, string> }) => ({ id: ctx.params['id'] });
const depends = (ctx: { params: Record<string, string> }) => [`node:${ctx.params['id']}`];

const routes = [
	defineRoute('/soft/:id', {
		strategy: 'template',
		template,
		depends,
		load,
		freshness: { maxStale: 60, mode: 'soft' }
	}),
	defineRoute('/hard/:id', {
		strategy: 'template',
		template,
		depends,
		load,
		freshness: { maxStale: 60, mode: 'hard' }
	}),
	defineRoute('/diverge/:id', { strategy: 'template', template, depends, load }),
	defineRoute('/flaky/:id', { strategy: 'template', template, depends, load }),
	defineRoute('/acct', {
		strategy: 'template',
		scope: 'principal',
		template: { source: 'x' },
		load: () => ({})
	})
];

const gone = { flaky: false };

const app: RigOptions['app'] = (request) => {
	const { pathname } = new URL(request.url);
	const [, kind, id = ''] = pathname.split('/');
	const missing = new Response('missing', { status: 404, headers: HTML });
	if (id === '404' || (kind === 'flaky' && gone.flaky)) return missing;
	if (kind === 'soft' || kind === 'hard' || kind === 'flaky') {
		return new Response(body(id), { headers: HTML });
	}
	if (kind === 'diverge') return new Response(body(`stale ${id}`), { headers: HTML });
	if (pathname === '/acct') return new Response(body('acct'), { headers: HTML });
	if (pathname === '/form') return new Response('saved');
	if (pathname === '/app.js')
		return new Response('js', { headers: { 'cache-control': 'no-store' } });
	return new Response('missing', { status: 404, headers: HTML });
};

const held = async (storage: ReplicaStorage): Promise<TimedView[]> =>
	viewsOf((await storage.readBeacons()).map((b) => b.event));

const make = (spool: RigOptions['spool'] = {}, extra: Partial<RigOptions> = {}) =>
	rig({ routes, app, spool, ...extra });

describe('shadow mode', () => {
	it('makes the requests the page would make and no others, one flush providing the artifact', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'POST /.spool/beacon']);
		expect(await r.runtime.replica.ids()).toEqual(['/soft/1']);

		r.reset();
		for (let i = 0; i < 5; i++) await r.visit('/soft/1');
		expect(r.log).toEqual(Array.from({ length: 5 }, () => 'GET /soft/1'));
		expect(
			r.urls.filter((u) => u.includes('/.spool/artifact') || u.includes('/.spool/sync'))
		).toEqual([]);
	});

	it('serves nothing locally: the network answers every view, and each is a shadow view', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/soft/1');
		const second = await r.visit('/soft/1');
		expect(second).toContain('data-spool-client');
		const views = await held(r.storage);
		expect(views.map((v) => [v.tier, v.reason, v.mismatch])).toEqual([
			['shadow', 'fresh', false]
		]);
	});

	it('reports a divergent route as a mismatch and a matching route never', async () => {
		const r = make({ mode: 'shadow' });
		for (const path of ['/soft/1', '/diverge/1']) await r.visit(path);
		for (let i = 0; i < 3; i++) {
			await r.visit('/soft/1');
			await r.visit('/diverge/1');
		}
		const views = await held(r.storage);
		const byRoute = (route: string) => views.filter((v) => v.route === route);
		expect(byRoute('/soft/:id').map((v) => [v.reason, v.mismatch])).toEqual([
			['fresh', false],
			['fresh', false],
			['fresh', false]
		]);
		expect(byRoute('/diverge/:id').map((v) => [v.reason, v.mismatch])).toEqual([
			['fresh', true],
			['fresh', true],
			['fresh', true]
		]);
	});

	it('records no comparison for a cold view or a principal route, and counts a non-200 as a difference', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/acct');
		await r.visit('/soft/404');
		await r.visit('/soft/404');
		expect((await held(r.storage)).map((v) => [v.reason, v.mismatch])).toEqual([
			['principal', null],
			['cold', null],
			['cold', null]
		]);

		gone.flaky = false;
		await r.visit('/flaky/1');
		await r.visit('/flaky/1');
		gone.flaky = true;
		await r.visit('/flaky/1');
		gone.flaky = false;
		const flaky = (await held(r.storage)).filter((v) => v.route === '/flaky/:id');
		expect(flaky.map((v) => [v.reason, v.mismatch])).toEqual([
			['fresh', false],
			['fresh', true]
		]);
	});

	it('leaves beacons, assets and other subresource requests to the browser', () => {
		const r = make({ mode: 'shadow' });
		const ignored = (request: Request) => r.runtime.handle(request, () => {});
		expect(ignored(sub('/cdn-cgi/rum', { method: 'POST', body: '{}' }))).toBeUndefined();
		expect(ignored(sub('/app.js'))).toBeUndefined();
		expect(ignored(sub('/form', { method: 'POST', body: 'x' }))).toBeUndefined();
		expect(ignored(nav('/not-a-route'))).toBeDefined();
		expect(r.log).toEqual([]);
	});

	it('still serves subresources and absorbs beacons for a route that serves, in a serve server', async () => {
		const r = make({});
		await r.drive(sub('/app.js'));
		const absorbed = await r.drive(
			sub('/cdn-cgi/rum', {
				method: 'POST',
				body: '{}',
				headers: { 'content-type': 'text/plain' }
			})
		);
		expect(absorbed.status).toBe(204);
	});

	it('does no sync of its own: a view past a hard bound is recorded as one that would have synced', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/hard/1');
		r.advance(61);
		r.reset();
		await r.visit('/hard/1');
		expect(r.log).toEqual(['GET /hard/1']);
		const views = await held(r.storage);
		expect(views[views.length - 1]).toMatchObject({
			tier: 'shadow',
			reason: 'hard-sync',
			mismatch: false
		});
	});

	it('sends held views in one batch once there are enough, and not before', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/soft/1');
		r.reset();
		for (let i = 0; i < VIEW_BATCH + 4; i++) await r.visit('/soft/1');
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toHaveLength(1);
		expect(viewsOf(r.sink.events)).toHaveLength(1 + VIEW_BATCH);
		expect(await r.storage.readBeacons()).toHaveLength(4);
	});

	it('sends a few views once the oldest has waited long enough, at the next network moment', async () => {
		const r = make({ mode: 'shadow' });
		await r.visit('/soft/1');
		await r.visit('/soft/1');
		r.reset();
		await r.visit('/soft/1');
		expect(r.log).toEqual(['GET /soft/1']);

		r.advance(VIEW_HOLD_MS / 1000);
		await r.visit('/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'GET /soft/1', 'POST /.spool/beacon']);
		expect(viewsOf(r.sink.events)).toHaveLength(4);
	});
});

describe('route mode and the sampled canary', () => {
	it('shadows only the route that asks, whatever the server mode', async () => {
		const mixed = [
			defineRoute('/soft/:id', {
				strategy: 'template',
				template,
				depends,
				load,
				mode: 'shadow'
			}),
			defineRoute('/hard/:id', { strategy: 'template', template, depends, load })
		];
		const r = rig({ routes: mixed, app });
		for (const path of ['/soft/1', '/hard/1']) await r.visit(path);
		r.reset();
		await r.visit('/soft/1');
		await r.visit('/hard/1');
		expect(r.log).toEqual(['GET /soft/1']);
		const views = await held(r.storage);
		expect(views.slice(-2).map((v) => [v.route, v.tier])).toEqual([
			['/soft/:id', 'shadow'],
			['/hard/:id', 'local']
		]);
	});

	it('runs shadow on the sampled fraction of views in serve mode and serves the rest', async () => {
		const draws = [0.9, 0.9, 0.2, 0.9, 0.2];
		const r = make({ shadowSample: 0.5 }, { random: () => draws.shift() ?? 0.9 });
		await r.visit('/soft/1');
		r.reset();
		await r.visit('/soft/1');
		expect(r.log).toEqual([]);
		await r.visit('/soft/1');
		expect(r.log).toEqual(['GET /soft/1']);
		await r.visit('/soft/1');
		await r.visit('/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'GET /soft/1']);
		const views = await held(r.storage);
		expect(views.map((v) => v.tier)).toEqual(['network', 'local', 'shadow', 'local', 'shadow']);
	});

	it('never samples at 0 and always samples at 1', async () => {
		const never = make({ shadowSample: 0 }, { random: () => 0 });
		await never.visit('/soft/1');
		never.reset();
		await never.visit('/soft/1');
		expect(never.log).toEqual([]);
		const always = make({ shadowSample: 1 }, { random: () => 0.99 });
		await always.visit('/soft/1');
		await always.visit('/soft/1');
		expect((await held(always.storage)).map((v) => v.tier)).toEqual(['shadow', 'shadow']);
	});
});

describe('view events', () => {
	it('say how each view went, with the engine, the worker age and the gap since the last view', async () => {
		const r = make(
			{},
			{ userAgent: 'Mozilla/5.0 (Macintosh; rv:128.0) Gecko/20100101 Firefox/128.0' }
		);
		await r.visit('/soft/1');
		r.advance(10);
		await r.visit('/soft/1');
		r.advance(70);
		await r.visit('/soft/1');
		await r.visit('/hard/2');
		r.advance(70);
		await r.visit('/hard/2');
		await r.visit('/acct');
		await r.spool.invalidate(['node:2']);
		r.advance(70);
		await r.visit('/hard/2');

		const views = await held(r.storage);
		expect(views.map((v) => [v.tier, v.reason, v.staleSec, v.gapMs, v.swAgeMs])).toEqual([
			['network', 'cold', null, null, 0],
			['local', 'fresh', 10, 10_000, 10_000],
			['local-revalidate', 'soft-sync', 80, 70_000, 80_000],
			['network', 'cold', null, 0, 80_000],
			['local-revalidate', 'hard-sync', 70, 70_000, 150_000],
			['network', 'principal', null, 0, 150_000],
			['fallback', 'stale-after-sync', 70, 70_000, 220_000]
		]);
		expect(new Set(views.map((v) => v.engine))).toEqual(new Set(['firefox']));
		expect(views.map((v) => v.scope)).toEqual([
			'public',
			'public',
			'public',
			'public',
			'public',
			'principal',
			'public'
		]);
	});

	it('are not queued when the config turns them off', async () => {
		const r = make({ views: false });
		await r.visit('/soft/1');
		await r.visit('/soft/1');
		expect(await r.storage.readBeacons()).toEqual([]);
	});

	it('name the offline outcomes: a stale page shown, and a refusal', async () => {
		const strict = [
			defineRoute('/strict/:id', {
				strategy: 'template',
				template,
				depends,
				load,
				freshness: { maxStale: 60, mode: 'hard' },
				offline: 'refuse'
			}),
			routes[1] as (typeof routes)[number]
		];
		const r = rig({ routes: strict, app });
		await r.visit('/strict/1');
		await r.visit('/hard/1');
		r.advance(61);
		r.offline(true);
		await r.visit('/hard/1');
		await expect(r.visit('/strict/1')).rejects.toThrow('offline');
		const views = await held(r.storage);
		expect(views.map((v) => [v.tier, v.reason])).toEqual([
			['network', 'cold'],
			['network', 'cold'],
			['local-revalidate', 'offline-stale']
		]);
	});
});

describe('provisioning in a flush', () => {
	it('warms the hot paths on the first flush that has something to send, with no artifact request', async () => {
		const r = make({ provision: { hot: ['/soft/7', '/hard/8', '/acct', '/nothing'] } });
		await r.visit('/soft/1');
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		const flushes = r.log.filter((l) => l === 'POST /.spool/beacon');
		expect(flushes).toHaveLength(1);
		expect(r.log).not.toContain('GET /.spool/artifact?path=/soft/7');
		expect((await r.runtime.replica.ids()).sort()).toEqual(['/hard/8', '/soft/1', '/soft/7']);
		r.reset();
		await r.visit('/soft/7');
		await r.visit('/hard/8');
		expect(r.log).toEqual([]);
	});

	it('charges each piggybacked artifact its bytes and no request', async () => {
		const r = make({ provision: { hot: ['/soft/7'] } });
		await r.visit('/soft/1');
		await r.visit('/soft/7');
		const { entries } = (await r.runtime.message({ type: 'spool:ledger' })) as {
			entries: Array<{ id: string; bytes: number; requests: number; views: number }>;
		};
		expect(entries.map((e) => [e.id, e.requests, e.views, e.bytes > 0])).toEqual([
			['/soft/1', 1, 0, true],
			['/soft/7', 0, 1, true]
		]);
	});

	it('asks for a hot path the server cannot build once, not at every network moment', async () => {
		const boom = defineRoute('/boom/:id', {
			strategy: 'template',
			template,
			load: () => {
				throw new Error('no data');
			}
		});
		const r = rig({
			routes: [...routes, boom],
			app,
			spool: { provision: { hot: ['/boom/1', '/soft/7'] } }
		});
		await r.visit('/soft/1');
		for (let i = 0; i < 3; i++) await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toHaveLength(1);
		expect((await r.runtime.replica.ids()).sort()).toEqual(['/soft/1', '/soft/7']);
	});

	it('does not ask for a hot path whose benefit is not positive', async () => {
		const kept = defineRoute('/soft/:id', {
			strategy: 'template',
			template,
			depends,
			load,
			freshness: { maxStale: 60, mode: 'soft' },
			provision: { reuse: 1, futureViews: 5 }
		});
		const r = rig({
			routes: [kept, ...routes.slice(1)],
			app,
			spool: { provision: { hot: ['/soft/7'], reuse: 0, artifactBytes: 100_000 } }
		});
		await r.visit('/soft/1');
		await r.drive(nav('/soft/1'));
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(await r.runtime.replica.ids()).toEqual(['/soft/1']);
	});
});
