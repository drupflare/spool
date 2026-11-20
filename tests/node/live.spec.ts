import { getRequestListener } from '@hono/node-server';
import express from 'express';
import type { IDBFactory } from 'fake-indexeddb';
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	browserLiveDeps,
	LIVE_LOCK,
	socketSource,
	startLive,
	type LiveDeps,
	type StreamSource
} from '../../src/client/live';
import { spoolExpress } from '../../src/express/index';
import { spoolHono } from '../../src/hono/index';
import { toNodeListener } from '../../src/node/listener';
import {
	LIVE_EVENTS,
	LIVE_PATH,
	LIVE_PING,
	parseLiveDelta,
	type LiveDelta
} from '../../src/protocol/index';
import {
	createSpool,
	defineRoute,
	memoryHub,
	memorySink,
	partitionId,
	type LiveHub,
	type LiveOpen
} from '../../src/server/index';
import { frameText, openingFrames, type LiveFrame } from '../../src/server/live';
import {
	decodeOpen,
	encodeOpen,
	hibernatingSockets,
	SOCKET_OPEN_MAX,
	type LiveSocket,
	type SocketHost
} from '../../src/server/live-sockets';
import { memoryStore } from '../../src/stores/index';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { createRuntime, type LiveState, type PartitionStatus } from '../../src/sw/runtime';
import { memoryStorage } from '../../src/sw/storage';
import { closeServers, listen } from './exercise';
import { fakeCaches, freshIndexedDB, nav, ORIGIN } from './helpers';

afterEach(async () => {
	vi.useRealTimers();
	await closeServers();
});

// #region helpers: reading a stream

type Frame = { event: string; data: any } | { comment: string };

function reading(response: Response) {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let bytes = 0;
	const parse = (text: string): Frame => {
		if (text.startsWith(':')) return { comment: text.slice(1) };
		const event = /^event: (.*)$/m.exec(text)?.[1] ?? '';
		const data = /^data: (.*)$/m.exec(text)?.[1] ?? 'null';
		return { event, data: JSON.parse(data) };
	};
	return {
		/** the next frame, or null once the stream has ended */
		async next(): Promise<Frame | null> {
			for (;;) {
				const cut = buffer.indexOf('\n\n');
				if (cut >= 0) {
					const text = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					return parse(text);
				}
				const { value, done } = await reader.read();
				if (done) return null;
				bytes += value.byteLength;
				buffer += decoder.decode(value, { stream: true });
			}
		},
		/** every frame until the stream ends */
		async all(): Promise<Frame[]> {
			const out: Frame[] = [];
			for (let f = await this.next(); f; f = await this.next()) out.push(f);
			return out;
		},
		bytes: () => bytes,
		cancel: () => reader.cancel()
	};
}

const names = (frames: Array<Frame | null>) =>
	frames.map((f) => (f && 'event' in f ? f.event : f === null ? null : 'comment'));

const OPEN: Omit<LiveOpen, 'partition'> = {
	first: [],
	leaseMs: 60_000,
	keepaliveMs: 25_000,
	maxAgeMs: 0
};

// #endregion

describe('the in-process hub', () => {
	it('sends a delta to every open stream and a revocation only to the partition it names', async () => {
		const hub = memoryHub();
		const a1 = reading(await hub.open({ ...OPEN, partition: 'A' }));
		const a2 = reading(await hub.open({ ...OPEN, partition: 'A' }));
		const b = reading(await hub.open({ ...OPEN, partition: 'B' }));
		const delta: LiveDelta = {
			protocol: 1,
			from: 4,
			cursor: 5,
			changed: { 'node:1': 5 },
			dropped: [],
			reset: false
		};
		hub.publish(delta);
		for (const stream of [a1, a2, b]) {
			expect(names([await stream.next(), await stream.next()])).toEqual(['lease', 'delta']);
		}
		expect(hub.stats().open).toBe(3);

		hub.revoke('A');
		expect(names(await a1.all())).toEqual(['revoked']);
		expect(names(await a2.all())).toEqual(['revoked']);
		expect(hub.stats()).toMatchObject({ open: 1, opened: 3, closed: 2 });
		hub.publish({ ...delta, from: 5, cursor: 6 });
		expect(await b.next()).toMatchObject({ event: 'delta', data: { cursor: 6 } });
		await b.cancel();
		expect(hub.stats()).toMatchObject({ open: 0, closed: 3 });
	});

	it('writes the opening frames first, then a lease, then one lease for every half lease', async () => {
		vi.useFakeTimers();
		const hub = memoryHub();
		const stream = reading(
			await hub.open({
				...OPEN,
				partition: 'A',
				leaseMs: 10_000,
				first: [{ event: 'hello', data: { protocol: 1, cursor: 3 } }]
			})
		);
		expect(names([await stream.next(), await stream.next()])).toEqual(['hello', 'lease']);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(names([await stream.next(), await stream.next(), await stream.next()])).toEqual([
			'lease',
			'lease',
			'lease'
		]);
		expect(hub.stats().leases).toBe(4);
	});

	it('counts the keepalive bytes: four bytes a comment', async () => {
		vi.useFakeTimers();
		const hub = memoryHub();
		const stream = reading(await hub.open({ ...OPEN, partition: null, leaseMs: 3_600_000 }));
		expect(names([await stream.next()])).toEqual(['lease']);
		await vi.advanceTimersByTimeAsync(75_000);
		expect(hub.stats().keepaliveBytes).toBe(12);
		expect(names([await stream.next(), await stream.next(), await stream.next()])).toEqual([
			'comment',
			'comment',
			'comment'
		]);
	});

	it('ends a partition stream with revoked at the first lease tick its session no longer passes', async () => {
		vi.useFakeTimers();
		const hub = memoryHub();
		let live = true;
		const stream = reading(
			await hub.open({ ...OPEN, partition: 'A', leaseMs: 10_000, valid: () => live })
		);
		expect(names([await stream.next()])).toEqual(['lease']);
		live = false;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(names(await stream.all())).toEqual(['revoked']);
		expect(hub.stats()).toMatchObject({ open: 0, closed: 1 });
	});

	it('closes a stream at its maximum age and when the client goes away', async () => {
		vi.useFakeTimers();
		const hub = memoryHub();
		const aged = reading(await hub.open({ ...OPEN, partition: null, maxAgeMs: 30_000 }));
		const gone = new AbortController();
		await hub.open({ ...OPEN, partition: null, signal: gone.signal });
		expect(hub.stats().open).toBe(2);
		gone.abort();
		expect(hub.stats().open).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(names(await aged.all())).toEqual(['lease', 'comment', 'lease']);
		expect(hub.stats()).toMatchObject({ open: 0, opened: 2, closed: 2 });
	});

	it('detaches a connection whose keepalive write throws, and leaves the others', async () => {
		vi.useFakeTimers();
		const hub = memoryHub({
			beforeWrite: ({ partition, writes }) => {
				if (partition === 'B' && writes === 2) throw new Error('the socket is gone');
			}
		});
		const a = reading(await hub.open({ ...OPEN, partition: 'A', leaseMs: 3_600_000 }));
		await hub.open({ ...OPEN, partition: 'B', leaseMs: 3_600_000 });
		expect(hub.stats().open).toBe(2);
		await vi.advanceTimersByTimeAsync(25_000);
		expect(hub.stats()).toMatchObject({ open: 1, opened: 2, closed: 1 });
		expect(names([await a.next(), await a.next()])).toEqual(['lease', 'comment']);
	});

	it('closes a stream whose client stopped reading without a close being reported', async () => {
		const hub = memoryHub();
		await hub.open({ ...OPEN, partition: null });
		const delta: LiveDelta = {
			protocol: 1,
			from: 0,
			cursor: 1,
			changed: {},
			dropped: [],
			reset: false
		};
		for (let i = 0; i < 12; i++) hub.publish(delta);
		expect(hub.stats()).toMatchObject({ open: 0, opened: 1, closed: 1 });
	});

	it('publishes the delta of a bump: the tags it changed, from the cursor before it', async () => {
		const hub = memoryHub();
		const seen: LiveDelta[] = [];
		const watching: LiveHub = { ...hub, publish: (d) => void seen.push(d) };
		const spool = createSpool({
			routes: [
				defineRoute('/about', {
					strategy: 'template',
					template: { source: '<p></p>' },
					load: () => ({})
				})
			],
			store: memoryStore(),
			live: { hub: watching }
		});
		await spool.invalidate(['a', 'b'], { drop: ['/gone'] });
		await spool.invalidate([]);
		await spool.invalidate(['a']);
		expect(seen).toEqual([
			{
				protocol: 1,
				from: 0,
				cursor: 1,
				changed: { a: 1, b: 1 },
				dropped: ['/gone'],
				reset: false
			},
			{ protocol: 1, from: 1, cursor: 2, changed: { a: 2 }, dropped: [], reset: false }
		]);
		expect(seen.map((d) => parseLiveDelta(d))).toEqual(seen);
	});
});

