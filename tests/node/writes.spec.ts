import type { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
	buildPack,
	couplingReport,
	defineDataset,
	defineResource,
	defineWrite,
	HEADERS,
	ifMatch,
	makeDelta,
	ProtocolError,
	readBundle,
	WRITE_HEADERS,
	writeFor,
	type BundleDelta,
	type BundleState,
	type Route,
	type WriteDeclaration,
	type WriteRefusal
} from '../../src/protocol/index';
import {
	applyPatch,
	serializeWrite,
	type ResourcePatch,
	type ResourceWrite
} from '../../src/protocol/write';
import {
	buildBundle,
	createSpool,
	defineRoute,
	memoryBundleStore,
	partitionId
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { createPackStore, type PackStore } from '../../src/sw/pack/store';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import {
	createRuntime,
	type Runtime,
	type RuntimeDeps,
	type WriteReply
} from '../../src/sw/runtime';
import { memoryVault } from '../../src/sw/seal';
import { memoryStorage } from '../../src/sw/storage';
import {
	destroyWrites,
	idbWriteStore,
	memoryWriteStore,
	settleWrite,
	WriteQueue,
	type WriteRecord,
	type WriteStore,
	type WriteTimers
} from '../../src/sw/write';
import { fakeCaches, freshIndexedDB, nav, ORIGIN } from './helpers';

// #region the site: one write class over a versioned map, with counters on every site function

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const idOf = (n: number) => `write-id-${String(n).padStart(16, '0')}`;
const source = '<html><head></head><body>profile of {{owner}}</body></html>';

function site(
	over: { enabled?: boolean; remember?: number; maxPending?: number; maxDelayMs?: number } = {}
) {
	const db = new Map<string, { version: number; value: unknown }>();
	const calls = { apply: 0, read: 0, key: 0 };
	const applied: Array<{ key: string; value: unknown; expected: string; writeId: string }> = [];
	const gate: { hold?: Promise<void> } = {};
	const user = { current: null as string | null };
	const profile = defineWrite({
		name: 'profile',
		scope: 'principal',
		path: '/profile',
		key: (ctx) => {
			calls.key += 1;
			return `profile:${ctx.identity.principal}`;
		},
		read: (_ctx, key) => {
			calls.read += 1;
			const row = db.get(key);
			return { version: String(row?.version ?? 0), value: row?.value };
		},
		apply: async (ctx, key, value, expected) => {
			calls.apply += 1;
			await gate.hold;
			const row = db.get(key) ?? { version: 0, value: undefined };
			if (String(row.version) !== expected) {
				return { conflict: { version: String(row.version), value: row.value } };
			}
			const next = { version: row.version + 1, value };
			db.set(key, next);
			applied.push({ key, value, expected, writeId: ctx.writeId });
			return { version: String(next.version) };
		},
		maxBytes: 120,
		maxPending: over.maxPending ?? 2,
		...(over.maxDelayMs === undefined ? {} : { maxDelayMs: over.maxDelayMs })
	});
	const spool = createSpool({
		routes: [
			defineRoute('/profile', {
				strategy: 'template',
				scope: 'principal',
				retention: 'persistent',
				template: { source },
				depends: (ctx) => [`profile:${ctx.identity?.principal}`],
				load: (ctx) => ({ owner: ctx.identity?.principal })
			}),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: '<html><head></head><body>about</body></html>' },
				load: () => ({})
			})
		],
		store: memoryStore(),
		logout: ['/logout'],
		identity: {
			secret: 's',
			resolve: (request) => {
				const as = request.headers.get('x-user') ?? user.current;
				return as ? { principal: as } : null;
			}
		},
		writes: {
			classes: [profile],
			...(over.enabled === undefined ? { enabled: true } : { enabled: over.enabled }),
			...(over.remember !== undefined ? { remember: over.remember } : {})
		}
	});
	return { db, calls, applied, gate, user, spool, profile };
}

type Site = ReturnType<typeof site>;

type Put = {
	as?: string | null;
	name?: string;
	key?: string;
	version?: string | null;
	id?: string | null;
	body?: string;
	method?: string;
};

/** a PUT as the worker would send it, from `as` */
function put(s: Site, over: Put = {}): Promise<Response | undefined> {
	const as = over.as === undefined ? 'ada' : over.as;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (as) headers['x-user'] = as;
	if (over.version !== null) headers['if-match'] = ifMatch(over.version ?? '0');
	if (over.id !== null) headers['spool-write-id'] = over.id ?? idOf(1);
	const key = over.key ?? `profile:${as}`;
	const query = `name=${over.name ?? 'profile'}&key=${encodeURIComponent(key)}`;
	return s.spool.respond(
		new Request(`${ORIGIN}/.spool/write?${query}`, {
			method: over.method ?? 'PUT',
			headers,
			body: over.body ?? JSON.stringify({ value: 'hello' })
		})
	);
}

const read = async (response: Response | undefined) => ({
	status: response?.status,
	body: (await response?.json()) as Record<string, unknown>
});

// #endregion

describe('declaring a write class', () => {
	const base: WriteDeclaration = {
		name: 'profile',
		scope: 'principal',
		path: '/profile',
		key: () => 'k',
		read: () => ({ version: '0' }),
		apply: () => ({ version: '1' }),
		maxBytes: 100,
		maxPending: 2
	};

	it('freezes a valid class and names its only kind last-value', () => {
		const write = defineWrite(base);
		expect(write.kind).toBe('last-value');
		expect(Object.isFrozen(write)).toBe(true);
	});

	it('refuses a public write at declaration time', () => {
		expect(() => defineWrite({ ...base, scope: 'public' as never })).toThrow(ProtocolError);
		expect(() => defineWrite({ ...base, scope: 'public' as never })).toThrow(/never queued/);
	});

	it.each(['comment', 'cart', 'payment', 'counter', 'inventory', 'audit', 'append'])(
		'has no kind named %s',
		(kind) => {
			expect(() => defineWrite({ ...base, kind: kind as never })).toThrow(
				/only kind is "last-value"/
			);
		}
	);

	it('refuses a bad name, pattern, function and limit', () => {
		expect(() => defineWrite({ ...base, name: 'a b' })).toThrow(/write name/);
		expect(() => defineWrite({ ...base, path: 'profile' })).toThrow();
		expect(() => defineWrite({ ...base, apply: undefined as never })).toThrow(/apply must be/);
		for (const maxBytes of [0, 1.5, 2_000_000]) {
			expect(() => defineWrite({ ...base, maxBytes })).toThrow(/maxBytes/);
		}
		expect(() => defineWrite({ ...base, maxPending: 0 })).toThrow(/maxPending/);
	});

	it('accepts a non-negative integer maxDelayMs and refuses any other', () => {
		expect(defineWrite(base).maxDelayMs).toBeUndefined();
		expect(defineWrite({ ...base, maxDelayMs: 0 }).maxDelayMs).toBe(0);
		expect(defineWrite({ ...base, maxDelayMs: 60_000 }).maxDelayMs).toBe(60_000);
		for (const maxDelayMs of [-1, 1.5, Number.NaN, '60' as never]) {
			expect(() => defineWrite({ ...base, maxDelayMs })).toThrow(ProtocolError);
			expect(() => defineWrite({ ...base, maxDelayMs })).toThrow(/maxDelayMs/);
		}
	});

	it('serializes maxDelayMs into the worker config only when it is set', () => {
		expect(serializeWrite(defineWrite(base))).toEqual({
			name: 'profile',
			maxBytes: 100,
			maxPending: 2
		});
		expect(Object.keys(serializeWrite(defineWrite(base)))).not.toContain('maxDelayMs');
		expect(serializeWrite(defineWrite({ ...base, maxDelayMs: 60_000 }))).toEqual({
			name: 'profile',
			maxBytes: 100,
			maxPending: 2,
			maxDelayMs: 60_000
		});
	});

	it('is refused by createSpool for a public route, an unknown path, a duplicate and a missing identity', () => {
		const routes = [
			defineRoute('/about', {
				strategy: 'template',
				template: { source: '<html><head></head><body>x</body></html>' },
				load: () => ({})
			}),
			defineRoute('/profile', {
				strategy: 'template',
				scope: 'principal',
				template: { source },
				load: () => ({})
			})
		];
		const identity = { secret: 's', resolve: () => null };
		const make = (writes: ReturnType<typeof defineWrite>[], withIdentity = true) =>
			createSpool({
				routes,
				store: memoryStore(),
				...(withIdentity ? { identity } : {}),
				writes: { classes: writes, enabled: true }
			});
		const code = (fn: () => unknown) => {
			try {
				fn();
			} catch (error) {
				return (error as ProtocolError).code;
			}
			return null;
		};
		expect(code(() => make([defineWrite({ ...base, path: '/about' })]))).toBe('bad-write');
		expect(code(() => make([defineWrite({ ...base, path: '/nowhere' })]))).toBe('bad-write');
		expect(code(() => make([defineWrite(base), defineWrite(base)]))).toBe('bad-write');
		expect(code(() => make([defineWrite(base)], false))).toBe('bad-write');
		expect(code(() => make([defineWrite(base)]))).toBeNull();
	});

	it('puts the classes in the worker config only while the flag is on', () => {
		expect(site({ enabled: true }).spool.config.writes).toEqual([
			{ name: 'profile', maxBytes: 120, maxPending: 2 }
		]);
		expect(site({ enabled: false }).spool.config.writes).toBeUndefined();
		const bare = createSpool({ routes: [], store: memoryStore() });
		expect(bare.config.writes).toBeUndefined();
	});
});

