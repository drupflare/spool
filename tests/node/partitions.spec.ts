import type { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createSpool, defineRoute, memorySink, partitionId } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { createRuntime, type PartitionStatus, type Runtime } from '../../src/sw/runtime';
import { memoryVault, sealedStorage } from '../../src/sw/seal';
import { memoryStorage } from '../../src/sw/storage';
import { artifact, fakeCaches, freshIndexedDB, nav, ORIGIN, sub } from './helpers';

const POLICY = "default-src 'self'";
const HTML = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY };
const page = (text: string) => `<html><head></head><body>${text}</body></html>`;
const source = '<html><head></head><body>grades of {{owner}} {{mark.score}}</body></html>';

function world() {
	const factory: IDBFactory = freshIndexedDB();
	const user = { current: null as string | null };
	const revoked = new Set<string>();
	const marks: Record<string, number> = { A: 91, B: 47 };
	const mine = (ctx: { identity: { principal: string } | null }) =>
		(ctx.identity as { principal: string }).principal;
	const principal = (retention: 'persistent' | 'session') => ({
		strategy: 'template' as const,
		scope: 'principal' as const,
		retention,
		template: { source },
		depends: (ctx: Parameters<typeof mine>[0]) => [`perm:${mine(ctx)}`, `grades:${mine(ctx)}`],
		load: (
			ctx: Parameters<typeof mine>[0] & { record: (id: string, data: unknown) => unknown }
		) => ({
			owner: mine(ctx),
			mark: ctx.record(`mark:${mine(ctx)}`, { score: marks[mine(ctx)] })
		})
	});
	const routes = [
		defineRoute('/grades', principal('persistent')),
		defineRoute('/inbox', principal('session')),
		defineRoute('/about', {
			strategy: 'template',
			template: { source: '<html><head></head><body>about</body></html>' },
			load: () => ({})
		})
	];
	const spool = createSpool({
		routes,
		store: memoryStore(),
		sink: memorySink(),
		beacons: ['/track'],
		logout: ['/logout'],
		identity: {
			secret: 's',
			resolve: () => (user.current ? { principal: user.current } : null)
		}
	});
	const hooks = {
		offline: false,
		afterArtifact: undefined as undefined | (() => Promise<void>),
		artifactHeaders: undefined as undefined | ((headers: Headers) => void)
	};
	const log: string[] = [];
	/** who the server saw behind each replayed beacon */
	const tracked: Array<string | null> = [];
	const cleared: unknown[] = [];
	let t = 1_700_000_000_000;

	const app = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		const as = user.current;
		const html = (text: string, init: ResponseInit = {}) =>
			new Response(page(text), { ...init, headers: { ...HTML, ...init.headers } });
		if (request.method === 'POST' && pathname === '/track') {
			tracked.push(as);
			return new Response(null, { status: 204 });
		}
		if (request.method === 'POST' && pathname === '/login') {
			user.current = searchParams.get('as');
			return html('welcome');
		}
		if (request.method === 'POST' && pathname === '/grades/edit') {
			marks[as as string] = (marks[as as string] as number) + 1;
			await spool.invalidate([`grades:${as}`, `mark:${as}`]);
			return html('saved');
		}
		if (pathname === '/logout') {
			user.current = null;
			return html('bye');
		}
		if (pathname === '/expire') {
			user.current = null;
			return html('expired', { headers: { 'spool-clear': '*' } });
		}
		if (pathname === '/grades' || pathname === '/inbox') {
			if (!as || revoked.has(as)) return html('no', { status: as ? 403 : 401 });
			return html(`grades of ${as} ${marks[as]}`);
		}
		if (pathname === '/about') return html('about');
		return html('missing', { status: 404 });
	};

	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		const url = new URL(request.url);
		log.push(`${request.method} ${url.pathname}`);
		if (hooks.offline) throw new TypeError('offline');
		let response = await spool.handle(request, app);
		if (url.pathname === '/.spool/artifact') {
			if (hooks.artifactHeaders) {
				const headers = new Headers(response.headers);
				hooks.artifactHeaders(headers);
				response = new Response(response.body, { status: response.status, headers });
			}
			await hooks.afterArtifact?.();
		}
		return response;
	};

	const caches = fakeCaches();
	const storage = memoryStorage();
	const boot = (partitions = idbPartitions(factory, idbVault(factory))): Runtime =>
		createRuntime({
			config: spool.config,
			storage,
			fetch: fetchImpl,
			caches,
			origin: ORIGIN,
			now: () => t,
			partitions,
			broadcast: (message) => void cleared.push(message)
		});
	const runtime = boot();

	async function drive(request: Request, target = runtime): Promise<Response> {
		const waited: Promise<unknown>[] = [];
		const pending = target.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}

	return {
		factory,
		user,
		revoked,
		marks,
		spool,
		hooks,
		log,
		tracked,
		storage,
		cleared,
		runtime,
		boot,
		drive,
		visit: async (path: string, target = runtime) => (await drive(nav(path), target)).text(),
		/** a request from another tab while this tab's background work is still waiting on the network */
		concurrent: async (request: Request) => {
			await (runtime.handle(request, () => undefined) as Promise<Response>);
			await new Promise((resolve) => setTimeout(resolve, 30));
		},
		post: (path: string, target = runtime) =>
			drive(nav(path, { method: 'POST', body: 'x' }), target),
		partition: async (target = runtime) =>
			(await target.message({ type: 'spool:partition' })) as PartitionStatus,
		advance: (seconds: number) => void (t += seconds * 1000),
		names: async () =>
			((await factory.databases()) as Array<{ name: string }>).map((d) => d.name).sort()
	};
}

