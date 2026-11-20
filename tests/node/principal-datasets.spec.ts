import type { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
	buildPack,
	defineDataset,
	ProtocolError,
	readBundle,
	setProof,
	type Dataset,
	type DatasetContext,
	type DatasetResponse
} from '../../src/protocol/index';
import { buildBundle, createSpool, defineRoute, memoryBundleStore } from '../../src/server/index';
import { buildRing, RING_BYTES } from '../../src/server/ring';
import { memoryStore } from '../../src/stores/index';
import { principalGuard, syncDataset, type DatasetOutcome } from '../../src/sw/dataset-sync';
import { createPackStore, type PackStore } from '../../src/sw/pack/store';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { idbPrincipalDatasets, sealedDatasets } from '../../src/sw/principal-dataset';
import { Replica } from '../../src/sw/replica';
import type { PartitionStatus } from '../../src/sw/runtime';
import { memoryVault } from '../../src/sw/seal';
import { freshIndexedDB, nav, ORIGIN, sub } from './helpers';
import { HTML, rig } from './rig';

// #region the site: a principal dataset of orders, one feed per principal

type Order = { id: string; note: string; dept: string };

const DB = 'spool-principal-datasets';
const page = (text: string) => `<html><head></head><body>${text}</body></html>`;
const byId = (a: Order, b: Order) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

class Ledger {
	rows = new Map<string, Map<string, Order>>();
	cursors = new Map<string, number>();
	events = new Map<string, Array<{ cursor: number; key: string }>>();
	/** `principal function argument` for every dataset function the server ran */
	calls: string[] = [];
	/** a principal's seed waits on this */
	gate = new Map<string, Promise<void>>();
	forbidden = new Set<string>();
	/** how many of the next patches carry a wrong proof */
	lies = 0;

	cursorOf(who: string): number {
		return this.cursors.get(who) ?? 0;
	}

	list(who: string): Order[] {
		return [...(this.rows.get(who)?.values() ?? [])].sort(byId);
	}

	put(who: string, row: Order): void {
		const rows = this.rows.get(who) ?? new Map<string, Order>();
		this.rows.set(who, rows);
		rows.set(row.id, row);
		this.bump(who, row.id);
	}

	remove(who: string, id: string): void {
		this.rows.get(who)?.delete(id);
		this.bump(who, id);
	}

	private bump(who: string, key: string): void {
		const cursor = this.cursorOf(who) + 1;
		this.cursors.set(who, cursor);
		this.events.set(who, [...(this.events.get(who) ?? []), { cursor, key }]);
	}
}

function orders(ledger: Ledger, maxStaleMs = 60_000): Dataset<Order> {
	const enter = (ctx: DatasetContext, fn: string, arg = ''): string => {
		const who = ctx.principal?.principal as string;
		ledger.calls.push(`${who} ${fn}${arg ? ` ${arg}` : ''}`);
		if (ledger.forbidden.has(who)) throw new ProtocolError('dataset-forbidden', 'no access');
		return who;
	};
	return defineDataset<Order>(
		'orders',
		{
			scope: 'principal',
			maxStaleMs,
			schema: 'v1',
			maxRows: 1000,
			maxBytes: 1_000_000,
			key: (row) => row.id,
			seed: async (ctx) => {
				const who = enter(ctx, 'seed', ctx.after ?? '');
				await ledger.gate.get(who);
				return ledger.list(who).filter((r) => ctx.after === undefined || r.id > ctx.after);
			},
			read: (ids, ctx) => {
				const who = enter(ctx, 'read', ids.join(','));
				return ids.flatMap((id) => ledger.rows.get(who)?.get(id) ?? []);
			},
			changes: (since, ctx) => {
				const who = enter(ctx, 'changes', String(since));
				const cursor = ledger.cursorOf(who);
				const touched = [
					...new Set(
						(ledger.events.get(who) ?? [])
							.filter((e) => e.cursor > since)
							.map((e) => e.key)
					)
				];
				const held = ledger.rows.get(who);
				const out = {
					cursor,
					puts: touched.filter((key) => held?.has(key)),
					deletes: touched
						.filter((key) => !held?.has(key))
						.map((key) => ({ key, cursor }))
				};
				if (ledger.lies > 0) {
					ledger.lies -= 1;
					return {
						...out,
						proof: { kind: 'set' as const, count: 9999, digest: '0'.repeat(64) }
					};
				}
				return out;
			},
			horizon: (ctx) => {
				enter(ctx, 'horizon');
				return 0;
			},
			head: (ctx) => {
				const who = enter(ctx, 'head');
				return { cursor: ledger.cursorOf(who) };
			}
		},
		{ principalDatasets: true }
	);
}

const SOURCE =
	'<html><head></head><body>{{#each items}}<i>{{id}}:{{note}}</i>{{/each}}</body></html>';

type Over = { flag?: boolean; maxStaleMs?: number };

function site(over: Over = {}) {
	const ledger = new Ledger();
	const user = { current: null as string | null };
	const dataset = orders(ledger, over.maxStaleMs);
	const on = over.flag !== false;
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const rows = user.current ? ledger.list(user.current) : [];
		const list = rows.map((r) => `<i>${r.id}:${r.note}</i>`).join('');
		if (pathname === '/login' || pathname === '/orders')
			return new Response(page(list), { headers: HTML });
		if (pathname === '/logout') {
			user.current = null;
			return new Response(page('bye'), { headers: HTML });
		}
		if (pathname === '/clear') {
			return new Response(page('cleared'), { headers: { ...HTML, 'spool-clear': '*' } });
		}
		if (pathname === '/about') return new Response(page('about'), { headers: HTML });
		return new Response(page('missing'), { status: 404, headers: HTML });
	};
	const r = rig({
		routes: [
			defineRoute('/orders', {
				strategy: 'template',
				scope: 'principal',
				retention: 'persistent',
				freshness: { maxStale: 1_000_000, mode: 'soft' },
				template: { source: SOURCE },
				...(on
					? {
							query: {
								list: 'items',
								dataset: 'orders',
								filter: { dept: 'string' as const },
								pageSize: 10
							}
						}
					: {}),
				load: () => ({ title: 'orders', items: [] })
			}),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: page('about') },
				load: () => ({})
			})
		],
		app,
		spool: {
			...(on ? { datasets: [dataset], principalDatasets: true } : {}),
			logout: ['/logout'],
			identity: {
				secret: 's',
				resolve: () => (user.current ? { principal: user.current } : null)
			}
		}
	});
	return { ledger, user, r, app, dataset };
}

type Site = ReturnType<typeof site>;

function ask(
	s: Site,
	as: string | null,
	query = 'name=orders',
	extra: Record<string, string> = {}
) {
	s.user.current = as;
	return s.r.spool.respond(new Request(`${ORIGIN}/.spool/dataset?${query}`, { headers: extra }));
}

async function seedOf(s: Site, as: string) {
	const response = await ask(s, as);
	return (await (response as Response).json()) as DatasetResponse;
}

// #endregion

// #region helpers that read IndexedDB the way an attacker with the disk would