describe('PUT /.spool/write', () => {
	it('applies a write once and answers the new version', async () => {
		const s = site();
		const { status, body } = await read(await put(s));
		expect(status).toBe(200);
		expect(body).toEqual({ version: '1' });
		expect(s.applied).toEqual([
			{ key: 'profile:ada', value: 'hello', expected: '0', writeId: idOf(1) }
		]);
	});

	it('answers 412 with the server version and value when If-Match is stale', async () => {
		const s = site();
		await put(s);
		const { status, body } = await read(await put(s, { id: idOf(2), version: '0' }));
		expect(status).toBe(412);
		expect(body).toEqual({ code: 'conflict', conflict: { version: '1', value: 'hello' } });
		expect(s.applied).toHaveLength(1);
	});

	it('answers a repeated id with the current version and applies nothing', async () => {
		const s = site();
		await put(s);
		const again = await read(await put(s));
		expect(again).toEqual({ status: 200, body: { version: '1' } });
		expect(s.calls.apply).toBe(1);
		expect(s.calls.read).toBe(1);
	});

	it('refuses a repeated id with a different body', async () => {
		const s = site();
		await put(s);
		const { status, body } = await read(
			await put(s, { body: JSON.stringify({ value: 'other' }) })
		);
		expect(status).toBe(422);
		expect(body['code']).toBe('id-reused');
		expect(s.calls.apply).toBe(1);
	});

	it('runs two requests for one key one at a time, so a concurrent repeat applies once', async () => {
		const s = site();
		let release = () => {};
		s.gate.hold = new Promise<void>((resolve) => (release = resolve));
		const first = put(s);
		const second = put(s);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(s.calls.apply).toBe(1);
		release();
		expect([(await first)?.status, (await second)?.status]).toEqual([200, 200]);
		expect(s.calls.apply).toBe(1);
	});

	it('forgets the oldest slot past `remember`, and says so by applying a replay again', async () => {
		const s = site({ remember: 1 });
		await put(s, { as: 'ada' });
		await put(s, { as: 'bo' });
		const replay = await read(await put(s, { as: 'ada' }));
		expect(replay.status).toBe(412);
		expect(s.calls.apply).toBe(3);
	});

	it('refuses a key that belongs to another principal before reading or applying', async () => {
		const s = site();
		const { status, body } = await read(await put(s, { as: 'ada', key: 'profile:bo' }));
		expect(status).toBe(403);
		expect(body['code']).toBe('forbidden');
		expect(s.calls.apply).toBe(0);
		expect(s.calls.read).toBe(0);
	});

	it.each([
		['no one signed in', { as: null }, 401, 'sign-in'],
		['an unknown name', { name: 'cart' }, 404, 'unknown-write'],
		['a missing If-Match', { version: null }, 428, 'missing-version'],
		['a malformed id', { id: 'short' }, 400, 'bad-id'],
		['a missing id', { id: null }, 400, 'bad-id'],
		['a body that is not JSON', { body: 'nope' }, 400, 'bad-body'],
		['a body with no value', { body: '{}' }, 400, 'bad-body'],
		[
			'a body over maxBytes',
			{ body: JSON.stringify({ value: 'x'.repeat(200) }) },
			413,
			'too-large'
		],
		['another method', { method: 'POST' }, 405, 'bad-method']
	] as Array<[string, Put, number, string]>)(
		'refuses %s with a typed code and applies nothing',
		async (_name, over, status, code) => {
			const s = site();
			const got = await read(await put(s, over));
			expect(got.status).toBe(status);
			expect(got.body['code']).toBe(code);
			expect(s.calls.apply).toBe(0);
		}
	);

	it('refuses a malformed key and a malformed If-Match', async () => {
		const s = site();
		const key = await read(
			await s.spool.respond(
				new Request(`${ORIGIN}/.spool/write?name=profile`, {
					method: 'PUT',
					headers: { 'x-user': 'ada', 'spool-write-id': idOf(1), 'if-match': '"0"' },
					body: '{"value":1}'
				})
			)
		);
		expect(key.body['code']).toBe('bad-key');
		const version = await read(
			await s.spool.respond(
				new Request(`${ORIGIN}/.spool/write?name=profile&key=profile%3Aada`, {
					method: 'PUT',
					headers: { 'x-user': 'ada', 'spool-write-id': idOf(1), 'if-match': '*' },
					body: '{"value":1}'
				})
			)
		);
		expect(version.body['code']).toBe('bad-version');
		expect(s.calls.apply).toBe(0);
	});

	it('answers writes-off while the flag is off and never calls the site', async () => {
		const s = site({ enabled: false });
		const { status, body } = await read(await put(s));
		expect(status).toBe(403);
		expect(body['code']).toBe('writes-off');
		expect(s.calls).toEqual({ apply: 0, read: 0, key: 0 });
	});

	it('answers writes-off when no class is declared', async () => {
		const bare = createSpool({
			routes: [],
			store: memoryStore(),
			writes: { enabled: true, classes: [] }
		});
		const response = await bare.respond(
			new Request(`${ORIGIN}/.spool/write?name=profile&key=k`, { method: 'PUT' })
		);
		expect((await read(response)).body['code']).toBe('writes-off');
	});
});

// #region the queue against the real endpoint

type Sent = { record: WriteRecord; status: number };

function queueOf(
	s: Site,
	over: {
		as?: string;
		store?: WriteStore;
		before?: (record: WriteRecord) => Promise<void> | void;
		lose?: () => boolean;
		network?: () => boolean;
	} = {}
) {
	const sent: Sent[] = [];
	const flushes: unknown[] = [];
	let t = 1000;
	const store = over.store ?? memoryWriteStore();
	const queue = new WriteQueue({
		store,
		classes: () => s.spool.config.writes ?? [],
		now: () => (t += 1),
		send: async (record) => {
			await over.before?.(record);
			if (over.network?.()) throw new TypeError('offline');
			const response = (await s.spool.respond(
				new Request(
					`${ORIGIN}/.spool/write?name=${record.name}&key=${encodeURIComponent(record.key)}`,
					{
						method: 'PUT',
						headers: {
							'x-user': over.as ?? 'ada',
							'if-match': ifMatch(record.base),
							'spool-write-id': record.id
						},
						body: JSON.stringify({ value: record.value })
					}
				)
			)) as Response;
			const body: unknown = await response.json();
			sent.push({ record: structuredClone(record), status: response.status });
			if (over.lose?.()) throw new TypeError('the response was lost');
			return { status: response.status, body };
		},
		onFlush: (flush) => flushes.push(flush)
	});
	return { queue, store, sent, flushes };
}

const refusal = (result: unknown) => (result as WriteRefusal).code;

describe('the device queue', () => {
	it('folds two edits to one key into one request with the second value and the first base', async () => {
		const s = site();
		const q = queueOf(s);
		expect(await q.queue.write('profile', 'profile:ada', 'one', '0')).toEqual({
			ok: true,
			state: 'pending',
			edits: 1
		});
		expect(await q.queue.write('profile', 'profile:ada', 'two', '7')).toEqual({
			ok: true,
			state: 'pending',
			edits: 2
		});
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(q.sent).toHaveLength(1);
		expect(q.sent[0]?.record.value).toBe('two');
		expect(q.sent[0]?.record.base).toBe('0');
	});

	it('sends N edits as one request and one apply, then empties the queue', async () => {
		const s = site();
		const q = queueOf(s);
		for (const value of ['a', 'b', 'c', 'd', 'e']) {
			await q.queue.write('profile', 'profile:ada', value, '0');
		}
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(q.sent).toHaveLength(1);
		expect(s.calls.apply).toBe(1);
		expect(s.db.get('profile:ada')?.value).toBe('e');
		expect(await q.queue.list()).toEqual([]);
		expect(q.flushes).toEqual([{ queued: 1, flushed: 1, conflicted: 0 }]);
	});

	it('survives a flush whose response was lost, retries with the same id and applies once', async () => {
		const s = site();
		let lose = true;
		const q = queueOf(s, { lose: () => lose });
		await q.queue.write('profile', 'profile:ada', 'v', '0');
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 0, conflicted: 0 });
		expect(s.calls.apply).toBe(1);
		const held = await q.store.get('profile', 'profile:ada');
		expect(held?.state).toBe('pending');
		expect(held?.attempts).toBe(1);
		lose = false;
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(q.sent.map((x) => x.record.id)).toEqual([held?.id, held?.id]);
		expect(q.sent.map((x) => x.status)).toEqual([200, 200]);
		expect(s.calls.apply).toBe(1);
		expect(await q.queue.list()).toEqual([]);
	});

	it('retries a record a dead worker left flushing, with the same id', async () => {
		const s = site();
		const store = memoryWriteStore();
		const first = queueOf(s, { store, lose: () => true });
		await first.queue.write('profile', 'profile:ada', 'v', '0');
		await first.queue.flush();
		const held = (await store.get('profile', 'profile:ada')) as WriteRecord;
		await store.put({ ...held, state: 'flushing' });
		const second = queueOf(s, { store });
		expect(await second.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(second.sent[0]?.record.id).toBe(held.id);
		expect(s.calls.apply).toBe(1);
	});

	it('keeps an edit made while a request is in flight for a later flush and never loses it', async () => {
		const s = site();
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const q = queueOf(s, { before: () => gate });
		await q.queue.write('profile', 'profile:ada', 'first', '0');
		const flushing = q.queue.flush();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await q.store.get('profile', 'profile:ada'))?.state).toBe('flushing');
		const late = await q.queue.write('profile', 'profile:ada', 'second', '0');
		expect(late).toMatchObject({ ok: true, state: 'flushing', edits: 2 });
		release();
		expect(await flushing).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(q.sent[0]?.record.value).toBe('first');
		const left = (await q.store.get('profile', 'profile:ada')) as WriteRecord;
		expect([left.value, left.base, left.state, left.edits]).toEqual([
			'second',
			'1',
			'pending',
			1
		]);
		expect(left.id).not.toBe(q.sent[0]?.record.id);
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(s.db.get('profile:ada')?.value).toBe('second');
		expect(s.calls.apply).toBe(2);
	});

	it('keeps an edit after a failed attempt out of the retry, so the retry stays identical', async () => {
		const s = site();
		let lose = true;
		const q = queueOf(s, { lose: () => lose });
		await q.queue.write('profile', 'profile:ada', 'first', '0');
		await q.queue.flush();
		await q.queue.write('profile', 'profile:ada', 'second', '0');
		lose = false;
		await q.queue.flush();
		expect(q.sent.map((x) => x.record.value)).toEqual(['first', 'first']);
		expect(q.sent[0]?.record.id).toBe(q.sent[1]?.record.id);
		expect(s.calls.apply).toBe(1);
		await q.queue.flush();
		expect(s.db.get('profile:ada')).toEqual({ version: 2, value: 'second' });
	});

	describe('a stale If-Match', () => {
		async function conflicted() {
			const s = site();
			s.db.set('profile:ada', { version: 4, value: 'theirs' });
			const q = queueOf(s);
			await q.queue.write('profile', 'profile:ada', 'mine', '3');
			const flush = await q.queue.flush();
			return { s, q, flush };
		}

		it('parks the record as conflicted with the local value kept and the server side stored', async () => {
			const { q, flush } = await conflicted();
			expect(flush).toEqual({ queued: 1, flushed: 0, conflicted: 1 });
			const held = (await q.store.get('profile', 'profile:ada')) as WriteRecord;
			expect(held.state).toBe('conflicted');
			expect(held.value).toBe('mine');
			expect(held.conflict).toEqual({ version: '4', value: 'theirs' });
			expect(await q.queue.list()).toMatchObject([
				{
					key: 'profile:ada',
					state: 'conflicted',
					conflict: { version: '4', value: 'theirs' }
				}
			]);
		});

		it('never retries by itself', async () => {
			const { s, q } = await conflicted();
			expect(await q.queue.flush()).toEqual({ queued: 0, flushed: 0, conflicted: 0 });
			expect(await q.queue.flush()).toEqual({ queued: 0, flushed: 0, conflicted: 0 });
			expect(q.sent).toHaveLength(1);
			expect(s.calls.apply).toBe(1);
		});

		it('resolves local by re-basing onto the server version, with a new id', async () => {
			const { s, q } = await conflicted();
			const first = q.sent[0]?.record.id;
			const result = await q.queue.resolve('profile', 'profile:ada', 'local');
			expect(result).toEqual({ ok: true, flush: { queued: 1, flushed: 1, conflicted: 0 } });
			expect(q.sent[1]?.record.base).toBe('4');
			expect(q.sent[1]?.record.id).not.toBe(first);
			expect(s.db.get('profile:ada')).toEqual({ version: 5, value: 'mine' });
			expect(await q.queue.list()).toEqual([]);
		});

		it('resolves server by dropping the local value and returning the server side', async () => {
			const { s, q } = await conflicted();
			const result = await q.queue.resolve('profile', 'profile:ada', 'server');
			expect(result).toEqual({ ok: true, server: { version: '4', value: 'theirs' } });
			expect(await q.queue.list()).toEqual([]);
			expect(s.calls.apply).toBe(1);
		});

		it('refuses to resolve what is not conflicted or not there', async () => {
			const s = site();
			const q = queueOf(s);
			await q.queue.write('profile', 'profile:ada', 'v', '0');
			expect(refusal(await q.queue.resolve('profile', 'profile:ada', 'local'))).toBe(
				'not-conflicted'
			);
			expect(refusal(await q.queue.resolve('profile', 'profile:zed', 'server'))).toBe(
				'no-record'
			);
			expect(refusal(await q.queue.resolve('profile', 'profile:ada', 'x' as never))).toBe(
				'bad-body'
			);
		});
	});

	it('refuses a body over maxBytes, a queue over maxPending, an unknown name, a missing version and a bad key', async () => {
		const s = site();
		const q = queueOf(s);
		expect(refusal(await q.queue.write('profile', 'k', 'x'.repeat(200), '0'))).toBe(
			'too-large'
		);
		expect(refusal(await q.queue.write('cart', 'k', 'x', '0'))).toBe('unknown-write');
		expect(refusal(await q.queue.write('profile', 'k', 'x', undefined))).toBe(
			'missing-version'
		);
		expect(refusal(await q.queue.write('profile', 'k', 'x', 'a b'))).toBe('bad-version');
		expect(refusal(await q.queue.write('profile', '', 'x', '0'))).toBe('bad-key');
		expect(refusal(await q.queue.write('profile', 'k', undefined, '0'))).toBe('bad-body');
		const cyclic: Record<string, unknown> = {};
		cyclic['self'] = cyclic;
		expect(refusal(await q.queue.write('profile', 'k', cyclic, '0'))).toBe('bad-body');
		expect((await q.queue.write('profile', 'k1', 'x', '0')).ok).toBe(true);
		expect((await q.queue.write('profile', 'k2', 'x', '0')).ok).toBe(true);
		expect(refusal(await q.queue.write('profile', 'k3', 'x', '0'))).toBe('too-many');
		expect((await q.queue.write('profile', 'k1', 'y', '0')).ok).toBe(true);
		expect(await q.queue.list()).toHaveLength(2);
	});

	it('parks a permanent refusal as conflicted with its code and stops a pass on a network failure', async () => {
		const s = site();
		const q = queueOf(s);
		await q.queue.write('profile', 'profile:bo', 'x', '0');
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 0, conflicted: 1 });
		expect(await q.queue.list()).toMatchObject([{ state: 'conflicted', refusal: 'forbidden' }]);
		expect(s.calls.apply).toBe(0);

		let down = true;
		const n = queueOf(s, { network: () => down });
		await n.queue.write('profile', 'profile:ada', 'a', '0');
		await n.queue.write('profile', 'profile:ada2', 'b', '0');
		expect(await n.queue.flush()).toEqual({ queued: 1, flushed: 0, conflicted: 0 });
		expect(n.sent).toHaveLength(0);
		expect((await n.queue.list()).map((x) => [x.state, x.attempts])).toEqual([
			['pending', 1],
			['pending', 0]
		]);
		down = false;
	});

	it('leaves a record pending, without counting an attempt, when the server says to sign in', async () => {
		const s = site();
		const q = queueOf(s, { as: '' });
		await q.queue.write('profile', 'profile:ada', 'a', '0');
		await q.queue.write('profile', 'profile:ada2', 'b', '0');
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 0, conflicted: 0 });
		expect(q.sent.map((x) => x.status)).toEqual([401]);
		expect((await q.queue.list()).map((x) => [x.state, x.attempts])).toEqual([
			['pending', 0],
			['pending', 0]
		]);
		expect(s.calls.apply).toBe(0);
	});

	it('leaves a record pending when the server has writes off, and parks any other refusal', async () => {
		const answers = [
			{ status: 403, body: { code: 'writes-off' } },
			{ status: 422, body: { code: 'id-reused' } }
		];
		const store = memoryWriteStore();
		const queue = new WriteQueue({
			store,
			classes: () => [{ name: 'profile', maxBytes: 100, maxPending: 5 }],
			now: () => 1,
			send: async () => answers.shift() as { status: number; body: unknown }
		});
		await queue.write('profile', 'k', 'v', '0');
		await queue.flush();
		expect((await store.get('profile', 'k'))?.state).toBe('pending');
		await queue.flush();
		expect(await queue.list()).toMatchObject([{ state: 'conflicted', refusal: 'id-reused' }]);
	});

	it('stops after kill: nothing is sent, stored or reported', async () => {
		const s = site();
		const q = queueOf(s);
		await q.queue.write('profile', 'profile:ada', 'a', '0');
		q.queue.kill();
		expect(await q.queue.flush()).toEqual({ queued: 0, flushed: 0, conflicted: 0 });
		expect(refusal(await q.queue.write('profile', 'profile:ada', 'b', '0'))).toBe(
			'no-partition'
		);
		expect(await q.queue.list()).toEqual([]);
		expect(refusal(await q.queue.resolve('profile', 'profile:ada', 'server'))).toBe(
			'no-partition'
		);
		expect(q.sent).toHaveLength(0);
		expect(q.flushes).toEqual([]);
	});

	it('stops a pass that a kill interrupts, and does not touch the store with the late answer', async () => {
		const s = site();
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const q = queueOf(s, { before: () => gate });
		await q.queue.write('profile', 'profile:ada', 'a', '0');
		const flushing = q.queue.flush();
		await new Promise((resolve) => setTimeout(resolve, 10));
		q.queue.kill();
		release();
		await flushing;
		expect((await q.store.get('profile', 'profile:ada'))?.state).toBe('flushing');
		expect(q.flushes).toEqual([]);
	});

	it('reports counts only: no field of a flush carries a value', async () => {
		const s = site();
		const q = queueOf(s);
		await q.queue.write('profile', 'profile:ada', 'private words', '0');
		await q.queue.flush();
		expect(JSON.stringify(q.flushes)).not.toContain('private');
		expect(Object.keys(q.flushes[0] as object).sort()).toEqual([
			'conflicted',
			'flushed',
			'queued'
		]);
	});

	it('leaves a record that is still queued after a failed 200 handler under its own id, so the retry applies nothing twice', async () => {
		const s = site();
		const inner = memoryWriteStore();
		let failDelete = true;
		const store: WriteStore = {
			...inner,
			delete: async (name, key) => {
				if (failDelete) throw new Error('storage failed');
				return inner.delete(name, key);
			}
		};
		const q = queueOf(s, { store });
		await q.queue.write('profile', 'profile:ada', 'v', '0');
		expect(await q.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		const stuck = (await inner.get('profile', 'profile:ada')) as WriteRecord;
		expect(stuck.state).toBe('flushing');
		expect(s.calls.apply).toBe(1);
		failDelete = false;
		await q.queue.flush();
		expect(q.sent.map((x) => x.record.id)).toEqual([stuck.id, stuck.id]);
		expect(s.calls.apply).toBe(1);
		expect(await q.queue.list()).toEqual([]);
	});
});