async function rows(factory: IDBFactory, name: string, store: string): Promise<unknown[]> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const all = await new Promise<unknown[]>((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).getAll();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return all;
}

async function signIn(w: ReturnType<typeof world>, as: string, path = '/grades') {
	w.user.current = as;
	await w.visit(path);
}

describe('principal routes from a sealed per-partition store', () => {
	it('serves a principal page locally after one network view, from the partition of the signed-in user', async () => {
		const w = world();
		await signIn(w, 'A');
		expect(w.log).toEqual(['GET /grades', 'GET /.spool/artifact']);
		const held = await w.partition();
		expect(held.partition).toBe(await partitionId('s', 'A'));
		expect(held.artifacts).toEqual(['/grades']);
		expect(held.records).toEqual(['mark:A']);

		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 91');
		expect(w.log).toEqual([]);
	});

	it('leaves a principal route to the network when the worker has no partition host', async () => {
		const w = world();
		const bare = createRuntime({
			config: w.spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) =>
				w.spool.handle(
					new Request(input as string, init),
					async () => new Response(page('x'), { headers: HTML })
				),
			caches: fakeCaches(),
			origin: ORIGIN
		});
		w.user.current = 'A';
		for (let i = 0; i < 2; i++) {
			const waited: Promise<unknown>[] = [];
			await bare.handle(nav('/grades'), (p) => void waited.push(p));
			await Promise.all(waited);
		}
		expect(await bare.replica.ids()).toEqual([]);
	});

	it('keeps the ids and versions readable but nothing else: artifacts, records and meta are ciphertext, under a key that cannot be exported', async () => {
		const w = world();
		await signIn(w, 'A');
		const id = await partitionId('s', 'A');
		const artifacts = (await rows(w.factory, `spool-p-${id}`, 'artifacts')) as Array<{
			artifact: Record<string, unknown>;
			sealed: { data: ArrayBuffer };
		}>;
		expect(artifacts).toHaveLength(1);
		expect(Object.keys(artifacts[0]?.artifact ?? {})).toEqual(['id']);
		const text = new TextDecoder('latin1').decode(artifacts[0]?.sealed.data);
		expect(text).not.toContain('grades');
		expect(text).not.toContain('perm:A');
		const records = (await rows(w.factory, `spool-p-${id}`, 'records')) as Array<{
			data?: unknown;
			sealed: unknown;
		}>;
		expect(records[0]?.data).toBeUndefined();
		expect(records[0]?.sealed).toBeDefined();
		const keys = (await rows(w.factory, 'spool-keys', 'keys')) as CryptoKey[];
		expect(keys).toHaveLength(1);
		expect(keys[0]?.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', keys[0] as CryptoKey)).rejects.toThrow();
	});

	it("wipes the previous partition when the signed-in user changes, and never shows one user the other's page", async () => {
		const w = world();
		await signIn(w, 'A');
		await w.visit('/grades');
		const a = await partitionId('s', 'A');
		expect(await w.names()).toContain(`spool-p-${a}`);

		await w.post('/login?as=B');
		const afterSwitch = await w.partition();
		expect(afterSwitch.partition).toBe(await partitionId('s', 'B'));
		expect(afterSwitch.artifacts).toEqual([]);
		expect(afterSwitch.records).toEqual([]);
		expect(await w.names()).not.toContain(`spool-p-${a}`);
		expect(w.cleared).toContainEqual({ type: 'spool:cleared', reason: 'partition' });

		w.log.length = 0;
		const first = await w.visit('/grades');
		expect(first).toContain('grades of B 47');
		expect(w.log[0]).toBe('GET /grades');
		const second = await w.visit('/grades');
		expect(second).toContain('grades of B 47');
		expect(second).not.toContain('grades of A');
		expect((await w.partition()).records).toEqual(['mark:B']);
	});

	it('does not decrypt a row copied into another partition, another id, or after its key is shredded', async () => {
		const vault = memoryVault();
		const innerA = memoryStorage();
		const innerB = memoryStorage();
		const options = {
			vault,
			retentionOf: () => 'persistent' as const,
			shared: 'persistent' as const
		};
		const a = sealedStorage(innerA, { ...options, partition: 'A' });
		const b = sealedStorage(innerB, { ...options, partition: 'B' });
		await a.putArtifact({ artifact: artifact({ id: '/secret' }), fetchedAt: 1 });
		expect((await a.getArtifact('/secret'))?.artifact.id).toBe('/secret');

		const raw = (await innerA.getArtifact('/secret')) as never;
		await innerB.putArtifact(raw);
		await b.getMeta();
		expect(await b.getArtifact('/secret')).toBeUndefined();

		const moved = JSON.parse(JSON.stringify({ artifact: { id: '/other' } }));
		await innerA.putArtifact({ ...(raw as object), ...moved });
		expect(await a.getArtifact('/other')).toBeUndefined();

		await vault.shred('A');
		const again = sealedStorage(innerA, { ...options, partition: 'A' });
		expect(await again.getArtifact('/secret')).toBeUndefined();
		expect(await again.allArtifacts()).toEqual([]);
	});

	it('ignores a write that arrives after the store is shut', async () => {
		const inner = memoryStorage();
		const sealed = sealedStorage(inner, {
			vault: memoryVault(),
			partition: 'A',
			retentionOf: () => 'session',
			shared: 'session'
		});
		sealed.kill();
		await sealed.putArtifact({ artifact: artifact(), fetchedAt: 1 });
		await sealed.putRecords([{ id: 'r', version: 1, data: {} }]);
		await sealed.setMeta({ version: 'v', cursor: 1, tags: [], syncedAt: 1 });
		expect(await inner.allArtifacts()).toEqual([]);
		expect(await inner.allRecords()).toEqual([]);
		expect(await inner.getMeta()).toBeUndefined();
	});

	it('keeps a persistent route across a worker restart and loses a session route, whose key lived in memory', async () => {
		const w = world();
		w.user.current = 'A';
		await w.visit('/grades');
		await w.visit('/inbox');
		expect((await w.partition()).artifacts).toEqual(['/grades', '/inbox']);

		const restarted = w.boot();
		w.log.length = 0;
		expect(await w.visit('/grades', restarted)).toContain('grades of A 91');
		expect(w.log).toEqual([]);
		expect((await w.visit('/inbox', restarted)).length).toBeGreaterThan(0);
		expect(w.log[0]).toBe('GET /inbox');
		expect((await w.partition(restarted)).artifacts).toContain('/grades');
	});
});

