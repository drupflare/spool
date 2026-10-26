import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CATALOGUE_BYTES,
	defineRoute,
	HEADERS,
	MAX_CATALOGUE_PATH,
	parseBeaconBatch,
	type CatalogueGuess
} from '../../src/protocol/index';
import { viewFromBeacon } from '../../src/protocol/view';
import {
	compressedSize,
	createSpool,
	MAX_CATALOGUE_BUILD,
	memorySink,
	partitionId
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { CATALOGUE_REASK_MS } from '../../src/sw/analytics';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { Replica } from '../../src/sw/replica';
import { createRuntime, type GraphStatus, type LedgerStatus } from '../../src/sw/runtime';
import { memoryStorage } from '../../src/sw/storage';
import { artifact, fakeCaches, freshIndexedDB, nav, ORIGIN } from './helpers';

const HTML = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': "default-src 'self'"
};
const page = (text: string) => `<html><head></head><body>${text}</body></html>`;
const SOURCE = '<html><head></head><body>item {{title}} {{menu}}</body></html>';

/** compressed bytes by route id, so a test sets exactly what each entry weighs */
const WEIGHT: Record<string, number> = {
	'/c/1': 4000,
	'/c/2': 4000,
	'/c/3': 9000,
	'/c/4': 9000
};

type Options = {
	catalogue?: boolean;
	cap?: number;
	home?: CatalogueGuess[];
	grades?: CatalogueGuess[];
	weight?: Record<string, number>;
	/** how long `/home` may go unvalidated, in seconds; the public default when absent */
	fresh?: number;
	/** `false` leaves view events off, so nothing is held to carry an ask */
	views?: boolean;
};

/** break-even at the default 17,054 B document: 4,000 B needs 0.226, 9,000 B needs 0.508 */
const HOME: CatalogueGuess[] = [
	{ path: '/c/1', p: 0.3 },
	{ path: '/c/2', p: 0.2 },
	{ path: '/c/3', p: 0.9 },
	{ path: '/c/4', p: 0.4 }
];