async function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = factory.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function records(factory: IDBFactory, name: string, store: string): Promise<unknown[]> {
	const db = await open(factory, name);
	const all = await new Promise<unknown[]>((resolve, reject) => {
		const request = db.transaction(store).objectStore(store).getAll();
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return all;
}

const names = async (factory: IDBFactory) =>
	((await factory.databases()) as Array<{ name: string }>).map((d) => d.name).sort();

const asText = (_key: string, value: unknown) => {
	const bytes =
		value instanceof ArrayBuffer
			? new Uint8Array(value)
			: ArrayBuffer.isView(value)
				? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
				: undefined;
	return bytes ? String.fromCharCode(...bytes) : value;
};

/** every record of every database, keys included, as one searchable string */
async function everything(factory: IDBFactory): Promise<string> {
	let text = '';
	for (const name of await names(factory)) {
		const db = await open(factory, name);
		for (const store of [...db.objectStoreNames]) {
			const [keys, values] = await Promise.all(
				(['getAllKeys', 'getAll'] as const).map(
					(method) =>
						new Promise<unknown[]>((resolve, reject) => {
							const request = db.transaction(store).objectStore(store)[method]();
							request.onsuccess = () => resolve(request.result);
							request.onerror = () => reject(request.error);
						})
				)
			);
			text += JSON.stringify([name, store, keys, values], asText);
		}
		db.close();
	}
	return text;
}

const partitionsIn = async (factory: IDBFactory, store: 'rows' | 'meta') =>
	[
		...new Set(
			((await records(factory, DB, store)) as Array<{ partition: string }>).map(
				(r) => r.partition
			)
		)
	].sort();

// #endregion

// #region the worker

const SECRET_NOTE = (who: string, n: number) => `${who}-confidential-${n}`;
const need = expect.stringContaining('GET /.spool/sync?need=');

function world(over: Over = {}) {
	const s = site(over);
	const factory: IDBFactory = freshIndexedDB();
	const broadcasts: unknown[] = [];
	const log: string[] = [];
	const net: { intercept?: (request: Request) => Response | undefined } = {};
	const runtime = s.r.make({
		partitions: idbPartitions(factory, idbVault(factory)),
		broadcast: (message) => void broadcasts.push(message),
		fetch: async (input, init) => {
			const request = new Request(input as string, init);
			const url = new URL(request.url);
			log.push(`${request.method} ${url.pathname}${url.search}`);
			return net.intercept?.(request) ?? s.r.spool.handle(request, s.app);
		}
	});
	const drive = (request: Request) => s.r.drive(request, runtime);
	const visit = async (path: string) => (await drive(nav(path))).text();
	const status = async () =>
		(await runtime.message({ type: 'spool:partition' })) as PartitionStatus;
	/**
	 * Signs in through a login page, which names the partition as a login handler must, then visits
	 * twice: the first provisions the page, the second seeds the rows.
	 */
	const hold = async (who: string) => {
		s.user.current = who;
		await visit('/login');
		await visit('/orders');
		await visit('/orders');
	};
	const fill = (who: string, n: number) => {
		for (let i = 1; i <= n; i++) {
			s.ledger.put(who, {
				id: `${who}-o${i}`,
				note: SECRET_NOTE(who, i),
				dept: i % 2 ? 'a' : 'b'
			});
		}
	};
	return {
		...s,
		factory,
		broadcasts,
		log,
		net,
		runtime,
		drive,
		visit,
		status,
		hold,
		fill,
		reset: () => void (log.length = 0),
		partition: (who: string) => s.r.spool.partition(who)
	};
}

// #endregion

describe('declaring a principal dataset', () => {
	const base = () => ({
		scope: 'principal' as const,
		schema: 'v1',
		maxRows: 10,
		maxBytes: 1000,
		maxStaleMs: 1000,
		key: (row: Order) => row.id,
		seed: () => [],
		read: () => [],
		changes: () => 'reset' as const,
		horizon: () => 0,
		head: () => ({ cursor: 0 })
	});

	it('throws bad-dataset without the option, naming it', () => {
		expect(() => defineDataset('x', base())).toThrow(/principal datasets flag/);
		expect(() => defineDataset('x', base())).toThrow(/principalDatasets/);
	});

	it('needs a positive maxStaleMs and refuses provision auto on a principal dataset', () => {
		const flag = { principalDatasets: true };
		const { maxStaleMs: _drop, ...without } = base();
		expect(() => defineDataset('x', without, flag)).toThrow('maxStaleMs');
		expect(() => defineDataset('x', { ...base(), maxStaleMs: 0 }, flag)).toThrow('maxStaleMs');
		expect(() => defineDataset('x', { ...base(), maxStaleMs: 1.5 }, flag)).toThrow(
			'maxStaleMs'
		);
		expect(() => defineDataset('x', { ...base(), provision: 'auto' }, flag)).toThrow('auto');
		expect(defineDataset('x', base(), flag).maxStaleMs).toBe(1000);
	});

	it('refuses maxStaleMs on a public dataset', () => {
		expect(() => defineDataset('x', { ...base(), scope: 'public' })).toThrow('maxStaleMs');
	});

	it('makes createSpool refuse the dataset without its own flag and without an identity', () => {
		const s = site();
		const routes = [
			defineRoute('/about', {
				strategy: 'template',
				template: { source: page('a') },
				load: () => ({})
			})
		];
		const off = () => createSpool({ routes, store: memoryStore(), datasets: [s.dataset] });
		expect(off).toThrow(/principalDatasets option/);
		expect(() =>
			createSpool({
				routes,
				store: memoryStore(),
				datasets: [s.dataset],
				principalDatasets: true
			})
		).toThrow('identity');
	});

	it('keeps scopes apart: a public route cannot query a principal dataset and the reverse', () => {
		const s = site();
		const publicSet = defineDataset<Order>('open', {
			...base(),
			scope: 'public',
			maxStaleMs: undefined as never
		});
		const route = (scope: 'public' | 'principal', dataset: string) =>
			defineRoute(`/${scope}-${dataset}`, {
				strategy: 'data',
				scope,
				load: () => ({}),
				query: { list: 'items', dataset }
			});
		const make = (routes: ReturnType<typeof route>[]) =>
			createSpool({
				routes,
				store: memoryStore(),
				datasets: [s.dataset, publicSet],
				principalDatasets: true,
				identity: { secret: 's', resolve: () => null }
			});
		expect(() => make([route('public', 'orders')])).toThrow(
			/public route cannot query the principal/
		);
		expect(() => make([route('principal', 'open')])).toThrow(
			/principal route cannot query the public/
		);
		expect(() => make([route('principal', 'orders'), route('public', 'open')])).not.toThrow();
	});

	it('allows query on a principal route only with query.dataset and no plan', () => {
		const declare = (query: object) => () =>
			defineRoute('/q', {
				strategy: 'data',
				scope: 'principal',
				load: () => ({}),
				query
			} as never);
		expect(declare({ list: 'items' })).toThrow(/only with query.dataset/);
		expect(declare({ list: 'items', dataset: 'orders', plan: { group: ['dept'] } })).toThrow();
		expect(declare({ list: 'items', dataset: 'orders' })).not.toThrow();
	});
});

describe('the principal dataset endpoint', () => {
	it('answers 401 with no identity, private and uncacheable', async () => {
		const s = site();
		const response = (await ask(s, null)) as Response;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'sign in' });
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('spool-partition')).toBeNull();
		expect(s.ledger.calls).toEqual([]);
	});

	it('answers with exactly these headers: private no-store, the partition, the protocol', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		const response = (await ask(s, 'ada')) as Response;
		expect(response.status).toBe(200);
		expect([...response.headers.keys()].sort()).toEqual([
			'cache-control',
			'content-type',
			'spool-partition',
			'spool-protocol'
		]);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('spool-partition')).toBe(await s.r.spool.partition('ada'));
		expect(response.headers.get('spool-protocol')).toBe('1');
	});

	it('answers 403 for a dataset-forbidden refusal, private and with no row', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'private words', dataset: 'x' } as never);
		s.ledger.forbidden.add('ada');
		const response = (await ask(s, 'ada')) as Response;
		expect(response.status).toBe(403);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.text()).toBe('{"error":"forbidden"}');
	});

	it('hands a principal dataset its identity and a public dataset none, with the public headers', async () => {
		const s = site();
		await ask(s, 'ada');
		expect(s.ledger.calls).toEqual(['ada head', 'ada seed']);
		const seen: Array<Record<string, unknown>> = [];
		const open = defineDataset<Order>('open', {
			scope: 'public',
			schema: 'v1',
			maxRows: 10,
			maxBytes: 1000,
			key: (row) => row.id,
			seed: (ctx) => (seen.push(ctx as never), []),
			read: () => [],
			changes: () => 'reset',
			horizon: () => 0,
			head: () => ({ cursor: 0 })
		});
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [open],
			identity: { secret: 's', resolve: () => ({ principal: 'ada' }) }
		});
		const response = (await spool.respond(
			new Request(`${ORIGIN}/.spool/dataset?name=open`)
		)) as Response;
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(Object.keys(seen[0] as object).sort()).toEqual(['request', 'url']);
		expect([...response.headers.keys()].sort()).toEqual([
			'cache-control',
			'content-type',
			'spool-protocol'
		]);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('derives everything from the identity: another principal key in the URL changes nothing', async () => {
		const s = site();
		for (let i = 1; i <= 3; i++)
			s.ledger.put('ada', { id: `a${i}`, note: `ada-${i}`, dept: 'a' });
		for (let i = 1; i <= 7; i++)
			s.ledger.put('bob', { id: `b${i}`, note: `bob-${i}`, dept: 'a' });
		// bob's cursor is 7 and his key is b5; ada asks for both, and names bob outright
		const patch = (await (
			(await ask(s, 'ada', 'name=orders&since=2&schema=v1&principal=bob&as=bob')) as Response
		).json()) as DatasetResponse;
		expect(patch.reset).toBe(false);
		expect(patch.cursor).toBe(3);
		expect(patch.puts.map((p) => p.key)).toEqual(['a3']);
		const ahead = (await (
			(await ask(s, 'ada', 'name=orders&since=7&schema=v1')) as Response
		).json()) as DatasetResponse;
		expect(ahead.reset).toBe(true);
		expect(ahead.cursor).toBe(3);
		const paged = (await (
			(await ask(s, 'ada', 'name=orders&after=b5&limit=5')) as Response
		).json()) as DatasetResponse;
		expect(paged.puts).toEqual([]);
		for (const body of [patch, ahead, paged]) expect(JSON.stringify(body)).not.toContain('bob');
		expect(s.ledger.calls.every((c) => c.startsWith('ada '))).toBe(true);
	});
});