// #endregion

// #region the sealed store

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

const names = async (factory: IDBFactory) =>
	((await factory.databases()) as Array<{ name: string }>).map((d) => d.name).sort();

const record = (over: Partial<WriteRecord> = {}): WriteRecord => ({
	name: 'profile',
	key: 'profile:ada',
	value: 'a private sentence',
	base: '0',
	id: idOf(1),
	state: 'pending',
	queuedAt: 1,
	updatedAt: 1,
	bytes: 30,
	edits: 1,
	attempts: 0,
	...over
});

describe('the write deadline', () => {
	type WriteClass = { name: string; maxBytes: number; maxPending: number; maxDelayMs?: number };
	const profile: WriteClass = {
		name: 'profile',
		maxBytes: 100,
		maxPending: 10,
		maxDelayMs: 60_000
	};
	const quick: WriteClass = { name: 'quick', maxBytes: 100, maxPending: 10, maxDelayMs: 30_000 };

	/**
	 * A queue on a clock the test moves. `advance` fires each timer that falls due on the way, in
	 * order, and waits for its flush; `send` answers 200 unless `offline` says the network is off.
	 */
	function deadlines(
		classes: WriteClass[],
		over: { store?: WriteStore; offline?: () => boolean } = {}
	) {
		let at = 0;
		const store = over.store ?? memoryWriteStore();
		const timers = new Map<object, { due: number; fn: () => unknown }>();
		const sent: Array<{ key: string; value: unknown; base: string }> = [];
		let attempts = 0;
		const queue = new WriteQueue({
			store,
			classes: () => classes,
			now: () => at,
			timers: {
				set: (fn, ms) => {
					const handle = {};
					timers.set(handle, { due: at + ms, fn });
					return handle;
				},
				clear: (handle) => void timers.delete(handle as object)
			},
			send: async (record) => {
				attempts += 1;
				if (over.offline?.()) throw new TypeError('offline');
				sent.push({ key: record.key, value: record.value, base: record.base });
				return { status: 200, body: { version: String(sent.length) } };
			}
		});
		async function advance(to: number): Promise<void> {
			for (;;) {
				const next = [...timers.entries()]
					.filter(([, timer]) => timer.due <= to)
					.sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				timers.delete(next[0]);
				at = next[1].due;
				await next[1].fn();
			}
			at = to;
		}
		return {
			queue,
			store,
			sent,
			advance,
			attempts: () => attempts,
			pending: () => timers.size
		};
	}

	it('sends nothing before a network moment when maxDelayMs is unset', async () => {
		const d = deadlines([{ name: 'profile', maxBytes: 100, maxPending: 10 }]);
		await d.queue.write('profile', 'a', 1, '0');
		await d.queue.write('profile', 'b', 2, '0');
		await d.queue.write('profile', 'c', 3, '0');
		await d.advance(10 * 60_000);
		expect(d.sent).toHaveLength(0);
		expect(d.pending()).toBe(0);
		expect(await d.queue.flush()).toEqual({ queued: 3, flushed: 3, conflicted: 0 });
		expect(d.sent).toHaveLength(3);
	});

	it('holds one key until its deadline, then sends its last value once', async () => {
		const d = deadlines([profile]);
		await d.queue.write('profile', 'a', 'one', '0');
		await d.advance(10_000);
		await d.queue.write('profile', 'a', 'two', '0');
		await d.advance(20_000);
		await d.queue.write('profile', 'a', 'three', '0');
		await d.advance(59_999);
		expect(d.sent).toHaveLength(0);
		await d.advance(60_000);
		expect(d.sent).toEqual([{ key: 'a', value: 'three', base: '0' }]);
		expect(d.pending()).toBe(0);
	});

	it('sends three keys in one burst at the deadline and none before', async () => {
		const d = deadlines([profile]);
		await d.queue.write('profile', 'a', 'x', '0');
		await d.advance(10_000);
		await d.queue.write('profile', 'b', 'y', '0');
		await d.advance(20_000);
		await d.queue.write('profile', 'c', 'z', '0');
		await d.advance(59_999);
		expect(d.sent).toHaveLength(0);
		await d.advance(60_000);
		expect(d.sent.map((s) => s.key)).toEqual(['a', 'b', 'c']);
		expect(d.pending()).toBe(0);
	});

	it('starts a new window at the next write after a flush', async () => {
		const d = deadlines([profile]);
		await d.queue.write('profile', 'a', 'one', '0');
		await d.advance(60_000);
		expect(d.sent).toHaveLength(1);
		await d.advance(65_000);
		await d.queue.write('profile', 'a', 'two', '1');
		await d.advance(124_999);
		expect(d.sent).toHaveLength(1);
		await d.advance(125_000);
		expect(d.sent.map((s) => s.value)).toEqual(['one', 'two']);
	});

	it('sends once on an explicit flush before the deadline and not again at the old one', async () => {
		const d = deadlines([profile]);
		await d.queue.write('profile', 'a', 'one', '0');
		await d.advance(30_000);
		expect(await d.queue.flush()).toEqual({ queued: 1, flushed: 1, conflicted: 0 });
		expect(d.pending()).toBe(0);
		await d.advance(60_000);
		expect(d.sent).toHaveLength(1);
	});

	it('flushes a record whose deadline passed while the worker was stopped, once', async () => {
		const first = deadlines([profile]);
		await first.queue.write('profile', 'a', 'x', '0');
		await first.queue.write('profile', 'b', 'y', '0');
		const second = deadlines([profile], { store: first.store });
		await second.advance(120_000);
		expect(second.sent).toHaveLength(0);
		expect(await second.queue.flushDue()).toEqual({ queued: 2, flushed: 2, conflicted: 0 });
		expect(second.sent.map((s) => s.key)).toEqual(['a', 'b']);
		expect(await second.queue.flushDue()).toEqual({ queued: 0, flushed: 0, conflicted: 0 });
		expect(second.sent).toHaveLength(2);
	});

	it('flushes two classes together at the earlier due time', async () => {
		const d = deadlines([profile, quick]);
		await d.queue.write('profile', 'a', 'slow', '0');
		await d.advance(10_000);
		await d.queue.write('quick', 'b', 'fast', '0');
		await d.advance(39_999);
		expect(d.sent).toHaveLength(0);
		await d.advance(40_000);
		expect(d.sent.map((s) => s.key)).toEqual(['a', 'b']);
		expect(d.pending()).toBe(0);
	});

	it('closes a deadline that failed, so no timer retries it until a new write', async () => {
		let offline = true;
		const d = deadlines([profile], { offline: () => offline });
		await d.queue.write('profile', 'a', 'x', '0');
		await d.advance(60_000);
		expect(d.attempts()).toBe(1);
		await d.advance(300_000);
		expect(d.attempts()).toBe(1);
		expect(d.pending()).toBe(0);
		expect((await d.store.get('profile', 'a'))?.due).toBeUndefined();
		offline = false;
		await d.queue.write('profile', 'a', 'y', '0');
		await d.advance(360_000);
		expect(d.sent.map((s) => s.value)).toEqual(['x']);
		await d.advance(420_000);
		expect(d.sent.map((s) => s.value)).toEqual(['x', 'y']);
	});

	it('stops its deadline when the queue is killed', async () => {
		const d = deadlines([profile]);
		await d.queue.write('profile', 'a', 'x', '0');
		expect(d.pending()).toBe(1);
		d.queue.kill();
		expect(d.pending()).toBe(0);
		await d.advance(60_000);
		expect(d.sent).toHaveLength(0);
	});
});