// #region the route

function site(
	options: { live?: Parameters<typeof createSpool>[0]['live']; identity?: boolean } = {}
) {
	const user = { current: null as string | null };
	const hub = memoryHub();
	const store = memoryStore();
	const spool = createSpool({
		routes: [
			defineRoute('/about', {
				strategy: 'template',
				template: { source: '<p>about</p>' },
				load: () => ({})
			})
		],
		store,
		...(options.identity === false
			? {}
			: {
					identity: {
						secret: 's',
						resolve: () => (user.current ? { principal: user.current } : null)
					}
				}),
		live: options.live === undefined ? { hub } : options.live
	});
	const open = (query = '') => spool.respond(new Request(`${ORIGIN}${LIVE_PATH}${query}`));
	return { spool, user, hub, store, open };
}

describe('/.spool/live', () => {
	it('opens a partition stream with hello, the catch-up delta from the held cursor, then a lease', async () => {
		const w = site();
		await w.spool.invalidate(['a']);
		await w.spool.invalidate(['b']);
		w.user.current = 'alice';
		const id = await partitionId('s', 'alice');
		const response = (await w.open(`?partition=${id}&have=1`)) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-store');
		const stream = reading(response);
		expect(await stream.next()).toEqual({ event: 'hello', data: { protocol: 1, cursor: 2 } });
		expect(await stream.next()).toEqual({
			event: 'delta',
			data: { protocol: 1, from: 1, cursor: 2, changed: { b: 2 }, dropped: [], reset: false }
		});
		expect(await stream.next()).toEqual({ event: 'lease', data: { leaseMs: 120_000 } });
		await stream.cancel();
	});

	it('answers a page with no cursor an empty delta at the store cursor', async () => {
		const w = site();
		await w.spool.invalidate(['a']);
		w.user.current = 'alice';
		const id = await partitionId('s', 'alice');
		const stream = reading((await w.open(`?partition=${id}`)) as Response);
		await stream.next();
		expect(await stream.next()).toEqual({
			event: 'delta',
			data: { protocol: 1, from: 1, cursor: 1, changed: {}, dropped: [], reset: false }
		});
		await stream.cancel();
	});

	it('sends revoked and closes for a partition the request session does not own, and no data', async () => {
		const w = site();
		w.user.current = 'alice';
		const bobs = await partitionId('s', 'bob');
		const mine = await partitionId('s', 'alice');
		expect(
			names(await reading((await w.open(`?partition=${bobs}`)) as Response).all())
		).toEqual(['revoked']);
		w.user.current = null;
		expect(
			names(await reading((await w.open(`?partition=${mine}`)) as Response).all())
		).toEqual(['revoked']);
		expect(w.hub.stats().opened).toBe(0);
	});

	it('carries the tag diff and a duration, never the principal or a private field', async () => {
		const w = site();
		w.user.current = 'alice-the-principal';
		const id = await partitionId('s', 'alice-the-principal');
		const stream = reading((await w.open(`?partition=${id}`)) as Response);
		const frames = [await stream.next(), await stream.next(), await stream.next()];
		await w.spool.invalidate(['grades:alice']);
		frames.push(await stream.next());
		const text = JSON.stringify(frames);
		expect(text).not.toContain('alice-the-principal');
		expect(text).not.toContain(id);
		expect(frames.map((f) => (f && 'event' in f ? Object.keys(f.data).sort() : null))).toEqual([
			['cursor', 'protocol'],
			['changed', 'cursor', 'dropped', 'from', 'protocol', 'reset'],
			['leaseMs'],
			['changed', 'cursor', 'dropped', 'from', 'protocol', 'reset']
		]);
		await stream.cancel();
		for (const name of names(frames)) expect(LIVE_EVENTS).toContain(name);
	});

	it('answers 204 to a stream with no partition unless the site opted in to public freshness', async () => {
		const off = site();
		expect(((await off.open()) as Response).status).toBe(204);
		const on = site({ live: { public: true } });
		const stream = reading((await on.open()) as Response);
		expect(names([await stream.next(), await stream.next(), await stream.next()])).toEqual([
			'hello',
			'delta',
			'lease'
		]);
		await stream.cancel();
	});

	it('revokes the streams of a principal through spool.revoke, and nobody else', async () => {
		const w = site();
		w.user.current = 'alice';
		const mine = reading(
			(await w.open(`?partition=${await partitionId('s', 'alice')}`)) as Response
		);
		w.user.current = 'bob';
		const theirs = reading(
			(await w.open(`?partition=${await partitionId('s', 'bob')}`)) as Response
		);
		await w.spool.revoke('alice');
		expect(names(await mine.all()).slice(-1)).toEqual(['revoked']);
		expect(w.hub.stats().open).toBe(1);
		await theirs.cancel();
	});

	it('refuses a malformed query and a non-GET', async () => {
		const w = site();
		expect(((await w.open('?have=x')) as Response).status).toBe(400);
		expect(((await w.open('?partition=a b')) as Response).status).toBe(400);
		const post = await w.spool.respond(
			new Request(`${ORIGIN}${LIVE_PATH}`, { method: 'POST' })
		);
		expect(post?.status).toBe(404);
	});

	it('is off with live false, and answers 404', async () => {
		const w = site({ live: false });
		expect(((await w.open()) as Response).status).toBe(404);
		expect(w.spool.config.live).toBeUndefined();
		await w.spool.revoke('alice');
	});

	it('is on by default for a site with an identity on a host of one process, off without one', () => {
		expect(site({ live: undefined as never }).spool.config.live).toEqual({
			public: false,
			mode: 'adaptive'
		});
		expect(site({ live: 'always' }).spool.config.live).toEqual({
			public: false,
			mode: 'always'
		});
		expect(site({ live: { mode: 'always', public: true } }).spool.config.live).toEqual({
			public: true,
			mode: 'always'
		});
		const none = createSpool({
			routes: [],
			store: memoryStore(),
			sink: memorySink()
		});
		expect(none.config.live).toBeUndefined();
		expect(site({ live: { public: true } }).spool.config.live).toEqual({
			public: true,
			mode: 'adaptive'
		});
	});

	it('refuses a lease or keepalive below one second', () => {
		expect(() => site({ live: { lease: 0 } })).toThrow('live.lease');
		expect(() => site({ live: { keepalive: 0.5 } })).toThrow('live.keepalive');
	});

	it('re-resolves the session at each lease tick and ends the stream when it is gone', async () => {
		vi.useFakeTimers();
		const w = site({ live: { lease: 10 } });
		w.user.current = 'alice';
		const stream = reading(
			(await w.open(`?partition=${await partitionId('s', 'alice')}`)) as Response
		);
		expect(names([await stream.next(), await stream.next(), await stream.next()])).toEqual([
			'hello',
			'delta',
			'lease'
		]);
		w.user.current = null;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(names(await stream.all())).toEqual(['revoked']);
	});
});