describe('holding a principal dataset', () => {
	it('answers a held query with no request, from rows sealed in the partition', async () => {
		const w = world();
		w.fill('ada', 3);
		await w.hold('ada');
		const status = await w.status();
		expect(status.partition).toBe(await w.partition('ada'));
		expect(status.datasets).toMatchObject([{ name: 'orders', count: 3, cursor: 3 }]);
		w.reset();
		const body = await w.visit('/orders');
		expect(w.log).toEqual([]);
		for (let i = 1; i <= 3; i++)
			expect(body).toContain(`<i>ada-o${i}:${SECRET_NOTE('ada', i)}</i>`);
		expect(await partitionsIn(w.factory, 'rows')).toEqual([await w.partition('ada')]);
		expect(await records(w.factory, DB, 'rows')).toHaveLength(3);
	});

	it('answers a list with a query string from the held rows, with no request', async () => {
		const w = world();
		w.fill('ada', 3);
		await w.hold('ada');
		w.reset();
		const body = await w.visit('/orders?dept=a');
		expect(w.log).toEqual([]);
		expect(body).toContain(`<i>ada-o1:${SECRET_NOTE('ada', 1)}</i>`);
		expect(body).toContain(`<i>ada-o3:${SECRET_NOTE('ada', 3)}</i>`);
		expect(body).not.toContain('ada-o2');
	});

	it('syncs a patch from the principal feed and answers locally again', async () => {
		const w = world({ maxStaleMs: 10_000 });
		w.fill('ada', 3);
		await w.hold('ada');
		w.ledger.put('ada', { id: 'ada-o9', note: 'ada-late', dept: 'a' });
		w.ledger.remove('ada', 'ada-o2');
		w.r.advance(10);
		w.reset();
		const refreshed = await w.visit('/orders');
		expect(refreshed).toContain('ada-o9:ada-late');
		expect(w.log).toEqual([need, expect.stringContaining('GET /.spool/dataset?')]);
		expect(w.log[1]).toContain('since=3');
		w.reset();
		const fresh = await w.visit('/orders');
		expect(w.log).toEqual([]);
		expect(fresh).toContain('ada-o9:ada-late');
		expect(fresh).not.toContain('ada-o2');
	});

	it('1. holds A, then B back to back: A rows never reach B and A sealed rows are gone', async () => {
		const w = world();
		w.fill('ada', 3);
		w.fill('bob', 2);
		await w.hold('ada');
		const ada = await w.partition('ada');
		expect(await partitionsIn(w.factory, 'rows')).toEqual([ada]);
		w.log.length = 0;
		w.ledger.calls.length = 0;
		await w.hold('bob');
		const bob = await w.partition('bob');
		expect(await partitionsIn(w.factory, 'rows')).toEqual([bob]);
		expect(await partitionsIn(w.factory, 'meta')).toEqual([bob]);
		expect(await everything(w.factory)).not.toContain(ada);
		w.reset();
		const body = await w.visit('/orders');
		expect(w.log).toEqual([]);
		expect(body).toContain('bob-o1');
		expect(body).toContain('bob-o2');
		expect(body).not.toContain('ada');
		const held = (await w.status()).datasets[0];
		const proof = await setProof(new Map(w.ledger.list('bob').map((r) => [r.id, r as never])));
		expect(held).toMatchObject({ count: 2, cursor: 2, digest: proof.digest });
		expect(w.ledger.calls.filter((c) => c.startsWith('ada '))).toEqual([]);
		expect(w.ledger.calls.slice(0, 2)).toEqual(['bob head', 'bob seed']);
		expect(w.log.filter((u) => u.includes('since='))).toEqual([]);
	});

	it('2. discards a response for A that arrives after the worker moved to B', async () => {
		const w = world();
		w.fill('ada', 3);
		w.fill('bob', 2);
		w.user.current = 'ada';
		await w.visit('/orders');
		let release = () => {};
		w.ledger.gate.set('ada', new Promise<void>((resolve) => (release = resolve)));
		const waited: Promise<unknown>[] = [];
		const slow = w.runtime.handle(nav('/orders'), (p) => void waited.push(p));
		await slow;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(w.ledger.calls).toContain('ada seed');
		await w.hold('bob');
		const before = (await w.status()).datasets;
		expect(before).toMatchObject([{ name: 'orders', count: 2 }]);
		release();
		await Promise.all(waited);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await w.status()).datasets).toEqual(before);
		expect(await partitionsIn(w.factory, 'rows')).toEqual([await w.partition('bob')]);
		expect(await records(w.factory, DB, 'rows')).toHaveLength(2);
		expect(
			w.broadcasts.filter((m) => (m as { reason?: string }).reason === 'partition')
		).toHaveLength(1);
	});

	it('4. leaves no row value, field name or row key in any database, and a copied row does not open', async () => {
		const w = world();
		w.fill('ada', 3);
		await w.hold('ada');
		const text = await everything(w.factory);
		expect(text).toContain(DB);
		for (const secret of ['confidential', 'ada-o1', 'note', 'dept']) {
			expect(text, secret).not.toContain(secret);
		}

		const factory = freshIndexedDB();
		const vault = memoryVault();
		const mk = (partition: string) =>
			sealedDatasets(idbPrincipalDatasets(factory, partition), {
				partition,
				vault,
				retention: 'persistent'
			});
		const meta = (count: number) => ({
			name: 'orders',
			schema: 'v1',
			cursor: 1,
			count,
			digest: '0'.repeat(64),
			bytes: 10,
			appliedAt: 1
		});
		const row = (key: string, note: string) => ({
			name: 'orders',
			key,
			row: { id: key, note },
			hash: '1'.repeat(64)
		});
		const one = mk('P1');
		const two = mk('P2');
		await one.commitDataset({
			name: 'orders',
			meta: meta(1),
			clear: true,
			puts: [row('k1', 'one')],
			deletes: []
		});
		await two.commitDataset({
			name: 'orders',
			meta: meta(1),
			clear: true,
			puts: [row('k2', 'two')],
			deletes: []
		});
		const stolen = ((await records(factory, DB, 'rows')) as Array<{ partition: string }>).find(
			(r) => r.partition === 'P1'
		) as { partition: string; name: string; slot: string };
		const db = await open(factory, DB);
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('rows', 'readwrite');
			tx.objectStore('rows').put({ ...stolen, partition: 'P2' });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
		const read = await mk('P2').readDataset('orders');
		expect(read.map((r) => r.key)).toEqual(['k2']);
		expect((await mk('P1').readDataset('orders')).map((r) => r.key)).toEqual(['k1']);
	});

	it('commits, patches and reads back through the sealed store, and kill stops every call', async () => {
		const factory = freshIndexedDB();
		const store = sealedDatasets(idbPrincipalDatasets(factory, 'P'), {
			partition: 'P',
			vault: memoryVault(),
			retention: 'session'
		});
		const meta = (count: number) => ({
			name: 'd',
			schema: 'v1',
			cursor: count,
			count,
			digest: '0'.repeat(64),
			bytes: 1,
			appliedAt: count
		});
		const row = (key: string) => ({ name: 'd', key, row: { id: key }, hash: '1'.repeat(64) });
		await store.commitDataset({
			name: 'd',
			meta: meta(2),
			clear: true,
			puts: [row('b'), row('a')],
			deletes: []
		});
		await store.commitDataset({
			name: 'd',
			meta: meta(2),
			clear: false,
			puts: [row('c')],
			deletes: ['a']
		});
		expect((await store.readDataset('d')).map((r) => r.key)).toEqual(['b', 'c']);
		expect(await store.getDatasets()).toEqual([meta(2)]);
		store.kill();
		await store.commitDataset({ name: 'd', meta: meta(9), clear: true, puts: [], deletes: [] });
		expect(await store.readDataset('d')).toEqual([]);
		expect(await store.getDatasets()).toEqual([]);
		expect(await records(factory, DB, 'rows')).toHaveLength(2);
		await store.clearDatasets();
		expect(await records(factory, DB, 'rows')).toHaveLength(2);
	});

	it('clears a dataset whose meta no longer opens, and reads it as absent', async () => {
		const factory = freshIndexedDB();
		const mk = (vault = memoryVault()) =>
			sealedDatasets(idbPrincipalDatasets(factory, 'P'), {
				partition: 'P',
				vault,
				retention: 'session'
			});
		const first = mk();
		await first.commitDataset({
			name: 'd',
			meta: {
				name: 'd',
				schema: 'v1',
				cursor: 1,
				count: 1,
				digest: '0'.repeat(64),
				bytes: 1,
				appliedAt: 1
			},
			clear: true,
			puts: [{ name: 'd', key: 'a', row: { id: 'a' }, hash: '1'.repeat(64) }],
			deletes: []
		});
		const restarted = mk();
		expect(await restarted.getDatasets()).toEqual([]);
		expect(await records(factory, DB, 'rows')).toEqual([]);
		expect(await records(factory, DB, 'meta')).toEqual([]);
	});
});

