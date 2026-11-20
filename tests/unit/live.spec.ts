import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LIVE_PATH, LIVE_PING, type LiveDelta } from '../../src/protocol/index';
import { createSpool, defineRoute, partitionId, type LiveOpen } from '../../src/server/index';
import { durableObjectHub } from '../../src/stores/durable-object';
import { memoryStore } from '../../src/stores/index';
import readme from '../fixtures/readme-live-worker';

type Frame = { event: string; data: unknown } | { comment: string };

function reading(response: Response) {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	return {
		async next(): Promise<Frame | null> {
			for (;;) {
				const cut = buffer.indexOf('\n\n');
				if (cut >= 0) {
					const text = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					if (text.startsWith(':')) return { comment: text.slice(1) };
					return {
						event: /^event: (.*)$/m.exec(text)?.[1] ?? '',
						data: JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null')
					};
				}
				const { value, done } = await reader.read();
				if (done) return null;
				buffer += decoder.decode(value, { stream: true });
			}
		},
		cancel: () => reader.cancel()
	};
}

const OPEN: Omit<LiveOpen, 'partition'> = {
	first: [{ event: 'hello', data: { protocol: 1, cursor: 0 } }],
	leaseMs: 60_000,
	keepaliveMs: 25_000,
	maxAgeMs: 0
};

const delta: LiveDelta = {
	protocol: 1,
	from: 0,
	cursor: 1,
	changed: { 'node:1': 1 },
	dropped: [],
	reset: false
};

let n = 0;
const fresh = () => {
	const name = `hub-${n++}`;
	return { hub: durableObjectHub(env.SPOOL_LIVE, name), object: env.SPOOL_LIVE.getByName(name) };
};

function socketReading(response: Response) {
	const ws = response.webSocket as WebSocket;
	const frames: string[] = [];
	const waiting: Array<() => void> = [];
	let closed = false;
	ws.accept();
	ws.addEventListener('message', (e) => {
		frames.push(String(e.data));
		waiting.shift()?.();
	});
	ws.addEventListener('close', () => {
		closed = true;
		for (const wake of waiting.splice(0)) wake();
	});
	return {
		async next(): Promise<Frame | null> {
			while (frames.length === 0) {
				if (closed) return null;
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			const text = frames.shift() as string;
			return {
				event: /^event: (.*)$/m.exec(text)?.[1] ?? '',
				data: JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? 'null')
			};
		},
		send: (text: string) => ws.send(text),
		close: () => ws.close(1000)
	};
}

describe('SpoolLive over hibernatable sockets', () => {
	const hibernating = () => {
		const name = `sockets-${n++}`;
		return durableObjectHub(env.SPOOL_LIVE, { name, hibernate: true });
	};

	it('accepts the upgrade and writes hello, the catch-up and a lease, as the stream does', async () => {
		const hub = hibernating();
		expect(hub.sockets).toBe(true);
		const response = (await hub.open({ ...OPEN, partition: 'A', socket: true })) as Response;
		expect(response.status).toBe(101);
		const socket = socketReading(response);
		expect(await socket.next()).toEqual({ event: 'hello', data: { protocol: 1, cursor: 0 } });
		expect(await socket.next()).toEqual({ event: 'lease', data: { leaseMs: 60_000 } });
		socket.close();
	});

	it('answers a ping with a lease frame, delivers a published delta and revokes one partition', async () => {
		const hub = hibernating();
		const a = socketReading(
			(await hub.open({ ...OPEN, partition: 'A', socket: true })) as Response
		);
		const b = socketReading(
			(await hub.open({ ...OPEN, partition: 'B', socket: true })) as Response
		);
		for (const socket of [a, b]) {
			await socket.next();
			await socket.next();
		}
		a.send(LIVE_PING);
		expect(await a.next()).toEqual({ event: 'lease', data: { leaseMs: 60_000 } });
		await hub.publish(delta);
		expect(await a.next()).toEqual({ event: 'delta', data: delta });
		expect(await b.next()).toEqual({ event: 'delta', data: delta });
		await hub.revoke('A');
		expect(await a.next()).toEqual({ event: 'revoked', data: {} });
		expect(await a.next()).toBeNull();
		b.send(LIVE_PING);
		expect(await b.next()).toEqual({ event: 'lease', data: { leaseMs: 60_000 } });
		b.close();
	});

	it('serves SSE to a request that is not an upgrade, and to a hub that did not ask for sockets', async () => {
		const hub = hibernating();
		const stream = reading((await hub.open({ ...OPEN, partition: 'A' })) as Response);
		expect(await stream.next()).toEqual({ event: 'hello', data: { protocol: 1, cursor: 0 } });
		await stream.cancel();
		const plain = durableObjectHub(env.SPOOL_LIVE, `plain-${n++}`);
		expect(plain.sockets).toBe(false);
		const sse = (await plain.open({ ...OPEN, partition: 'A', socket: true })) as Response;
		expect(sse.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		await reading(sse).cancel();
	});

	it('answers 413 when the opening frames do not fit a header, and 400 to an upgrade with none', async () => {
		const hub = hibernating();
		const changed = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`tag:${i}`, i]));
		const big = { event: 'delta' as const, data: { ...delta, changed } };
		const refused = (await hub.open({
			...OPEN,
			first: [big],
			partition: 'A',
			socket: true
		})) as Response;
		expect(refused.status).toBe(413);
		const bare = await env.SPOOL_LIVE.getByName(`bare-${n++}`).fetch(
			new Request('https://spool.live/socket', { headers: { upgrade: 'websocket' } })
		);
		expect(bare.status).toBe(400);
	});

	it('is served by /.spool/live for an upgrade, and revoke through the spool reaches the socket', async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/about', {
					strategy: 'template',
					template: { source: '<p>about</p>' },
					load: () => ({})
				})
			],
			store: memoryStore(),
			identity: { secret: 's', resolve: () => ({ principal: 'alice' }) },
			live: { hub: hibernating() }
		});
		expect(spool.config.live).toEqual({ public: false, mode: 'adaptive', socket: true });
		const id = await partitionId('s', 'alice');
		const response = (await spool.respond(
			new Request(`https://site.test${LIVE_PATH}?partition=${id}&have=0`, {
				headers: { upgrade: 'websocket' }
			})
		)) as Response;
		expect(response.status).toBe(101);
		const socket = socketReading(response);
		const seen = [await socket.next(), await socket.next(), await socket.next()];
		expect(seen.map((f) => (f && 'event' in f ? f.event : null))).toEqual([
			'hello',
			'delta',
			'lease'
		]);
		await spool.invalidate(['node:1']);
		expect(await socket.next()).toEqual({ event: 'delta', data: delta });
		await spool.revoke('alice');
		expect(await socket.next()).toEqual({ event: 'revoked', data: {} });
		expect(await socket.next()).toBeNull();
	});
});