describe('the sealed device store', () => {
	it('keeps the partition, class and key readable and everything else ciphertext', async () => {
		const factory = freshIndexedDB();
		const store = idbWriteStore(factory, 'pa', memoryVault());
		await store.put(record({ conflict: { version: '9', value: 'the server secret' } }));
		const [row] = (await rows(factory, 'spool-writes', 'queue')) as Array<{
			partition: string;
			name: string;
			key: string;
			value?: unknown;
			sealed: { data: ArrayBuffer };
		}>;
		expect([row?.partition, row?.name, row?.key]).toEqual(['pa', 'profile', 'profile:ada']);
		expect(row?.value).toBeUndefined();
		const text = new TextDecoder('latin1').decode(row?.sealed.data);
		expect(text).not.toContain('private');
		expect(text).not.toContain('server secret');
		expect((await store.get('profile', 'profile:ada'))?.value).toBe('a private sentence');
	});

	it('gives each partition its own rows, and deleting one partition leaves the other', async () => {
		const factory = freshIndexedDB();
		const vault = memoryVault();
		const a = idbWriteStore(factory, 'pa', vault);
		const b = idbWriteStore(factory, 'pb', vault);
		await a.put(record());
		await b.put(record({ value: 'bo words', key: 'profile:bo' }));
		expect((await a.all()).map((r) => r.key)).toEqual(['profile:ada']);
		expect((await b.all()).map((r) => r.key)).toEqual(['profile:bo']);
		expect(await b.get('profile', 'profile:ada')).toBeUndefined();
		await destroyWrites(factory, 'pa');
		expect(await a.all()).toEqual([]);
		expect((await b.all()).map((r) => r.value)).toEqual(['bo words']);
	});

	it('reads a row as absent once its partition key is shredded, and drops it', async () => {
		const factory = freshIndexedDB();
		const vault = memoryVault();
		const store = idbWriteStore(factory, 'pa', vault);
		await store.put(record());
		await vault.shred('pa');
		expect(await store.get('profile', 'profile:ada')).toBeUndefined();
		expect(await store.all()).toEqual([]);
		expect(await rows(factory, 'spool-writes', 'queue')).toEqual([]);
	});

	it('does not read a row copied into another slot', async () => {
		const factory = freshIndexedDB();
		const vault = memoryVault();
		const store = idbWriteStore(factory, 'pa', vault);
		await store.put(record());
		const [row] = (await rows(factory, 'spool-writes', 'queue')) as Array<
			Record<string, unknown>
		>;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open('spool-writes');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('queue', 'readwrite');
			tx.objectStore('queue').put({ ...row, key: 'profile:bo' });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
		expect(await store.get('profile', 'profile:bo')).toBeUndefined();
	});

	it('creates no database when asked to delete a partition that never had one', async () => {
		const factory = freshIndexedDB();
		await destroyWrites(factory, 'pa');
		expect(await names(factory)).toEqual([]);
	});

	it('creates spool-writes at version 1 and leaves the shared spool database alone', async () => {
		const factory = freshIndexedDB();
		const store = idbWriteStore(factory, 'pa', memoryVault());
		await store.put(record());
		const list = (await factory.databases()) as Array<{ name: string; version: number }>;
		expect(list).toEqual([{ name: 'spool-writes', version: 1 }]);
	});

	it('never blocks another context from deleting or upgrading spool-writes while its connection is open', async () => {
		const factory = freshIndexedDB();
		const store = idbWriteStore(factory, 'pa', memoryVault());
		await store.put(record());
		const blocked: string[] = [];

		await new Promise<void>((resolve, reject) => {
			const request = factory.deleteDatabase('spool-writes');
			request.onblocked = () => void blocked.push('delete');
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
		await store.put(record({ key: 'profile:bo' }));
		expect((await store.all()).map((r) => r.key)).toEqual(['profile:bo']);

		await new Promise<void>((resolve, reject) => {
			const request = factory.open('spool-writes', 2);
			request.onblocked = () => void blocked.push('upgrade');
			request.onsuccess = () => {
				request.result.close();
				resolve();
			};
			request.onerror = () => reject(request.error);
		});
		expect(blocked).toEqual([]);
	});
});

// #endregion

// #region resource writes

type Row = { id: string; title: string };
const SITE = 'https://site.test';

/** a public dataset whose `changes` reads a log of puts and removes, with the rows it holds */
function table(name: string, rows: Row[]) {
	const current = new Map(rows.map((row) => [row.id, row]));
	const log: Array<{ key: string; deleted: boolean }> = [];
	const dataset = defineDataset(name, {
		scope: 'public',
		key: (row) => String((row as Row).id),
		seed: () => [...current.values()],
		read: async (ids) => ids.flatMap((id) => (current.has(id) ? [current.get(id) as Row] : [])),
		changes: async (since) => {
			const latest = new Map<string, boolean>();
			for (const entry of log.slice(since)) latest.set(entry.key, entry.deleted);
			const puts = [...latest].filter(([, gone]) => !gone).map(([key]) => key);
			const deletes = [...latest]
				.filter(([, gone]) => gone)
				.map(([key]) => ({ key, cursor: log.length }));
			return { cursor: log.length, puts, deletes };
		},
		horizon: async () => 0,
		head: async () => ({ cursor: log.length }),
		schema: 'v1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});
	return {
		dataset,
		put(row: Row) {
			current.set(row.id, row);
			log.push({ key: row.id, deleted: false });
		},
		remove(id: string) {
			current.delete(id);
			log.push({ key: id, deleted: true });
		}
	};
}

/** a site with one resource over `rows` and an audit table the handler also writes */
function resourceSite(
	options: { status?: number; bundles?: boolean; routes?: Route[]; audit?: boolean } = {}
) {
	const rows = table('rows', [
		{ id: 'r1', title: 'One' },
		{ id: 'r2', title: 'Two' }
	]);
	const audit = table('audit', []);
	const store = memoryStore();
	const bundles = memoryBundleStore();
	const spool = createSpool({
		routes: options.routes ?? [],
		resources: [defineResource('/rows', { dataset: 'rows', key: 'id' })],
		datasets: [rows.dataset, audit.dataset],
		store,
		...(options.bundles === false ? {} : { bundles })
	});
	const next = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/rows') {
			const row = (await request.json()) as Row;
			rows.put(row);
			if (options.audit !== false) audit.put({ id: 'a1', title: 'posted' });
			return Response.json(row, { status: 201 });
		}
		if (request.method === 'DELETE' && url.pathname.startsWith('/rows/')) {
			rows.remove(url.pathname.slice('/rows/'.length));
			return Response.json({ id: url.pathname.slice('/rows/'.length) });
		}
		if (request.method !== 'PATCH' || url.pathname !== '/rows/r1') {
			return new Response('not found', { status: 404 });
		}
		if (options.status !== undefined) return new Response('no', { status: options.status });
		const body = (await request.json()) as { title: string };
		rows.put({ id: 'r1', title: body.title });
		if (options.audit !== false) audit.put({ id: 'a1', title: 'patched' });
		return Response.json({ id: 'r1', title: body.title });
	};
	const patch = (title: string) =>
		new Request(`${SITE}/rows/r1`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title })
		});
	return { spool, store, bundles, rows, audit, next, patch };
}

/** a worker pack stub that holds `version` and refuses a delta whose digest is `bad` */
function fakePack(version: number) {
	const applied: BundleDelta[] = [];
	const pack = {
		head: async () => ({ version }),
		applyDelta: async (delta: BundleDelta) => {
			if (delta.digest === 'bad') throw new Error('the set digest does not match');
			applied.push(delta);
		}
	} as unknown as PackStore;
	return { pack, applied };
}

/** a response with these headers that says it came from `url` */
function answerFrom(url: string, headers: Record<string, string> = {}) {
	const response = new Response(null, { headers });
	Object.defineProperty(response, 'url', { value: url });
	return response;
}

const deltaOf = (from: number, to: number, digest = '0'.repeat(64)): BundleDelta => ({
	from,
	to,
	digest,
	tables: {}
});

/** the server's state at version 0, as a worker holds it before the write */
async function workerAt0(site: ReturnType<typeof resourceSite>) {
	const pack = createPackStore(freshIndexedDB());
	const bytes = await site.bundles.get(0);
	if (!bytes) throw new Error('the site holds no pack at version 0');
	await pack.installPack(
		(async function* () {
			yield bytes;
		})()
	);
	return pack;
}

/** a fetch of the site's delta route, counted by the caller */
const deltaFrom =
	(site: ReturnType<typeof resourceSite>, fetched: Array<[number, number]>) =>
	async (from: number, to: number) => {
		fetched.push([from, to]);
		const route = await site.spool.handle(
			new Request(`${SITE}/.spool/bundle/delta/${from}/${to}`),
			site.next
		);
		return (await route.json()) as BundleDelta;
	};

/**
 * The answer the server sends past the byte limit: the same answer with the delta left out and the
 * digest of the state it reaches in its place.
 */
async function pastLimit(
	site: ReturnType<typeof resourceSite>,
	answer: Response,
	url: string,
	from: number,
	to: number,
	text: string
): Promise<Response> {
	const route = await site.spool.handle(
		new Request(`${SITE}/.spool/bundle/delta/${from}/${to}`),
		site.next
	);
	const { digest } = (await route.json()) as BundleDelta;
	const headers = new Headers(answer.headers);
	headers.delete(HEADERS.delta);
	headers.set(WRITE_HEADERS.digest, digest);
	const out = new Response(text, { status: answer.status, headers });
	Object.defineProperty(out, 'url', { value: url });
	return out;
}

describe('defineResource', () => {
	it('expands one item family and the writes that change it', () => {
		const resource = defineResource('/rows', { dataset: 'rows', key: 'id' });
		expect(
			resource.routes.map((route) => [
				route.pattern,
				route.strategy,
				route.family,
				route.query
			])
		).toEqual([
			['/rows', 'data', undefined, { list: 'rows', dataset: 'rows' }],
			['/rows/:id', 'data', { dataset: 'rows', key: 'id' }, undefined]
		]);
		expect(
			resource.writes.map((write) => [
				write.method,
				write.pattern,
				write.apply,
				write.updates
			])
		).toEqual([
			['POST', '/rows', 'response', ['/rows', '/rows/:id']],
			['PUT', '/rows/:id', 'response', ['/rows', '/rows/:id']],
			['PATCH', '/rows/:id', 'response', ['/rows', '/rows/:id']],
			['DELETE', '/rows/:id', 'delete', ['/rows', '/rows/:id']],
			['POST', '/rows/:id/:action', 'invalidate', ['/rows', '/rows/:id']],
			['PUT', '/rows/:id/:action', 'invalidate', ['/rows', '/rows/:id']],
			['PATCH', '/rows/:id/:action', 'invalidate', ['/rows', '/rows/:id']],
			['DELETE', '/rows/:id/:action', 'invalidate', ['/rows', '/rows/:id']]
		]);
	});

	it('refuses a write with an unknown method, apply or origin, or a function apply', () => {
		const code = (fn: () => unknown) => {
			try {
				fn();
			} catch (error) {
				return (error as ProtocolError).code;
			}
			return null;
		};
		const base = {
			method: 'PATCH',
			dataset: 'rows',
			key: 'id',
			apply: 'response',
			updates: []
		};
		const refused = (declaration: object) =>
			code(() => defineWrite('/rows/:id', declaration as never));
		expect(refused({ ...base, method: 'GET' })).toBe('bad-write');
		expect(refused({ ...base, apply: 'predict' })).toBe('bad-write');
		expect(refused({ ...base, apply: (row: unknown) => row })).toBe('bad-write');
		expect(refused({ ...base, key: '' })).toBe('bad-write');
		expect(refused({ ...base, origin: 'https://api.test/v2' })).toBe('bad-write');
		expect(refused(base)).toBeNull();
	});
});