describe('keeping stale or revoked rows off the page', () => {
	it('5. answers locally for maxStaleMs and refreshes before it answers at the bound, with no document request', async () => {
		const w = world({ maxStaleMs: 60_000 });
		w.fill('ada', 2);
		await w.hold('ada');
		w.r.advance(59);
		w.reset();
		await w.visit('/orders');
		expect(w.log).toEqual([]);
		w.r.advance(1);
		expect(await w.visit('/orders')).toContain('ada-o1');
		expect(w.log).toEqual([need, expect.stringContaining('GET /.spool/dataset?')]);
		w.reset();
		await w.visit('/orders');
		expect(w.log).toEqual([]);
	});

	it('5. leaves a queued principal sync to a network moment, whatever the lease says', async () => {
		const w = world({ maxStaleMs: 2_000_000_000 });
		w.fill('ada', 2);
		await w.hold('ada');
		w.r.advance(1_000_001 + 86_400);
		w.reset();
		await w.visit('/orders');
		await w.visit('/orders');
		expect(w.log.filter((entry) => entry.startsWith('GET /.spool/'))).toEqual([]);
		await w.visit('/login');
		expect(w.log.some((entry) => entry.startsWith('GET /.spool/sync'))).toBe(true);
	});

	it('5. a row that left the principal scope arrives as a delete and is gone from the next page', async () => {
		const w = world({ maxStaleMs: 10_000 });
		w.fill('ada', 3);
		await w.hold('ada');
		w.ledger.remove('ada', 'ada-o1');
		w.r.advance(10);
		await w.visit('/orders');
		const body = await w.visit('/orders');
		expect(body).not.toContain('ada-o1');
		expect(body).toContain('ada-o2');
		expect((await w.status()).datasets).toMatchObject([{ count: 2, cursor: 4 }]);
		expect(await records(w.factory, DB, 'rows')).toHaveLength(2);
	});

	it('5. a 403 for the whole dataset drops its rows and keeps the partition', async () => {
		const w = world({ maxStaleMs: 10_000 });
		w.fill('ada', 3);
		await w.hold('ada');
		w.ledger.forbidden.add('ada');
		w.r.advance(10);
		await w.visit('/orders');
		expect((await w.status()).datasets).toEqual([]);
		expect(await records(w.factory, DB, 'rows')).toEqual([]);
		expect(await records(w.factory, DB, 'meta')).toEqual([]);
		expect((await w.status()).partition).toBe(await w.partition('ada'));
		w.reset();
		await w.visit('/orders');
		expect(w.log).toEqual(['GET /orders']);
	});

	it('5. a reset with no rows leaves the device holding none', async () => {
		const w = world({ maxStaleMs: 10_000 });
		w.fill('ada', 2);
		await w.hold('ada');
		w.ledger.remove('ada', 'ada-o1');
		w.ledger.remove('ada', 'ada-o2');
		w.ledger.events.set('ada', []);
		w.r.advance(10);
		await w.visit('/orders');
		expect((await w.status()).datasets).toMatchObject([{ count: 0 }]);
		expect(await records(w.factory, DB, 'rows')).toEqual([]);
		expect(await w.visit('/orders')).not.toContain('ada-o');
	});

	it('5. a principal removed on the server is served for at most maxStaleMs, then wiped', async () => {
		const w = world({ maxStaleMs: 60_000 });
		w.fill('ada', 2);
		await w.hold('ada');
		w.user.current = null;
		w.r.advance(59);
		w.reset();
		expect(await w.visit('/orders')).toContain('ada-o1');
		expect(w.log).toEqual([]);
		w.r.advance(1);
		const after = await w.visit('/orders');
		expect(after).not.toContain('ada-o');
		expect(w.log).toEqual([need, 'GET /orders']);
		expect((await w.status()).partition).toBeNull();
		expect(await records(w.factory, DB, 'rows')).toEqual([]);
		expect(await records(w.factory, DB, 'meta')).toEqual([]);
	});

	it('5. a 401 on a dataset request ends the session and wipes the partition', async () => {
		const w = world({ maxStaleMs: 10_000 });
		w.fill('ada', 2);
		await w.hold('ada');
		w.r.advance(10);
		w.net.intercept = (request) =>
			new URL(request.url).pathname === '/.spool/dataset'
				? new Response('{"error":"sign in"}', { status: 401 })
				: undefined;
		w.reset();
		await w.visit('/orders');
		expect(w.log.slice(0, 2)).toEqual([need, expect.stringContaining('/.spool/dataset?')]);
		expect(w.log[2]).toBe('GET /orders');
		expect(await records(w.factory, DB, 'rows')).toEqual([]);
		expect(w.broadcasts).toContainEqual({ type: 'spool:cleared', reason: 'session-ended' });
	});
});

