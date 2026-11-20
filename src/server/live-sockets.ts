import { LIVE_PING } from '../protocol/config.js';
import type { LiveDelta } from '../protocol/envelope.js';
import { frameText, type LiveFrame, type LiveOpen } from './live.js';

/** the part of a hibernatable `WebSocket` the hub uses */
export type LiveSocket = {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
};

/**
 * @internal what the hub needs from a Durable Object: `SpoolLive` fills it from `ctx`, a test fills
 * it with fakes whose sockets outlive the hub, as the runtime's do
 */
export type SocketHost = {
	pair(): [client: LiveSocket, server: LiveSocket];
	accept(server: LiveSocket, tags: string[]): void;
	sockets(tag?: string): LiveSocket[];
	autoResponse(request: string, response: string): void;
	alarm: { get(): Promise<number | null>; set(at: number): Promise<void> };
};

/** what a socket needs at open; the rest of {@link LiveOpen} belongs to the SSE hub */
export type SocketOpen = Pick<LiveOpen, 'partition' | 'first' | 'leaseMs' | 'maxAgeMs'>;

/** the request header that carries {@link SocketOpen} from the Worker to the object, since a GET upgrade has no body */
export const SOCKET_OPEN_HEADER = 'x-spool-open';

/** the encoded opening header is at most this long, a bound chosen here and not read from the platform */
export const SOCKET_OPEN_MAX = 8192;

/** what each socket keeps across hibernation; `expires` is epoch milliseconds, 0 for never */
type Attachment = { leaseMs: number; expires: number };

const tagOf = (partition: string | null) => (partition === null ? 'public' : `p:${partition}`);
const leaseFrame = (leaseMs: number) => frameText({ event: 'lease', data: { leaseMs } });

/** the opening request as a header value, or null when it is longer than {@link SOCKET_OPEN_MAX} */
export function encodeOpen(init: SocketOpen): string | null {
	const { partition, first, leaseMs, maxAgeMs } = init;
	const bytes = new TextEncoder().encode(JSON.stringify({ partition, first, leaseMs, maxAgeMs }));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const header = btoa(binary);
	return header.length > SOCKET_OPEN_MAX ? null : header;
}

/** reads {@link encodeOpen}; undefined for anything that is not a well-formed opening request */
export function decodeOpen(header: string | null): SocketOpen | undefined {
	if (!header) return undefined;
	try {
		const binary = atob(header);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		const frames = v['first'];
		const frame = (f: unknown) =>
			typeof f === 'object' &&
			f !== null &&
			typeof (f as { event?: unknown }).event === 'string' &&
			'data' in f;
		if (
			(v['partition'] !== null && typeof v['partition'] !== 'string') ||
			!Array.isArray(frames) ||
			!frames.every(frame) ||
			typeof v['leaseMs'] !== 'number' ||
			!(v['leaseMs'] > 0) ||
			typeof v['maxAgeMs'] !== 'number' ||
			!(v['maxAgeMs'] >= 0)
		) {
			return undefined;
		}
		return {
			partition: v['partition'] as string | null,
			first: frames as LiveFrame[],
			leaseMs: v['leaseMs'],
			maxAgeMs: v['maxAgeMs']
		};
	} catch {
		return undefined;
	}
}

/**
 * The socket half of a Durable Object hub. Nothing here holds a timer, so an idle object can
 * hibernate: a socket's partition is its tag, its lease and expiry are its attachment, and a ping
 * is answered with a `lease` frame by the runtime's auto-response, which does not wake the object.
 * `maxAge` is the one thing that needs the object awake, so it runs from a single alarm set to the
 * earliest expiry. Build it again after a wake and call `restore`.
 */
export function hibernatingSockets(host: SocketHost, now: () => number = Date.now) {
	const attachment = (ws: LiveSocket) => ws.deserializeAttachment() as Attachment | null;
	const quiet = (fn: () => void) => {
		try {
			fn();
		} catch {
			// a socket that closed since it was listed
		}
	};

	return {
		/** registers the ping auto-response again from a socket that survived a hibernation */
		restore(): void {
			const first = host.sockets()[0];
			const kept = first ? attachment(first) : null;
			if (kept) host.autoResponse(LIVE_PING, leaseFrame(kept.leaseMs));
		},

		/** accepts a socket and writes the frames SSE writes at open; returns the end for the client */
		async open(init: SocketOpen): Promise<LiveSocket> {
			const [client, server] = host.pair();
			host.accept(server, [tagOf(init.partition)]);
			const expires = init.maxAgeMs > 0 ? now() + init.maxAgeMs : 0;
			server.serializeAttachment({ leaseMs: init.leaseMs, expires } satisfies Attachment);
			host.autoResponse(LIVE_PING, leaseFrame(init.leaseMs));
			for (const frame of init.first) server.send(frameText(frame));
			server.send(leaseFrame(init.leaseMs));
			if (expires > 0) {
				const set = await host.alarm.get();
				if (set === null || set > expires) await host.alarm.set(expires);
			}
			return client;
		},

		/** the same answer the auto-response gives, for a runtime that does not give it */
		message(ws: LiveSocket, data: string | ArrayBuffer): void {
			const kept = attachment(ws);
			if (data === LIVE_PING && kept) quiet(() => ws.send(leaseFrame(kept.leaseMs)));
		},

		/** sends a delta to every open socket */
		publish(delta: LiveDelta): void {
			const text = frameText({ event: 'delta', data: delta });
			for (const ws of host.sockets()) quiet(() => ws.send(text));
		},

		/** sends `revoked` to every socket of `partition` and closes it */
		revoke(partition: string): void {
			const text = frameText({ event: 'revoked', data: {} });
			for (const ws of host.sockets(tagOf(partition))) {
				quiet(() => ws.send(text));
				quiet(() => ws.close(1000, 'revoked'));
			}
		},

		/** closes the sockets past their maximum age and sets the alarm for the next expiry */
		async alarm(): Promise<void> {
			const at = now();
			let next = 0;
			for (const ws of host.sockets()) {
				const expires = attachment(ws)?.expires ?? 0;
				if (expires === 0) continue;
				if (expires <= at) quiet(() => ws.close(1000, 'max age'));
				else next = next === 0 ? expires : Math.min(next, expires);
			}
			if (next > 0) await host.alarm.set(next);
		}
	};
}
