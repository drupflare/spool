import { describe, expect, it } from 'vitest';
import type { BeaconBatch, BeaconEvent } from '../../src/protocol/index';
import { CLEAR_ALL, artifactTag } from '../../src/protocol/index';
import {
	BeaconQueue,
	FLUSH_CHUNK,
	MAX_BEACON_BYTES,
	MAX_HOLD_MS,
	VIEW_BATCH,
	VIEW_HOLD_MS
} from '../../src/sw/analytics';
import { isCurrent, validatedAt, verdict } from '../../src/sw/freshness';
import { idbStorage } from '../../src/sw/idb';
import { Replica } from '../../src/sw/replica';
import { ChangeRate, Scheduler, syncBenefit, type SyncPolicy } from '../../src/sw/scheduler';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { artifact, freshIndexedDB, sub, syncOf } from './helpers';

describe('freshness', () => {
	const hard = { maxStale: 60, mode: 'hard' } as const;
	const soft = { maxStale: 60, mode: 'soft' } as const;

	it('serves within maxStale, inclusive of the bound', () => {
		expect(verdict(hard, 1000, 1000)).toBe('serve');
		expect(verdict(hard, 0, 60_000)).toBe('serve');
		expect(verdict(soft, 0, 60_000)).toBe('serve');
	});

	it('blocks on a sync past a hard bound and serves then syncs past a soft one', () => {
		expect(verdict(hard, 0, 60_001)).toBe('sync-first');
		expect(verdict(soft, 0, 60_001)).toBe('serve-then-sync');
	});

	it('counts a clock that moved backwards as past the bound', () => {
		expect(verdict(hard, 5000, 1000)).toBe('sync-first');
		expect(verdict(soft, 5000, 1000)).toBe('serve-then-sync');
	});

	it('dates an artifact by its fetch or the last sync, whichever is later', () => {
		expect(validatedAt(10, 20)).toBe(20);
		expect(validatedAt(30, 20)).toBe(30);
	});

	it('is current until a dependency version passes the artifact vector', () => {
		const a = artifact({ deps: ['x', 'y'], vector: 5 });
		const versions: Record<string, number> = { x: 5, y: 0 };
		expect(isCurrent(a, (t) => versions[t] ?? 0)).toBe(true);
		versions['y'] = 6;
		expect(isCurrent(a, (t) => versions[t] ?? 0)).toBe(false);
		expect(isCurrent(artifact({ deps: [] }), () => 99)).toBe(true);
	});
});