function rig(options: Options = {}) {
	const user = { current: null as string | null };
	const log: string[] = [];
	const batches: Array<Record<string, unknown>> = [];
	const hooks = {
		saveData: false,
		tamper: undefined as undefined | ((response: Response) => Response)
	};
	const weight = options.weight ?? WEIGHT;
	const me = (ctx: { identity: { principal: string } | null }) =>
		(ctx.identity as { principal: string }).principal;
	const principal = (tag: (name: string, ctx: Parameters<typeof me>[0]) => string) => ({
		strategy: 'template' as const,
		scope: 'principal' as const,
		template: { source: SOURCE },
		depends: (ctx: Parameters<typeof me>[0] & { params: Record<string, string> }) => [
			tag(ctx.params['n'] ?? '', ctx)
		],
		load: (ctx: Parameters<typeof me>[0]) => ({ title: `of ${me(ctx)}`, menu: '' })
	});
	const routes = [
		defineRoute('/home', {
			strategy: 'template',
			template: { source: SOURCE },
			depends: () => ['home'],
			load: () => ({ title: 'home', menu: '' }),
			...(options.fresh === undefined
				? {}
				: { freshness: { maxStale: options.fresh, mode: 'soft' as const } }),
			...(options.catalogue === false ? {} : { catalogue: () => options.home ?? HOME })
		}),
		defineRoute('/c/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			depends: (ctx) => [`c:${ctx.params['id']}`],
			load: (ctx) => ({
				title: `t${ctx.params['id']}`,
				menu: ctx.record('site:menu', 'Menu')
			})
		}),
		defineRoute('/pub/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			depends: (ctx) => [`pub:${ctx.params['id']}`],
			load: (ctx) => ({ title: `p${ctx.params['id']}`, menu: '' })
		}),
		defineRoute('/grades', {
			...principal((_, ctx) => `perm:${me(ctx)}`),
			catalogue: () =>
				options.grades ?? [
					{ path: '/inbox', p: 0.9 },
					{ path: '/pub/1', p: 0.9 }
				]
		}),
		defineRoute(
			'/inbox',
			principal((_, ctx) => `perm:inbox:${me(ctx)}`)
		),
		defineRoute(
			'/box/:n',
			principal((n, ctx) => `perm:box:${n}:${me(ctx)}`)
		)
	];
	const sink = memorySink();
	const spool = createSpool({
		routes,
		store: memoryStore(),
		sink,
		beacons: ['/track'],
		...(options.views === false ? { views: false } : {}),
		identity: {
			secret: 's',
			resolve: () => (user.current ? { principal: user.current } : null)
		},
		...(options.cap === undefined ? {} : { catalogueBytes: options.cap }),
		catalogueSize: (bytes) => {
			const id = (JSON.parse(new TextDecoder().decode(bytes)) as { id: string }).id;
			return weight[id] ?? 300;
		}
	});
	const app = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/track') {
			return new Response(null, { status: 204 });
		}
		return new Response(page(`net ${pathname}`), { headers: HTML });
	};
	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		let request = new Request(input as string, init);
		const url = new URL(request.url);
		log.push(
			`${request.method} ${url.pathname}${url.pathname === '/.spool/sync' ? url.search : ''}`
		);
		const beacon = url.pathname === '/.spool/beacon';
		if (beacon) {
			batches.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
			if (hooks.saveData) {
				const headers = new Headers(request.headers);
				headers.set('save-data', 'on');
				request = new Request(request, { headers });
			}
		}
		const response = await spool.handle(request, app);
		return beacon && hooks.tamper ? hooks.tamper(response) : response;
	};
	const storage = memoryStorage();
	const factory = freshIndexedDB();
	let t = 1_700_000_000_000;
	const start = () =>
		createRuntime({
			config: spool.config,
			storage,
			fetch: fetchImpl,
			caches: fakeCaches(),
			origin: ORIGIN,
			now: () => t,
			partitions: idbPartitions(factory, idbVault(factory))
		});
	let runtime = start();
	const drive = async (request: Request): Promise<Response> => {
		const waited: Promise<unknown>[] = [];
		const pending = runtime.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	};
	const views = async () =>
		(await storage.readBeacons()).flatMap(({ event }) => viewFromBeacon(event) ?? []);
	return {
		user,
		log,
		batches,
		hooks,
		sink,
		spool,
		get runtime() {
			return runtime;
		},
		/** a new worker over the same storage, as after the browser stops an idle one */
		restart: () => void (runtime = start()),
		storage,
		views,
		visit: async (path: string) => (await drive(nav(path))).text(),
		post: (path: string) => drive(nav(path, { method: 'POST', body: 'x' })),
		advance: (seconds: number) => void (t += seconds * 1000),
		ids: () => runtime.replica.ids(),
		partition: async () =>
			(await runtime.message({ type: 'spool:partition' })) as {
				partition: string | null;
				artifacts: string[];
			},
		ledger: async () => (await runtime.message({ type: 'spool:ledger' })) as LedgerStatus,
		/** the steps that make a flush go out: a held site beacon, then a navigation to the network */
		flush: async () => {
			await drive(nav('/track', { method: 'POST', body: 'x' }));
			await drive(nav('/elsewhere'));
		}
	};
}

const askFor = (spool: ReturnType<typeof createSpool>, batch: object, headers = {}) =>
	spool.respond(
		new Request('https://site.test/.spool/beacon', {
			method: 'POST',
			headers,
			body: JSON.stringify({ protocol: 1, events: [], ...batch })
		})
	) as Promise<Response>;

const idsIn = async (response: Response) =>
	((await response.json()) as { catalogue: Array<{ id: string }> }).catalogue.map((a) => a.id);

describe('the beacon batch that asks for a catalogue', () => {
	it('accepts the page path with or without the sweep', () => {
		expect(parseBeaconBatch({ protocol: 1, events: [], catalogue: { path: '/a' } })).toEqual({
			protocol: 1,
			events: [],
			catalogue: { path: '/a' }
		});
		expect(
			parseBeaconBatch({ protocol: 1, events: [], catalogue: { path: '/a', sweep: true } })
		).toMatchObject({ catalogue: { path: '/a', sweep: true } });
	});

	it.each([
		['a string', 'x'],
		['null', null],
		['no path', {}],
		['a path without a slash', { path: 'a' }],
		['a path over the limit', { path: `/${'a'.repeat(MAX_CATALOGUE_PATH)}` }],
		['a sweep that is not true', { path: '/a', sweep: 'yes' }],
		['a false sweep', { path: '/a', sweep: false }]
	])('refuses %s', (_, catalogue) => {
		expect(() => parseBeaconBatch({ protocol: 1, events: [], catalogue })).toThrow();
	});
});