describe('declared patches', () => {
	const row = { id: 'r1', title: 'one', count: 2 };

	it('applies each part of a patch to a fixed row, in set, inc, unset order', () => {
		const cases: Array<[ResourcePatch, unknown, unknown]> = [
			[{ set: { title: 'two' } }, {}, { id: 'r1', title: 'two', count: 2 }],
			[
				{ set: { title: { body: 'name' } } },
				{ name: 'from body' },
				{ ...row, title: 'from body' }
			],
			[{ set: { title: { body: 'a.b' } } }, { a: { b: 'deep' } }, { ...row, title: 'deep' }],
			[{ inc: { count: 3 } }, {}, { ...row, count: 5 }],
			[{ inc: { hits: 1 } }, {}, { ...row, hits: 1 }],
			[{ unset: ['title'] }, {}, { id: 'r1', count: 2 }],
			[
				{ set: { count: { body: 'n' } }, inc: { count: 1 }, unset: ['title'] },
				{ n: 7 },
				{ id: 'r1', count: 8 }
			]
		];
		for (const [patch, body, expected] of cases) {
			expect(applyPatch(row, body, patch)).toEqual(expected);
		}
	});

	it('returns undefined for a body path with no value and an inc on a non-number', () => {
		expect(applyPatch(row, {}, { set: { title: { body: 'missing' } } })).toBeUndefined();
		expect(applyPatch(row, { a: 5 }, { set: { title: { body: 'a.b' } } })).toBeUndefined();
		expect(applyPatch(row, {}, { inc: { title: 1 } })).toBeUndefined();
	});

	it('never changes the row it was given', () => {
		const held = { id: 'r1', count: 2 };
		applyPatch(held, {}, { inc: { count: 1 }, unset: ['id'] });
		expect(held).toEqual({ id: 'r1', count: 2 });
	});

	it('refuses a patch that is empty, has an unknown key or a bad field, or a value that is not JSON', () => {
		const code = (patch: unknown) => {
			try {
				defineWrite('/rows/:id', {
					method: 'PATCH',
					dataset: 'rows',
					key: 'id',
					apply: patch as never,
					updates: []
				});
			} catch (error) {
				return (error as ProtocolError).code;
			}
			return null;
		};
		for (const patch of [
			{},
			{ bogus: 1 },
			{ set: 'x' },
			{ set: { 'a.b': 1 } },
			{ set: { title: { body: 'a..b' } } },
			{ set: { title: () => 1 } },
			{ set: { title: Number.NaN } },
			{ inc: { count: '1' } },
			{ inc: { count: Number.NaN } },
			{ unset: 'title' },
			{ unset: ['__proto__'] }
		]) {
			expect(code(patch)).toBe('bad-write');
		}
		expect(code({ set: { title: 'x' }, inc: { count: 1 }, unset: ['id'] })).toBeNull();
	});
});

describe('writeFor and couplingReport', () => {
	const rows = defineResource('/rows', { dataset: 'rows', key: 'id' });
	const api = defineResource('/v2/articles', {
		dataset: 'articles',
		key: 'id',
		origin: 'https://api.test'
	});

	it('matches a same-origin write, and never a cross-origin lookalike', () => {
		expect(writeFor(rows.writes, 'PATCH', new URL(`${SITE}/rows/r1`), SITE)?.pattern).toBe(
			'/rows/:id'
		);
		const lookalike = new URL('https://evil.test/rows/r1');
		expect(writeFor(rows.writes, 'PATCH', lookalike, SITE)).toBeUndefined();
		expect(writeFor(rows.writes, 'GET', new URL(`${SITE}/rows/r1`), SITE)).toBeUndefined();
	});

	it('matches a declared origin, and not the page origin', () => {
		const declared = new URL('https://api.test/v2/articles/a1');
		expect(writeFor(api.writes, 'PATCH', declared, SITE)).toBeDefined();
		expect(
			writeFor(api.writes, 'PATCH', new URL(`${SITE}/v2/articles/a1`), SITE)
		).toBeUndefined();
	});

	it('reports the resource each write couples to, or none', () => {
		const writes = [
			{ method: 'PATCH', url: `${SITE}/rows/r1` },
			{ method: 'PATCH', url: 'https://evil.test/rows/r1' },
			{ method: 'PATCH', url: `${SITE}/about` }
		];
		expect(couplingReport(writes, [rows], SITE)).toEqual([
			{
				method: 'PATCH',
				url: `${SITE}/rows/r1`,
				resource: '/rows',
				families: ['/rows', '/rows/:id']
			},
			{ method: 'PATCH', url: 'https://evil.test/rows/r1', resource: null, families: [] },
			{ method: 'PATCH', url: `${SITE}/about`, resource: null, families: [] }
		]);
	});

	it('reports the GET families of an action write, and the declared origin of a foreign write', () => {
		const writes = [
			{ method: 'POST', url: `${SITE}/rows/r1/touch` },
			{ method: 'PATCH', url: 'https://api.test/v2/articles/a1' }
		];
		expect(couplingReport(writes, [rows, api], SITE)).toEqual([
			{
				method: 'POST',
				url: `${SITE}/rows/r1/touch`,
				resource: '/rows',
				families: ['/rows', '/rows/:id']
			},
			{
				method: 'PATCH',
				url: 'https://api.test/v2/articles/a1',
				resource: '/v2/articles',
				families: ['/v2/articles', '/v2/articles/:id']
			}
		]);
	});
});

describe('the server answer to a resource write', () => {
	it('attaches exactly the rows the handler changed, including a side-effect row', async () => {
		const site = resourceSite();
		const response = await site.spool.handle(site.patch('Uno'), site.next);
		expect(response.status).toBe(200);
		const delta = JSON.parse(response.headers.get(HEADERS.delta) ?? 'null') as BundleDelta;
		expect([delta.from, delta.to]).toEqual([0, 1]);
		expect(Object.keys(delta.tables).sort()).toEqual(['audit', 'rows']);
		expect(delta.tables['rows']).toEqual({
			puts: [['r1', { id: 'r1', title: 'Uno' }]],
			deletes: []
		});
		expect(delta.tables['audit']).toEqual({
			puts: [['a1', { id: 'a1', title: 'patched' }]],
			deletes: []
		});
		expect(await site.store.cursor()).toBe(1);
	});

	it('leaves the header out past the byte limit; the delta route answers the same change', async () => {
		const site = resourceSite();
		const long = 'x'.repeat(20_000);
		const response = await site.spool.handle(site.patch(long), site.next);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		const route = await site.spool.handle(
			new Request(`${SITE}/.spool/bundle/delta/0/1`),
			site.next
		);
		expect(route.status).toBe(200);
		const delta = (await route.json()) as BundleDelta;
		expect(delta.tables['rows']?.puts).toEqual([['r1', { id: 'r1', title: long }]]);
	});

	it('answers no delta and moves no version when the handler refuses the write', async () => {
		const site = resourceSite({ status: 403 });
		const response = await site.spool.handle(site.patch('Uno'), site.next);
		expect(response.status).toBe(403);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		expect(await site.store.cursor()).toBe(0);
	});

	it('passes a write through without a pack store: no delta, no version move', async () => {
		const site = resourceSite({ bundles: false });
		const response = await site.spool.handle(site.patch('Uno'), site.next);
		expect(response.status).toBe(200);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		expect(await site.store.cursor()).toBe(0);
	});
});

describe('a resource write confirmed by its digest in the worker', () => {
	const writeAt = (method: string, path: string) =>
		writeFor(
			defineResource('/rows', { dataset: 'rows', key: 'id' }).writes,
			method,
			new URL(`${SITE}${path}`),
			SITE
		) as ResourceWrite;
	const resourceRoutes = defineResource('/rows', { dataset: 'rows', key: 'id' }).routes;

	it('answers the version and the digest of the state when the delta is left out', async () => {
		const site = resourceSite();
		const response = await site.spool.handle(site.patch('x'.repeat(20_000)), site.next);
		expect(response.headers.get(HEADERS.delta)).toBeNull();
		const route = await site.spool.handle(
			new Request(`${SITE}/.spool/bundle/delta/0/1`),
			site.next
		);
		const delta = (await route.json()) as BundleDelta;
		expect(response.headers.get(HEADERS.vector)).toBe('1');
		expect(response.headers.get(WRITE_HEADERS.digest)).toBe(delta.digest);
	});

	it('confirms a correct PATCH prediction with no request when the digest matches', async () => {
		const site = resourceSite({ audit: false });
		const long = 'x'.repeat(20_000);
		const response = await site.spool.handle(site.patch(long), site.next);
		Object.defineProperty(response, 'url', { value: `${SITE}/rows/r1` });
		const pack = await workerAt0(site);
		const fetched: Array<[number, number]> = [];
		await settleWrite(response, pack, deltaFrom(site, fetched), SITE, {
			write: writeAt('PATCH', '/rows/r1'),
			url: new URL(`${SITE}/rows/r1`),
			body: { title: long },
			routes: resourceRoutes
		});
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toEqual({ id: 'r1', title: long });
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 0 }));
	});

	it('confirms a POST with no request when the delta is left out, the path and query rows it adds included', async () => {
		const site = resourceSite({ audit: false });
		const row = { id: 'r3', title: 'x'.repeat(20_000) };
		const response = await site.spool.handle(
			new Request(`${SITE}/rows`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(row)
			}),
			site.next
		);
		Object.defineProperty(response, 'url', { value: `${SITE}/rows` });
		const pack = await workerAt0(site);
		const fetched: Array<[number, number]> = [];
		await settleWrite(response, pack, deltaFrom(site, fetched), SITE, {
			write: writeAt('POST', '/rows'),
			url: new URL(`${SITE}/rows`),
			body: row,
			routes: resourceRoutes
		});
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r3')).toEqual(row);
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 0 }));
	});

	it('confirms a DELETE with no request when the delta is left out, the path and query rows it removes included', async () => {
		const site = resourceSite({ audit: false });
		const row = { id: 'r3', title: 'x'.repeat(20_000) };
		const posted = await site.spool.handle(
			new Request(`${SITE}/rows`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(row)
			}),
			site.next
		);
		const pack = await workerAt0(site);
		const fetched: Array<[number, number]> = [];
		const made = await pastLimit(site, posted, `${SITE}/rows`, 0, 1, JSON.stringify(row));
		await settleWrite(made, pack, deltaFrom(site, fetched), SITE, {
			write: writeAt('POST', '/rows'),
			url: new URL(`${SITE}/rows`),
			body: row,
			routes: resourceRoutes
		});
		const removed = await site.spool.handle(
			new Request(`${SITE}/rows/r3`, { method: 'DELETE' }),
			site.next
		);
		const gone = await pastLimit(site, removed, `${SITE}/rows/r3`, 1, 2, await removed.text());
		await settleWrite(gone, pack, deltaFrom(site, fetched), SITE, {
			write: writeAt('DELETE', '/rows/r3'),
			url: new URL(`${SITE}/rows/r3`),
			body: undefined,
			routes: resourceRoutes
		});
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r3')).toBeUndefined();
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 2, unconfirmed: 0 }));
	});

	it('a prediction the digest refutes is never read, and costs one delta fetch', async () => {
		const site = resourceSite({ audit: false });
		const row = { id: 'r3', title: 'x'.repeat(20_000) };
		const posted = await site.spool.handle(
			new Request(`${SITE}/rows`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(row)
			}),
			site.next
		);
		const pack = await workerAt0(site);
		const fetched: Array<[number, number]> = [];
		const seen: unknown[] = [];
		const wrong = await pastLimit(
			site,
			posted,
			`${SITE}/rows`,
			0,
			1,
			JSON.stringify({ id: 'r3', title: 'wrong' })
		);
		const fetch = deltaFrom(site, fetched);
		await settleWrite(
			wrong,
			pack,
			async (from, to) => {
				seen.push(await pack.getRow('rows', 'r3'));
				return fetch(from, to);
			},
			SITE,
			{
				write: writeAt('POST', '/rows'),
				url: new URL(`${SITE}/rows`),
				body: row,
				routes: resourceRoutes
			}
		);
		expect(seen).toEqual([undefined]);
		expect(fetched).toEqual([[0, 1]]);
		expect(await pack.getRow('rows', 'r3')).toEqual(row);
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 0 }));
	});
});