// #endregion

// #region adapters stream without buffering

async function firstFrames(base: string) {
	const abort = new AbortController();
	const id = await partitionId('s', 'alice');
	const response = await fetch(`${base}${LIVE_PATH}?partition=${id}`, { signal: abort.signal });
	const stream = reading(response);
	// the stream never ends, so a frame in hand proves the adapter wrote before it closed
	const frames = [await stream.next(), await stream.next(), await stream.next()];
	abort.abort();
	return { frames, type: response.headers.get('content-type') };
}

describe('adapters pass the stream through as it is written', () => {
	const make = () => {
		const w = site();
		w.user.current = 'alice';
		return w;
	};
	const settled = async (w: ReturnType<typeof make>) => {
		await vi.waitFor(() => expect(w.hub.stats().open).toBe(0));
		expect(w.hub.stats()).toMatchObject({ opened: 1, closed: 1 });
	};

	it('node:http through toNodeListener', async () => {
		const w = make();
		const base = await listen(
			createServer(toNodeListener((request) => w.spool.respond(request)))
		);
		const { frames, type } = await firstFrames(base);
		expect(names(frames)).toEqual(['hello', 'delta', 'lease']);
		expect(type).toBe('text/event-stream; charset=utf-8');
		await settled(w);
	});

	it('Express through spoolExpress', async () => {
		const w = make();
		const app = express();
		app.use(spoolExpress(w.spool));
		const base = await listen(createServer(app));
		expect(names((await firstFrames(base)).frames)).toEqual(['hello', 'delta', 'lease']);
		await settled(w);
	});

	it('Hono on @hono/node-server through spoolHono', async () => {
		const w = make();
		const app = new Hono();
		app.use('*', spoolHono(w.spool));
		const base = await listen(createServer(getRequestListener(app.fetch)));
		expect(names((await firstFrames(base)).frames)).toEqual(['hello', 'delta', 'lease']);
		await settled(w);
	});
});

// #endregion

// #region the worker

const HTML = {
	'content-type': 'text/html; charset=utf-8',
	'content-security-policy': "default-src 'self'"
};
const page = (text: string) => `<html><head></head><body>${text}</body></html>`;

function world(live?: { public?: boolean; mode?: 'adaptive' | 'always' }) {
	const factory: IDBFactory = freshIndexedDB();
	const user = { current: null as string | null };
	const store = memoryStore();
	const hub = memoryHub();
	const mine = (ctx: { identity: { principal: string } | null }) =>
		(ctx.identity as { principal: string }).principal;
	const spool = createSpool({
		routes: [
			defineRoute('/grades', {
				strategy: 'template',
				scope: 'principal',
				template: { source: '<html><head></head><body>grades of {{owner}}</body></html>' },
				depends: (ctx) => [`grades:${mine(ctx)}`],
				load: (ctx) => ({ owner: mine(ctx) })
			}),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: '<html><head></head><body>about</body></html>' },
				load: () => ({})
			}),
			defineRoute('/notice', {
				strategy: 'template',
				freshness: { maxStale: 300, mode: 'hard' },
				template: { source: '<html><head></head><body>notice</body></html>' },
				load: () => ({})
			})
		],
		store,
		sink: memorySink(),
		identity: {
			secret: 's',
			resolve: () => (user.current ? { principal: user.current } : null)
		},
		live: { hub, ...live }
	});
	const app = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		const html = (text: string, init: ResponseInit = {}) =>
			new Response(page(text), { ...init, headers: { ...HTML, ...init.headers } });
		if (pathname === '/grades') {
			return user.current ? html(`grades of ${user.current}`) : html('no', { status: 401 });
		}
		if (pathname === '/notice') return html('notice');
		return html(pathname === '/about' ? 'about' : 'missing');
	};
	const log: string[] = [];
	const cleared: unknown[] = [];
	const wants: unknown[] = [];
	const pageSim = { answers: false };
	let t = 1_700_000_000_000;
	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		log.push(`${request.method} ${new URL(request.url).pathname}`);
		return spool.handle(request, app);
	};
	const runtime = createRuntime({
		config: spool.config,
		storage: memoryStorage(),
		fetch: fetchImpl,
		caches: fakeCaches(),
		origin: ORIGIN,
		now: () => t,
		partitions: idbPartitions(factory, idbVault(factory)),
		liveWaitMs: 40,
		broadcast: (m) => {
			const type = (m as { type?: string }).type;
			if (type === 'spool:cleared') cleared.push(m);
			if (type === 'spool:want-live') {
				wants.push(m);
				// the page answers the way startLive does: connect, which brings a delta and a lease
				if (pageSim.answers) void connectNow();
			}
		}
	});
	// a top-level load, or a frame of a page that stays open when `frame` is set
	const visit = async (path: string, frame = false) => {
		const waited: Promise<unknown>[] = [];
		const request = nav(path);
		if (frame) Object.defineProperty(request, 'destination', { value: 'iframe' });
		const response = await (runtime.handle(
			request,
			(p) => void waited.push(p)
		) as Promise<Response>);
		await Promise.all(waited);
		return response.text();
	};
	const connectNow = async () => {
		const { have, partition } = (await runtime.message({
			type: 'spool:live-state'
		})) as LiveState;
		const [, frame] = await openingFrames(store, have);
		const delta = frame?.data as LiveDelta;
		await runtime.message({ type: 'spool:live', partition, event: 'delta', delta });
		await runtime.message({ type: 'spool:live', partition, event: 'lease', leaseMs: 600_000 });
	};
	const state = async () => (await runtime.message({ type: 'spool:live-state' })) as LiveState;
	return {
		factory,
		user,
		store,
		spool,
		log,
		cleared,
		wants,
		page: pageSim,
		runtime,
		visit,
		state,
		advance: (seconds: number) => void (t += seconds * 1000),
		partition: async () =>
			(await runtime.message({ type: 'spool:partition' })) as PartitionStatus,
		send: (message: Record<string, unknown>) =>
			runtime.message({ type: 'spool:live', ...message }) as Promise<
				{ ok: boolean } | undefined
			>,
		/** what the stream does on connect: the catch-up delta for the cursor the worker holds, then a lease */
		connect: async (partition: string | null, leaseMs = 600_000) => {
			const { have } = await state();
			const frames = await openingFrames(store, have);
			const delta = frames[1]?.data as LiveDelta;
			const ack = await runtime.message({
				type: 'spool:live',
				partition,
				event: 'delta',
				delta
			});
			await runtime.message({ type: 'spool:live', partition, event: 'lease', leaseMs });
			return ack as { ok: boolean };
		},
		signIn: async (as: string) => {
			user.current = as;
			await visit('/grades');
			log.length = 0;
		}
	};
}