describe('the Worker shape in docs/adapters/cloudflare-workers.md', () => {
	it('upgrades /.spool/live to a socket through createSpool and durableObjectHub', async () => {
		const id = await partitionId('s', 'alice');
		const response = await readme.fetch(
			new Request(`https://site.test${LIVE_PATH}?partition=${id}&have=0`, {
				headers: { upgrade: 'websocket' }
			}),
			env
		);
		expect(response.status).toBe(101);
		const socket = socketReading(response);
		expect(await socket.next()).toMatchObject({ event: 'hello' });
		socket.close();
	});
});

describe('SpoolLive', () => {
	it('holds the stream the hub forwards and sends it the opening frames, then a lease', async () => {
		const { hub, object } = fresh();
		const stream = reading(await hub.open({ ...OPEN, partition: 'A' }));
		expect(await stream.next()).toEqual({ event: 'hello', data: { protocol: 1, cursor: 0 } });
		expect(await stream.next()).toEqual({ event: 'lease', data: { leaseMs: 60_000 } });
		expect(await object.stats()).toMatchObject({ open: 1, opened: 1, leases: 1 });
		await stream.cancel();
	});

	it('delivers a delta published from another stub to every open stream, and revokes one partition', async () => {
		const { hub, object } = fresh();
		const a = reading(await hub.open({ ...OPEN, partition: 'A' }));
		const b = reading(await hub.open({ ...OPEN, partition: 'B' }));
		for (const stream of [a, b]) {
			await stream.next();
			await stream.next();
		}
		await hub.publish(delta);
		expect(await a.next()).toEqual({ event: 'delta', data: delta });
		expect(await b.next()).toEqual({ event: 'delta', data: delta });
		await hub.revoke('A');
		expect(await a.next()).toEqual({ event: 'revoked', data: {} });
		expect(await a.next()).toBeNull();
		expect(await object.stats()).toMatchObject({ open: 1, opened: 2, closed: 1 });
		await b.cancel();
	});

	it('ends a stream at its maximum age', async () => {
		const { hub, object } = fresh();
		const stream = reading(await hub.open({ ...OPEN, partition: null, maxAgeMs: 50 }));
		await stream.next();
		await stream.next();
		expect(await stream.next()).toBeNull();
		expect(await object.stats()).toMatchObject({ open: 0, closed: 1 });
	});

	it('serves /.spool/live for a spool whose hub is the object, and publishes each invalidation to it', async () => {
		const { hub, object } = fresh();
		const spool = createSpool({
			routes: [
				defineRoute('/about', {
					strategy: 'template',
					template: { source: '<p>about</p>' },
					load: () => ({})
				})
			],
			store: memoryStore(),
			identity: { secret: 's', resolve: () => ({ principal: 'alice' }) },
			live: { hub }
		});
		const id = await partitionId('s', 'alice');
		const response = (await spool.respond(
			new Request(`https://site.test${LIVE_PATH}?partition=${id}&have=0`)
		)) as Response;
		expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		const stream = reading(response);
		const seen = [await stream.next(), await stream.next(), await stream.next()];
		expect(seen.map((f) => (f && 'event' in f ? f.event : null))).toEqual([
			'hello',
			'delta',
			'lease'
		]);
		await spool.invalidate(['node:1']);
		expect(await stream.next()).toEqual({ event: 'delta', data: delta });
		await spool.revoke('alice');
		expect(await stream.next()).toEqual({ event: 'revoked', data: {} });
		expect(await stream.next()).toBeNull();
		expect(await object.stats()).toMatchObject({ open: 0, opened: 1, closed: 1 });
	});
});