describe('Replica', () => {
	const make = (storage: ReplicaStorage = memoryStorage(), version = 'v1', now = () => 1000) => ({
		storage,
		replica: new Replica(storage, version, now)
	});

	it('starts with no cursor and nothing stored', async () => {
		const { replica } = make();
		await replica.load();
		expect(replica.cursor).toBeNull();
		expect(replica.syncedAt).toBe(0);
		expect(await replica.ids()).toEqual([]);
	});

	it('takes the first artifact vector as the cursor and keeps it after later ones', async () => {
		const { replica } = make();
		await replica.load();
		expect(await replica.put(artifact({ id: '/a', vector: 7 }), true)).toBe(true);
		expect(replica.cursor).toBe(7);
		await replica.put(artifact({ id: '/b', vector: 9, deps: [] }), true);
		expect(replica.cursor).toBe(7);
		expect(await replica.ids()).toEqual(['/a', '/b']);
	});

	it('refuses an artifact that a known change already outdates', async () => {
		const { replica } = make();
		await replica.load();
		await replica.put(artifact({ id: '/a', vector: 1 }), true);
		await replica.applySync(syncOf({ cursor: 5, changed: { 'node:2': 4 } }));
		expect(await replica.put(artifact({ id: '/b', deps: ['node:2'], vector: 3 }), true)).toBe(
			false
		);
		expect(await replica.put(artifact({ id: '/b', deps: ['node:2'], vector: 4 }), true)).toBe(
			true
		);
	});

	it('keeps a persist-false artifact in memory only, and moves it when persist flips', async () => {
		const { replica, storage } = make();
		await replica.load();
		await replica.put(artifact({ id: '/m' }), false);
		expect((await replica.get('/m'))?.artifact.id).toBe('/m');
		expect(await storage.getArtifact('/m')).toBeUndefined();
		await replica.put(artifact({ id: '/m' }), true);
		expect(await storage.getArtifact('/m')).toBeDefined();
		await replica.put(artifact({ id: '/m' }), false);
		expect(await storage.getArtifact('/m')).toBeUndefined();
		expect(await replica.ids()).toEqual(['/m']);
	});

	it('applies a sync: evicts only artifacts that depend on a changed tag, then moves the cursor and clock', async () => {
		let t = 100;
		const { replica } = make(memoryStorage(), 'v1', () => t);
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: ['a'], vector: 1 }), true);
		await replica.put(artifact({ id: '/b', deps: ['b'], vector: 1 }), true);
		t = 500;
		const gone = await replica.applySync(syncOf({ cursor: 3, changed: { a: 2 } }));
		expect(gone).toEqual(['/a']);
		expect(await replica.ids()).toEqual(['/b']);
		expect(replica.cursor).toBe(3);
		expect(replica.syncedAt).toBe(500);
		const kept = await replica.get('/b');
		expect(replica.validatedAt(kept!)).toBe(500);
	});

	it('never lowers the cursor or a tag version', async () => {
		const { replica } = make();
		await replica.load();
		await replica.put(artifact({ id: '/a', vector: 1 }), true);
		await replica.applySync(syncOf({ cursor: 9, changed: { t: 8 } }));
		await replica.applySync(syncOf({ cursor: 4, changed: { t: 3 } }));
		expect(replica.cursor).toBe(9);
		expect(replica.isCurrent(artifact({ deps: ['t'], vector: 5 }))).toBe(false);
	});

	it('drops the artifacts a sync names, and everything on reset', async () => {
		const { replica } = make();
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: [], vector: 1 }), true);
		await replica.put(artifact({ id: '/b', deps: [], vector: 1 }), true);
		expect(await replica.applySync(syncOf({ cursor: 2, dropped: ['/a'] }))).toEqual(['/a']);
		expect(await replica.ids()).toEqual(['/b']);
		expect(await replica.applySync(syncOf({ cursor: 1, reset: true }))).toEqual(['/b']);
		expect(await replica.ids()).toEqual([]);
		expect(replica.cursor).toBe(1);
	});

	it('applies an envelope invalidation always, but moves the cursor only for an answered cursor', async () => {
		let t = 10;
		const { replica } = make(memoryStorage(), 'v1', () => t);
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: ['a'], vector: 1 }), true);
		t = 20;
		const unanswered = await replica.applyEnvelope(
			{ protocol: 1, vector: 8, invalidate: { a: 2 } },
			null,
			false
		);
		expect(unanswered).toEqual(['/a']);
		expect(replica.cursor).toBe(1);
		expect(replica.syncedAt).toBe(0);

		t = 30;
		await replica.applyEnvelope({ protocol: 1, vector: 8, seen: 1 }, 1, false);
		expect(replica.cursor).toBe(8);
		expect(replica.syncedAt).toBe(30);
	});

	it('does not extend freshness from an aged, mismatched or vectorless response', async () => {
		let t = 10;
		const { replica } = make(memoryStorage(), 'v1', () => t);
		await replica.load();
		await replica.put(artifact({ deps: [], vector: 1 }), true);
		t = 99;
		await replica.applyEnvelope({ protocol: 1, vector: 8, seen: 1 }, 1, true);
		await replica.applyEnvelope({ protocol: 1, vector: 8, seen: 2 }, 1, false);
		await replica.applyEnvelope({ protocol: 1, seen: 1 }, 1, false);
		await replica.applyEnvelope({ protocol: 1, vector: 8, seen: 1 }, null, false);
		expect(replica.syncedAt).toBe(0);
		expect(replica.cursor).toBe(1);
	});

	it('wipes on Spool-Clear * and restarts at the sent vector', async () => {
		const { replica } = make();
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: ['a'], vector: 1 }), true);
		const gone = await replica.applyEnvelope(
			{ protocol: 1, clear: [CLEAR_ALL], vector: 6 },
			null,
			false
		);
		expect(gone).toEqual(['/a']);
		expect(await replica.ids()).toEqual([]);
		expect(replica.cursor).toBe(6);
		await replica.applyEnvelope({ protocol: 1, clear: [CLEAR_ALL] }, null, false);
		expect(replica.cursor).toBe(6);
	});

	it('drops an artifact named by an artifact tag only when it is older than the drop', async () => {
		const { replica } = make();
		await replica.load();
		await replica.put(artifact({ id: '/old', deps: [], vector: 2 }), true);
		await replica.put(artifact({ id: '/new', deps: [], vector: 9 }), true);
		const gone = await replica.applyEnvelope(
			{ protocol: 1, invalidate: { [artifactTag('/old')]: 5, [artifactTag('/new')]: 5 } },
			null,
			false
		);
		expect(gone).toEqual(['/old']);
		expect(await replica.ids()).toEqual(['/new']);
	});

	it('restores cursor, clock and tag versions from storage in a new instance', async () => {
		const storage = memoryStorage();
		const first = make(storage, 'v1', () => 42).replica;
		await first.load();
		await first.put(artifact({ id: '/a', deps: ['a'], vector: 1 }), true);
		await first.applySync(syncOf({ cursor: 4, changed: { other: 3 } }));

		const second = new Replica(storage, 'v1', () => 50);
		await second.load();
		expect(second.cursor).toBe(4);
		expect(second.syncedAt).toBe(42);
		expect(await second.ids()).toEqual(['/a']);
		expect(second.isCurrent(artifact({ deps: ['other'], vector: 2 }))).toBe(false);
	});

	it('wipes what an older runtime version stored', async () => {
		const storage = memoryStorage();
		const old = make(storage, 'v1').replica;
		await old.load();
		await old.put(artifact({ id: '/a' }), true);
		const next = new Replica(storage, 'v2', () => 1);
		await next.load();
		expect(await next.ids()).toEqual([]);
		expect(next.cursor).toBeNull();
	});
});