describe('wiping the partition', () => {
	it('6. a logout with a sync in flight wipes the rows and discards the late answer', async () => {
		const w = world();
		w.fill('ada', 3);
		w.user.current = 'ada';
		await w.visit('/orders');
		let release = () => {};
		w.ledger.gate.set('ada', new Promise<void>((resolve) => (release = resolve)));
		const waited: Promise<unknown>[] = [];
		await w.runtime.handle(nav('/orders'), (p) => void waited.push(p));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await w.visit('/logout');
		expect((await w.status()).partition).toBeNull();
		release();
		await Promise.all(waited);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await records(w.factory, DB, 'rows')).toEqual([]);
		expect(await records(w.factory, DB, 'meta')).toEqual([]);
		expect((await w.status()).datasets).toEqual([]);
	});

	it('6. the logout pattern, Spool-Clear and an account switch each delete the rows', async () => {
		for (const out of ['/logout', '/clear']) {
			const w = world();
			w.fill('ada', 2);
			await w.hold('ada');
			expect(await records(w.factory, DB, 'rows')).toHaveLength(2);
			await w.visit(out);
			expect(await records(w.factory, DB, 'rows'), out).toEqual([]);
			expect(await records(w.factory, DB, 'meta'), out).toEqual([]);
			expect((await w.status()).partition, out).toBeNull();
		}
		const w = world();
		w.fill('ada', 2);
		w.fill('bob', 1);
		await w.hold('ada');
		await w.hold('bob');
		expect(await records(w.factory, DB, 'rows')).toHaveLength(1);
	});

	it('6. a wipe leaves the next sign-in of the same principal to seed again', async () => {
		const w = world();
		w.fill('ada', 2);
		await w.hold('ada');
		await w.visit('/logout');
		w.reset();
		await w.hold('ada');
		expect(w.log.filter((u) => u.startsWith('GET /.spool/dataset'))).toHaveLength(1);
		expect((await w.status()).datasets).toMatchObject([{ count: 2 }]);
	});
});