describe('which entries the server sends', () => {
	const build = (over: Options = {}) => rig(over).spool;
	const ask = { catalogue: { path: '/home' } };

	it('sends the entries at or above their break-even and none below it, best net first', async () => {
		const response = await askFor(build(), ask);
		expect(response.status).toBe(200);
		expect(await idsIn(response)).toEqual(['/c/3', '/c/1']);
	});

	it('lets a route override the document an entry replaces', async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/home', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({}),
					catalogue: () => [{ path: '/c/1', p: 0.9 }]
				}),
				defineRoute('/c/:id', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({}),
					documentBytes: 500
				})
			],
			store: memoryStore(),
			catalogueSize: () => 4000
		});
		expect((await askFor(spool, ask)).status).toBe(204);
	});

	it('weighs a data route against its own size', async () => {
		const spool = (p: number) =>
			createSpool({
				routes: [
					defineRoute('/home', {
						strategy: 'template',
						template: { source: SOURCE },
						load: () => ({}),
						catalogue: () => [{ path: '/api/1', p }]
					}),
					defineRoute('/api/:id', { strategy: 'data', load: () => ({ a: 1 }) })
				],
				store: memoryStore(),
				catalogueSize: () => 300
			});
		expect((await askFor(spool(0.3), ask)).status).toBe(204);
		expect(await idsIn(await askFor(spool(0.35), ask))).toEqual(['/api/1']);
	});

	it('never exceeds the cap, whatever it is', async () => {
		const guesses: CatalogueGuess[] = [
			{ path: '/c/1', p: 0.9 },
			{ path: '/c/2', p: 0.9 },
			{ path: '/c/3', p: 0.95 },
			{ path: '/c/4', p: 0.1 }
		];
		const sent = async (cap: number) => {
			const response = await askFor(build({ cap, home: guesses }), ask);
			return response.status === 204 ? [] : await idsIn(response);
		};
		const bytes = (ids: string[]) => ids.reduce((sum, id) => sum + (WEIGHT[id] as number), 0);
		for (const cap of [0, 1000, 3999, 4000, 7999, 8000, 8999, 9000, 16_999, 17_000, 32_768]) {
			expect(bytes(await sent(cap)), `cap ${cap}`).toBeLessThanOrEqual(cap);
		}
		expect(await sent(3999)).toEqual([]);
		expect(await sent(4000)).toEqual(['/c/1']);
		expect(await sent(8999)).toEqual(['/c/1', '/c/2']);
		expect(await sent(16_999)).toEqual(['/c/1', '/c/2']);
		expect(await sent(17_000)).toEqual(['/c/1', '/c/2', '/c/3']);
	});

	it('defaults the cap to 32 KiB and refuses a cap that is not a non-negative number', () => {
		expect(DEFAULT_CATALOGUE_BYTES).toBe(32_768);
		const routes = [
			defineRoute('/a', { strategy: 'template', template: { source: '' }, load: () => ({}) })
		];
		for (const catalogueBytes of [-1, Number.NaN, Infinity]) {
			expect(() => createSpool({ routes, store: memoryStore(), catalogueBytes })).toThrow(
				/catalogueBytes/
			);
		}
	});

	it('judges a guess with n on the lower bound of its share when catalogueConfidence is set', async () => {
		const build = (options: { catalogueConfidence?: number }) =>
			createSpool({
				routes: [
					defineRoute('/home', {
						strategy: 'template',
						template: { source: SOURCE },
						load: () => ({}),
						catalogue: () => [
							{ path: '/c/1', p: 0.03, n: 5 },
							{ path: '/c/2', p: 0.03, n: 100_000 },
							{ path: '/c/3', p: 0.03 }
						]
					}),
					defineRoute('/c/:id', {
						strategy: 'template',
						template: { source: SOURCE },
						load: () => ({})
					})
				],
				store: memoryStore(),
				catalogueSize: () => 300,
				...options
			});
		expect((await idsIn(await askFor(build({}), ask))).sort()).toEqual([
			'/c/1',
			'/c/2',
			'/c/3'
		]);
		const cautious = build({ catalogueConfidence: 1.28 });
		expect((await idsIn(await askFor(cautious, ask))).sort()).toEqual(['/c/2', '/c/3']);
	});

	it('refuses a catalogueConfidence that is not a non-negative number', () => {
		const routes = [
			defineRoute('/a', { strategy: 'template', template: { source: '' }, load: () => ({}) })
		];
		for (const catalogueConfidence of [-1, Number.NaN, Infinity]) {
			expect(() =>
				createSpool({ routes, store: memoryStore(), catalogueConfidence })
			).toThrow(/catalogueConfidence/);
		}
	});

	it('skips a guess that is not a page the device can render from data', async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/home', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({}),
					catalogue: () =>
						[
							{ path: '/home', p: 0.9 },
							{ path: '/c/1?x=1', p: 0.9 },
							{ path: '/.spool/sync', p: 0.9 },
							{ path: '/nope', p: 0.9 },
							{ path: '/static/1', p: 0.9 },
							{ path: '/assembly/1', p: 0.9 },
							{ path: '/c/2', p: Number.NaN },
							{ path: '/c/3', p: 0 },
							{ path: '/c/4', p: 1.5 },
							{ path: '/c/5', p: '0.9' },
							{ path: 'c/6', p: 0.9 },
							{ path: '/c/7', p: 0.9 },
							{ path: '/c/7', p: 0.9 }
						] as CatalogueGuess[]
				}),
				defineRoute('/c/:id', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({})
				}),
				defineRoute('/static/:id', { strategy: 'static' }),
				defineRoute('/assembly/:id', {
					strategy: 'assembly',
					load: () => ({ shell: '<p></p>' })
				})
			],
			store: memoryStore(),
			catalogueSize: () => 300
		});
		expect(await idsIn(await askFor(spool, ask))).toEqual(['/c/7']);
	});

	it('builds at most MAX_CATALOGUE_BUILD pages for one request', async () => {
		let builds = 0;
		const spool = createSpool({
			routes: [
				defineRoute('/home', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({}),
					catalogue: () =>
						Array.from({ length: 100 }, (_, i) => ({ path: `/c/${i}`, p: 0.9 }))
				}),
				defineRoute('/c/:id', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => {
						builds += 1;
						return {};
					}
				})
			],
			store: memoryStore(),
			catalogueSize: () => 300
		});
		const response = await askFor(spool, ask);
		expect(builds).toBe(MAX_CATALOGUE_BUILD);
		expect((await idsIn(response)).length).toBe(MAX_CATALOGUE_BUILD);
	});

	it('answers the flush and keeps its events when the route throws, never an error', async () => {
		const sink = memorySink();
		const spool = createSpool({
			routes: [
				defineRoute('/home', {
					strategy: 'template',
					template: { source: SOURCE },
					load: () => ({}),
					catalogue: () => {
						throw new Error('no data');
					}
				})
			],
			store: memoryStore(),
			sink
		});
		const response = await askFor(spool, {
			...ask,
			events: [{ path: '/.spool/view', body: '{}', contentType: 'application/json', at: 1 }]
		});
		expect(response.status).toBe(204);
		expect(sink.events).toHaveLength(1);
	});

	it('sends nothing for a page whose route declares no catalogue, or for no route', async () => {
		const spool = build();
		expect((await askFor(spool, { catalogue: { path: '/c/1' } })).status).toBe(204);
		expect((await askFor(spool, { catalogue: { path: '/nowhere' } })).status).toBe(204);
		expect((await askFor(spool, {})).status).toBe(204);
	});

	it('refuses a route that declares a bad catalogue or document size', () => {
		const base = { strategy: 'template' as const, template: { source: '' }, load: () => ({}) };
		expect(() => defineRoute('/a', { ...base, catalogue: 'x' as never })).toThrow(/catalogue/);
		expect(() => defineRoute('/a', { ...base, documentBytes: -1 })).toThrow(/documentBytes/);
		expect(() => defineRoute('/a', { ...base, documentBytes: Number.NaN })).toThrow(
			/documentBytes/
		);
		const route = defineRoute('/a', { ...base, documentBytes: 0, catalogue: () => [] });
		expect(route.documentBytes).toBe(0);
	});

	it('tells the worker which routes declare a catalogue', () => {
		const { routes } = rig().spool.config;
		expect(routes.find((r) => r.pattern === '/home')?.catalogue).toBe(true);
		expect(routes.find((r) => r.pattern === '/c/:id')?.catalogue).toBeUndefined();
	});
});

