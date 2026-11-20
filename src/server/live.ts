import { PROTOCOL_VERSION } from '../protocol/artifact.js';
import type { LiveDelta, LiveEventName, LiveEvents } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { toSyncResponse } from '../protocol/sync.js';
import type { VersionStore } from '../stores/version-store.js';

/** what a hub needs to open one stream; everything but `signal` and `valid` crosses a Durable Object as JSON */
export type LiveOpen = {
	/** the principal partition id the page holds; null for a public stream */
	partition: string | null;
	/** events written first, in order: `hello` and the catch-up `delta` */
	first: LiveFrame[];
	/** how long each `lease` event grants, in milliseconds; a lease follows `first` and then every half of it */
	leaseMs: number;
	/** milliseconds between keepalive comments */
	keepaliveMs: number;
	/** the stream closes after this long, so the next connect resolves the identity again; 0 never */
	maxAgeMs: number;
	/** the request's abort signal; a stream closes when it aborts */
	signal?: AbortSignal;
	/**
	 * Called at each lease tick of a partition stream; false ends the session at once with `revoked`.
	 * A hub that runs in another isolate cannot take a function, so it ignores this and relies on
	 * {@link LiveHub.revoke} and `maxAgeMs`.
	 */
	valid?: () => boolean | Promise<boolean>;
	/**
	 * true when the request is a WebSocket upgrade. A hub with `sockets` answers it with a socket;
	 * any other hub ignores it and answers the stream, which makes the page fall back to SSE.
	 */
	socket?: boolean;
};

/** one event as it goes on the wire */
export type LiveFrame = {
	[N in LiveEventName]: { event: N; data: LiveEvents[N] };
}[LiveEventName];

/**
 * Where open streams live. `open` answers a stream `Response`; `publish` sends a delta to every open
 * stream; `revoke` sends `revoked` to every stream of a partition and closes it. The in-process
 * {@link memoryHub} fits a host that is one long-lived process. A Worker needs a hub every isolate
 * can reach, which is the Durable Object hub in `@drupflare/spool/stores/durable-object`.
 * `sockets` is true for a hub that also answers a WebSocket upgrade at the same path; the site's
 * config then tells pages to try a socket first.
 */
export interface LiveHub {
	readonly sockets?: boolean;
	open(init: LiveOpen): Response | Promise<Response>;
	publish(delta: LiveDelta): void | Promise<void>;
	revoke(partition: string): void | Promise<void>;
}

/** what an in-process hub counts, for a test and for the cost figures */
export type LiveStats = {
	/** streams open now */
	open: number;
	opened: number;
	closed: number;
	/** bytes of `:k` comments written */
	keepaliveBytes: number;
	/** bytes of events written */
	eventBytes: number;
	/** `lease` events written */
	leases: number;
};

/** an in-process hub that also reports its counts */
export type MemoryHub = LiveHub & { stats(): LiveStats };

const encoder = new TextEncoder();
const KEEPALIVE = encoder.encode(':k\n\n');

/** unread frames after which a stream is taken for dead and closed */
const STALLED = 8;