describe('refusing what is not this principal', () => {
	function device(s: Site, as: string, factory: IDBFactory = freshIndexedDB()) {
		const host = idbPartitions(factory, idbVault(factory));
		const partition = 'P-' + as;
		const storage = host.open(partition, () => 'persistent', 'persistent', true);
		const replica = new Replica(storage, 'v1', () => 1000);
		const sent: string[] = [];
		const edit: { headers?: (h: Headers) => void } = {
			headers: (h) => h.set('spool-partition', partition)
		};
		const sync = (name = 'orders'): Promise<DatasetOutcome> =>
			syncDataset(
				{
					store: replica.datasets,
					origin: ORIGIN,
					epoch: () => replica.epoch,
					budget: async () => undefined,
					guard: principalGuard(partition),
					fetch: async (url) => {
						sent.push(url.replace(ORIGIN, ''));
						s.user.current = as;
						const real = (await s.r.spool.respond(new Request(url))) as Response;
						if (!edit.headers) return real;
						const headers = new Headers(real.headers);
						edit.headers(headers);
						return new Response(await real.text(), { status: real.status, headers });
					}
				},
				name
			);
		return { replica, storage, sync, sent, edit, partition, factory };
	}

	it('3. never applies a response with no Spool-Partition or another one', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		for (const edit of [
			(h: Headers) => h.delete('spool-partition'),
			(h: Headers) => h.set('spool-partition', 'someone-else')
		]) {
			const d = device(s, 'ada');
			d.edit.headers = edit;
			expect(await d.sync()).toEqual({
				name: 'orders',
				requests: 1,
				status: 'refused',
				reason: 'partition',
				by: undefined
			});
			expect(await d.replica.datasets.list()).toEqual([]);
		}
	});

	it('3. an answer that names this partition is applied', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		const d = device(s, 'ada');
		d.edit.headers = (h) => h.set('spool-partition', d.partition);
		expect(await d.sync()).toMatchObject({ status: 'seeded', rows: 1 });
	});

	it('7. refuses a replayed older patch: the rows and the confirmation time stay', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		s.ledger.put('ada', { id: 'a2', note: 'n', dept: 'a' });
		const d = device(s, 'ada');
		d.edit.headers = (h) => h.set('spool-partition', d.partition);
		await d.sync();
		const held = (await d.replica.datasets.get('orders'))?.meta;
		expect(held).toMatchObject({ cursor: 2, count: 2, appliedAt: 1000 });
		const replay = {
			protocol: 1,
			name: 'orders',
			schema: 'v1',
			cursor: 1,
			reset: false,
			puts: [{ key: 'a1', row: { id: 'a1', note: 'old', dept: 'a' } }],
			deletes: [],
			proof: { kind: 'set', count: 1, digest: '0'.repeat(64) }
		};
		const replica = d.replica;
		const outcome = await syncDataset(
			{
				store: replica.datasets,
				origin: ORIGIN,
				epoch: () => replica.epoch,
				budget: async () => undefined,
				guard: principalGuard(d.partition),
				fetch: async () =>
					new Response(JSON.stringify(replay), {
						headers: {
							'spool-partition': d.partition,
							'content-type': 'application/json'
						}
					})
			},
			'orders'
		);
		expect(outcome).toMatchObject({ status: 'current', cursor: 2, rows: 2 });
		expect((await replica.datasets.get('orders'))?.meta).toEqual(held);
		expect((await replica.datasets.get('orders'))?.rows.get('a1')?.['note']).toBe('n');
	});

	it('2. ends a patch as refused epoch, writing nothing, when the side died while it was in flight', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		const d = device(s, 'ada');
		await d.sync();
		const held = (await d.replica.datasets.get('orders'))?.meta;
		s.ledger.put('ada', { id: 'a2', note: 'n', dept: 'a' });
		let dead = false;
		const outcome = await syncDataset(
			{
				store: d.replica.datasets,
				origin: ORIGIN,
				epoch: () => (dead ? -1 : d.replica.epoch),
				budget: async () => undefined,
				guard: principalGuard(d.partition),
				fetch: async (url) => {
					s.user.current = 'ada';
					const real = (await s.r.spool.respond(new Request(url))) as Response;
					dead = true;
					const headers = new Headers(real.headers);
					headers.set('spool-partition', d.partition);
					return new Response(await real.text(), { headers });
				}
			},
			'orders'
		);
		expect(outcome).toMatchObject({ status: 'refused', reason: 'epoch', requests: 1 });
		expect((await d.replica.datasets.get('orders'))?.meta).toEqual(held);
		expect(await records(d.factory, DB, 'rows')).toHaveLength(1);
	});

	it('7. discards a patch whose proof fails and reseeds once, with exact requests', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		const d = device(s, 'ada');
		d.edit.headers = (h) => h.set('spool-partition', d.partition);
		await d.sync();
		s.ledger.put('ada', { id: 'a2', note: 'n', dept: 'a' });
		s.ledger.lies = 1;
		d.sent.length = 0;
		const outcome = await d.sync();
		expect(outcome).toMatchObject({ status: 'reseeded', rows: 2, requests: 2 });
		expect(d.sent).toEqual([
			'/.spool/dataset?name=orders&since=1&schema=v1',
			'/.spool/dataset?name=orders'
		]);
		expect((await d.replica.datasets.get('orders'))?.meta).toMatchObject({
			count: 2,
			cursor: 2
		});
	});

	it('maps 401 to ended and 403 to revoked, and 403 drops the held dataset', async () => {
		const s = site();
		s.ledger.put('ada', { id: 'a1', note: 'n', dept: 'a' });
		const d = device(s, 'ada');
		d.edit.headers = (h) => h.set('spool-partition', d.partition);
		await d.sync();
		s.ledger.forbidden.add('ada');
		expect(await d.sync()).toMatchObject({ status: 'refused', reason: 'revoked' });
		expect(await d.replica.datasets.list()).toEqual([]);
		const guard = principalGuard('P');
		expect(guard(new Response(null, { status: 401 }))).toBe('ended');
		expect(guard(new Response(null, { status: 403 }))).toBe('revoked');
		expect(guard(new Response(null, { status: 404 }))).toBe('ok');
		expect(
			guard(new Response(null, { status: 200, headers: { 'spool-partition': 'P' } }))
		).toBe('ok');
	});
});

describe('with the flag off', () => {
	it('9. serves no principal dataset, creates no database and leaves principal pages as they were', async () => {
		const w = world({ flag: false });
		expect(() =>
			createSpool({ routes: [], store: memoryStore(), datasets: [w.dataset] })
		).toThrow();
		w.fill('ada', 2);
		await w.hold('ada');
		await w.visit('/about');
		await w.visit('/logout');
		expect(w.log.filter((u) => u.includes('/.spool/dataset'))).toEqual([]);
		expect(await names(w.factory)).not.toContain(DB);
		const status = await w.status();
		expect(status.datasets).toEqual([]);
	});
});

// #region authenticated families: the server projects a row to the fields its viewer may hold

type Person = { id: string; name: string; email: string };

const PEOPLE: Person[] = [
	{ id: 'ada', name: 'Ada', email: 'ada@secret.test' },
	{ id: 'bob', name: 'Bob', email: 'bob@secret.test' }
];

const PEOPLE_API = 'https://api.test';

// the worker answers a page or a data route only with the security headers of a network navigation
const SECURE_HTML = { ...HTML, 'content-security-policy': "default-src 'self'" };

const PERSON_SOURCE =
	'<html><head></head><body>{{row.id}} {{row.name}} {{row.email}}</body></html>';

const COURSES = [{ id: 'c1', title: 'Algebra' }];

/** a public dataset of courses, to sit beside the principal one */
async function publicCourses() {
	const proof = await setProof(new Map(COURSES.map((row) => [row.id, row])));
	return defineDataset<(typeof COURSES)[number]>('courses', {
		scope: 'public',
		schema: 'v1',
		maxRows: 100,
		maxBytes: 100_000,
		key: (row) => row.id,
		seed: () => COURSES,
		read: (ids) => COURSES.filter((row) => ids.includes(row.id)),
		changes: () => ({ cursor: 0, puts: [], deletes: [], proof }),
		horizon: () => 0,
		head: () => ({ cursor: 0, proof })
	});
}

/**
 * `own` seeds each principal only its own row; `fields: false` leaves the dataset without a fields
 * function; `courses` adds a public dataset with a same-origin and a cross-origin family over it
 */