describe('Save-Data', () => {
	const ask = { catalogue: { path: '/home' } };

	it('sends no catalogue, in any case of the header, and still answers a want', async () => {
		const spool = rig().spool;
		for (const value of ['on', 'ON', ' on ']) {
			const response = await askFor(spool, ask, { 'save-data': value });
			expect(response.status, value).toBe(204);
		}
		const both = await askFor(spool, { ...ask, want: ['/pub/1'] }, { 'save-data': 'on' });
		const body = (await both.json()) as { artifacts: unknown[]; catalogue?: unknown };
		expect(body.artifacts).toHaveLength(1);
		expect(body.catalogue).toBeUndefined();
		expect((await askFor(spool, ask, { 'save-data': 'off' })).status).toBe(200);
		expect((await askFor(spool, ask)).status).toBe(200);
	});

	it('leaves the worker with nothing held and no second ask for the same page', async () => {
		const w = rig();
		w.hooks.saveData = true;
		await w.visit('/home');
		await w.flush();
		expect(w.batches[0]?.['catalogue']).toEqual({ path: '/home', sweep: true });
		expect(await w.ids()).toEqual(['/home']);
		expect((await w.ledger()).totals.catalogueBytes).toBe(0);

		await w.visit('/home');
		await w.flush();
		expect(w.batches).toHaveLength(2);
		expect(w.batches[1]?.['catalogue']).toBeUndefined();
	});
});