describe('Scheduler', () => {
	async function setup(fetchSync: (from: number) => Promise<ReturnType<typeof syncOf>>) {
		const replica = new Replica(memoryStorage(), 'v1', () => 1);
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: ['a'], vector: 3 }), true);
		const calls: number[] = [];
		let network = 0;
		const scheduler = new Scheduler({
			replica,
			fetchSync: (from) => {
				calls.push(from);
				return fetchSync(from);
			},
			onNetwork: () => void network++
		});
		return { replica, scheduler, calls, network: () => network };
	}

	it('makes one request for any number of concurrent callers', async () => {
		let release: (r: ReturnType<typeof syncOf>) => void = () => {};
		const { scheduler, calls } = await setup(
			() => new Promise((resolve) => (release = resolve))
		);
		const all = [scheduler.sync(), scheduler.sync(), scheduler.background()];
		await Promise.resolve();
		release(syncOf({ cursor: 4 }));
		expect(await Promise.all(all)).toEqual([true, true, undefined]);
		expect(calls).toEqual([3]);
	});

	it('syncs from the replica cursor, applies the answer and signals a network moment', async () => {
		const { scheduler, replica, calls, network } = await setup(async () =>
			syncOf({ cursor: 6, changed: { a: 5 } })
		);
		expect(await scheduler.sync()).toBe(true);
		expect(calls).toEqual([3]);
		expect(replica.cursor).toBe(6);
		expect(await replica.ids()).toEqual([]);
		expect(network()).toBe(1);
	});

	it('resolves false when the request fails and tries again next time', async () => {
		let fail = true;
		const { scheduler, calls } = await setup(async () => {
			if (fail) throw new Error('offline');
			return syncOf({ cursor: 3 });
		});
		expect(await scheduler.sync()).toBe(false);
		fail = false;
		expect(await scheduler.sync()).toBe(true);
		expect(calls).toEqual([3, 3]);
	});

	it('background never rejects', async () => {
		const { scheduler } = await setup(async () => {
			throw new Error('offline');
		});
		await expect(scheduler.background()).resolves.toBeUndefined();
	});

	it('background survives a network hook that throws', async () => {
		const replica = new Replica(memoryStorage(), 'v1', () => 1);
		await replica.load();
		await replica.put(artifact({ deps: [], vector: 1 }), true);
		const scheduler = new Scheduler({
			replica,
			fetchSync: async () => syncOf({ cursor: 1 }),
			onNetwork: () => {
				throw new Error('hook');
			}
		});
		await expect(scheduler.background()).resolves.toBeUndefined();
	});

	it('makes no request when nothing is stored', async () => {
		const replica = new Replica(memoryStorage(), 'v1', () => 1);
		await replica.load();
		let called = 0;
		const scheduler = new Scheduler({
			replica,
			fetchSync: async () => {
				called++;
				return syncOf();
			}
		});
		expect(await scheduler.sync()).toBe(true);
		expect(called).toBe(0);
	});
});