describe('the worker and the stream', () => {
	it('tells the page the stream setting, the partition held and the lowest cursor', async () => {
		const w = world();
		expect(await w.state()).toEqual({
			type: 'spool:live-state',
			live: { public: false, mode: 'adaptive' },
			partition: null,
			have: null
		});
		await w.signIn('alice');
		expect(await w.state()).toEqual({
			type: 'spool:live-state',
			live: { public: false, mode: 'adaptive' },
			partition: await partitionId('s', 'alice'),
			have: 0
		});
	});

	it('renews at the bound with no stream: one sync past maxStale, none inside it', async () => {
		const w = world();
		await w.signIn('alice');
		w.advance(200);
		await w.visit('/grades');
		expect(w.log).toEqual([]);
		w.advance(200);
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /.spool/sync']);
	});

	it('reads past maxStale with 0 requests while the stream lease is open, and renews when it lapses', async () => {
		const w = world();
		await w.signIn('alice');
		const id = await partitionId('s', 'alice');
		expect(await w.connect(id)).toEqual({ type: 'spool:live', ok: true });
		w.advance(400);
		expect(await w.visit('/grades')).toContain('grades of alice');
		w.advance(100);
		expect(await w.visit('/grades')).toContain('grades of alice');
		expect(w.log).toEqual([]);
		w.advance(200);
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /.spool/sync']);
	});

	it('does not extend a lease that arrives before a delta covered the side', async () => {
		const w = world();
		await w.signIn('alice');
		const id = await partitionId('s', 'alice');
		await w.send({ partition: id, event: 'lease', leaseMs: 600_000 });
		w.advance(400);
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /.spool/sync']);
	});

	it('takes a pushed tag change as a sync: the page goes to the network at once, inside the lease', async () => {
		const w = world();
		await w.signIn('alice');
		const id = await partitionId('s', 'alice');
		await w.connect(id);
		await w.spool.invalidate(['grades:alice']);
		const { have } = await w.state();
		const [, delta] = await openingFrames(w.store, have);
		expect(await w.send({ partition: id, event: 'delta', delta: delta?.data })).toEqual({
			type: 'spool:live',
			ok: true
		});
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /grades', 'GET /.spool/artifact']);
	});

	it('ends the lease on a gap and tells the page to connect again', async () => {
		const w = world();
		await w.signIn('alice');
		const id = await partitionId('s', 'alice');
		await w.connect(id);
		const gap: LiveDelta = {
			protocol: 1,
			from: 9,
			cursor: 10,
			changed: { 'grades:alice': 10 },
			dropped: [],
			reset: false
		};
		expect(await w.send({ partition: id, event: 'delta', delta: gap })).toEqual({
			type: 'spool:live',
			ok: false
		});
		w.advance(400);
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /.spool/sync']);
	});

	it('wipes the partition on revoked with no request, as a logout does', async () => {
		const w = world();
		await w.signIn('alice');
		const id = await partitionId('s', 'alice');
		await w.connect(id);
		expect(await w.send({ partition: id, event: 'revoked' })).toEqual({
			type: 'spool:live',
			ok: true
		});
		expect(w.log).toEqual([]);
		expect((await w.partition()).partition).toBeNull();
		const dbs = ((await w.factory.databases()) as Array<{ name: string }>).map((d) => d.name);
		expect(dbs).not.toContain(`spool-p-${id}`);
		expect(w.cleared).toEqual([{ type: 'spool:cleared', reason: 'revoked' }]);
		w.user.current = null;
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /grades']);
	});

	it('ignores revoked, a lease and a delta from a stream of a partition it has left', async () => {
		const w = world();
		await w.signIn('alice');
		await w.send({ partition: 'someone-else', event: 'revoked' });
		await w.send({ partition: 'someone-else', event: 'lease', leaseMs: 600_000 });
		expect((await w.partition()).partition).toBe(await partitionId('s', 'alice'));
		w.advance(400);
		await w.visit('/grades');
		expect(w.log).toEqual(['GET /.spool/sync']);
		expect(w.cleared).toEqual([]);
	});

	it('answers nothing to a malformed stream message', async () => {
		const w = world();
		await w.signIn('alice');
		expect(await w.send({ partition: 7, event: 'revoked' })).toBeUndefined();
		expect(await w.send({ partition: null, event: 'lease', leaseMs: -1 })).toBeUndefined();
		expect(
			await w.send({ partition: null, event: 'delta', delta: { cursor: 'x' } })
		).toBeUndefined();
		expect(await w.send({ partition: null, event: 'nope' })).toBeUndefined();
	});

	it('leases the public replica only where the site opted in', async () => {
		const logs: string[][] = [];
		for (const opted of [false, true]) {
			const w = world(opted ? { public: true } : {});
			await w.visit('/notice');
			await w.visit('/notice');
			w.log.length = 0;
			await w.connect(null);
			w.advance(400);
			expect(await w.visit('/notice')).toContain('notice');
			logs.push([...w.log]);
		}
		expect(logs).toEqual([['GET /.spool/sync'], []]);
	});
});

describe('the adaptive policy: the first renewal of a page lifetime is paid, the second becomes the stream', () => {
	it('opens no stream for a visitor who loads documents, whether the lease falls due once or at every document', async () => {
		for (const due of [1, 4]) {
			const w = world();
			w.page.answers = true;
			await w.signIn('alice');
			for (let i = 0; i < 4; i++) {
				if (i < due || due === 4) w.advance(400);
				await w.visit('/grades');
			}
			expect(w.wants).toEqual([]);
			expect(w.log.filter((l) => l === 'GET /.spool/sync')).toHaveLength(due);
		}
	});

	it('pays one renewal in a page that stays open, then asks for the stream in place of the second', async () => {
		const w = world();
		w.page.answers = true;
		await w.signIn('alice');
		w.advance(400);
		await w.visit('/grades', true);
		expect(w.log).toEqual(['GET /.spool/sync']);
		expect(w.wants).toEqual([]);
		w.advance(400);
		expect(await w.visit('/grades', true)).toContain('grades of alice');
		expect(w.wants).toEqual([{ type: 'spool:want-live' }]);
		expect(w.log).toEqual(['GET /.spool/sync']);
		w.advance(400);
		await w.visit('/grades', true);
		expect(w.log).toEqual(['GET /.spool/sync']);
		expect(w.wants).toHaveLength(1);
	});

	it('renews at the second contact when no page opens the stream in time, and does not ask again', async () => {
		const w = world();
		await w.signIn('alice');
		for (let i = 0; i < 3; i++) {
			w.advance(400);
			await w.visit('/grades', true);
		}
		expect(w.wants).toHaveLength(1);
		expect(w.log).toEqual(['GET /.spool/sync', 'GET /.spool/sync', 'GET /.spool/sync']);
	});

	it('starts the count again when the page reports a new visible session', async () => {
		const w = world();
		await w.signIn('alice');
		w.advance(400);
		await w.visit('/grades', true);
		await w.send({ partition: null, event: 'session' });
		w.advance(400);
		await w.visit('/grades', true);
		expect(w.wants).toEqual([]);
		expect(w.log).toEqual(['GET /.spool/sync', 'GET /.spool/sync']);
	});

	it('asks for nothing under always, where the page opens the stream itself', async () => {
		const w = world({ mode: 'always' });
		await w.signIn('alice');
		for (let i = 0; i < 3; i++) {
			w.advance(400);
			await w.visit('/grades', true);
		}
		expect(w.wants).toEqual([]);
	});
});