describe('security headers on a principal page', () => {
	it("replays the site's policy from the sealed store and keeps it across a restart", async () => {
		const w = world();
		await signIn(w, 'A');
		w.log.length = 0;
		const local = await w.drive(nav('/grades'));
		expect(w.log).toEqual([]);
		expect(local.headers.get('content-security-policy')).toBe(POLICY);

		const restarted = w.boot();
		const again = await w.drive(nav('/grades'), restarted);
		expect(w.log).toEqual([]);
		expect(again.headers.get('content-security-policy')).toBe(POLICY);
	});
});

describe('logout and the end of a session', () => {
	it('sends the held same-origin beacons while the session is still the signed-out user, then wipes', async () => {
		const w = world();
		await signIn(w, 'A');
		await w.drive(sub('/track', { method: 'POST', body: 'one' }));
		await w.drive(sub('/track', { method: 'POST', body: 'two' }));
		expect(w.tracked).toEqual([]);

		w.log.length = 0;
		await w.visit('/logout');
		expect(w.log.slice(0, 3)).toEqual(['POST /track', 'POST /track', 'GET /logout']);
		expect(w.tracked).toEqual(['A', 'A']);
		expect((await w.partition()).partition).toBeNull();
		const left = await w.storage.readBeacons();
		expect(left.filter((b) => b.event.path === '/track')).toEqual([]);

		w.user.current = 'B';
		w.advance(25 * 3600);
		await w.visit('/about');
		expect(w.tracked).toEqual(['A', 'A']);
	});

	it('drops the held same-origin beacons and counts them when the logout cannot send them, and never replays them for the next user', async () => {
		const w = world();
		await signIn(w, 'A');
		await w.drive(sub('/track', { method: 'POST', body: 'one' }));
		await w.drive(sub('/track', { method: 'POST', body: 'two' }));

		w.hooks.offline = true;
		w.log.length = 0;
		await expect(w.drive(nav('/logout'))).rejects.toThrow();
		expect(w.log.filter((line) => line === 'POST /track')).toHaveLength(1);
		expect((await w.partition()).partition).toBeNull();
		const held = (await w.runtime.message({ type: 'spool:held' })) as {
			dropped: Record<string, number>;
		};
		expect(held.dropped).toEqual({ 'same-origin': 2 });
		const left = await w.storage.readBeacons();
		expect(left.filter((b) => b.event.path === '/track')).toEqual([]);
		const record = left.find((b) => b.event.path === '/.spool/dropped');
		expect(JSON.parse(record?.event.body ?? '{}')).toEqual({ vendor: 'same-origin', count: 2 });

		w.hooks.offline = false;
		w.user.current = 'B';
		w.advance(25 * 3600);
		await w.visit('/about');
		expect(w.tracked).toEqual([]);
	});

	it('does not send or drop held cross-origin events before the logout, which carry no cookies', async () => {
		const w = world();
		await signIn(w, 'A');
		await w.storage.addBeacon({
			path: '/collect',
			origin: 'https://vendor.test',
			vendor: 'v',
			body: 'x',
			contentType: 'text/plain',
			at: 1_700_000_000_000
		});
		await w.visit('/logout');
		expect(w.log.indexOf('POST /collect')).toBeGreaterThan(w.log.indexOf('GET /logout'));
		const held = (await w.runtime.message({ type: 'spool:held' })) as {
			dropped: Record<string, number>;
		};
		expect(held.dropped).toEqual({});
	});

	it('reads a valid Spool-Clear beside a malformed spool header, and a malformed Spool-Clear as a wipe', async () => {
		const cases: Array<Record<string, string>> = [
			{ 'spool-artifact': 'noequals', 'spool-clear': '*' },
			{ 'spool-vector': 'x', 'spool-clear': '%E0%A4%A' }
		];
		for (const headers of cases) {
			const w = world();
			await signIn(w, 'A');
			const a = await partitionId('s', 'A');
			const broken = createRuntime({
				config: w.spool.config,
				storage: memoryStorage(),
				fetch: async () =>
					new Response(page('x'), {
						headers: { ...HTML, 'spool-protocol': '1', ...headers }
					}),
				caches: fakeCaches(),
				origin: ORIGIN,
				partitions: idbPartitions(w.factory, idbVault(w.factory))
			});
			expect((await w.partition(broken)).partition).toBe(a);
			const waited: Promise<unknown>[] = [];
			await broken.handle(nav('/about'), (p) => void waited.push(p));
			await Promise.all(waited);
			expect((await w.partition(broken)).partition).toBeNull();
		}
	});

	it('wipes before the request leaves, with the network down', async () => {
		const w = world();
		await signIn(w, 'A');
		const a = await partitionId('s', 'A');
		w.hooks.offline = true;
		w.log.length = 0;
		await expect(w.drive(nav('/logout'))).rejects.toThrow();
		expect(w.log).toEqual(['GET /logout', 'GET /logout']);
		expect((await w.partition()).partition).toBeNull();
		expect(await w.names()).not.toContain(`spool-p-${a}`);
		expect(await rows(w.factory, 'spool-keys', 'keys')).toEqual([]);
		expect(w.cleared).toContainEqual({ type: 'spool:cleared', reason: 'logout' });

		await expect(w.visit('/grades')).rejects.toThrow();
		expect((await w.partition()).artifacts).toEqual([]);
	});

	it('empties every tab online: another tab of the same worker finds nothing and asks the network', async () => {
		const w = world();
		await signIn(w, 'A');
		await w.visit('/grades');
		await w.visit('/logout');
		w.log.length = 0;
		const body = await w.visit('/grades');
		expect(body).toContain('no');
		expect(w.log).toEqual(['GET /grades']);
		expect((await w.partition()).partition).toBeNull();
		const restarted = w.boot();
		expect((await w.partition(restarted)).artifacts).toEqual([]);
	});

	it('wipes on Spool-Clear, and on a decorated navigation that carries no partition', async () => {
		const w = world();
		await signIn(w, 'A');
		await w.visit('/expire');
		expect((await w.partition()).partition).toBeNull();

		await signIn(w, 'A');
		expect((await w.partition()).partition).not.toBeNull();
		w.user.current = null;
		await w.visit('/about');
		expect((await w.partition()).partition).toBeNull();
		expect(w.cleared.map((m) => (m as { reason: string }).reason)).toEqual([
			'clear',
			'session-ended'
		]);
	});

	it('sends Clear-Site-Data with the hard reset and Spool-Clear tokens for one partition', async () => {
		const w = world();
		const response = await w.spool.decorate(
			new Request(`${ORIGIN}/logout`),
			new Response('x', { headers: HTML }),
			{ clear: ['abc'], hardReset: true }
		);
		expect(response.headers.get('clear-site-data')).toBe('"storage"');
		expect(response.headers.get('spool-clear')).toBe('abc');

		await signIn(w, 'A');
		const a = await partitionId('s', 'A');
		const other = await w.drive(nav('/about'));
		expect(other.status).toBe(200);
		const wiped = createRuntime({
			config: w.spool.config,
			storage: memoryStorage(),
			fetch: async () =>
				new Response(page('x'), {
					headers: {
						...HTML,
						'spool-protocol': '1',
						'spool-clear': a,
						'spool-partition': a
					}
				}),
			caches: fakeCaches(),
			origin: ORIGIN,
			partitions: idbPartitions(w.factory, idbVault(w.factory))
		});
		expect((await w.partition(wiped)).partition).toBe(a);
		const waited: Promise<unknown>[] = [];
		await wiped.handle(nav('/about'), (p) => void waited.push(p));
		await Promise.all(waited);
		expect((await w.partition(wiped)).partition).toBeNull();
	});

	it('does not bring a partition back from the answer to its own logout, which still names it', async () => {
		const w = world();
		await signIn(w, 'A');
		const a = await partitionId('s', 'A');
		const stale = createRuntime({
			config: w.spool.config,
			storage: memoryStorage(),
			fetch: async () =>
				new Response(page('bye'), {
					headers: { ...HTML, 'spool-protocol': '1', 'spool-partition': a }
				}),
			caches: fakeCaches(),
			origin: ORIGIN,
			partitions: idbPartitions(w.factory, idbVault(w.factory))
		});
		expect((await w.partition(stale)).partition).toBe(a);
		const waited: Promise<unknown>[] = [];
		await stale.handle(nav('/logout'), (p) => void waited.push(p));
		await Promise.all(waited);
		expect((await w.partition(stale)).partition).toBeNull();
	});
});