describe('Scheduler, with need and deferral', () => {
	async function setup(policy?: SyncPolicy) {
		const replica = new Replica(memoryStorage(), 'v1', () => 1);
		await replica.load();
		await replica.put(artifact({ id: '/a', deps: ['a'], vector: 3 }), true);
		const calls: Array<{ from: number; need?: Record<string, number> }> = [];
		const gates: Array<() => void> = [];
		let active = 0;
		let peak = 0;
		const scheduler = new Scheduler({
			replica,
			policy,
			fetchSync: async (from, need) => {
				calls.push({ from, need });
				active++;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => gates.push(resolve));
				active--;
				return syncOf({
					cursor: 5,
					changed: need
						? Object.fromEntries(
								Object.keys(need)
									.slice(0, 1)
									.map((t) => [t, 4])
							)
						: {},
					partial: need !== undefined
				});
			}
		});
		const release = async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			gates.splice(0).forEach((open) => open());
		};
		return { replica, scheduler, calls, release, peak: () => peak };
	}

	it('asks only about the named ids and leaves the cursor and the clock alone', async () => {
		const { replica, scheduler, calls, release } = await setup();
		const done = scheduler.sync({ x: 1, y: 2 });
		await release();
		expect(await done).toBe(true);
		expect(calls).toEqual([{ from: 3, need: { x: 1, y: 2 } }]);
		expect(replica.cursor).toBe(3);
		expect(replica.syncedAt).toBe(0);
	});

	it('joins an identical need and any caller of a full sync that is running', async () => {
		const { scheduler, calls, release } = await setup();
		const a = scheduler.sync({ x: 1 });
		const b = scheduler.sync({ x: 1 });
		expect(a).toBe(b);
		await release();
		await a;
		const full = scheduler.sync();
		const covered = scheduler.sync({ z: 1 });
		expect(covered).toBe(full);
		await release();
		await full;
		expect(calls.map((c) => c.need)).toEqual([{ x: 1 }, undefined]);
	});

	it('never has two syncs in flight: a different need waits for the one running', async () => {
		const { scheduler, calls, release, peak } = await setup();
		const first = scheduler.sync({ x: 1 });
		const second = scheduler.sync({ y: 1 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toHaveLength(1);
		await release();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toHaveLength(2);
		await release();
		await second;
		expect(peak()).toBe(1);
	});

	it('queues a deferred sync only when the expected benefit is positive', async () => {
		const policy = { changesPerDay: 1, staleBytes: 65_000, syncBytes: 2000 };
		const { scheduler } = await setup(policy);
		expect(scheduler.defer({ a: 1, b: 1, c: 1 }, 60)).toBe(false);
		expect(scheduler.pending).toEqual([]);
		expect(scheduler.defer({}, 1e9)).toBe(false);
		expect(scheduler.defer({ a: 1, b: 1, c: 1 }, 3600)).toBe(true);
		expect(scheduler.defer({ b: 0, d: 4 }, 3600)).toBe(true);
		expect(scheduler.pending).toEqual(['a', 'b', 'c', 'd']);
	});

	it('drains what was queued as one request taking the lowest held version, and is quiet when empty', async () => {
		const { scheduler, calls, release } = await setup({
			changesPerDay: 1,
			staleBytes: 65_000,
			syncBytes: 2000
		});
		expect(await scheduler.drain()).toBe(true);
		expect(calls).toEqual([]);
		scheduler.defer({ a: 5, b: 2 }, 7200);
		scheduler.defer({ a: 3 }, 7200);
		const drained = scheduler.drain();
		await release();
		expect(await drained).toBe(true);
		expect(calls).toEqual([{ from: 3, need: { a: 3, b: 2 } }]);
		expect(scheduler.pending).toEqual([]);
	});

	it('learns the change rate from what each sync found', async () => {
		const { scheduler, release } = await setup();
		const prior = scheduler.rate.perSecond();
		expect(prior).toBe(1 / 86_400);
		const none = new ChangeRate(1);
		none.observe(10, 86_400, 0);
		expect(none.perSecond()).toBe(1 / (86_400 + 864_000));
		const done = scheduler.sync({ a: 1, b: 1 }, 1000);
		await release();
		await done;
		expect(scheduler.rate.perSecond()).toBe((1 + 1) / (86_400 + 2 * 1000));
	});
});

describe('syncBenefit', () => {
	const policy = { changesPerDay: 1, staleBytes: 65_000, syncBytes: 2000 };

	it('is the chance of a change times the stale cost, less the sync cost', () => {
		const age = 3600;
		const chance = 1 - Math.exp(-(1 / 86_400) * 2 * age);
		expect(syncBenefit({ ageSec: age, perSecond: 1 / 86_400, tags: 2, policy })).toBe(
			chance * 65_000 - 2000
		);
	});

	it('is the negative sync cost at age zero and rises toward the stale cost less the sync cost', () => {
		expect(syncBenefit({ ageSec: 0, perSecond: 1, tags: 1, policy })).toBe(-2000);
		expect(syncBenefit({ ageSec: -5, perSecond: 1, tags: 1, policy })).toBe(-2000);
		expect(syncBenefit({ ageSec: 1e9, perSecond: 1, tags: 1, policy })).toBe(63_000);
	});
});