// #endregion

// #region the page module

function fakeLocks() {
	const queues = new Map<string, Array<() => void>>();
	const busy = new Set<string>();
	const grant = (name: string) => {
		const next = queues.get(name)?.shift();
		if (next) next();
	};
	return {
		request: (
			name: string,
			options: { signal?: AbortSignal },
			callback: () => Promise<unknown>
		): Promise<unknown> =>
			new Promise((resolve, reject) => {
				const run = async () => {
					busy.add(name);
					try {
						resolve(await callback());
					} catch (error) {
						reject(error);
					} finally {
						busy.delete(name);
						grant(name);
					}
				};
				if (!busy.has(name)) return void run();
				const queue = queues.get(name) ?? [];
				queues.set(name, queue);
				const entry = () => void run();
				queue.push(entry);
				options.signal?.addEventListener('abort', () => {
					const at = queue.indexOf(entry);
					if (at >= 0) queue.splice(at, 1);
					reject(new DOMException('aborted', 'AbortError'));
				});
			})
	} as unknown as Pick<LockManager, 'request'>;
}

function fakeSource() {
	const listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();
	const source = {
		readyState: 0,
		closed: false,
		url: '',
		addEventListener: (name: string, fn: (e: MessageEvent<string>) => void) =>
			void listeners.set(name, [...(listeners.get(name) ?? []), fn]),
		close() {
			source.closed = true;
			source.readyState = 2;
		},
		emit(name: string, data?: unknown) {
			for (const fn of listeners.get(name) ?? []) {
				fn({ data: JSON.stringify(data ?? {}) } as MessageEvent<string>);
			}
		}
	};
	return source;
}

function tab(shared: {
	locks: Pick<LockManager, 'request'>;
	sources: Array<ReturnType<typeof fakeSource>>;
}) {
	let visible = true;
	const visibility: Array<() => void> = [];
	const hide: Array<() => void> = [];
	const sent: unknown[] = [];
	const answer = {
		ok: true as boolean,
		state: {
			type: 'spool:live-state',
			live: { public: false, mode: 'always' },
			partition: 'P',
			have: 7
		} as LiveState
	};
	const deps: LiveDeps = {
		state: async () => answer.state,
		send: async (message) => {
			sent.push(message);
			return { type: 'spool:live', ok: answer.ok };
		},
		visible: () => visible,
		onVisibility: (fn) => void visibility.push(fn),
		onPageHide: (fn) => void hide.push(fn),
		locks: shared.locks,
		open: (url) => {
			const source = fakeSource();
			source.url = url;
			shared.sources.push(source);
			return source as unknown as StreamSource;
		}
	};
	return {
		deps,
		sent,
		answer,
		start: () => startLive(deps),
		show() {
			visible = true;
			visibility.forEach((fn) => fn());
		},
		hide() {
			visible = false;
			visibility.forEach((fn) => fn());
		},
		leave: () => hide.forEach((fn) => fn())
	};
}

const settle = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
};
const live = (sources: Array<ReturnType<typeof fakeSource>>) => sources.filter((s) => !s.closed);