describe('the reads after a resource write, against the server', () => {
	it('costs one request per write, and the collection and item reads after them none', async () => {
		const site = resourceSite({ audit: false });
		await site.spool.publish(new URL(SITE));
		const pack = await workerAt0(site);
		const asked: string[] = [];
		const runtime = createRuntime({
			config: site.spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				asked.push(`${request.method} ${request.url}`);
				// the first visit to the collection is the one network read; its answer sets the policy
				const answer =
					request.method === 'GET'
						? Response.json({
								rows: [
									{ id: 'r1', title: 'One' },
									{ id: 'r2', title: 'Two' }
								]
							})
						: await site.spool.handle(request, site.next);
				answer.headers.set('content-security-policy', "default-src 'self'");
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: SITE,
			pack
		});
		await runtime.handle(new Request(`${SITE}/rows`), () => undefined);
		expect(asked).toEqual([`GET ${SITE}/rows`]);
		const row = { id: 'r3', title: 'x'.repeat(20_000) };
		const posted = await runtime.handle(
			new Request(`${SITE}/rows`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(row)
			}),
			() => undefined
		);
		expect(posted?.status).toBe(201);
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`]);

		const list = await runtime.handle(new Request(`${SITE}/rows`), () => undefined);
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`]);
		expect(await list?.json()).toMatchObject({ rows: [{ id: 'r1' }, { id: 'r2' }, row] });
		const item = await runtime.handle(new Request(`${SITE}/rows/r3`), () => undefined);
		expect(await item?.json()).toEqual(row);
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`]);

		const deleted = await runtime.handle(
			new Request(`${SITE}/rows/r1`, { method: 'DELETE' }),
			() => undefined
		);
		expect(deleted?.status).toBe(200);
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`, `DELETE ${SITE}/rows/r1`]);

		const after = await runtime.handle(new Request(`${SITE}/rows`), () => undefined);
		expect(await after?.json()).toMatchObject({ rows: [{ id: 'r2' }, row] });
		const kept = await runtime.handle(new Request(`${SITE}/rows/r2`), () => undefined);
		expect(await kept?.json()).toEqual({ id: 'r2', title: 'Two' });
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`, `DELETE ${SITE}/rows/r1`]);
	});
});

describe('index tables of a resource write', () => {
	const query = defineRoute('/titles', {
		strategy: 'data',
		load: () => ({}),
		query: { list: 'rows', dataset: 'rows', filter: { title: 'string' }, sort: ['title'] }
	});
	const resourceRoutes = defineResource('/rows', { dataset: 'rows', key: 'id' }).routes;

	it('lets publish build the pack at the write version after a write', async () => {
		const site = resourceSite({ routes: [query] });
		await site.spool.handle(site.patch('Uno'), site.next);
		const out = await site.spool.publish(new URL(SITE));
		expect(out.version).toBe(1);
		const served = (await site.spool.respond(
			new Request(`${SITE}/.spool/bundle/1`)
		)) as Response;
		expect(served.status).toBe(200);
		const { state } = await readBundle(new Uint8Array(await served.arrayBuffer()));
		expect(Object.keys(state.tables).sort()).toEqual([
			'audit',
			'path:rows',
			'query:rows',
			'rows'
		]);
	});

	it('sends the query index rows the write changes in Spool-Delta', async () => {
		const site = resourceSite({ routes: [query] });
		const response = await site.spool.handle(site.patch('Uno'), site.next);
		const delta = JSON.parse(response.headers.get(HEADERS.delta) ?? 'null') as BundleDelta;
		expect(delta.tables['query:rows']).toEqual({
			puts: [['r1', { title: 'Uno' }]],
			deletes: []
		});
		expect(delta.tables['path:rows']).toBeUndefined();
	});

	it('writes the same table names a fresh build at that version has', async () => {
		const site = resourceSite({ routes: [query] });
		await site.spool.handle(site.patch('Uno'), site.next);
		const kept = await readBundle((await site.bundles.get(1)) as Uint8Array<ArrayBuffer>);
		const fresh = await buildBundle({
			store: memoryBundleStore(),
			datasets: [site.rows.dataset, site.audit.dataset],
			routes: [query, ...resourceRoutes],
			version: 1,
			url: new URL(SITE)
		});
		const { state } = await readBundle(fresh.bytes);
		expect(Object.keys(kept.state.tables).sort()).toEqual(Object.keys(state.tables).sort());
	});
});

describe('settleWrite in the worker', () => {
	it('applies the answer delta with no further request', async () => {
		const { pack, applied } = fakePack(1);
		const fetched: Array<[number, number]> = [];
		const delta = deltaOf(1, 2);
		const answer = answerFrom(`${SITE}/rows/r1`, { [HEADERS.delta]: JSON.stringify(delta) });
		await settleWrite(
			answer,
			pack,
			async (from, to) => (fetched.push([from, to]), deltaOf(from, to)),
			SITE
		);
		expect(applied).toEqual([delta]);
		expect(fetched).toEqual([]);
	});

	it('fetches exactly one delta when the answer delta is refused', async () => {
		const { pack, applied } = fakePack(1);
		const fetched: Array<[number, number]> = [];
		const answer = answerFrom(`${SITE}/rows/r1`, {
			[HEADERS.delta]: JSON.stringify(deltaOf(1, 2, 'bad'))
		});
		await settleWrite(
			answer,
			pack,
			async (from, to) => (fetched.push([from, to]), deltaOf(from, to)),
			SITE
		);
		expect(fetched).toEqual([[1, 2]]);
		expect(applied).toEqual([deltaOf(1, 2)]);
	});

	it('fetches the delta to the version the answer names when it sends no delta', async () => {
		const { pack, applied } = fakePack(1);
		const fetched: Array<[number, number]> = [];
		const answer = answerFrom(`${SITE}/rows/r1`, { [HEADERS.vector]: '3' });
		await settleWrite(
			answer,
			pack,
			async (from, to) => (fetched.push([from, to]), deltaOf(from, to)),
			SITE
		);
		expect(fetched).toEqual([[1, 3]]);
		expect(applied).toEqual([deltaOf(1, 3)]);
	});

	it('applies nothing from an answer that landed on another origin', async () => {
		const { pack, applied } = fakePack(1);
		const fetched: Array<[number, number]> = [];
		const landed = answerFrom('https://evil.test/rows/r1', {
			[HEADERS.delta]: JSON.stringify(deltaOf(1, 2))
		});
		await settleWrite(
			landed,
			pack,
			async (from, to) => (fetched.push([from, to]), deltaOf(from, to)),
			SITE
		);
		expect(applied).toEqual([]);
		expect(fetched).toEqual([]);
	});
});

describe('settleWrite predicts a write the server did not describe', () => {
	/** a held pack of table `rows` at version 1, with `rows` already sorted by id */
	async function heldRows(rows: Array<Record<string, unknown>>) {
		const store = createPackStore(freshIndexedDB());
		const tables = { rows: rows.map((row) => [String(row.id), row] as const) };
		const { bytes } = await buildPack({ version: 1, tables: tables as never });
		await store.installPack(
			(async function* () {
				yield bytes;
			})()
		);
		return store;
	}

	/** a 200 answer whose body is `body` as JSON, from `url` */
	function answerJson(url: string, body: unknown, headers: Record<string, string> = {}) {
		const response = new Response(JSON.stringify(body), { headers });
		Object.defineProperty(response, 'url', { value: url });
		return response;
	}

	const r1 = { id: 'r1', title: 'one', count: 4 };
	const resource = defineResource('/rows', { dataset: 'rows', key: 'id' });
	const at = (method: string, path: string) =>
		writeFor(resource.writes, method, new URL(`${SITE}${path}`), SITE) as ResourceWrite;

	/** settles one answer and counts the delta fetches it made */
	async function settle(
		pack: PackStore,
		answer: Response,
		write: ResourceWrite,
		path: string,
		body: unknown
	) {
		const fetched: Array<[number, number]> = [];
		await settleWrite(
			answer,
			pack,
			async (from, to) => (fetched.push([from, to]), deltaOf(from, to)),
			SITE,
			{ write, url: new URL(`${SITE}${path}`), body, routes: [] }
		);
		return fetched;
	}

	it('predicts the row a POST answer holds, with no request and no version move', async () => {
		const pack = await heldRows([r1]);
		const body = { id: 'r2', title: 'two', count: 0 };
		const fetched = await settle(
			pack,
			answerJson(`${SITE}/rows`, body),
			at('POST', '/rows'),
			'/rows',
			body
		);
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r2')).toEqual(body);
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 1 }));
	});

	it('predicts a DELETE as the removal of the row the path names', async () => {
		const pack = await heldRows([r1]);
		const fetched = await settle(
			pack,
			answerJson(`${SITE}/rows/r1`, null),
			at('DELETE', '/rows/r1'),
			'/rows/r1',
			undefined
		);
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toBeUndefined();
		expect(await pack.scanTable('rows')).toEqual([]);
	});

	it('predicts a PATCH answer with a row that has no id as nothing', async () => {
		const pack = await heldRows([r1]);
		const fetched = await settle(
			pack,
			answerJson(`${SITE}/rows/r1`, { title: 'x' }),
			at('PATCH', '/rows/r1'),
			'/rows/r1',
			{ title: 'x' }
		);
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toEqual(r1);
		expect((await pack.head())?.unconfirmed).toBe(0);
	});

	it('predicts a merge as the held row with the request body laid over it', async () => {
		const pack = await heldRows([r1]);
		const merge = defineWrite('/rows/:id', {
			method: 'PATCH',
			dataset: 'rows',
			key: 'id',
			apply: 'merge',
			updates: []
		});
		const fetched = await settle(pack, answerJson(`${SITE}/rows/r1`, null), merge, '/rows/r1', {
			title: 'merged'
		});
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toEqual({ ...r1, title: 'merged' });
	});

	it('predicts a patch on the held row, and nothing when the row is not held', async () => {
		const pack = await heldRows([r1]);
		const patch = defineWrite('/rows/:id', {
			method: 'PATCH',
			dataset: 'rows',
			key: 'id',
			apply: { set: { title: { body: 'title' } }, inc: { count: 1 } },
			updates: []
		});
		await settle(pack, answerJson(`${SITE}/rows/r1`, null), patch, '/rows/r1', {
			title: 'two'
		});
		expect(await pack.getRow('rows', 'r1')).toEqual({ id: 'r1', title: 'two', count: 5 });

		await settle(pack, answerJson(`${SITE}/rows/r9`, null), patch, '/rows/r9', { title: 'x' });
		expect(await pack.getRow('rows', 'r9')).toBeUndefined();
		expect((await pack.head())?.unconfirmed).toBe(1);
	});

	it('predicts nothing for an invalidate write, which leaves the held rows as they are', async () => {
		const pack = await heldRows([r1]);
		const action = at('POST', '/rows/r1/publish');
		const fetched = await settle(
			pack,
			answerJson(`${SITE}/rows/r1/publish`, { id: 'r1', title: 'x' }),
			action,
			'/rows/r1/publish',
			{}
		);
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toEqual(r1);
		expect((await pack.head())?.unconfirmed).toBe(0);
	});

	it('keeps the version the answer names over a prediction', async () => {
		const pack = await heldRows([r1]);
		const body = { id: 'r2', title: 'two', count: 0 };
		const after: BundleState = {
			version: 2,
			tables: {
				rows: [
					['r1', r1],
					['r2', body]
				]
			}
		};
		const delta = await makeDelta({ version: 1, tables: { rows: [['r1', r1]] } }, after);
		const fetched: Array<[number, number]> = [];
		await settleWrite(
			answerJson(`${SITE}/rows`, body, { [HEADERS.vector]: '2' }),
			pack,
			async (from, to) => (fetched.push([from, to]), delta),
			SITE,
			{ write: at('POST', '/rows'), url: new URL(`${SITE}/rows`), body, routes: [] }
		);
		expect(fetched).toEqual([[1, 2]]);
		expect(await pack.getRow('rows', 'r2')).toEqual(body);
		expect((await pack.head())?.unconfirmed).toBe(0);
	});

	/** the rows of `table` at `version`, as the server's state after a write */
	const rowsAt = (version: number, rows: Array<Record<string, unknown>>) =>
		({
			version,
			tables: { rows: rows.map((row) => [String(row.id), row]) }
		}) as unknown as BundleState;
	const stateAt1 = rowsAt(1, [r1]);
	const digestOf = async (state: BundleState) => (await makeDelta(state, state)).digest;

	it('confirms a correct prediction with no request when the answer names the version and digest', async () => {
		const pack = await heldRows([r1]);
		const body = { id: 'r2', title: 'two', count: 0 };
		const digest = await digestOf(rowsAt(2, [r1, body]));
		const fetched = await settle(
			pack,
			answerJson(`${SITE}/rows`, body, {
				[HEADERS.vector]: '2',
				[WRITE_HEADERS.digest]: digest
			}),
			at('POST', '/rows'),
			'/rows',
			body
		);
		expect(fetched).toEqual([]);
		expect(await pack.getRow('rows', 'r2')).toEqual(body);
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 2, unconfirmed: 0 }));
	});

	it('fetches one delta and keeps the server row when the digest names another state', async () => {
		const pack = await heldRows([r1]);
		const body = { id: 'r2', title: 'two', count: 0 };
		const server = rowsAt(2, [r1, { id: 'r2', title: 'TWO', count: 0 }]);
		const digest = await digestOf(server);
		const fetched: Array<[number, number]> = [];
		await settleWrite(
			answerJson(`${SITE}/rows`, body, {
				[HEADERS.vector]: '2',
				[WRITE_HEADERS.digest]: digest
			}),
			pack,
			async (from, to) => (fetched.push([from, to]), makeDelta(stateAt1, server)),
			SITE,
			{ write: at('POST', '/rows'), url: new URL(`${SITE}/rows`), body, routes: [] }
		);
		expect(fetched).toEqual([[1, 2]]);
		expect(await pack.getRow('rows', 'r2')).toEqual({ id: 'r2', title: 'TWO', count: 0 });
		expect(await pack.head()).toEqual(expect.objectContaining({ version: 2, unconfirmed: 0 }));
	});

	it('drops a wrong prediction when the fetch that follows it fails', async () => {
		const pack = await heldRows([r1]);
		const body = { id: 'r2', title: 'two', count: 0 };
		const digest = await digestOf(rowsAt(2, [r1, { id: 'r2', title: 'TWO', count: 0 }]));
		await expect(
			settleWrite(
				answerJson(`${SITE}/rows`, body, {
					[HEADERS.vector]: '2',
					[WRITE_HEADERS.digest]: digest
				}),
				pack,
				async () => {
					throw new Error('offline');
				},
				SITE,
				{ write: at('POST', '/rows'), url: new URL(`${SITE}/rows`), body, routes: [] }
			)
		).rejects.toThrow('offline');
		expect(await pack.getRow('rows', 'r2')).toBeUndefined();
		expect((await pack.head())?.unconfirmed).toBe(0);
	});

	it('an invalidate write fetches one delta when the digest says the rows moved, and none when they did not', async () => {
		const action = at('POST', '/rows/r1/publish');
		const url = new URL(`${SITE}/rows/r1/publish`);
		const moved = rowsAt(2, [{ ...r1, count: 9 }]);
		const movedPack = await heldRows([r1]);
		const movedFetched: Array<[number, number]> = [];
		await settleWrite(
			answerJson(
				url.href,
				{},
				{ [HEADERS.vector]: '2', [WRITE_HEADERS.digest]: await digestOf(moved) }
			),
			movedPack,
			async (from, to) => (movedFetched.push([from, to]), makeDelta(stateAt1, moved)),
			SITE,
			{ write: action, url, body: {}, routes: [] }
		);
		expect(movedFetched).toEqual([[1, 2]]);
		expect(await movedPack.getRow('rows', 'r1')).toEqual({ ...r1, count: 9 });

		const same = rowsAt(2, [r1]);
		const samePack = await heldRows([r1]);
		const sameFetched: Array<[number, number]> = [];
		await settleWrite(
			answerJson(
				url.href,
				{},
				{ [HEADERS.vector]: '2', [WRITE_HEADERS.digest]: await digestOf(same) }
			),
			samePack,
			async (from, to) => (sameFetched.push([from, to]), makeDelta(stateAt1, same)),
			SITE,
			{ write: action, url, body: {}, routes: [] }
		);
		expect(sameFetched).toEqual([]);
		expect(await samePack.head()).toEqual(
			expect.objectContaining({ version: 2, unconfirmed: 0 })
		);
		expect(await samePack.getRow('rows', 'r1')).toEqual(r1);
	});
});

describe('a cross-origin lookalike in the worker', () => {
	it('is left to the browser and changes no held row', async () => {
		const site = resourceSite();
		const pack = createPackStore(freshIndexedDB());
		const packed = await buildPack({
			version: 1,
			tables: { rows: [['r1', { id: 'r1', title: 'One' }]] }
		});
		async function* once() {
			yield packed.bytes;
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: site.spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				asked.push(`${request.method} ${request.url}`);
				const forged = deltaOf(1, 2);
				forged.tables = {
					rows: { puts: [['r1', { id: 'r1', title: 'Evil' }]], deletes: [] }
				};
				return new Response('{}', {
					headers: {
						'content-type': 'application/json',
						[HEADERS.delta]: JSON.stringify(forged)
					}
				});
			},
			caches: fakeCaches(),
			origin: SITE,
			pack
		});
		const pending = runtime.handle(
			new Request('https://evil.test/rows/r1', { method: 'PATCH', body: '{"title":"Evil"}' }),
			() => undefined
		);
		expect(pending).toBeUndefined();
		expect(asked).toEqual([]);
		expect(await pack.getRow('rows', 'r1')).toEqual({ id: 'r1', title: 'One' });
		expect(await pack.head()).toMatchObject({ version: 1 });
	});
});

// #endregion

describe('a resource write and the collection after it in the worker', () => {
	it('sends the POST once and answers the collection from the pack with no request after it', async () => {
		const site = resourceSite();
		const pack = createPackStore(freshIndexedDB());
		const packed = await buildPack({
			version: 1,
			tables: { rows: [['r1', { id: 'r1', title: 'One' }]] }
		});
		async function* once() {
			yield packed.bytes;
		}
		await pack.installPack(once());
		const asked: string[] = [];
		const runtime = createRuntime({
			config: site.spool.config,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				asked.push(`${request.method} ${request.url}`);
				const answer =
					request.method === 'GET'
						? Response.json(
								{ rows: [{ id: 'r1', title: 'One' }] },
								{ headers: { 'content-security-policy': "default-src 'self'" } }
							)
						: Response.json({ id: 'r2', title: 'Two' }, { status: 201 });
				Object.defineProperty(answer, 'url', { value: request.url });
				return answer;
			},
			caches: fakeCaches(),
			origin: SITE,
			pack
		});
		const first = await runtime.handle(new Request(`${SITE}/rows`), () => undefined);
		expect(first?.status).toBe(200);
		expect(asked).toEqual([`GET ${SITE}/rows`]);
		const post = await runtime.handle(
			new Request(`${SITE}/rows`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: 'r2', title: 'Two' })
			}),
			() => undefined
		);
		expect(post?.status).toBe(201);
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`]);

		const list = await runtime.handle(new Request(`${SITE}/rows`), () => undefined);
		expect(await list?.json()).toMatchObject({ rows: [{ id: 'r1' }, { id: 'r2' }] });
		expect(asked).toEqual([`GET ${SITE}/rows`, `POST ${SITE}/rows`]);
	});
});