/** the SSE text of one event */
export function frameText(frame: LiveFrame): string {
	return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

type Conn = {
	partition: string | null;
	send(frame: LiveFrame): void;
	end(): void;
};

/** unref a timer where the runtime has the call, so an idle stream never holds a process open */
function quiet<T>(timer: T): T {
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

/**
 * @internal a test seam: `beforeWrite` runs before each write to a connection, `writes` counting
 * from 1, and a throw there detaches the connection like a failed socket write
 */
export type MemoryHubOptions = {
	beforeWrite?(info: { partition: string | null; writes: number }): void;
};

/**
 * A hub that holds its streams in this process. A keepalive comment goes to each connection every
 * `keepaliveMs`; a connection whose write throws, whose client cancels or whose request aborts is
 * detached.
 */
export function memoryHub(options: MemoryHubOptions = {}): MemoryHub {
	const conns = new Set<Conn>();
	const stats: LiveStats = {
		open: 0,
		opened: 0,
		closed: 0,
		keepaliveBytes: 0,
		eventBytes: 0,
		leases: 0
	};

	return {
		stats: () => ({ ...stats, open: conns.size }),
		open(init) {
			let conn: Conn | undefined;
			let done = false;
			const timers: Array<ReturnType<typeof setInterval>> = [];
			const finish = () => {
				if (done) return;
				done = true;
				for (const timer of timers) clearInterval(timer);
				if (conn) conns.delete(conn);
				stats.closed += 1;
			};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					let writes = 0;
					const write = (bytes: Uint8Array) => {
						if (done) return;
						// a client that is gone but not reported (seen under `wrangler dev`) stops reading
						if ((controller.desiredSize ?? 1) <= -STALLED) return conn?.end();
						try {
							options.beforeWrite?.({
								partition: init.partition,
								writes: (writes += 1)
							});
							controller.enqueue(bytes);
						} catch {
							finish();
						}
					};
					const self: Conn = {
						partition: init.partition,
						send(frame) {
							const bytes = encoder.encode(frameText(frame));
							stats.eventBytes += bytes.byteLength;
							if (frame.event === 'lease') stats.leases += 1;
							write(bytes);
						},
						end() {
							finish();
							try {
								controller.close();
							} catch {
								// already closed by the client
							}
						}
					};
					conn = self;
					conns.add(self);
					stats.opened += 1;
					for (const frame of init.first) self.send(frame);
					const lease = async () => {
						if (init.partition !== null && init.valid) {
							let live = false;
							try {
								live = await init.valid();
							} catch {
								live = false;
							}
							if (!live) {
								self.send({ event: 'revoked', data: {} });
								return self.end();
							}
						}
						self.send({ event: 'lease', data: { leaseMs: init.leaseMs } });
					};
					void lease();
					timers.push(
						quiet(setInterval(() => void lease(), Math.max(1, init.leaseMs / 2)))
					);
					timers.push(
						quiet(
							setInterval(() => {
								stats.keepaliveBytes += KEEPALIVE.byteLength;
								write(KEEPALIVE);
							}, init.keepaliveMs)
						)
					);
					if (init.maxAgeMs > 0) {
						const limit = quiet(setTimeout(() => self.end(), init.maxAgeMs));
						timers.push(limit as unknown as ReturnType<typeof setInterval>);
					}
					init.signal?.addEventListener('abort', () => self.end(), { once: true });
				},
				cancel: finish
			});
			return new Response(stream, { headers: LIVE_HEADERS });
		},
		publish(delta) {
			for (const conn of conns) conn.send({ event: 'delta', data: delta });
		},
		revoke(partition) {
			for (const conn of [...conns]) {
				if (conn.partition !== partition) continue;
				conn.send({ event: 'revoked', data: {} });
				conn.end();
			}
		}
	};
}

/** the response headers of a stream: no cache keeps it and a proxy in front of it passes bytes through */
export const LIVE_HEADERS = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-store',
	'x-accel-buffering': 'no'
} as const;

/** the `hello` and catch-up `delta` frames for a page that holds `have`, read from `store` */
export async function openingFrames(
	store: VersionStore,
	have: number | null
): Promise<LiveFrame[]> {
	const diff = await store.diff(have ?? (await store.cursor()));
	const from = have ?? diff.cursor;
	return [
		{ event: 'hello', data: { protocol: PROTOCOL_VERSION, cursor: diff.cursor } },
		{ event: 'delta', data: { ...toSyncResponse(diff), from } }
	];
}

/**
 * Wraps `store` so every bump also publishes its delta. The delta of one bump is exactly the tags it
 * changed, from the cursor before it to the one it returned; a page that finds a gap between its
 * cursor and a delta's `from` stops trusting the stream and asks again.
 */
export function publishing(store: VersionStore, hub: LiveHub): VersionStore {
	return {
		cursor: () => store.cursor(),
		diff: (from) => store.diff(from),
		async bump(tags) {
			const cursor = await store.bump(tags);
			const changed = [...new Set(tags)];
			if (changed.length === 0) return cursor;
			const delta: LiveDelta = {
				...toSyncResponse({
					cursor,
					changed: Object.fromEntries(changed.map((tag) => [tag, cursor])),
					reset: false
				}),
				from: cursor - 1
			};
			try {
				await hub.publish(delta);
			} catch {
				// a stream that missed this delta sees the gap in the next one
			}
			return cursor;
		}
	};
}