describe('the page holds one stream per origin while a tab is visible', () => {
	const shared = () => ({
		locks: fakeLocks(),
		sources: [] as Array<ReturnType<typeof fakeSource>>
	});

	it('opens one stream for two visible tabs, for the partition and cursor the worker named', async () => {
		const s = shared();
		const a = tab(s);
		const b = tab(s);
		a.start();
		b.start();
		await settle();
		expect(s.sources.map((x) => x.url)).toEqual([`${LIVE_PATH}?partition=P&have=7`]);
		expect(LIVE_LOCK).toBe('spool-live');
	});

	it('hands the stream to the visible tab when the holder hides, and closes it when none is visible', async () => {
		const s = shared();
		const a = tab(s);
		const b = tab(s);
		a.start();
		b.start();
		await settle();
		a.hide();
		await settle();
		expect(s.sources).toHaveLength(2);
		expect(live(s.sources)).toEqual([s.sources[1]]);
		b.hide();
		await settle();
		expect(live(s.sources)).toEqual([]);
		a.show();
		await settle();
		expect(live(s.sources)).toHaveLength(1);
		expect(s.sources).toHaveLength(3);
	});

	it('closes on pagehide', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		a.leave();
		expect(live(s.sources)).toEqual([]);
	});

	it('opens nothing without Web Locks, without a worker answer or on a site with no stream', async () => {
		const none = {
			locks: undefined as never,
			sources: [] as Array<ReturnType<typeof fakeSource>>
		};
		const a = tab(none);
		a.deps.locks = undefined;
		a.start();
		await settle();
		const s = shared();
		const b = tab(s);
		b.answer.state = { ...b.answer.state, live: null };
		b.start();
		const c = tab(s);
		c.deps.state = () => Promise.reject(new Error('no worker'));
		c.start();
		await settle();
		expect([none.sources.length, s.sources.length]).toEqual([0, 0]);
	});

	it('opens a stream with no partition only where the site pushes public freshness', async () => {
		const s = shared();
		const a = tab(s);
		a.answer.state = { ...a.answer.state, partition: null, have: null };
		a.start();
		await settle();
		expect(s.sources).toHaveLength(0);
		const p = shared();
		const b = tab(p);
		b.answer.state = {
			...b.answer.state,
			partition: null,
			have: null,
			live: { public: true, mode: 'always' }
		};
		b.start();
		await settle();
		expect(p.sources.map((x) => x.url)).toEqual([LIVE_PATH]);
	});

	it('forwards each event to the worker with the partition the stream was opened for', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		const delta = {
			protocol: 1,
			from: 7,
			cursor: 8,
			changed: { t: 8 },
			dropped: [],
			reset: false
		};
		s.sources[0]?.emit('delta', delta);
		s.sources[0]?.emit('lease', { leaseMs: 120_000 });
		s.sources[0]?.emit('lease', { nope: true });
		s.sources[0]?.emit('delta', { cursor: 'x' });
		await settle();
		expect(a.sent).toEqual([
			{ partition: 'P', event: 'delta', delta },
			{ partition: 'P', event: 'lease', leaseMs: 120_000 }
		]);
	});

	it('connects again after a gap, with the cursor the worker holds then', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		a.answer.ok = false;
		a.answer.state = { ...a.answer.state, have: 9 };
		s.sources[0]?.emit('delta', {
			protocol: 1,
			from: 12,
			cursor: 13,
			changed: {},
			dropped: [],
			reset: false
		});
		await settle();
		expect(s.sources.map((x) => [x.url, x.closed])).toEqual([
			[`${LIVE_PATH}?partition=P&have=7`, true],
			[`${LIVE_PATH}?partition=P&have=9`, false]
		]);
	});

	it('wipes on revoked and does not connect again for the partition the server revoked', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		s.sources[0]?.emit('revoked');
		await settle();
		expect(a.sent).toEqual([{ partition: 'P', event: 'revoked' }]);
		expect(s.sources).toHaveLength(1);
		a.answer.state = { ...a.answer.state, partition: 'Q' };
		a.answer.ok = true;
		a.start().reconcile();
		await settle();
		expect(s.sources.map((x) => x.url)).toEqual([
			`${LIVE_PATH}?partition=P&have=7`,
			`${LIVE_PATH}?partition=Q&have=7`
		]);
	});

	it('gives up when the browser gives up: the stream closes and the renewals stand', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		const source = s.sources[0];
		source?.emit('error');
		expect(source?.closed).toBe(false);
		if (source) source.readyState = 2;
		source?.emit('error');
		await settle();
		expect(source?.closed).toBe(true);
		expect(s.sources).toHaveLength(1);
	});

	it('reopens for the new partition when the worker reports a wipe or a switch', async () => {
		const s = shared();
		const a = tab(s);
		const live1 = a.start();
		await settle();
		a.answer.state = { ...a.answer.state, partition: 'Q', have: 3 };
		live1.reconcile();
		await settle();
		expect(s.sources.map((x) => x.url)).toEqual([
			`${LIVE_PATH}?partition=P&have=7`,
			`${LIVE_PATH}?partition=Q&have=3`
		]);
	});

	it('adaptive: opens nothing until the worker asks, opens one when it does, and starts over each visible session', async () => {
		const s = shared();
		const a = tab(s);
		a.answer.state = { ...a.answer.state, live: { public: false, mode: 'adaptive' } };
		const live1 = a.start();
		await settle();
		expect(s.sources).toHaveLength(0);
		expect(a.sent).toEqual([{ partition: null, event: 'session' }]);
		live1.arm();
		await settle();
		expect(s.sources.map((x) => x.url)).toEqual([`${LIVE_PATH}?partition=P&have=7`]);
		a.hide();
		await settle();
		expect(live(s.sources)).toEqual([]);
		a.show();
		await settle();
		expect(s.sources).toHaveLength(1);
		expect(a.sent).toEqual([
			{ partition: null, event: 'session' },
			{ partition: null, event: 'session' }
		]);
		live1.arm();
		await settle();
		expect(live(s.sources)).toHaveLength(1);
		expect(s.sources).toHaveLength(2);
	});

	it('always: opens at once and again when the tab becomes visible, with no session message', async () => {
		const s = shared();
		const a = tab(s);
		a.start();
		await settle();
		expect(s.sources).toHaveLength(1);
		a.hide();
		a.show();
		await settle();
		expect(s.sources).toHaveLength(2);
		expect(a.sent).toEqual([]);
	});

	it('is null where the browser has no EventSource', () => {
		const had = (globalThis as { EventSource?: unknown }).EventSource;
		(globalThis as { EventSource?: unknown }).EventSource = undefined;
		expect(
			browserLiveDeps({
				liveState: () => Promise.reject(new Error('x')),
				liveEvent: async () => undefined
			})
		).toBeNull();
		(globalThis as { EventSource?: unknown }).EventSource = had;
	});
});

// #endregion

// #region hibernating sockets

type FakeSocket = LiveSocket & {
	sent: string[];
	tags: string[];
	closed: boolean;
};

/** a host whose sockets survive `hibernatingSockets` being built again, like the runtime's */
function fakeHost() {
	const all: FakeSocket[] = [];
	const auto: Array<[string, string]> = [];
	const alarm = { at: null as number | null, sets: 0 };
	const make = (): FakeSocket => {
		let attachment: unknown = null;
		const socket: FakeSocket = {
			sent: [],
			tags: [],
			closed: false,
			send: (text) => void socket.sent.push(text),
			close: () => void (socket.closed = true),
			serializeAttachment: (value) => void (attachment = structuredClone(value)),
			deserializeAttachment: () => attachment
		};
		return socket;
	};
	const host: SocketHost = {
		pair: () => [make(), make()],
		accept(ws, tags) {
			(ws as FakeSocket).tags = tags;
			all.push(ws as FakeSocket);
		},
		sockets: (tag) =>
			all.filter((s) => !s.closed && (tag === undefined || s.tags.includes(tag))),
		autoResponse: (request, response) => void auto.push([request, response]),
		alarm: {
			get: async () => alarm.at,
			set: async (at) => {
				alarm.at = at;
				alarm.sets += 1;
			}
		}
	};
	return { host, all, auto, alarm };
}

const parseText = (text: string): Frame => ({
	event: /^event: (.*)$/m.exec(text)?.[1] ?? '',
	data: JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null')
});

const FIRST: LiveFrame[] = [
	{ event: 'hello', data: { protocol: 1, cursor: 2 } },
	{
		event: 'delta',
		data: { protocol: 1, from: 1, cursor: 2, changed: { b: 2 }, dropped: [], reset: false }
	}
];
const SOCKET_OPEN = { first: FIRST, leaseMs: 60_000, maxAgeMs: 0 };
const BUMP: LiveDelta = {
	protocol: 1,
	from: 2,
	cursor: 3,
	changed: { c: 3 },
	dropped: [],
	reset: false
};
const LEASE_TEXT = frameText({ event: 'lease', data: { leaseMs: 60_000 } });