describe('delivery at a network moment', () => {
	const beacons = (w: { log: string[] }) =>
		w.log.filter((line) => line === 'POST /.spool/beacon').length;

	it('flushes once at the first network moment after the visit, and the entries arrive', async () => {
		const w = rig();
		await w.visit('/home');
		expect(beacons(w)).toBe(1);
		expect(w.batches[0]?.['catalogue']).toEqual({ path: '/home', sweep: true });
		expect((await w.ids()).sort()).toEqual(['/c/1', '/c/3', '/home']);
		await w.visit('/elsewhere');
		await w.visit('/elsewhere');
		expect(beacons(w)).toBe(1);
	});

	it('sends no beacon for a site with no catalogue, whose views wait for a bigger batch', async () => {
		const w = rig({ catalogue: false });
		await w.visit('/home');
		await w.visit('/elsewhere');
		await w.visit('/elsewhere');
		expect(beacons(w)).toBe(0);
		expect(await w.ids()).toEqual(['/home']);
	});

	it('makes no flush for an ask when no spool event is held to carry it', async () => {
		const w = rig({ views: false });
		await w.visit('/home');
		await w.visit('/elsewhere');
		await w.flush();
		expect(w.log).toContain('POST /track');
		expect(beacons(w)).toBe(0);
		expect(await w.ids()).toEqual(['/home']);
	});

	it('flushes once at a moment with a due ask, not again that day, and never on a local view', async () => {
		const w = rig({ fresh: 7 * 86_400 });
		await w.visit('/home');
		expect(beacons(w)).toBe(1);
		await w.visit('/elsewhere');
		expect(beacons(w)).toBe(1);

		w.advance(CATALOGUE_REASK_MS / 1000 + 1);
		const before = w.log.length;
		await w.visit('/home');
		expect((await w.views()).at(-1)).toMatchObject({ route: '/home', tier: 'local' });
		expect(w.log.slice(before)).toEqual([]);

		await w.visit('/elsewhere');
		expect(beacons(w)).toBe(2);
		expect(w.batches[1]?.['catalogue']).toEqual({ path: '/home', sweep: true });
		await w.visit('/elsewhere');
		expect(beacons(w)).toBe(2);
	});

	it('asks again only for a page it has not asked for', async () => {
		const w = rig();
		await w.visit('/home');
		await w.flush();
		await w.visit('/home');
		await w.flush();
		expect(w.batches.map((b) => b['catalogue'])).toEqual([
			{ path: '/home', sweep: true },
			undefined
		]);
	});

	it('does not ask again after a worker restart until a day has passed', async () => {
		const w = rig();
		await w.visit('/home');
		await w.flush();
		w.restart();
		await w.visit('/home');
		await w.flush();
		w.advance(CATALOGUE_REASK_MS / 1000 - 1);
		w.restart();
		await w.visit('/home');
		await w.flush();
		w.advance(1);
		await w.visit('/home');
		await w.flush();
		expect(w.batches.map((b) => b['catalogue'])).toEqual([
			{ path: '/home', sweep: true },
			undefined,
			undefined,
			{ path: '/home', sweep: true }
		]);
	});

	it('stores each entry once in the graph and charges the ledger its bytes', async () => {
		const w = rig();
		await w.visit('/home');
		await w.flush();
		const graph = (await w.runtime.message({ type: 'spool:graph' })) as GraphStatus;
		expect(graph.records).toEqual(['site:menu']);
		const { entries, totals } = await w.ledger();
		const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
		expect(byId['/c/1']?.catalogueBytes).toBeGreaterThan(0);
		expect(byId['/c/3']?.catalogueBytes).toBeGreaterThan(0);
		expect(byId['/c/2']).toBeUndefined();
		expect(byId['/c/1']).toMatchObject({ requests: 0, views: 0, catalogueViews: 0 });
		expect(totals.catalogueBytes).toBe(
			(byId['/c/1']?.catalogueBytes as number) + (byId['/c/3']?.catalogueBytes as number)
		);
	});
});