function directory(
	options: { fields?: boolean; own?: boolean; courses?: Dataset<(typeof COURSES)[number]> } = {}
) {
	const { fields = true, own = false, courses } = options;
	const rows = new Map(PEOPLE.map((p) => [p.id, { ...p }]));
	const user = { current: null as string | null };
	const viewerFields = (viewer: { principal: string } | null, row: Person) =>
		viewer?.principal === row.id ? ['id', 'name', 'email'] : ['id', 'name'];
	const dataset = defineDataset<Person>(
		'people',
		{
			scope: 'principal',
			maxStaleMs: 60_000,
			schema: 'v1',
			maxRows: 100,
			maxBytes: 100_000,
			key: (row) => row.id,
			seed: (ctx) =>
				[...rows.values()]
					.filter((p) => !own || p.id === ctx.principal?.principal)
					.sort((a, b) => (a.id < b.id ? -1 : 1)),
			read: (ids) => ids.flatMap((id) => rows.get(id) ?? []),
			changes: () => 'reset',
			horizon: () => 0,
			head: () => ({ cursor: 0 }),
			...(fields ? { fields: viewerFields } : {})
		},
		{ principalDatasets: true }
	);
	const routes = [
		defineRoute('/people/:id', {
			strategy: 'template',
			scope: 'principal',
			family: { dataset: 'people', key: 'id' },
			template: { source: PERSON_SOURCE }
		} as never),
		defineRoute('/about', {
			strategy: 'template',
			template: { source: page('about') },
			load: () => ({})
		}),
		defineRoute('/account', {
			strategy: 'template',
			auth: 'principal',
			family: { dataset: 'people', key: 'viewer.id' },
			template: { source: PERSON_SOURCE }
		} as never),
		defineRoute('/api/status', {
			strategy: 'data',
			load: () => ({ ok: true }),
			provision: { reuse: 1, futureViews: 50 }
		}),
		defineRoute('/v2/people/:id', {
			strategy: 'data',
			scope: 'principal',
			origin: PEOPLE_API,
			family: { dataset: 'people', key: 'id' }
		}),
		defineRoute('/v2/people', {
			strategy: 'data',
			scope: 'principal',
			origin: PEOPLE_API,
			query: { list: 'people', dataset: 'people' },
			load: () => ({})
		}),
		...(courses
			? [
					defineRoute('/api/courses/:id', {
						strategy: 'data',
						family: { dataset: 'courses', key: 'id' }
					}),
					defineRoute('/v2/courses/:id', {
						strategy: 'data',
						origin: PEOPLE_API,
						family: { dataset: 'courses', key: 'id' }
					})
				]
			: [])
	];
	const r = rig({
		routes,
		app: (request) => {
			const { pathname } = new URL(request.url);
			if (pathname.endsWith('/courses/c1')) return Response.json(COURSES[0]);
			if (pathname === '/logout') {
				user.current = null;
				return new Response(page('bye'), { headers: HTML });
			}
			if (pathname === '/api/status') return Response.json({ ok: true });
			if (['/about', '/account'].includes(pathname) || pathname.startsWith('/people/')) {
				return new Response(page('network'), { headers: SECURE_HTML });
			}
			return new Response(page('missing'), { status: 404, headers: HTML });
		},
		spool: {
			datasets: courses ? [dataset, courses] : [dataset],
			principalDatasets: true,
			logout: ['/logout'],
			identity: {
				secret: 's',
				resolve: () => (user.current ? { principal: user.current } : null)
			}
		}
	});
	return { r, user, dataset, routes };
}

type Directory = ReturnType<typeof directory>;

function directoryWorker(d: Directory, pack?: PackStore) {
	const factory = freshIndexedDB();
	const runtime = d.r.make({
		partitions: idbPartitions(factory, idbVault(factory)),
		broadcast: () => undefined,
		...(pack ? { pack } : {})
	});
	const visit = async (path: string, init: RequestInit = {}) =>
		(
			await d.r.drive(path.startsWith('/api') ? sub(path, init) : nav(path, init), runtime)
		).text();
	/** signs in, then holds the directory: one view provisions, the next seeds the rows */
	const hold = async (who: string) => {
		d.user.current = who;
		await visit('/about');
		await visit('/people/ada');
		await visit('/people/ada');
	};
	return { factory, log: d.r.log, runtime, visit, hold };
}

describe('authenticated families', () => {
	it('sends each viewer only the fields its fields function grants, in the response bytes', async () => {
		const d = directory();
		d.user.current = 'bob';
		const body = await (
			(await d.r.spool.respond(
				new Request(`${ORIGIN}/.spool/dataset?name=people`)
			)) as Response
		).text();
		expect(body).not.toContain('ada@secret.test');
		const parsed = JSON.parse(body) as { puts: Array<{ key: string; row: object }> };
		expect(parsed.puts.map((p) => [p.key, Object.keys(p.row).sort()])).toEqual([
			['ada', ['id', 'name']],
			['bob', ['email', 'id', 'name']]
		]);
	});

	it('holds no withheld field in the sealed store or the rendered page of another person', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold('bob');
		expect(await w.visit('/people/ada')).not.toContain('ada@secret.test');
		expect(await w.visit('/people/bob')).toContain('bob@secret.test');
		expect(await everything(w.factory)).not.toContain('ada@secret.test');
	});

	it('renders the viewer own full row at /account with no request after bootstrap', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold('ada');
		await w.visit('/account');
		const before = w.log.length;
		expect(await w.visit('/account')).toContain('ada@secret.test');
		expect(w.log.length - before).toBe(0);
	});

	it('wipes the first principal at logout, so the next one holds none of its rows', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold('ada');
		await w.visit('/logout');
		await w.hold('bob');
		expect(await w.visit('/people/ada')).not.toContain('ada@secret.test');
		expect(await everything(w.factory)).not.toContain('ada@secret.test');
	});

	it('reads the current principal projection after the next contact of a stale tab', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold('ada');
		d.user.current = 'bob';
		// a query string is never answered locally, so this view is the contact that names bob's partition
		await w.visit('/about?contact=1');
		await w.visit('/people/ada');
		const text = await w.visit('/people/ada');
		expect(text).toContain('Ada');
		expect(text).not.toContain('ada@secret.test');
		expect(await everything(w.factory)).not.toContain('ada@secret.test');
	});

	it('answers a bearer request to a public data route from the network, never from the store', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.visit('/about');
		await w.visit('/api/status');
		await w.visit('/api/status');
		const held = w.log.length;
		await w.visit('/api/status');
		expect(w.log.length - held).toBe(0);
		const mark = w.log.length;
		await w.visit('/api/status', { headers: { authorization: 'Bearer t0' } });
		expect(w.log.slice(mark)).toEqual(['GET /api/status']);
	});

	it('sends a public family read with an Authorization header to the network, with a partition held', async () => {
		const d = directory({ courses: await publicCourses() });
		const { bytes } = await buildPack({
			version: 1,
			tables: { courses: COURSES.map((row): [string, typeof row] => [row.id, row]) }
		});
		const pack = createPackStore(freshIndexedDB());
		await pack.installPack(
			(async function* () {
				yield bytes;
			})()
		);
		const w = directoryWorker(d, pack);
		await w.hold('bob');
		const bearer = { headers: { authorization: 'Bearer t0' } };
		for (const url of ['/api/courses/c1', `${PEOPLE_API}/v2/courses/c1`]) {
			const path = new URL(url, ORIGIN).pathname;
			d.r.reset();
			const local = await d.r.drive(sub(url), w.runtime);
			expect(await local.json()).toEqual(COURSES[0]);
			expect(d.r.log).toEqual([]);
			await d.r.drive(sub(url, bearer), w.runtime);
			expect(d.r.log).toEqual([`GET ${path}`]);
		}
	});

	it('refuses another person row when the family dataset has no fields, naming no row value', async () => {
		const d = directory({ fields: false });
		d.user.current = 'bob';
		const response = (await d.r.spool.respond(
			new Request(`${ORIGIN}/.spool/dataset?name=people`)
		)) as Response;
		const body = await response.text();
		expect(response.status).toBe(400);
		expect(body).toContain('fields');
		expect(body).not.toContain('ada@secret.test');
	});

	it('holds the viewer own row in full when the family dataset has no fields', async () => {
		const d = directory({ fields: false, own: true });
		d.user.current = 'ada';
		const response = (await d.r.spool.respond(
			new Request(`${ORIGIN}/.spool/dataset?name=people`)
		)) as Response;
		const parsed = (await response.json()) as { puts: Array<{ key: string; row: object }> };
		expect(response.status).toBe(200);
		expect(parsed.puts.map((p) => [p.key, Object.keys(p.row).sort()])).toEqual([
			['ada', ['email', 'id', 'name']]
		]);
	});

	it('keeps a principal family out of the public pack, the ring and the worker script', async () => {
		const d = directory();
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [d.dataset],
			routes: d.routes,
			version: 1,
			url: new URL(ORIGIN)
		});
		expect(built.index.tables).toEqual([]);
		const { state } = await readBundle(built.bytes);
		expect(state.tables).toEqual({});
		const ring = buildRing({
			path: '/people/ada',
			version: 1,
			digest: built.index.digest,
			routes: d.routes,
			tables: { people: PEOPLE.map((p) => [p.id, p]) } as never,
			packBytes: built.bytes.length,
			ringBytes: RING_BYTES,
			bootstrap: 'first-view',
			worker: 'auto'
		});
		expect(ring).toBeUndefined();
		expect(await d.r.spool.stub().text()).not.toContain('ada@secret.test');
	});

	it('refuses fields on a public dataset and a fields that is not a function', () => {
		const open = {
			scope: 'public' as const,
			schema: 'v1',
			maxRows: 10,
			maxBytes: 1000,
			key: (row: Person) => row.id,
			seed: () => [],
			read: () => [],
			changes: () => 'reset' as const,
			horizon: () => 0,
			head: () => ({ cursor: 0 })
		};
		expect(() => defineDataset('open', { ...open, fields: () => ['id'] } as never)).toThrow(
			/fields applies to a principal dataset/
		);
		const principal = { ...open, scope: 'principal' as const, maxStaleMs: 1000 };
		expect(() =>
			defineDataset('people', { ...principal, fields: 'id' } as never, {
				principalDatasets: true
			})
		).toThrow(/fields must be a function/);
	});
});