describe('the hibernating socket hub', () => {
	it('sends over a socket the frames SSE sends for the same hub events', async () => {
		const sse = memoryHub();
		const stream = reading(await sse.open({ ...OPEN, first: FIRST, partition: 'A' }));
		const h = fakeHost();
		const sockets = hibernatingSockets(h.host);
		await sockets.open({ ...SOCKET_OPEN, partition: 'A' });
		const socket = h.all[0] as FakeSocket;
		expect(socket.sent.map(parseText)).toEqual([
			await stream.next(),
			await stream.next(),
			await stream.next()
		]);
		expect(names(socket.sent.map(parseText))).toEqual(['hello', 'delta', 'lease']);
		sse.publish(BUMP);
		await sockets.publish(BUMP);
		expect(parseText(socket.sent[3] ?? '')).toEqual(await stream.next());
		sse.revoke('A');
		await sockets.revoke('A');
		expect(parseText(socket.sent[4] ?? '')).toEqual(await stream.next());
		expect(socket.sent).toHaveLength(5);
		expect(socket.closed).toBe(true);
		await stream.cancel();
	});

	it('tags a socket with its partition and revokes the streams of that partition only', async () => {
		const h = fakeHost();
		const sockets = hibernatingSockets(h.host);
		for (const partition of ['A', 'A', 'B', null]) {
			await sockets.open({ ...SOCKET_OPEN, partition });
		}
		expect(h.all.map((s) => s.tags)).toEqual([['p:A'], ['p:A'], ['p:B'], ['public']]);
		await sockets.revoke('A');
		expect(h.all.map((s) => s.closed)).toEqual([true, true, false, false]);
		expect(h.all.map((s) => s.sent.length)).toEqual([4, 4, 3, 3]);
		await sockets.publish(BUMP);
		expect(h.all.map((s) => s.sent.length)).toEqual([4, 4, 4, 4]);
	});

	it('sends the lease frame as the auto-response to a ping, and answers a ping itself where the platform does not', async () => {
		const h = fakeHost();
		const sockets = hibernatingSockets(h.host);
		await sockets.open({ ...SOCKET_OPEN, partition: 'A' });
		expect(h.auto).toEqual([[LIVE_PING, LEASE_TEXT]]);
		const socket = h.all[0] as FakeSocket;
		sockets.message(socket, 'something else');
		sockets.message(socket, new ArrayBuffer(4));
		expect(socket.sent).toHaveLength(3);
		sockets.message(socket, LIVE_PING);
		expect(socket.sent[3]).toBe(LEASE_TEXT);
	});

	it('rebuilds from the sockets alone after the object hibernates', async () => {
		const h = fakeHost();
		await hibernatingSockets(h.host).open({ ...SOCKET_OPEN, partition: 'A', maxAgeMs: 5000 });
		h.auto.length = 0;
		const woke = hibernatingSockets(h.host);
		woke.restore();
		expect(h.auto).toEqual([[LIVE_PING, LEASE_TEXT]]);
		await woke.publish(BUMP);
		expect(parseText(h.all[0]?.sent[3] ?? '')).toEqual({ event: 'delta', data: BUMP });
		woke.message(h.all[0] as FakeSocket, LIVE_PING);
		expect(h.all[0]?.sent[4]).toBe(LEASE_TEXT);
		await woke.revoke('A');
		expect(parseText(h.all[0]?.sent[5] ?? '')).toEqual({ event: 'revoked', data: {} });
		expect(h.all[0]?.closed).toBe(true);
	});

	it('restores nothing and registers nothing when no socket is attached', () => {
		const h = fakeHost();
		hibernatingSockets(h.host).restore();
		expect(h.auto).toEqual([]);
	});

	it('sets one alarm at the earliest expiry, and closes expired sockets when it fires', async () => {
		let t = 1000;
		const h = fakeHost();
		const sockets = hibernatingSockets(h.host, () => t);
		await sockets.open({ ...SOCKET_OPEN, partition: 'A', maxAgeMs: 5000 });
		expect(h.alarm.at).toBe(6000);
		t = 2000;
		await sockets.open({ ...SOCKET_OPEN, partition: 'B', maxAgeMs: 1000 });
		expect(h.alarm.at).toBe(3000);
		t = 2500;
		await sockets.open({ ...SOCKET_OPEN, partition: 'C', maxAgeMs: 9000 });
		await sockets.open({ ...SOCKET_OPEN, partition: 'D', maxAgeMs: 0 });
		expect(h.alarm.at).toBe(3000);
		expect(h.alarm.sets).toBe(2);
		t = 3000;
		await sockets.alarm();
		expect(h.all.map((s) => s.closed)).toEqual([false, true, false, false]);
		expect(h.alarm.at).toBe(6000);
		t = 6000;
		await sockets.alarm();
		expect(h.all.map((s) => s.closed)).toEqual([true, true, false, false]);
		expect(h.alarm.at).toBe(11_500);
		t = 11_500;
		await sockets.alarm();
		expect(h.all.map((s) => s.closed)).toEqual([true, true, true, false]);
		expect(h.alarm.sets).toBe(4);
	});

	it('round-trips the opening request through a header and refuses one past the cap', () => {
		const init = { ...SOCKET_OPEN, partition: 'A' };
		expect(decodeOpen(encodeOpen(init))).toEqual(init);
		const open = {
			...init,
			partition: null,
			first: [
				{
					event: 'delta' as const,
					data: { ...BUMP, changed: { 'tag:é': 1 } }
				}
			]
		};
		expect(decodeOpen(encodeOpen(open))).toEqual(open);
		const changed = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`tag:${i}`, i]));
		const big = { ...init, first: [{ event: 'delta' as const, data: { ...BUMP, changed } }] };
		expect(JSON.stringify(big).length).toBeGreaterThan(SOCKET_OPEN_MAX);
		expect(encodeOpen(big)).toBeNull();
	});

	it('refuses an opening header that is missing, not base64, not JSON or the wrong shape', () => {
		const wrong = (value: unknown) => btoa(JSON.stringify(value));
		for (const header of [
			null,
			'',
			'@@@',
			btoa('not json'),
			wrong({}),
			wrong({ ...SOCKET_OPEN, partition: 1 }),
			wrong({ ...SOCKET_OPEN, partition: 'A', leaseMs: 0 }),
			wrong({ ...SOCKET_OPEN, partition: 'A', maxAgeMs: -1 }),
			wrong({ ...SOCKET_OPEN, partition: 'A', first: [{ event: 'hello' }] })
		]) {
			expect(decodeOpen(header)).toBeUndefined();
		}
	});
});

describe('a socket upgrade on /.spool/live', () => {
	const recorder = () => {
		const opened: LiveOpen[] = [];
		const hub: LiveHub = {
			sockets: true,
			open: (init) => {
				opened.push(init);
				return new Response('hub');
			},
			publish() {},
			revoke() {}
		};
		return { hub, opened };
	};

	it('tells the page the hub serves sockets, and no other hub does', () => {
		expect(site({ live: { hub: recorder().hub } }).spool.config.live).toEqual({
			public: false,
			mode: 'adaptive',
			socket: true
		});
		expect(site().spool.config.live).toEqual({ public: false, mode: 'adaptive' });
	});

	it('refuses a partition the session does not own as SSE does, and hands the hub an upgrade only for the owner', async () => {
		const r = recorder();
		const w = site({ live: { hub: r.hub } });
		const mine = await partitionId('s', 'alice');
		const bobs = await partitionId('s', 'bob');
		const upgrade = (query: string) =>
			w.spool.respond(
				new Request(`${ORIGIN}${LIVE_PATH}${query}`, { headers: { upgrade: 'websocket' } })
			) as Promise<Response>;
		w.user.current = 'alice';
		expect(names(await reading(await upgrade(`?partition=${bobs}`)).all())).toEqual([
			'revoked'
		]);
		w.user.current = null;
		expect(names(await reading(await upgrade(`?partition=${mine}`)).all())).toEqual([
			'revoked'
		]);
		expect(r.opened).toHaveLength(0);
		w.user.current = 'alice';
		await upgrade(`?partition=${mine}&have=1`);
		await w.open(`?partition=${mine}`);
		expect(r.opened.map((o) => [o.partition, o.socket])).toEqual([
			[mine, true],
			[mine, undefined]
		]);
	});
});

type Wire = ReturnType<typeof fakeWire>;

function fakeWire() {
	const listeners = new Map<string, Array<(e: { data: unknown }) => void>>();
	const wire = {
		readyState: 0,
		closed: false,
		url: '',
		sent: [] as string[],
		addEventListener: (name: string, fn: (e: { data: unknown }) => void) =>
			void listeners.set(name, [...(listeners.get(name) ?? []), fn]),
		send: (text: string) => void wire.sent.push(text),
		close() {
			wire.closed = true;
			wire.readyState = 3;
		},
		emit(name: string, data?: unknown) {
			for (const fn of listeners.get(name) ?? []) fn({ data });
		}
	};
	return wire;
}