// #region the worker

/** a timer that fires only when the test says so, and reports the delays it was set with */
function manualTimers(): WriteTimers & { fire(): Promise<void>; delays(): number[] } {
	const armed = new Map<object, { ms: number; fn: () => unknown }>();
	return {
		set: (fn, ms) => {
			const handle = {};
			armed.set(handle, { ms, fn });
			return handle;
		},
		clear: (handle) => void armed.delete(handle as object),
		delays: () => [...armed.values()].map((t) => t.ms),
		fire: async () => {
			const all = [...armed.values()];
			armed.clear();
			for (const t of all) await t.fn();
		}
	};
}

function world(
	over: {
		enabled?: boolean;
		pack?: PackStore;
		maxDelayMs?: number;
		now?: () => number;
		timers?: WriteTimers;
	} = {}
) {
	const s = site(over);
	const factory: IDBFactory = freshIndexedDB();
	const log: string[] = [];
	const sent: Request[] = [];
	const broadcasts: unknown[] = [];
	const app = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		const html = (text: string) =>
			new Response(`<html><head></head><body>${text}</body></html>`, { headers: HTML });
		if (pathname === '/login') {
			s.user.current = searchParams.get('as');
			return html('welcome');
		}
		if (pathname === '/logout') {
			s.user.current = null;
			return html('bye');
		}
		if (pathname === '/profile')
			return s.user.current ? html(`profile of ${s.user.current}`) : html('no');
		if (pathname === '/about') return html('about');
		return html('missing');
	};
	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		sent.push(request);
		log.push(`${request.method} ${new URL(request.url).pathname}`);
		return s.spool.handle(request, app);
	};
	const deps: RuntimeDeps = {
		config: s.spool.config,
		storage: memoryStorage(),
		fetch: fetchImpl,
		caches: fakeCaches(),
		origin: ORIGIN,
		partitions: idbPartitions(factory, idbVault(factory)),
		pack: over.pack,
		now: over.now,
		timers: over.timers,
		broadcast: (message) => void broadcasts.push(message)
	};
	const runtime: Runtime = createRuntime(deps);
	async function drive(request: Request): Promise<Response> {
		const waited: Promise<unknown>[] = [];
		const pending = runtime.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}
	const ask = async (type: string, fields: Record<string, unknown> = {}) =>
		((await runtime.message({ type, ...fields })) as WriteReply).result as Record<
			string,
			unknown
		>;
	const writes = () => log.filter((entry) => entry === 'PUT /.spool/write').length;
	return {
		s,
		factory,
		log,
		sent,
		broadcasts,
		runtime,
		restart: (): Runtime => createRuntime(deps),
		drive,
		ask,
		writes,
		visit: (path: string) => drive(nav(path)),
		post: (path: string) => drive(nav(path, { method: 'POST', body: 'x' })),
		signIn: async (as: string) => {
			s.user.current = as;
			await drive(nav('/profile'));
		}
	};
}