describe('a view served from a catalogue entry', () => {
	it('is reason catalogue on tier local with no request, then an ordinary view', async () => {
		const w = rig();
		await w.visit('/home');
		await w.flush();
		w.log.length = 0;
		expect(await w.visit('/c/3')).toContain('item t3 Menu');
		expect(w.log).toEqual([]);
		expect(await w.visit('/c/3')).toContain('item t3 Menu');
		expect(w.log).toEqual([]);

		const views = (await w.views()).filter((v) => v.route === '/c/:id');
		expect(views.map((v) => [v.reason, v.tier])).toEqual([
			['catalogue', 'local'],
			['fresh', 'local']
		]);
		const { entries, totals } = await w.ledger();
		const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
		expect(byId['/c/3']).toMatchObject({ views: 2, catalogueViews: 1 });
		expect(byId['/c/1']).toMatchObject({ views: 0, catalogueViews: 0 });
		expect(totals.catalogueViews).toBe(1);
	});

	it('keeps the freshness reason when the entry is past its bound, and still opens it', async () => {
		const w = rig();
		await w.visit('/home');
		await w.flush();
		w.advance(3600);
		await w.visit('/c/1');
		const [view] = (await w.views()).filter((v) => v.route === '/c/:id');
		expect(view?.reason).toBe('soft-sync');
		expect((await w.ledger()).totals.catalogueViews).toBe(0);
		await w.visit('/c/1');
		expect((await w.views()).filter((v) => v.route === '/c/:id').at(-1)?.reason).not.toBe(
			'catalogue'
		);
	});
});