function socketEnv() {
	const wires: Wire[] = [];
	const events: Array<ReturnType<typeof fakeSource>> = [];
	return {
		wires,
		events,
		make: {
			socket: (url: string) => {
				const wire = fakeWire();
				wire.url = url;
				wires.push(wire);
				return wire;
			},
			events: (url: string) => {
				const source = fakeSource();
				source.url = url;
				events.push(source);
				return source as unknown as StreamSource;
			}
		}
	};
}

describe('the socket source', () => {
	const URL_ = `${LIVE_PATH}?partition=P&have=7`;
	const delta: LiveDelta = {
		protocol: 1,
		from: 7,
		cursor: 8,
		changed: { t: 8 },
		dropped: [],
		reset: false
	};

	it('feeds startLive what an EventSource feeds it, and is asked for only where the site serves sockets', async () => {
		const e = socketEnv();
		const s = { locks: fakeLocks(), sources: [] as Array<ReturnType<typeof fakeSource>> };
		const plain = tab(s);
		const asked: Array<[string, boolean | undefined]> = [];
		plain.deps.open = (url, socket) => {
			asked.push([url, socket]);
			return socketSource(url, e.make);
		};
		plain.start();
		await settle();
		expect(asked).toEqual([[URL_, false]]);

		const a = tab({ locks: fakeLocks(), sources: [] });
		a.answer.state = {
			...a.answer.state,
			live: { public: false, mode: 'always', socket: true }
		};
		a.deps.open = (url, socket) => {
			asked.push([url, socket]);
			return socketSource(url, e.make);
		};
		a.start();
		await settle();
		expect(asked[1]).toEqual([URL_, true]);
		const wire = e.wires[1] as Wire;
		expect(wire.url).toBe(URL_);
		wire.emit('open');
		wire.emit('message', frameText({ event: 'delta', data: delta }));
		wire.emit('message', frameText({ event: 'lease', data: { leaseMs: 120_000 } }));
		wire.emit('message', 'event: lease\ndata: {"nope":true}\n\n');
		wire.emit('message', 'event: delta\ndata: {"cursor":"x"}\n\n');
		wire.emit('message', 'not a frame');
		wire.emit('message', new ArrayBuffer(2));
		await settle();
		expect(a.sent).toEqual([
			{ partition: 'P', event: 'delta', delta },
			{ partition: 'P', event: 'lease', leaseMs: 120_000 }
		]);
	});

	it('wipes on revoked, closes the socket and does not connect again for that partition', async () => {
		vi.useFakeTimers();
		const e = socketEnv();
		const s = { locks: fakeLocks(), sources: [] as Array<ReturnType<typeof fakeSource>> };
		const a = tab(s);
		a.answer.state = {
			...a.answer.state,
			live: { public: false, mode: 'always', socket: true }
		};
		a.deps.open = (url) => socketSource(url, e.make);
		a.start();
		await vi.advanceTimersByTimeAsync(0);
		const wire = e.wires[0] as Wire;
		wire.emit('open');
		wire.emit('message', frameText({ event: 'revoked', data: {} }));
		wire.emit('close');
		await vi.advanceTimersByTimeAsync(10_000);
		expect(a.sent).toEqual([{ partition: 'P', event: 'revoked' }]);
		expect(wire.closed).toBe(true);
		expect(e.wires).toHaveLength(1);
	});

	it('pings every 25 seconds while open, and stops on close', () => {
		vi.useFakeTimers();
		const e = socketEnv();
		const source = socketSource(URL_, e.make);
		const wire = e.wires[0] as Wire;
		vi.advanceTimersByTime(60_000);
		expect(wire.sent).toEqual([]);
		wire.readyState = 1;
		wire.emit('open');
		expect(source.readyState).toBe(1);
		vi.advanceTimersByTime(75_000);
		expect(wire.sent).toEqual([LIVE_PING, LIVE_PING, LIVE_PING]);
		source.close();
		expect(wire.closed).toBe(true);
		expect(source.readyState).toBe(2);
		vi.advanceTimersByTime(50_000);
		expect(wire.sent).toHaveLength(3);
	});

	it('opens the same URL as SSE when the upgrade fails, and keeps the listeners', () => {
		const e = socketEnv();
		const source = socketSource(URL_, e.make);
		const got: string[] = [];
		source.addEventListener('lease', (event) => void got.push(event.data));
		(e.wires[0] as Wire).emit('close');
		expect(e.events.map((x) => x.url)).toEqual([URL_]);
		const es = e.events[0] as ReturnType<typeof fakeSource>;
		es.emit('lease', { leaseMs: 5 });
		source.addEventListener('revoked', () => void got.push('revoked'));
		es.emit('revoked');
		expect(got).toEqual(['{"leaseMs":5}', 'revoked']);
		expect(source.readyState).toBe(es.readyState);
		source.close();
		expect(es.closed).toBe(true);
	});

	it('connects again 3 seconds after the server closes an open socket, and not after close()', () => {
		vi.useFakeTimers();
		const e = socketEnv();
		const source = socketSource(URL_, e.make);
		(e.wires[0] as Wire).emit('open');
		(e.wires[0] as Wire).emit('close');
		expect(source.readyState).toBe(0);
		vi.advanceTimersByTime(2999);
		expect(e.wires).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(e.wires.map((w) => w.url)).toEqual([URL_, URL_]);
		(e.wires[1] as Wire).emit('open');
		(e.wires[1] as Wire).emit('close');
		source.close();
		vi.advanceTimersByTime(10_000);
		expect(e.wires).toHaveLength(2);
		expect(e.events).toHaveLength(0);
	});

	it('opens a ws or wss URL on the page origin in a browser, and EventSource where it has no WebSocket', () => {
		const made: string[] = [];
		class FakeWebSocket {
			readyState = 0;
			constructor(url: URL) {
				made.push(String(url));
			}
			addEventListener() {}
			send() {}
			close() {}
		}
		class FakeEventSource {
			readyState = 0;
			constructor(url: string) {
				made.push(url);
			}
			addEventListener() {}
			close() {}
		}
		vi.stubGlobal('WebSocket', FakeWebSocket);
		vi.stubGlobal('EventSource', FakeEventSource);
		try {
			vi.stubGlobal('location', { href: 'https://site.test/page' });
			const deps = browserLiveDeps({
				liveState: () => Promise.reject(new Error('x')),
				liveEvent: async () => undefined
			}) as LiveDeps;
			deps.open(URL_, true);
			deps.open(URL_, false);
			vi.stubGlobal('location', { href: 'http://site.test/' });
			deps.open(URL_, true);
			vi.stubGlobal('WebSocket', undefined);
			deps.open(URL_, true);
			expect(made).toEqual([`wss://site.test${URL_}`, URL_, `ws://site.test${URL_}`, URL_]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('falls back to SSE when a reconnect fails before it opens', () => {
		vi.useFakeTimers();
		const e = socketEnv();
		socketSource(URL_, e.make);
		(e.wires[0] as Wire).emit('open');
		(e.wires[0] as Wire).emit('close');
		vi.advanceTimersByTime(3000);
		(e.wires[1] as Wire).emit('close');
		expect(e.events.map((x) => x.url)).toEqual([URL_]);
	});
});

// #endregion
