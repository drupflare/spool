import { describe, expect, it } from 'vitest';
import {
	equivalent,
	injectClientTag,
	parseArtifact,
	type Artifact
} from '../../src/protocol/index';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { Graph } from '../../src/sw/graph/index';
import { Replica } from '../../src/sw/replica';
import { createRuntime } from '../../src/sw/runtime';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { campus } from '../fixtures/graph';
import { fakeCaches, nav, ORIGIN, sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const graphRig = (
	options: { sync?: 'background' | 'deferred'; spool?: RigOptions['spool'] } = {}
) => {
	const world = campus(options);
	const r = rig({
		spool: options.spool,
		routes: world.routes,
		app: (request) => {
			const { pathname } = new URL(request.url);
			const html = world.html(pathname);
			if (html !== undefined) return new Response(html, { headers: HTML });
			if (pathname === '/x.js')
				return new Response('js', { headers: { 'cache-control': 'no-store' } });
			if (pathname === '/form') return new Response('saved');
			return new Response('missing', { status: 404, headers: HTML });
		}
	});
	return { ...world, ...r };
};

const WALK = ['/c/101', '/t/ada', '/d'];

const provisioned = async () => {
	const g = graphRig();
	for (const path of WALK) await g.visit(path);
	return g;
};

describe('three routes over shared records', () => {
	it('store each record and projection once, whatever number of routes read it', async () => {
		const g = await provisioned();
		expect(g.log).toEqual([
			'GET /c/101',
			'GET /.spool/artifact',
			'GET /t/ada',
			'GET /.spool/artifact',
			'GET /d',
			'GET /.spool/artifact'
		]);
		expect((await g.storage.allRecords()).map((r) => r.id).sort()).toEqual([
			'course:101',
			'course:102',
			'site:name',
			'teacher:ada'
		]);
		expect((await g.storage.allProjections()).map((p) => p.id).sort()).toEqual([
			'menu',
			'roster:ada',
			'roster:bo'
		]);
		expect((await g.runtime.replica.ids()).sort()).toEqual(WALK.slice().sort());
	});

	it('ship each record in one response only, the later requests naming what the worker holds', async () => {
		const g = await provisioned();
		const shipped = g.artifacts.map(({ text }) => parseArtifact(JSON.parse(text)));
		const records = shipped.flatMap((a) => (a.records ?? []).map((r) => r.id));
		const projections = shipped.flatMap((a) => (a.projections ?? []).map((p) => p.id));
		expect(records.slice().sort()).toEqual([
			'course:101',
			'course:102',
			'site:name',
			'teacher:ada'
		]);
		expect(projections.slice().sort()).toEqual(['menu', 'roster:ada', 'roster:bo']);
		expect(g.artifacts.map((a) => a.url.includes('have='))).toEqual([false, true, true]);
	});

	it('render locally what the network renders, with 0 requests', async () => {
		const g = await provisioned();
		for (const path of WALK) {
			const network = injectClientTag(g.html(path) as string, g.spool.config.clientTag);
			g.reset();
			const local = await g.visit(path);
			expect(g.log).toEqual([]);
			const verdict = equivalent(local, network);
			expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
		}
	});

	it('keep the stored artifacts free of the data they reference', async () => {
		const g = await provisioned();
		const stored = await g.storage.allArtifacts();
		for (const { artifact } of stored) {
			expect(artifact.records).toBeUndefined();
			expect(artifact.projections).toBeUndefined();
			expect(JSON.stringify(artifact.body)).toContain('$record');
		}
	});
});

describe('a record change', () => {
	const fresh = async (): Promise<{ graph: Graph; artifacts: Artifact[] }> => {
		const world = campus();
		const spool = createSpool({ routes: world.routes, store: memoryStore() });
		const storage = memoryStorage();
		const artifacts: Artifact[] = [];
		const graph = new Graph({
			storage,
			tagVersion: () => 0,
			artifacts: async () => artifacts.map((artifact) => ({ artifact, fetchedAt: 0 }))
		});
		await graph.ensure();
		for (const path of WALK) {
			const response = await spool.respond(
				new Request(`${ORIGIN}/.spool/artifact?path=${path}`)
			);
			const artifact = parseArtifact(await response?.json());
			await graph.put(artifact, true);
			artifacts.push({ ...artifact, records: undefined, projections: undefined } as Artifact);
		}
		return { graph, artifacts };
	};

	it('invalidates exactly the projections that read it, and the artifacts that use them', async () => {
		const { graph } = await fresh();
		expect(await graph.invalidate({ 'course:101': 1 })).toEqual({
			records: ['course:101'],
			projections: ['menu', 'roster:ada'],
			artifacts: ['/c/101', '/d', '/t/ada']
		});
		expect(graph.records.ids()).toEqual(['course:102', 'site:name', 'teacher:ada']);
		expect(graph.projections.ids()).toEqual(['roster:bo']);
	});

	it('leaves every projection alone when the record only one page reads changes', async () => {
		const { graph } = await fresh();
		expect(await graph.invalidate({ 'teacher:ada': 1 })).toEqual({
			records: ['teacher:ada'],
			projections: [],
			artifacts: ['/t/ada']
		});
		expect(graph.projections.ids()).toEqual(['menu', 'roster:ada', 'roster:bo']);
	});

	it('reaches the projections of a shared record in each route that reads it', async () => {
		const { graph } = await fresh();
		expect(await graph.invalidate({ 'course:102': 1 })).toEqual({
			records: ['course:102'],
			projections: ['menu', 'roster:bo'],
			artifacts: ['/c/101', '/d', '/t/ada']
		});
	});

	it('ignores a tag that is not stored, one not newer than the stored version and one the graph never read', async () => {
		const { graph } = await fresh();
		expect(await graph.invalidate({ nothing: 9, 'course:101': 0, 'node:1': 3 })).toEqual({
			records: [],
			projections: [],
			artifacts: []
		});
		expect(graph.records.ids()).toHaveLength(4);
	});

	it('drops a projection whose child projection was dropped even when its own deps are not listed', async () => {
		const { graph } = await fresh();
		graph.index.addProjection('wrapper', [], ['roster:ada']);
		await graph.projections.put(
			[{ id: 'wrapper', version: 0, deps: [], data: { $projection: 'roster:ada' } }],
			true
		);
		const out = await graph.invalidate({ 'course:101': 1 });
		expect(out.projections).toEqual(['menu', 'roster:ada', 'wrapper']);
	});

	it('forgets the index along with the data when the graph is cleared', async () => {
		const { graph } = await fresh();
		await graph.clear();
		expect(await graph.invalidate({ 'course:101': 1 })).toEqual({
			records: [],
			projections: [],
			artifacts: []
		});
		expect(graph.index.artifactsUsing(['course:101'], ['menu'])).toEqual([]);
		expect(graph.index.projectionsReading(['course:101'])).toEqual([]);
	});

	it('is applied by the runtime from a piggybacked response, dropping exactly those stored entries', async () => {
		const g = await provisioned();
		g.db.courses['101'] = 'Intro II';
		await g.spool.invalidate(['course:101']);
		await g.drive(sub('/x.js'));
		expect((await g.storage.allRecords()).map((r) => r.id).sort()).toEqual([
			'course:102',
			'site:name',
			'teacher:ada'
		]);
		expect((await g.storage.allProjections()).map((p) => p.id)).toEqual(['roster:bo']);
		expect(await g.runtime.replica.ids()).toEqual([]);
	});
});

describe('a page whose references lost what they point at', () => {
	it('is dropped, answered by the network, fetched whole, and then local again', async () => {
		const g = await provisioned();
		await g.runtime.replica.graph.records.drop(['course:101']);
		g.reset();
		const html = await g.visit('/c/101');
		expect(html).toContain('<h1>Intro</h1>');
		expect(g.log).toEqual(['GET /c/101', 'GET /.spool/artifact']);
		const shipped = parseArtifact(JSON.parse((g.artifacts[0] as { text: string }).text));
		expect(shipped.records?.map((r) => r.id)).toEqual(['course:101']);

		g.reset();
		expect(await g.visit('/c/101')).toContain('<h1>Intro</h1>');
		expect(g.log).toEqual([]);
		const views = (await g.storage.readBeacons()).map((b) => JSON.parse(b.event.body));
		expect(views.map((v) => [v.tier, v.reason]).slice(-2)).toEqual([
			['fallback', 'refused'],
			['local', 'fresh']
		]);
	});
});

describe('a sync for the next page', () => {
	const stale = async () => {
		const g = await provisioned();
		g.db.teachers['ada'] = 'Ada II';
		g.db.courses['102'] = 'Advanced II';
		await g.spool.invalidate(['teacher:ada', 'course:102']);
		g.advance(901);
		g.reset();
		return g;
	};

	it('transfers exactly the ids the page needs that moved, in one request', async () => {
		const g = await stale();
		await g.visit('/c/101');
		expect(g.log).toEqual(['GET /.spool/sync']);
		expect(g.urls[0]).toContain('need=');
		expect(g.urls[0]).not.toContain('from=');
		expect(g.syncs).toEqual([
			{
				protocol: 1,
				cursor: 1,
				changed: { 'course:102': 1 },
				dropped: [],
				reset: false,
				partial: true
			}
		]);
	});

	it('then refetches only what that change invalidated, naming what it holds', async () => {
		const g = await stale();
		await g.visit('/c/101');
		g.reset();
		const html = await g.visit('/c/101');
		expect(html).toContain('Advanced II');
		expect(g.log).toEqual(['GET /c/101', 'GET /.spool/artifact']);
		const shipped = parseArtifact(JSON.parse((g.artifacts[0] as { text: string }).text));
		expect(shipped.records?.map((r) => r.id)).toEqual(['course:102']);
		expect(shipped.projections?.map((p) => p.id)).toEqual(['menu']);
		expect(g.artifacts[0]?.url).toContain('have=');
	});

	it('leaves the cursor where it was, and a page it did not cover still gets its own change from the refetch', async () => {
		const g = await stale();
		const cursor = g.runtime.replica.cursor;
		await g.visit('/c/101');
		expect(g.runtime.replica.cursor).toBe(cursor);

		g.reset();
		await g.visit('/t/ada');
		expect(g.log).toEqual(['GET /t/ada', 'GET /.spool/artifact']);
		const shipped = parseArtifact(JSON.parse((g.artifacts[0] as { text: string }).text));
		expect(shipped.records?.map((r) => r.id)).toEqual(['course:102', 'teacher:ada']);
		g.reset();
		expect(await g.visit('/t/ada')).toContain('Ada II');
		expect(g.log).toEqual([]);
	});

	it('marks the page validated when nothing moved, so the next view makes no request', async () => {
		const g = await provisioned();
		g.advance(901);
		g.reset();
		await g.visit('/c/101');
		expect(g.log).toEqual(['GET /.spool/sync']);
		expect(g.syncs[0]).toMatchObject({ changed: {}, partial: true });
		await g.visit('/c/101');
		await g.visit('/c/101');
		expect(g.log).toEqual(['GET /.spool/sync']);
	});

	it('asks for the artifact path too, so an explicit drop reaches a graph page', async () => {
		const g = await provisioned();
		await g.spool.invalidate([], { drop: ['/d'] });
		g.advance(901);
		g.reset();
		await g.visit('/d');
		expect(g.syncs[0]).toMatchObject({ dropped: ['/d'] });
		expect(await g.runtime.replica.ids()).not.toContain('/d');
	});

	it('falls back to the full sync when a page depends on more ids than a request may name', async () => {
		const g = await provisioned();
		const stored = await g.runtime.replica.get('/c/101');
		const wide = {
			...(stored?.artifact as Artifact),
			deps: Array.from({ length: 70 }, (_, i) => `t:${i}`)
		};
		expect(g.runtime.replica.needFor(wide)).toBeNull();
		expect(
			g.runtime.replica.needFor({ ...wide, deps: ['a'], body: { data: 1 } } as Artifact)
		).toBeNull();
		expect(
			g.runtime.replica.needFor({ ...wide, deps: ['a'], body: { data: 1 } } as Artifact, true)
		).toMatchObject({
			a: wide.vector
		});
	});
});

describe('deferred sync', () => {
	const deferred = async () => {
		// a tag that changes hourly makes a sync worth its request 901 s on, whatever the default prior
		const g = graphRig({ sync: 'deferred', spool: { provision: { changesPerDay: 24 } } });
		for (const path of ['/c/101', '/about']) await g.visit(path);
		return g;
	};

	it('serves the local page with no request past the soft bound and queues the sync', async () => {
		const g = await deferred();
		g.advance(901);
		g.reset();
		const html = await g.visit('/c/101');
		expect(html).toContain('Intro');
		expect(g.log).toEqual([]);
	});

	it('sends the queued sync as one request at the next network moment, then stays quiet', async () => {
		const g = await deferred();
		g.advance(901);
		g.reset();
		await g.visit('/c/101');
		await g.visit('/about');
		expect(g.log).toEqual([]);
		await g.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(g.log).toEqual(['POST /form', 'GET /.spool/sync']);
		expect(g.urls[1]).toContain('need=');
		g.reset();
		await g.visit('/c/101');
		await g.visit('/about');
		expect(g.log).toEqual([]);
	});

	it('applies a change the deferred sync found, so the next view goes to the network', async () => {
		const g = await deferred();
		await g.spool.invalidate(['course:101']);
		g.advance(901);
		g.reset();
		await g.visit('/c/101');
		await g.drive(sub('/form', { method: 'POST', body: 'x' }));
		g.reset();
		await g.visit('/c/101');
		expect(g.log).toEqual(['GET /c/101', 'GET /.spool/artifact']);
	});

	it('reports the view as local, reason soft-deferred', async () => {
		const g = await deferred();
		g.advance(901);
		await g.visit('/c/101');
		const held = (await g.storage.readBeacons()).map((b) => JSON.parse(b.event.body));
		expect(held[held.length - 1]).toMatchObject({ tier: 'local', reason: 'soft-deferred' });
	});
});

describe('the graph loads on first need', () => {
	const counting = () => {
		const base = memoryStorage();
		const calls: Record<string, number> = {};
		const storage = new Proxy(base, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (typeof value !== 'function' || typeof prop !== 'string') return value;
				return (...args: unknown[]) => {
					calls[prop] = (calls[prop] ?? 0) + 1;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
		}) as ReplicaStorage;
		return { storage, calls };
	};

	const restarted = async () => {
		const first = await provisioned();
		await first.visit('/about');
		const { storage, calls } = counting();
		for (const artifact of await first.storage.allArtifacts())
			await storage.putArtifact(artifact);
		for (const record of await first.storage.allRecords()) await storage.putRecords([record]);
		for (const projection of await first.storage.allProjections()) {
			await storage.putProjections([projection]);
		}
		await storage.setMeta((await first.storage.getMeta()) as never);
		for (const key of Object.keys(calls)) delete calls[key];
		const runtime = createRuntime({
			config: first.spool.config,
			storage,
			fetch: async () => new Response('x'),
			caches: fakeCaches(),
			origin: ORIGIN
		});
		return { runtime, calls };
	};

	const drive = async (runtime: ReturnType<typeof createRuntime>, path: string) => {
		const waited: Promise<unknown>[] = [];
		const response = await runtime.handle(nav(path), (p) => void waited.push(p));
		await Promise.all(waited);
		return response?.text();
	};

	it('does not touch records or projections to answer a page that has none', async () => {
		const { runtime, calls } = await restarted();
		await drive(runtime, '/about');
		await drive(runtime, '/about');
		expect(calls['allRecords'] ?? 0).toBe(0);
		expect(calls['allProjections'] ?? 0).toBe(0);
		expect(runtime.replica.graph.loaded).toBe(false);
	});

	it('loads them once, on the first page that references them', async () => {
		const { runtime, calls } = await restarted();
		await drive(runtime, '/about');
		const html = await drive(runtime, '/c/101');
		expect(html).toContain('<h1>Intro</h1>');
		await drive(runtime, '/t/ada');
		await drive(runtime, '/d');
		expect(calls['allRecords']).toBe(1);
		expect(calls['allProjections']).toBe(1);
		expect(runtime.replica.graph.loaded).toBe(true);
	});

	it('drops what a change learned while it slept, and answers the page from the network', async () => {
		const g = await provisioned();
		const replica = new Replica(g.storage, g.spool.config.version);
		await replica.load();
		await replica.applySync({
			protocol: 1,
			cursor: 5,
			changed: { 'course:101': 5 },
			dropped: [],
			reset: false
		});
		expect(await g.storage.allRecords()).toHaveLength(4);
		expect(replica.graph.loaded).toBe(false);

		const stored = await replica.get('/d');
		expect(stored).toBeUndefined();
		await replica.materialize({
			...parseArtifact(JSON.parse((g.artifacts[2] as { text: string }).text))
		});
		expect((await g.storage.allRecords()).map((r) => r.id)).not.toContain('course:101');
		expect((await g.storage.allProjections()).map((p) => p.id)).toEqual(['roster:bo']);
	});

	it('answers the graph status message after loading', async () => {
		const g = await provisioned();
		const status = await g.runtime.message({ type: 'spool:graph' });
		expect(status).toEqual({
			type: 'spool:graph',
			records: ['course:101', 'course:102', 'site:name', 'teacher:ada'],
			projections: ['menu', 'roster:ada', 'roster:bo']
		});
	});
});

describe('provisioning, reported', () => {
	it('charges each artifact its bytes and requests against the local views served from it', async () => {
		const g = graphRig();
		for (const path of WALK) await g.visit(path);
		for (const path of ['/c/101', '/c/101', '/c/101', '/t/ada', '/d', '/d'])
			await g.visit(path);
		await g.visit('/about');
		const status = (await g.runtime.message({ type: 'spool:ledger' })) as {
			entries: Array<{ id: string; bytes: number; requests: number; views: number }>;
			totals: { bytes: number; requests: number; views: number; bytesPerView: number | null };
		};
		const encoder = new TextEncoder();
		expect(status.entries.map((e) => [e.id, e.requests, e.views])).toEqual([
			['/about', 1, 0],
			['/c/101', 1, 3],
			['/d', 1, 2],
			['/t/ada', 1, 1]
		]);
		const spent = g.artifacts.map((a) => encoder.encode(a.text).length);
		const byId = Object.fromEntries(status.entries.map((e) => [e.id, e.bytes]));
		expect(Object.values(byId).reduce((t, b) => t + b, 0)).toBe(
			spent.reduce((t, b) => t + b, 0)
		);
		expect(byId['/c/101']).toBe(spent[0]);
		expect(status.totals).toMatchObject({ requests: 4, views: 6 });
		expect(status.totals.bytesPerView).toBe(status.totals.bytes / 6);
		expect(byId['/t/ada']).toBeLessThan(
			encoder.encode(
				JSON.stringify(parseArtifact(JSON.parse(g.artifacts[1]?.text as string)))
			).length + 1
		);
	});

	it('reports a null cost per view before any view is served', async () => {
		const g = graphRig();
		await g.visit('/c/101');
		const status = (await g.runtime.message({ type: 'spool:ledger' })) as {
			totals: { views: number; bytesPerView: number | null };
		};
		expect(status.totals.views).toBe(0);
		expect(status.totals.bytesPerView).toBeNull();
	});
});

describe('materializing an artifact', () => {
	const held = async () => {
		const graph = new Graph({
			storage: memoryStorage(),
			tagVersion: () => 0,
			artifacts: async () => []
		});
		await graph.put(
			{
				protocol: 1,
				id: '/seed',
				scope: 'public',
				strategy: 'template',
				deps: [],
				vector: 1,
				body: { data: 1 },
				records: [
					{ id: 'nav', version: 1, data: '<nav></nav>' },
					{ id: 'year', version: 1, data: '2026' },
					{ id: 'obj', version: 1, data: { n: 1 } }
				],
				projections: [{ id: 'footer', version: 1, deps: ['year'], data: 'text' }]
			},
			true
		);
		return graph;
	};
	const assembly = (body: Record<string, unknown>): Artifact =>
		({
			protocol: 1,
			id: '/p',
			scope: 'public',
			strategy: 'assembly',
			deps: [],
			vector: 1,
			body
		}) as unknown as Artifact;

	it('fills an assembly page from references in its fragments and slots', async () => {
		const graph = await held();
		const result = await graph.materialize(
			assembly({
				shell: 's',
				fragments: { nav: { $record: 'nav' } },
				slots: { year: { $record: 'year' }, foot: { $projection: 'footer' }, plain: 'x' }
			})
		);
		expect(result).toEqual({
			ok: true,
			artifact: assembly({
				shell: 's',
				fragments: { nav: '<nav></nav>' },
				slots: { year: '2026', foot: 'text', plain: 'x' }
			})
		});
	});

	it('hands back a page with no references as it is, and one with only a shell', async () => {
		const graph = await held();
		const plain = assembly({ shell: 's' });
		expect(await graph.materialize(plain)).toEqual({ ok: true, artifact: plain });
		const result = await graph.materialize(
			assembly({ shell: 's', fragments: { a: { $record: 'nav' } } })
		);
		expect(result.ok && result.artifact).toEqual(
			assembly({ shell: 's', fragments: { a: '<nav></nav>' } })
		);
	});

	it('refuses a missing record, and a reference that resolves to something other than text', async () => {
		const graph = await held();
		expect(
			await graph.materialize(assembly({ shell: 's', fragments: { a: { $record: 'gone' } } }))
		).toEqual({ ok: false, reason: 'record gone is not stored' });
		expect(
			await graph.materialize(assembly({ shell: 's', slots: { a: { $record: 'obj' } } }))
		).toEqual({ ok: false, reason: 'a did not resolve to text' });
		expect(
			await graph.materialize(assembly({ shell: 's', fragments: { a: { $record: 'obj' } } }))
		).toEqual({ ok: false, reason: 'a did not resolve to text' });
		expect(
			await graph.materialize(
				assembly({ shell: 's', fragments: { ok: 'x' }, slots: { a: { $record: 'gone' } } })
			)
		).toEqual({ ok: false, reason: 'record gone is not stored' });
	});

	it('keeps a persist-false entry in memory only and removes its persisted copy', async () => {
		const storage = memoryStorage();
		const graph = new Graph({ storage, tagVersion: () => 0, artifacts: async () => [] });
		await storage.putRecords([{ id: 'r', version: 1, data: 'old' }]);
		await graph.records.put([{ id: 'r', version: 2, data: 'new' }], false);
		expect(graph.records.get('r')?.data).toBe('new');
		expect(await storage.allRecords()).toEqual([]);
		await graph.records.put([{ id: 'r', version: 2, data: 'same version' }], true);
		expect(graph.records.get('r')?.data).toBe('new');
		await graph.clear();
		expect(graph.records.ids()).toEqual([]);
	});
});