describe('principal data fails safe', () => {
	it('catches a revoked permission at the first required sync, on a fake clock', async () => {
		const w = world();
		await signIn(w, 'A');
		w.revoked.add('A');
		await w.spool.invalidate(['perm:A']);

		w.advance(100);
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 91');
		expect(w.log).toEqual([]);

		w.advance(300);
		const body = await w.visit('/grades');
		expect(body).toContain('no');
		expect(w.log[0]).toMatch(/^GET \/\.spool\/sync$/);
		expect(w.log).toContain('GET /grades');
		expect((await w.partition()).artifacts).toEqual([]);
	});

	it('ends the open window at the first required sync after a sign-in the worker never saw', async () => {
		const w = world();
		await signIn(w, 'A');
		w.user.current = 'B';

		w.advance(100);
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 91');
		expect(w.log).toEqual([]);

		w.advance(300);
		const body = await w.visit('/grades');
		expect(w.log[0]).toBe('GET /.spool/sync');
		expect(body).toContain('grades of B 47');
		expect(body).not.toContain('grades of A');
		expect((await w.partition()).partition).toBe(await partitionId('s', 'B'));
		expect(w.cleared).toContainEqual({ type: 'spool:cleared', reason: 'partition' });
		expect(await w.names()).not.toContain(`spool-p-${await partitionId('s', 'A')}`);
	});

	it('wipes the principal store at the first required sync after a sign-out the worker never saw', async () => {
		const w = world();
		await signIn(w, 'A');
		w.user.current = null;
		w.advance(301);
		const body = await w.visit('/grades');
		expect(w.log).toContain('GET /.spool/sync');
		expect(body).not.toContain('grades of A');
		expect((await w.partition()).partition).toBeNull();
		expect(w.cleared).toContainEqual({ type: 'spool:cleared', reason: 'session-ended' });
	});

	it('refuses a hard principal route offline past its bound', async () => {
		const w = world();
		await signIn(w, 'A');
		w.advance(301);
		w.hooks.offline = true;
		await expect(w.visit('/grades')).rejects.toThrow();
	});

	it('falls back to the network after a form submission that changes what the page reads', async () => {
		const w = world();
		await signIn(w, 'A');
		expect(await w.visit('/grades')).toContain('grades of A 91');
		await w.post('/grades/edit');
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 92');
		expect(w.log).toContain('GET /grades');
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 92');
		expect(w.log).toEqual([]);
	});

	it('does not keep an artifact built before a write that the worker learns of first', async () => {
		const w = world();
		w.user.current = 'A';
		w.hooks.afterArtifact = async () => {
			w.hooks.afterArtifact = undefined;
			await w.concurrent(nav('/grades/edit', { method: 'POST', body: 'x' }));
		};
		await w.visit('/grades');
		expect((await w.partition()).artifacts).toEqual([]);
		w.log.length = 0;
		expect(await w.visit('/grades')).toContain('grades of A 92');
		expect(w.log[0]).toBe('GET /grades');
	});

	it('does not store an artifact answered for another partition', async () => {
		const w = world();
		w.user.current = 'A';
		w.hooks.artifactHeaders = (headers) => headers.set('spool-partition', 'someone-else');
		await w.visit('/grades');
		expect((await w.partition()).artifacts).toEqual([]);
	});

	it('drops a stored page when the server answers its route with a refusal', async () => {
		const w = world();
		await signIn(w, 'A');
		w.advance(301);
		w.revoked.add('A');
		w.hooks.offline = false;
		await w.spool.invalidate(['perm:A']);
		await w.visit('/grades');
		const again = await w.drive(nav('/grades'));
		expect(again.status).toBe(403);
		expect((await w.partition()).artifacts).toEqual([]);
	});

	it('does not let a request that outlives a logout bring the store back', async () => {
		const w = world();
		w.user.current = 'A';
		const a = await partitionId('s', 'A');
		w.hooks.afterArtifact = async () => {
			w.hooks.afterArtifact = undefined;
			await w.concurrent(nav('/logout'));
		};
		await w.visit('/grades');
		expect((await w.partition()).partition).toBeNull();
		expect(await w.names()).not.toContain(`spool-p-${a}`);
		expect(await rows(w.factory, 'spool-keys', 'keys')).toEqual([]);
	});
});
