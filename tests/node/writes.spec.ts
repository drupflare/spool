import type { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
	defineWrite,
	ifMatch,
	ProtocolError,
	type WriteDeclaration,
	type WriteRefusal
} from '../../src/protocol/index';
import { createSpool, defineRoute, partitionId } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { createRuntime, type Runtime, type WriteReply } from '../../src/sw/runtime';
import { memoryVault } from '../../src/sw/seal';
import { memoryStorage } from '../../src/sw/storage';
import {
	destroyWrites,
	idbWriteStore,
	memoryWriteStore,
	WriteQueue,
	type WriteRecord,
	type WriteStore
} from '../../src/sw/write';
import { fakeCaches, freshIndexedDB, nav, ORIGIN } from './helpers';

// #region the site: one write class over a versioned map, with counters on every site function

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const idOf = (n: number) => `write-id-${String(n).padStart(16, '0')}`;
const source = '<html><head></head><body>profile of {{owner}}</body></html>';

function site(over: { enabled?: boolean; remember?: number; maxPending?: number } = {}) {
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
		maxPending: over.maxPending ?? 2
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

// #region the worker

function world(over: { enabled?: boolean } = {}) {
	const s = site(over);
	const factory: IDBFactory = freshIndexedDB();
	const log: string[] = [];
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
		log.push(`${request.method} ${new URL(request.url).pathname}`);
		return s.spool.handle(request, app);
	};
	const runtime: Runtime = createRuntime({
		config: s.spool.config,
		storage: memoryStorage(),
		fetch: fetchImpl,
		caches: fakeCaches(),
		origin: ORIGIN,
		partitions: idbPartitions(factory, idbVault(factory)),
		broadcast: (message) => void broadcasts.push(message)
	});
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
		broadcasts,
		runtime,
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
});

// #endregion