/**
 * The `live` option of `createSpool`. `hub` is where streams live; omitted, an in-process hub, which
 * only suits one long-lived process. `public` also pushes tag changes to pages that hold no
 * principal partition. Seconds: `lease` is what each lease event grants (default 120), `keepalive`
 * the gap between comments (default 25) and `maxAge` how long one stream lives before the page
 * connects again and the identity is resolved again (default 3600; 0 never).
 *
 * `mode` decides when a page opens its stream. `adaptive`, the default, makes the first lease
 * renewal of a visible session an ordinary request and replaces the second with the stream, so a
 * visitor who loads documents, each a short page lifetime, never opens one and pays what it pays
 * without the option. `always` opens at login and whenever a tab becomes visible, for an app that
 * stays open. `live: 'always'` is the same as `{ mode: 'always' }`.
 *
 * A hub with `sockets`, such as `durableObjectHub(ns, { hibernate: true })`, also answers a WebSocket
 * upgrade at the same path, and pages open a socket first. `keepalive` and `maxAge` still apply to
 * SSE streams; a socket has no keepalive comment, since its ping is the page's, and ends at `maxAge`.
 */
export type LiveOptions = {
	hub?: LiveHub;
	mode?: 'adaptive' | 'always';
	public?: boolean;
	lease?: number;
	keepalive?: number;
	maxAge?: number;
};

/** what `createSpool` runs with, once the option and the runtime are read */
export type LiveSettings = {
	hub: LiveHub;
	mode: 'adaptive' | 'always';
	public: boolean;
	leaseMs: number;
	keepaliveMs: number;
	maxAgeMs: number;
};

const onWorkers = () =>
	typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

/**
 * Reads `live`. `false` is off. `true` and an object are on, with an in-process hub unless one is
 * given. Absent, it is on for a site with an `identity` option on a host that is one process, and
 * off on Workers, where an in-process hub only reaches its own isolate.
 */
export function liveSettings(options: {
	live?: boolean | 'always' | LiveOptions;
	identity?: unknown;
}): LiveSettings | undefined {
	const live = options.live;
	if (live === false) return undefined;
	if (live === undefined && (options.identity === undefined || onWorkers())) return undefined;
	const given: LiveOptions =
		typeof live === 'object' ? live : live === 'always' ? { mode: 'always' } : {};
	if (given.mode !== undefined && given.mode !== 'adaptive' && given.mode !== 'always') {
		throw new ProtocolError('bad-route', 'live.mode must be adaptive or always');
	}
	const seconds = (name: string, value: number | undefined, fallback: number, min: number) => {
		const v = value ?? fallback;
		if (!(Number.isFinite(v) && v >= min)) {
			throw new ProtocolError(
				'bad-route',
				`live.${name} must be a number of at least ${min}`
			);
		}
		return v * 1000;
	};
	return {
		hub: given.hub ?? memoryHub(),
		mode: given.mode ?? 'adaptive',
		public: given.public === true,
		leaseMs: seconds('lease', given.lease, 120, 1),
		keepaliveMs: seconds('keepalive', given.keepalive, 25, 1),
		maxAgeMs: seconds('maxAge', given.maxAge, 3600, 0)
	};
}

/** the `have` and `partition` query values of a live request */
export function parseLiveQuery(url: URL): { have: number | null; partition: string | null } {
	const have = url.searchParams.get('have');
	if (have !== null && !/^\d{1,15}$/.test(have)) {
		throw new ProtocolError('bad-sync', 'have must be a non-negative integer');
	}
	const partition = url.searchParams.get('partition');
	if (partition !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(partition)) {
		throw new ProtocolError('bad-sync', 'partition must be a base64url token');
	}
	return { have: have === null ? null : Number(have), partition };
}