describe('a principal route on another origin', () => {
	const asPerson = (response: Response | undefined) =>
		(response as Response).json() as Promise<Record<string, string>>;
	const bearer = { headers: { authorization: 'Bearer t0' } };
	const api = (path: string, init: RequestInit = {}) => sub(`${PEOPLE_API}${path}`, init);
	/** a worker that holds the directory as `who`, with the log cleared */
	async function held(who: string) {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold(who);
		d.r.reset();
		return { d, w };
	}

	it('serializes with its scope and origin, and builds no artifact, pack row or ring entry', async () => {
		const d = directory();
		for (const pattern of ['/v2/people/:id', '/v2/people']) {
			expect(
				d.r.spool.config.routes.find((route) => route.pattern === pattern)
			).toMatchObject({
				scope: 'principal',
				origin: PEOPLE_API
			});
		}
		d.user.current = 'ada';
		for (const path of ['/v2/people/ada', '/v2/people']) {
			const response = (await d.r.spool.respond(
				new Request(`${ORIGIN}/.spool/artifact?path=${path}`)
			)) as Response;
			expect(response.status).toBe(404);
		}
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [d.dataset],
			routes: d.routes,
			version: 1,
			url: new URL(ORIGIN)
		});
		expect(built.index.tables).toEqual([]);
	});

	it('is refused over a dataset of the other scope', () => {
		const open = defineDataset<Person>('people', {
			scope: 'public',
			schema: 'v1',
			maxRows: 10,
			maxBytes: 1000,
			key: (row) => row.id,
			seed: () => [],
			read: () => [],
			changes: () => 'reset' as const,
			horizon: () => 0,
			head: () => ({ cursor: 0 })
		});
		const principal = directory().dataset;
		const family = { dataset: 'people', key: 'id' };
		const make = (scope: 'public' | 'principal', dataset: typeof open) =>
			createSpool({
				routes: [
					defineRoute('/v2/people/:id', {
						strategy: 'data',
						scope,
						origin: PEOPLE_API,
						family
					})
				],
				store: memoryStore(),
				datasets: [dataset],
				principalDatasets: true,
				identity: { secret: 's', resolve: () => null }
			});
		expect(() => make('public', principal)).toThrow(/public route cannot read the principal/);
		expect(() => make('principal', open)).toThrow(/principal route cannot read the public/);
		expect(() => make('principal', principal)).not.toThrow();
		expect(() =>
			createSpool({
				routes: [
					defineRoute('/v2/people', {
						strategy: 'data',
						origin: PEOPLE_API,
						query: { list: 'people', dataset: 'people' },
						load: () => ({})
					})
				],
				store: memoryStore(),
				datasets: [principal],
				principalDatasets: true,
				identity: { secret: 's', resolve: () => null }
			})
		).toThrow(/public route cannot query the principal/);
	});

	it('answers a held row and the held collection with 0 requests, with the viewer fields only', async () => {
		const { d, w } = await held('bob');
		const row = await d.r.drive(api('/v2/people/ada', bearer), w.runtime);
		expect(await asPerson(row)).toEqual({ id: 'ada', name: 'Ada' });
		expect(row.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		const own = await d.r.drive(api('/v2/people/bob', bearer), w.runtime);
		expect(await asPerson(own)).toEqual({ id: 'bob', name: 'Bob', email: 'bob@secret.test' });
		const all = await d.r.drive(api('/v2/people', bearer), w.runtime);
		expect(((await all.json()) as { people: unknown[] }).people).toHaveLength(2);
		expect(d.r.log).toEqual([]);
	});

	it('sends a request with no Authorization header to the network, even with the rows held', async () => {
		const { d, w } = await held('bob');
		await d.r.drive(api('/v2/people/ada'), w.runtime);
		await d.r.drive(api('/v2/people'), w.runtime);
		expect(d.r.log).toEqual(['GET /v2/people/ada', 'GET /v2/people']);
	});

	it('sends a row it does not hold and a query it does not declare to the network', async () => {
		const { d, w } = await held('bob');
		await d.r.drive(api('/v2/people/zed', bearer), w.runtime);
		await d.r.drive(api('/v2/people?role=admin', bearer), w.runtime);
		expect(d.r.urls).toEqual(['GET /v2/people/zed', 'GET /v2/people?role=admin']);
	});

	it('sends a bearer read to the network when no partition is held', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await d.r.drive(api('/v2/people/ada', bearer), w.runtime);
		expect(d.r.log).toEqual(['GET /v2/people/ada']);
	});

	it('stops answering at a logout, so the next bearer read goes to the network', async () => {
		const { d, w } = await held('bob');
		await d.r.drive(api('/v2/people/ada', bearer), w.runtime);
		expect(d.r.log).toEqual([]);
		await w.visit('/logout');
		d.r.reset();
		await d.r.drive(api('/v2/people/ada', bearer), w.runtime);
		expect(d.r.log).toEqual(['GET /v2/people/ada']);
	});

	it('answers a read for ada from the partition of bob only, after the worker moved to bob', async () => {
		const d = directory();
		const w = directoryWorker(d);
		await w.hold('ada');
		d.user.current = 'bob';
		// a query string is never answered locally, so this view is the contact that names bob's partition
		await w.visit('/about?contact=1');
		await w.visit('/people/ada');
		await w.visit('/people/ada');
		d.r.reset();
		const row = await d.r.drive(api('/v2/people/ada', bearer), w.runtime);
		const text = await row.text();
		expect(JSON.parse(text)).toEqual({ id: 'ada', name: 'Ada' });
		expect(text).not.toContain('ada@secret.test');
		expect(d.r.log).toEqual([]);
		expect(await everything(w.factory)).not.toContain('ada@secret.test');
	});
});

// #endregion