describe('principal routes as catalogue entries', () => {
	const ask = { catalogue: { path: '/grades' } };

	it('refuses them without the sweep and sends them with it, under the caller partition', async () => {
		const w = rig();
		w.user.current = 'A';
		const without = await askFor(w.spool, ask);
		expect(await idsIn(without)).toEqual(['/pub/1']);
		expect(without.headers.get(HEADERS.partition)).toBeNull();

		const swept = await askFor(w.spool, { catalogue: { path: '/grades', sweep: true } });
		expect((await idsIn(swept.clone())).sort()).toEqual(['/inbox', '/pub/1']);
		expect(swept.headers.get(HEADERS.partition)).toBe(await partitionId('s', 'A'));
		expect(swept.headers.get('cache-control')).toBe('private, no-store');
	});

	it('sends a signed-out caller no principal entry and no principal page catalogue', async () => {
		const w = rig({
			home: [
				{ path: '/inbox', p: 0.9 },
				{ path: '/pub/1', p: 0.9 }
			]
		});
		const out = await askFor(w.spool, { catalogue: { path: '/home', sweep: true } });
		expect(await idsIn(out)).toEqual(['/pub/1']);
		expect(
			(await askFor(w.spool, { catalogue: { path: '/grades', sweep: true } })).status
		).toBe(204);
	});

	it('stores the entry in the partition the answer names and drops one for another partition', async () => {
		const w = rig();
		w.user.current = 'A';
		await w.visit('/grades');
		await w.flush();
		expect((await w.partition()).artifacts).toEqual(['/grades', '/inbox']);
		expect(await w.ids()).toContain('/pub/1');

		const t = rig();
		t.user.current = 'A';
		t.hooks.tamper = (response) => {
			const headers = new Headers(response.headers);
			headers.set(HEADERS.partition, 'someone-else');
			return new Response(response.body, { status: response.status, headers });
		};
		await t.visit('/grades');
		await t.flush();
		expect((await t.partition()).artifacts).toEqual(['/grades']);
		expect(await t.ids()).toContain('/pub/1');
	});

	it('drops a revoked entry no page has opened at the first required sync of a principal page', async () => {
		const w = rig();
		w.user.current = 'A';
		await w.visit('/grades');
		await w.flush();
		expect((await w.partition()).artifacts).toContain('/inbox');

		// control: nothing revoked, so the sweep keeps the entry
		w.advance(301);
		w.log.length = 0;
		await w.visit('/grades');
		const sync = w.log.find((line) => line.startsWith('GET /.spool/sync')) as string;
		const named = decodeURIComponent(decodeURIComponent(sync.split('need=')[1] as string));
		expect(named).toContain('perm:inbox:A@');
		expect(named).toContain('spool:artifact:/inbox@');
		expect((await w.partition()).artifacts).toContain('/inbox');

		await w.spool.invalidate(['perm:inbox:A']);
		w.advance(301);
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('item of A');
		expect(w.log).toHaveLength(1);
		expect(w.log[0]).toContain('GET /.spool/sync?need=');
		expect((await w.partition()).artifacts).toEqual(['/grades']);
		expect((await w.views()).at(-1)?.reason).toBe('hard-sync');
	});

	it('falls back to a full sync when the sweep would name more than MAX_NEED ids, and still drops the revoked one', async () => {
		const boxes = Array.from({ length: MAX_CATALOGUE_BUILD }, (_, i) => ({
			path: `/box/${i}`,
			p: 0.9
		}));
		const w = rig({ grades: boxes });
		w.user.current = 'A';
		await w.visit('/grades');
		await w.flush();
		expect((await w.partition()).artifacts).toHaveLength(1 + MAX_CATALOGUE_BUILD);

		await w.spool.invalidate(['perm:box:7:A']);
		w.advance(301);
		w.log.length = 0;
		await w.visit('/grades');
		expect(w.log).toHaveLength(1);
		expect(w.log[0]).toContain('GET /.spool/sync?from=');
		const held = (await w.partition()).artifacts;
		expect(held).not.toContain('/box/7');
		expect(held).toContain('/box/8');
	});
});

describe('Replica.sweep', () => {
	const entry = (id: string, deps: string[], vector: number) =>
		artifact({ id, scope: 'principal', deps, vector });

	it('adds every unopened entry at the lowest vector it was built at, and skips an opened one', async () => {
		const replica = new Replica(memoryStorage(), 'v');
		await replica.put(entry('/a', ['t:1', 't:2'], 5), true, true);
		await replica.put(entry('/b', ['t:1'], 3), true, true);
		await replica.put(entry('/c', ['t:9'], 4), true, true);
		await replica.open('/c');
		expect(await replica.sweep({ own: 7, 't:1': 9 })).toEqual({
			own: 7,
			't:1': 3,
			't:2': 5,
			'spool:artifact:/a': 5,
			'spool:artifact:/b': 3
		});
	});

	it('is null when the union is over MAX_NEED', async () => {
		const replica = new Replica(memoryStorage(), 'v');
		for (let i = 0; i < 40; i++) await replica.put(entry(`/e${i}`, [`t:${i}`], 1), true, true);
		expect(await replica.sweep({})).toBeNull();
	});

	it('opens a memory-only entry and ignores one that is not a catalogue entry', async () => {
		const replica = new Replica(memoryStorage(), 'v');
		await replica.put(entry('/m', ['t:1'], 1), false, true);
		await replica.put(entry('/n', ['t:2'], 1), true);
		await replica.open('/n');
		await replica.open('/missing');
		expect((await replica.get('/m'))?.catalogue).toBe(true);
		await replica.open('/m');
		expect((await replica.get('/m'))?.catalogue).toBeUndefined();
		expect(await replica.sweep({})).toEqual({});
	});
});

describe('the entry size', () => {
	it('measures a compressed size, smaller than the text and no larger than gzip', async () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ rows: Array(200).fill('a row') }));
		const size = await compressedSize(bytes);
		expect(size).toBeGreaterThan(0);
		expect(size).toBeLessThan(bytes.length);
		expect(size).toBeLessThanOrEqual(gzipSync(bytes).length);
	});
});