describe('BeaconQueue', () => {
	const post = (body: string, type = 'application/json') =>
		sub('/cdn-cgi/rum?x=1', { method: 'POST', body, headers: { 'content-type': type } });

	async function setup(send = async () => true, replay = async () => true) {
		const storage = memoryStorage();
		let t = 1_000_000;
		const sent: unknown[] = [];
		const replayed: BeaconEvent[] = [];
		const queue = new BeaconQueue({
			storage,
			now: () => t,
			send: async (batch) => {
				sent.push(batch);
				return send();
			},
			replay: async (event) => {
				replayed.push(event);
				return replay();
			}
		});
		return { queue, storage, sent, replayed, advance: (ms: number) => void (t += ms) };
	}

	it('replays each held beacon to its own URL, in order, and empties the queue', async () => {
		const { queue, storage, sent, replayed } = await setup();
		expect(await queue.enqueue(post('{"a":1}'))).toBe(true);
		expect(await queue.enqueue(post('{"a":2}'))).toBe(true);
		expect(await queue.flush()).toBe(true);
		expect(sent).toEqual([]);
		expect(replayed).toEqual([
			{
				path: '/cdn-cgi/rum',
				search: '?x=1',
				body: '{"a":1}',
				contentType: 'application/json',
				at: 1_000_000
			},
			{
				path: '/cdn-cgi/rum',
				search: '?x=1',
				body: '{"a":2}',
				contentType: 'application/json',
				at: 1_000_000
			}
		]);
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('keeps a beacon whose replay failed and sends spool events in the batch regardless', async () => {
		let ok = false;
		const { queue, storage, sent, replayed } = await setup(
			async () => true,
			async () => ok
		);
		await queue.enqueue(post('{"a":1}'));
		await queue.record({
			path: '/.spool/view',
			body: '{}',
			contentType: 'application/json',
			at: 1
		});
		expect(await queue.flush()).toBe(false);
		expect(sent).toHaveLength(1);
		expect(replayed).toHaveLength(1);
		expect((await storage.readBeacons()).map((b) => b.event.path)).toEqual(['/cdn-cgi/rum']);
		ok = true;
		expect(await queue.flush()).toBe(true);
		expect(replayed).toHaveLength(2);
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('counts the size of a body in bytes, not characters', async () => {
		const { queue, storage } = await setup();
		const wide = '\u00e9'.repeat(MAX_BEACON_BYTES / 2 + 1);
		expect(wide.length).toBeLessThan(MAX_BEACON_BYTES);
		expect(await queue.enqueue(post(wide))).toBe(false);
		expect(await queue.enqueue(post('\u00e9'.repeat(MAX_BEACON_BYTES / 2)))).toBe(true);
		expect(await storage.readBeacons()).toHaveLength(1);
	});

	it('holds a GET pixel with its method and drops an event past its cap, counting it', async () => {
		const { queue, storage, sent, replayed, advance } = await setup();
		const collector = {
			vendor: 'ua',
			match: 'https://c.example/collect',
			maxAgeMs: 1000,
			delivery: 'replay' as const
		};
		const pixel = sub('https://c.example/collect?cid=1', { method: 'GET' });
		expect(await queue.enqueue(pixel, collector)).toBe(true);
		const [held] = await storage.readBeacons();
		expect(held?.event).toMatchObject({
			method: 'GET',
			origin: 'https://c.example',
			vendor: 'ua',
			search: '?cid=1',
			until: 1_001_000
		});
		advance(1001);
		expect(await queue.flush()).toBe(true);
		expect(replayed).toEqual([]);
		expect(queue.dropped.get('ua')).toBe(1);
		const events = (sent[0] as BeaconBatch).events;
		expect(events.map((e) => e.path)).toEqual(['/.spool/dropped']);
		expect(JSON.parse(events[0]?.body ?? '')).toEqual({ vendor: 'ua', count: 1 });
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('sends a sink-delivered collector event in the batch without its cap', async () => {
		const { queue, sent, replayed } = await setup();
		const collector = {
			vendor: 'ga4',
			match: 'https://c.example/g',
			maxAgeMs: 5000,
			delivery: 'sink' as const
		};
		await queue.enqueue(
			sub('https://c.example/g/collect?v=2', { method: 'POST', body: 'en=x' }),
			collector
		);
		expect(await queue.flush()).toBe(true);
		expect(replayed).toEqual([]);
		expect(sent[0]).toEqual({
			protocol: 1,
			events: [
				{
					path: '/g/collect',
					search: '?v=2',
					body: 'en=x',
					contentType: 'text/plain;charset=UTF-8',
					at: 1_000_000,
					origin: 'https://c.example',
					vendor: 'ga4',
					deliver: 'sink'
				}
			]
		});
	});

	it('sends nothing when nothing is queued', async () => {
		const { queue, sent } = await setup();
		expect(await queue.flush()).toBe(false);
		expect(sent).toEqual([]);
	});

	it('defaults a missing content type to text/plain', async () => {
		const { queue, storage } = await setup();
		await queue.enqueue(sub('/cdn-cgi/rum', { method: 'POST', body: 'x' }));
		expect((await storage.readBeacons())[0]?.event.contentType).toContain('text/plain');
	});

	it('leaves binary and oversized beacons for the network', async () => {
		const { queue, storage } = await setup();
		expect(await queue.enqueue(post('x', 'application/octet-stream'))).toBe(false);
		expect(await queue.enqueue(post('x', 'multipart/form-data; boundary=a'))).toBe(false);
		expect(await queue.enqueue(post('x', 'image/png'))).toBe(false);
		expect(await queue.enqueue(post('x'.repeat(MAX_BEACON_BYTES + 1)))).toBe(false);
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('keeps the events when the send fails or throws, and sends them next time', async () => {
		let mode: 'refuse' | 'throw' | 'ok' = 'refuse';
		const { queue, storage, sent } = await setup(async () => {
			if (mode === 'throw') throw new Error('offline');
			return mode === 'ok';
		});
		await queue.record({ path: '/.spool/view', body: '{}', contentType: 'x', at: 1 });
		expect(await queue.flush()).toBe(false);
		mode = 'throw';
		expect(await queue.flush()).toBe(false);
		expect(await storage.readBeacons()).toHaveLength(1);
		mode = 'ok';
		expect(await queue.flush()).toBe(true);
		expect(sent).toHaveLength(3);
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('joins a flush already running', async () => {
		let release: (ok: boolean) => void = () => {};
		const storage = memoryStorage();
		let sends = 0;
		const queue = new BeaconQueue({
			storage,
			now: () => 1,
			replay: async () => true,
			send: () => {
				sends++;
				return new Promise((resolve) => (release = resolve));
			}
		});
		await queue.record({ path: '/.spool/view', body: '{}', contentType: 'x', at: 1 });
		const first = queue.flush();
		const second = queue.flush();
		while (sends === 0) await new Promise((resolve) => setTimeout(resolve, 0));
		release(true);
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(sends).toBe(1);
	});

	it('flushes on its own only once a held beacon is past the hold limit, and at most once a window', async () => {
		const { queue, replayed: sent, advance } = await setup();
		expect(await queue.flushIfDue()).toBe(false);
		await queue.enqueue(post('1'));
		advance(2 * 60 * 60 * 1000);
		expect(await queue.flushIfDue()).toBe(false);
		advance(MAX_HOLD_MS);
		expect(await queue.flushIfDue()).toBe(true);
		expect(sent).toHaveLength(1);

		await queue.enqueue(post('2'));
		advance(MAX_HOLD_MS - 1);
		expect(await queue.flushIfDue()).toBe(false);
		advance(2 * MAX_HOLD_MS);
		expect(await queue.flushIfDue()).toBe(true);
		expect(sent).toHaveLength(2);
	});
});

describe('BeaconQueue, persisted and batched', () => {
	const rum = (n: number) =>
		sub('/cdn-cgi/rum', {
			method: 'POST',
			body: String(n),
			headers: { 'content-type': 'text/plain' }
		});
	const view = (at: number) => ({
		path: '/.spool/view',
		body: '{}',
		contentType: 'application/json',
		at
	});

	function boot(storage: ReplicaStorage, clock: { t: number }, ok = () => true) {
		const sent: BeaconBatch[] = [];
		const replayed: BeaconEvent[] = [];
		const queue = new BeaconQueue({
			storage,
			now: () => clock.t,
			send: async (batch) => {
				sent.push(batch);
				return ok();
			},
			replay: async (event) => {
				replayed.push(event);
				return ok();
			}
		});
		return { queue, sent: replayed, batches: sent };
	}

	it('keeps the one-standalone-flush-per-day limit across a worker restart', async () => {
		const storage = memoryStorage();
		const clock = { t: 1_000_000 };
		const first = boot(storage, clock, () => false);
		await first.queue.enqueue(rum(1));
		clock.t += MAX_HOLD_MS + 1;
		expect(await first.queue.flushIfDue()).toBe(false);
		expect(first.sent).toHaveLength(1);

		const restarted = boot(storage, clock);
		clock.t += 2 * 60 * 60 * 1000;
		expect(await restarted.queue.flushIfDue()).toBe(false);
		expect(restarted.sent).toHaveLength(0);

		clock.t += MAX_HOLD_MS;
		expect(await restarted.queue.flushIfDue()).toBe(true);
		expect(restarted.sent).toHaveLength(1);
	});

	it('keeps the hourly check across a restart too', async () => {
		const storage = memoryStorage();
		const clock = { t: 5_000_000 };
		const first = boot(storage, clock);
		await first.queue.enqueue(rum(1));
		clock.t += MAX_HOLD_MS + 1;
		await first.queue.flushIfDue();
		await first.queue.enqueue(rum(2));
		expect(await storage.getFlush()).toEqual({
			lastStandalone: clock.t,
			checkedAt: clock.t
		});
		const restarted = boot(storage, clock);
		clock.t += 60_000;
		expect(await restarted.queue.flushIfDue()).toBe(false);
		expect(await storage.getFlush()).toMatchObject({ checkedAt: clock.t - 60_000 });
	});

	it('does not trust a stored time that is ahead of the clock', async () => {
		const storage = memoryStorage();
		const clock = { t: 1_000_000 };
		await storage.setFlush({
			lastStandalone: clock.t + 10 * MAX_HOLD_MS,
			checkedAt: clock.t + 10 * MAX_HOLD_MS
		});
		const { queue, sent } = boot(storage, clock);
		await queue.enqueue(rum(1));
		clock.t += MAX_HOLD_MS + 1;
		expect(await queue.flushIfDue()).toBe(true);
		expect(sent).toHaveLength(1);
	});

	it('records an event the worker made itself', async () => {
		const storage = memoryStorage();
		const { queue, batches } = boot(storage, { t: 1 });
		await queue.record(view(1));
		expect(await queue.flush()).toBe(true);
		expect(batches[0]?.events).toEqual([view(1)]);
	});

	it('waits at a network moment for a few views alone, but not for another site beacon', async () => {
		const storage = memoryStorage();
		const clock = { t: 10_000_000 };
		const { queue, sent, batches } = boot(storage, clock);
		for (let i = 0; i < VIEW_BATCH - 1; i++) await queue.record(view(clock.t));
		expect(await queue.flushAtMoment()).toBe(false);
		await queue.enqueue(rum(1));
		expect(await queue.flushAtMoment()).toBe(true);
		expect(sent).toHaveLength(1);
		expect(batches[0]?.events).toHaveLength(VIEW_BATCH - 1);
	});

	it('sends views at a moment once VIEW_BATCH are held or the oldest has waited VIEW_HOLD_MS', async () => {
		const storage = memoryStorage();
		const clock = { t: 10_000_000 };
		const { queue, batches: sent } = boot(storage, clock);
		expect(await queue.flushAtMoment()).toBe(false);
		for (let i = 0; i < VIEW_BATCH; i++) await queue.record(view(clock.t));
		expect(await queue.flushAtMoment()).toBe(true);

		await queue.record(view(clock.t));
		expect(await queue.flushAtMoment()).toBe(false);
		clock.t += VIEW_HOLD_MS;
		expect(await queue.flushAtMoment()).toBe(true);
		expect(sent.map((b) => b.events.length)).toEqual([VIEW_BATCH, 1]);
	});

	it('flushes at a moment when artifacts are wanted, once, with the first batch only', async () => {
		const storage = memoryStorage();
		const sent: BeaconBatch[] = [];
		const queue = new BeaconQueue({
			storage,
			now: () => 1,
			replay: async () => true,
			want: async () => ['/a', '/b'],
			send: async (batch) => {
				sent.push(batch);
				return true;
			}
		});
		for (let i = 0; i < FLUSH_CHUNK + 1; i++) await queue.record(view(1));
		expect(await queue.flushAtMoment()).toBe(true);
		expect(sent.map((b) => [b.events.length, b.want])).toEqual([
			[FLUSH_CHUNK, ['/a', '/b']],
			[1, undefined]
		]);
		expect(await storage.readBeacons()).toEqual([]);
	});

	it('stops at the first chunk that fails and keeps the rest held', async () => {
		const storage = memoryStorage();
		let calls = 0;
		const queue = new BeaconQueue({
			storage,
			now: () => 1,
			replay: async () => true,
			send: async () => ++calls === 1
		});
		for (let i = 0; i < 2 * FLUSH_CHUNK + 5; i++) await queue.record(view(1));
		expect(await queue.flush()).toBe(false);
		expect(await storage.readBeacons()).toHaveLength(FLUSH_CHUNK + 5);
	});
});

function storageContract(name: string, make: () => ReplicaStorage) {
	describe(`${name} storage`, () => {
		it('stores, reads, lists, deletes and clears artifacts', async () => {
			const s = make();
			expect(await s.getArtifact('/a')).toBeUndefined();
			await s.putArtifact({ artifact: artifact({ id: '/a' }), fetchedAt: 1 });
			await s.putArtifact({ artifact: artifact({ id: '/b' }), fetchedAt: 2 });
			await s.putArtifact({ artifact: artifact({ id: '/a', vector: 9 }), fetchedAt: 3 });
			expect((await s.getArtifact('/a'))?.artifact.vector).toBe(9);
			expect((await s.allArtifacts()).map((x) => x.artifact.id).sort()).toEqual(['/a', '/b']);
			await s.deleteArtifacts(['/a', '/missing']);
			expect((await s.allArtifacts()).map((x) => x.artifact.id)).toEqual(['/b']);
			await s.clearArtifacts();
			expect(await s.allArtifacts()).toEqual([]);
		});

		it('stores one meta record', async () => {
			const s = make();
			expect(await s.getMeta()).toBeUndefined();
			const meta = {
				version: 'v',
				cursor: 3,
				tags: [['a', 1]] as Array<[string, number]>,
				syncedAt: 9
			};
			await s.setMeta(meta);
			await s.setMeta({ ...meta, cursor: 4 });
			expect(await s.getMeta()).toEqual({ ...meta, cursor: 4 });
		});

		it('stores the flush state apart from the replica meta', async () => {
			const s = make();
			expect(await s.getFlush()).toBeUndefined();
			await s.setFlush({ lastStandalone: 5, checkedAt: 9 });
			await s.setMeta({ version: 'v', cursor: 1, tags: [], syncedAt: 0 });
			expect(await s.getFlush()).toEqual({ lastStandalone: 5, checkedAt: 9 });
		});

		it('stores records and projections by id, replacing and deleting them, and clears both', async () => {
			const s = make();
			expect(await s.allRecords()).toEqual([]);
			await s.putRecords([
				{ id: 'a', version: 1, data: { x: 1 } },
				{ id: 'b', version: 1, data: null }
			]);
			await s.putRecords([{ id: 'a', version: 2, data: 'new' }]);
			await s.putProjections([
				{ id: 'p', version: 1, deps: ['a'], data: [{ $record: 'a' }] }
			]);
			expect((await s.allRecords()).sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([
				{ id: 'a', version: 2, data: 'new' },
				{ id: 'b', version: 1, data: null }
			]);
			expect((await s.allProjections()).map((p) => p.id)).toEqual(['p']);
			await s.deleteRecords(['a', 'missing']);
			await s.deleteProjections(['p']);
			expect((await s.allRecords()).map((r) => r.id)).toEqual(['b']);
			expect(await s.allProjections()).toEqual([]);
			await s.putProjections([{ id: 'q', version: 1, deps: [], data: 1 }]);
			await s.clearGraph();
			expect(await s.allRecords()).toEqual([]);
			expect(await s.allProjections()).toEqual([]);
		});

		it('queues beacons in order and removes them by key', async () => {
			const s = make();
			const event = (n: number) => ({ path: '/p', body: String(n), contentType: 't', at: n });
			await s.addBeacon(event(1));
			await s.addBeacon(event(2));
			await s.addBeacon(event(3));
			const held = await s.readBeacons();
			expect(held.map((b) => b.event.body)).toEqual(['1', '2', '3']);
			await s.removeBeacons([held[0]!.key, held[2]!.key]);
			expect((await s.readBeacons()).map((b) => b.event.body)).toEqual(['2']);
		});
	});
}

storageContract('memory', memoryStorage);
storageContract('IndexedDB', () => idbStorage(freshIndexedDB()));

describe('IndexedDB storage', () => {
	it('survives a new storage object on the same database', async () => {
		const factory = freshIndexedDB();
		await idbStorage(factory).putArtifact({ artifact: artifact({ id: '/a' }), fetchedAt: 1 });
		expect((await idbStorage(factory).getArtifact('/a'))?.fetchedAt).toBe(1);
	});

	it('upgrades a version 1 database in place, keeping what it held', async () => {
		const factory = freshIndexedDB();
		const old = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open('spool', 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				db.createObjectStore('artifacts', { keyPath: 'artifact.id' });
				db.createObjectStore('meta');
				db.createObjectStore('beacons', { autoIncrement: true });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = old.transaction('artifacts', 'readwrite');
			tx.objectStore('artifacts').put({ artifact: artifact({ id: '/kept' }), fetchedAt: 7 });
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		old.close();

		const storage = idbStorage(factory);
		expect((await storage.getArtifact('/kept'))?.fetchedAt).toBe(7);
		await storage.putRecords([{ id: 'r', version: 1, data: 1 }]);
		expect((await storage.allRecords()).map((r) => r.id)).toEqual(['r']);
		await storage.setFlush({ lastStandalone: 1, checkedAt: 2 });
		expect(await storage.getFlush()).toEqual({ lastStandalone: 1, checkedAt: 2 });
	});

	it('rejects when the database cannot be opened', async () => {
		const failing = {
			open: () => {
				const request: { onerror?: () => void; error?: Error } = {
					error: new Error('blocked')
				};
				queueMicrotask(() => request.onerror?.());
				return request;
			}
		} as unknown as IDBFactory;
		await expect(idbStorage(failing).getMeta()).rejects.toThrow('blocked');
	});

	it('closes its connection on a version change so an upgrade is not blocked', async () => {
		const factory = freshIndexedDB();
		const storage = idbStorage(factory);
		await storage.setMeta({ version: 'v', cursor: 1, tags: [], syncedAt: 0 });
		const upgrade = factory.open('spool', 3);
		let blocked = false;
		upgrade.onblocked = () => void (blocked = true);
		upgrade.onupgradeneeded = () => {};
		await new Promise((resolve) => (upgrade.onsuccess = resolve));
		expect(blocked).toBe(false);
		upgrade.result.close();
	});

	it('rejects the call when a transaction aborts', async () => {
		const factory = freshIndexedDB();
		const storage = idbStorage(factory);
		await storage.setMeta({ version: 'v', cursor: 1, tags: [], syncedAt: 0 });
		const circular: Record<string, unknown> = {};
		circular['self'] = () => {};
		await expect(
			storage.putArtifact({ artifact: circular as never, fetchedAt: 1 })
		).rejects.toBeDefined();
	});
});