describe('declared writes in the worker', () => {
	it('sends a deadline write when its timer fires, and not at an earlier fire', async () => {
		let clock = 1_000;
		const timers = manualTimers();
		const w = world({ maxDelayMs: 60_000, now: () => clock, timers });
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'x',
			version: '0'
		});
		expect(timers.delays()).toEqual([60_000]);
		clock = 60_999;
		await timers.fire();
		expect(w.writes()).toBe(0);
		clock = 61_000;
		await timers.fire();
		expect(w.writes()).toBe(1);
		expect(w.s.calls.apply).toBe(1);
		expect(timers.delays()).toEqual([]);
	});

	it('flushes a write whose deadline passed while the worker was stopped, once, at its first contact', async () => {
		let clock = 1_000;
		const w = world({ maxDelayMs: 60_000, now: () => clock, timers: manualTimers() });
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'x',
			version: '0'
		});
		expect(w.writes()).toBe(0);
		clock = 100_000;
		const restarted = w.restart();
		const contact = (runtime: Runtime) => (request: Request) => {
			const waited: Promise<unknown>[] = [];
			const pending = runtime.handle(request, (p) => void waited.push(p));
			return Promise.all([pending, ...waited]);
		};
		await contact(restarted)(new Request(`${ORIGIN}/data.json`));
		expect(w.writes()).toBe(1);
		await contact(restarted)(new Request(`${ORIGIN}/data.json`));
		expect(w.writes()).toBe(1);
		expect(w.s.calls.apply).toBe(1);
	});

	it('sends two edits of one key as one request and one origin write at the next navigation', async () => {
		const w = world();
		await w.signIn('ada');
		const first = await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'one',
			version: '0'
		});
		expect(first).toEqual({ ok: true, state: 'pending', edits: 1 });
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'two',
			version: '0'
		});
		expect(w.writes()).toBe(0);
		await w.visit('/about');
		expect(w.writes()).toBe(1);
		expect(w.s.calls.apply).toBe(1);
		expect(w.s.applied).toEqual([
			expect.objectContaining({ key: 'profile:ada', value: 'two', expected: '0' })
		]);
		expect(await w.ask('spool:writes')).toEqual({ ok: true, writes: [] });
		expect(w.broadcasts).toContainEqual({
			type: 'spool:written',
			queued: 1,
			flushed: 1,
			conflicted: 0
		});
	});

	it('flushes on a page message, lists states without values, and resolves a conflict', async () => {
		const w = world();
		await w.signIn('ada');
		w.s.db.set('profile:ada', { version: 6, value: 'theirs' });
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'mine',
			version: '5'
		});
		expect(await w.ask('spool:flush')).toEqual({
			ok: true,
			queued: 1,
			flushed: 0,
			conflicted: 1
		});
		const listed = (await w.ask('spool:writes')) as { writes: Array<Record<string, unknown>> };
		expect(listed.writes).toHaveLength(1);
		expect(listed.writes[0]).toMatchObject({
			state: 'conflicted',
			conflict: { version: '6', value: 'theirs' }
		});
		expect(JSON.stringify(listed)).not.toContain('mine');
		expect(await w.ask('spool:flush')).toEqual({
			ok: true,
			queued: 0,
			flushed: 0,
			conflicted: 0
		});
		expect(w.writes()).toBe(1);
		expect(
			await w.ask('spool:resolve', { name: 'profile', key: 'profile:ada', use: 'local' })
		).toEqual({ ok: true, flush: { queued: 1, flushed: 1, conflicted: 0 } });
		expect(w.s.db.get('profile:ada')).toEqual({ version: 7, value: 'mine' });
	});

	it('refuses with writes-off, queues nothing and creates no spool-writes database while the flag is off', async () => {
		const w = world({ enabled: false });
		await w.signIn('ada');
		const messages: Array<[string, Record<string, unknown>]> = [
			['spool:write', { name: 'profile', key: 'profile:ada', value: 'x', version: '0' }],
			['spool:flush', {}],
			['spool:writes', {}],
			['spool:resolve', { name: 'profile', key: 'profile:ada', use: 'local' }]
		];
		for (const [type, fields] of messages) {
			expect(await w.ask(type, fields)).toMatchObject({ ok: false, code: 'writes-off' });
		}
		await w.visit('/about');
		expect(w.writes()).toBe(0);
		expect(await names(w.factory)).not.toContain('spool-writes');
		const direct = await read(await put(w.s));
		expect(direct.body['code']).toBe('writes-off');
		expect(w.s.calls.apply).toBe(0);
	});

	it('refuses when no principal is held, without creating the database', async () => {
		const w = world();
		expect(
			await w.ask('spool:write', { name: 'profile', key: 'k', value: 1, version: '0' })
		).toMatchObject({
			ok: false,
			code: 'no-partition'
		});
		expect(await names(w.factory)).not.toContain('spool-writes');
	});

	it('refuses an undeclared name and a missing version as typed answers', async () => {
		const w = world();
		await w.signIn('ada');
		expect(
			await w.ask('spool:write', { name: 'cart', key: 'k', value: 1, version: '0' })
		).toMatchObject({ ok: false, code: 'unknown-write' });
		expect(await w.ask('spool:write', { name: 'profile', key: 'k', value: 1 })).toMatchObject({
			ok: false,
			code: 'missing-version'
		});
		expect(
			await w.ask('spool:write', { name: 7, key: 'k', value: 1, version: '0' })
		).toMatchObject({
			ok: false,
			code: 'unknown-write'
		});
	});

	it('does not let a principal write the key of another, even when its queue holds it', async () => {
		const w = world();
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:bo',
			value: 'x',
			version: '0'
		});
		expect(await w.ask('spool:flush')).toEqual({
			ok: true,
			queued: 1,
			flushed: 0,
			conflicted: 1
		});
		expect(w.s.calls.apply).toBe(0);
		expect(w.s.calls.read).toBe(0);
		expect(w.s.db.has('profile:bo')).toBe(false);
	});

	it('deletes the queue on a logout, sends nothing afterwards and refuses later calls', async () => {
		const w = world();
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'x',
			version: '0'
		});
		const pa = await partitionId('s', 'ada');
		expect(await rows(w.factory, 'spool-writes', 'queue')).toHaveLength(1);
		await w.visit('/logout');
		expect(await rows(w.factory, 'spool-writes', 'queue')).toEqual([]);
		expect(await w.ask('spool:flush')).toMatchObject({ ok: false, code: 'no-partition' });
		await w.visit('/about');
		expect(w.writes()).toBe(0);
		expect(w.s.calls.apply).toBe(0);
		expect(pa).toBeTruthy();
	});

	it("removes A's queue when B signs in, leaves B's rows, and never sends A's value as B", async () => {
		const w = world();
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'ada words',
			version: '0'
		});
		const pb = await partitionId('s', 'bo');
		const other = idbWriteStore(w.factory, pb, idbVault(w.factory));
		// conflicted, so the login's network moment does not send it
		await other.put(record({ key: 'profile:bo', value: 'bo words', state: 'conflicted' }));
		await w.post('/login?as=bo');
		const left = (await rows(w.factory, 'spool-writes', 'queue')) as Array<{
			partition: string;
			key: string;
		}>;
		expect(left.map((r) => [r.partition, r.key])).toEqual([[pb, 'profile:bo']]);
		expect(await w.ask('spool:writes')).toMatchObject({
			ok: true,
			writes: [{ key: 'profile:bo', state: 'conflicted' }]
		});
		await w.visit('/about');
		expect(w.writes()).toBe(0);
		expect(w.s.calls.apply).toBe(0);
	});

	it('keeps a queued value across a worker restart and flushes it with its id', async () => {
		const w = world();
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'kept',
			version: '0'
		});
		const restarted = createRuntime({
			config: w.s.spool.config,
			storage: memoryStorage(),
			fetch: (input, init) =>
				w.s.spool.handle(
					new Request(input as string, init),
					async () => new Response('x', { headers: HTML })
				),
			caches: fakeCaches(),
			origin: ORIGIN,
			partitions: idbPartitions(w.factory, idbVault(w.factory))
		});
		const reply = (await restarted.message({ type: 'spool:flush' })) as WriteReply;
		expect(reply.result).toEqual({ ok: true, queued: 1, flushed: 1, conflicted: 0 });
		expect(w.s.db.get('profile:ada')).toEqual({ version: 1, value: 'kept' });
	});

	it('leaves a queued value alone under a worker whose config has no writes, and sends it once a worker with writes returns', async () => {
		const w = world();
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'queued while on',
			version: '0'
		});
		const [before] = (await rows(w.factory, 'spool-writes', 'queue')) as unknown[];
		const { writes: _writes, ...without } = w.s.spool.config;
		const seen: string[] = [];
		const make = (config: typeof w.s.spool.config) =>
			createRuntime({
				config,
				storage: memoryStorage(),
				fetch: (input, init) => {
					const request = new Request(input as string, init);
					seen.push(`${request.method} ${new URL(request.url).pathname}`);
					return w.s.spool.handle(
						request,
						async () => new Response('x', { headers: HTML })
					);
				},
				caches: fakeCaches(),
				origin: ORIGIN,
				partitions: idbPartitions(w.factory, idbVault(w.factory))
			});

		const off = make(without);
		const drive = async (request: Request) => {
			const waited: Promise<unknown>[] = [];
			const pending = off.handle(request, (p) => void waited.push(p));
			if (!pending) throw new Error('ignored');
			await pending;
			await Promise.all(waited);
		};
		await drive(nav('/about'));
		const reply = (type: string) => off.message({ type }) as Promise<WriteReply>;
		expect((await reply('spool:flush')).result).toMatchObject({
			ok: false,
			code: 'writes-off'
		});
		expect((await reply('spool:writes')).result).toMatchObject({
			ok: false,
			code: 'writes-off'
		});
		expect(seen).not.toContain('PUT /.spool/write');
		expect(w.s.calls.apply).toBe(0);
		expect(await rows(w.factory, 'spool-writes', 'queue')).toEqual([before]);

		const on = make(w.s.spool.config);
		const flushed = (await on.message({ type: 'spool:flush' })) as WriteReply;
		expect(flushed.result).toEqual({ ok: true, queued: 1, flushed: 1, conflicted: 0 });
		expect(w.s.db.get('profile:ada')).toEqual({ version: 1, value: 'queued while on' });
	});

	it('is invisible to a worker that does not know writes: no PUT, same views', async () => {
		const w = world();
		const { writes: _writes, ...old } = w.s.spool.config;
		const log: string[] = [];
		const oldWorker = createRuntime({
			config: old,
			storage: memoryStorage(),
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				log.push(`${request.method} ${new URL(request.url).pathname}`);
				return w.s.spool.handle(
					request,
					async () =>
						new Response('<html><head></head><body>x</body></html>', { headers: HTML })
				);
			},
			caches: fakeCaches(),
			origin: ORIGIN,
			partitions: idbPartitions(w.factory, idbVault(w.factory))
		});
		for (let i = 0; i < 2; i++) {
			const waited: Promise<unknown>[] = [];
			await oldWorker.handle(nav('/about'), (p) => void waited.push(p));
			await Promise.all(waited);
		}
		expect(log.filter((entry) => entry.includes('/.spool/write'))).toEqual([]);
		expect(
			await oldWorker.message({
				type: 'spool:write',
				name: 'profile',
				key: 'k',
				value: 1,
				version: '0'
			})
		).toMatchObject({
			result: { ok: false, code: 'writes-off' }
		});
		expect(await names(w.factory)).not.toContain('spool-writes');
	});

	it('sends the held pack as Spool-Have on a queued write, and counts its answer as a contact', async () => {
		const pack = createPackStore(freshIndexedDB());
		async function* once() {
			yield (await buildPack({ version: 0, tables: {} })).bytes;
		}
		await pack.installPack(once());
		const w = world({ pack });
		await w.signIn('ada');
		await w.ask('spool:write', {
			name: 'profile',
			key: 'profile:ada',
			value: 'one',
			version: '0'
		});
		const contacts = () =>
			w.broadcasts.filter((m) => (m as { type?: string }).type === 'spool:contact').length;
		const before = contacts();
		await w.ask('spool:flush');
		const put = w.sent.find((request) => request.method === 'PUT');
		expect(put?.headers.get(HEADERS.have)).toBe('0');
		expect(contacts()).toBe(before + 1);
	});
});

// #endregion
