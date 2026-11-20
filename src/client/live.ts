import { LIVE_PATH, LIVE_PING } from '../protocol/config.js';
import { parseLiveDelta } from '../protocol/envelope.js';
import type { LiveAck, LiveMessage, LiveState } from '../sw/runtime.js';

/** the part of `EventSource` the stream uses */
export type StreamSource = {
	readonly readyState: number;
	addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void;
	close(): void;
};

/** what {@link startLive} needs from the page and the worker */
export type LiveDeps = {
	/** asks the worker for the partition held, the cursor to start from and whether the site has a stream */
	state(): Promise<LiveState>;
	/** tells the worker what the stream delivered; undefined when the worker did not answer */
	send(message: LiveMessage): Promise<LiveAck | undefined>;
	visible(): boolean;
	/** calls `fn` when the page becomes visible or hidden, or is shown again from the back/forward cache */
	onVisibility(fn: () => void): void;
	/** calls `fn` when the document is going away */
	onPageHide(fn: () => void): void;
	/** `navigator.locks`; without it no stream opens, since two tabs would each hold one */
	locks: Pick<LockManager, 'request'> | undefined;
	/** `socket` is true when the site's hub accepts a WebSocket upgrade at the same URL */
	open(url: string, socket?: boolean): StreamSource;
};

/** the lock the tab holding the stream owns; every tab of the origin asks for the same name */
export const LIVE_LOCK = 'spool-live';

const CLOSED = 2;

function read<T>(text: string, parse: (value: unknown) => T): T | undefined {
	try {
		return parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/**
 * Holds one stream per origin while a tab is visible. Tabs queue on a Web Lock and only the holder
 * connects; a tab that is hidden or leaves gives the lock up and the next visible tab takes it, so
 * the stream closes when no tab is visible. The worker is shared by every tab, so the holder alone
 * tells it what the stream read and no tab-to-tab channel is needed. A browser without Web Locks or
 * `EventSource`, a stream that fails, or a site with no stream leaves the page on the renewals it
 * always made. `reconcile` reopens the stream for the partition the worker holds now. Where the site
 * sets `mode: 'adaptive'` (the default) nothing opens until `arm`, which the worker calls for at the
 * second lease renewal of a visible session; hiding the tab disarms it.
 */
export function startLive(deps: LiveDeps): { reconcile(): void; arm(): void } {
	let held: { release(): void; reopen(): void } | undefined;
	let armed = false;
	let waiting: AbortController | undefined;
	let revoked: string | null = null;

	function drop(): void {
		waiting?.abort();
		waiting = undefined;
		held?.release();
	}

	function want(): void {
		if (held || waiting || !deps.visible() || !deps.locks) return;
		const queue = new AbortController();
		waiting = queue;
		deps.locks
			.request(LIVE_LOCK, { signal: queue.signal }, () => hold(queue))
			.catch(() => undefined)
			.finally(() => {
				if (waiting === queue) waiting = undefined;
			});
	}

	async function hold(queue: AbortController): Promise<void> {
		if (waiting === queue) waiting = undefined;
		if (queue.signal.aborted) return;
		const state = await deps.state().catch(() => undefined);
		if (!state?.live || !deps.visible()) return;
		// adaptive: wait for the worker to ask; a visible session starts its renewal count at zero
		if (state.live.mode === 'adaptive' && !armed) {
			void deps.send({ partition: null, event: 'session' });
			return;
		}
		const { partition, have } = state;
		// a worker that kept a partition the server called revoked would loop here
		if (partition !== revoked) revoked = null;
		if (partition === null ? !state.live.public : partition === revoked) return;
		await new Promise<void>((done) => {
			const query = [
				...(partition === null ? [] : [`partition=${encodeURIComponent(partition)}`]),
				...(have === null ? [] : [`have=${have}`])
			].join('&');
			const source = deps.open(
				`${LIVE_PATH}${query ? `?${query}` : ''}`,
				state.live?.socket === true
			);
			let again = false;
			const release = () => {
				source.close();
				held = undefined;
				done();
				if (again) want();
			};
			const reopen = () => {
				again = true;
				release();
			};
			held = { release, reopen };
			source.addEventListener('delta', (event) => {
				const delta = read(event.data, parseLiveDelta);
				if (!delta) return;
				// a gap means a change went by unseen: connect again and catch up
				void deps.send({ partition, event: 'delta', delta }).then((ack) => {
					if (ack && !ack.ok) reopen();
				});
			});
			source.addEventListener('lease', (event) => {
				const leaseMs = read(event.data, (v) => (v as { leaseMs?: unknown }).leaseMs);
				if (typeof leaseMs === 'number')
					void deps.send({ partition, event: 'lease', leaseMs });
			});
			source.addEventListener('revoked', () => {
				revoked = partition;
				void deps.send({ partition, event: 'revoked' }).finally(reopen);
			});
			// the browser reconnects on its own until it gives up; once it has, the renewals take over
			source.addEventListener('error', () => {
				if (source.readyState === CLOSED) release();
			});
		});
	}

	function leave(): void {
		armed = false;
		drop();
	}

	deps.onVisibility(() => (deps.visible() ? want() : leave()));
	deps.onPageHide(leave);
	want();
	return {
		reconcile: () => (held ? held.reopen() : want()),
		arm() {
			armed = true;
			want();
		}
	};
}

/** the part of `WebSocket` {@link socketSource} uses */
export type SocketWire = {
	readonly readyState: number;
	addEventListener(name: string, listener: (event: { data: unknown }) => void): void;
	send(text: string): void;
	close(): void;
};

/** how {@link socketSource} makes its transports; `events` is the SSE fallback */
export type SocketMakers = {
	socket(url: string): SocketWire;
	events(url: string): StreamSource;
};

/** milliseconds between pings; each is answered with a `lease` frame and doubles as the keepalive */
const PING_MS = 25_000;
/** how long after the server closes an open socket the page connects again, as `EventSource` does */
const RETRY_MS = 3000;

/**
 * A {@link StreamSource} over a WebSocket. Each message is one SSE frame in text form, so the
 * listeners see what an `EventSource` would give them. The page sends `ping` every 25 seconds and
 * the server answers with a `lease` frame. A socket the server closes after it opened is opened
 * again after three seconds. If the upgrade fails before the socket opens, the same URL opens as
 * SSE and stays SSE, which keeps a site served by a hub without sockets working.
 */
export function socketSource(url: string, make: SocketMakers): StreamSource {
	const listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
	let wire: SocketWire | undefined;
	let fallback: StreamSource | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	function connect(): void {
		const own = make.socket(url);
		wire = own;
		let opened = false;
		own.addEventListener('open', () => {
			opened = true;
			ping = setInterval(() => own.send(LIVE_PING), PING_MS);
		});
		own.addEventListener('message', (event) => {
			if (typeof event.data !== 'string') return;
			const name = /^event: (.*)$/m.exec(event.data)?.[1];
			const data = /^data: (.*)$/m.exec(event.data)?.[1];
			if (name === undefined || data === undefined) return;
			for (const fn of listeners.get(name) ?? []) fn({ data } as MessageEvent<string>);
		});
		own.addEventListener('close', () => {
			clearInterval(ping);
			if (closed || wire !== own) return;
			if (!opened) return fall();
			retry = setTimeout(connect, RETRY_MS);
		});
	}

	function fall(): void {
		wire = undefined;
		fallback = make.events(url);
		for (const [name, fns] of listeners)
			for (const fn of fns) fallback.addEventListener(name, fn);
	}

	connect();
	return {
		get readyState() {
			if (fallback) return fallback.readyState;
			if (closed) return CLOSED;
			return wire?.readyState === 1 ? 1 : 0;
		},
		addEventListener(name, listener) {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			fallback?.addEventListener(name, listener);
		},
		close() {
			closed = true;
			clearTimeout(retry);
			clearInterval(ping);
			wire?.close();
			fallback?.close();
		}
	};
}

/** the live deps for a page with a worker; `client` is what `register()` returned */
export function browserLiveDeps(client: {
	liveState(): Promise<LiveState>;
	liveEvent(message: LiveMessage): Promise<LiveAck | undefined>;
}): LiveDeps | null {
	if (typeof EventSource === 'undefined') return null;
	return {
		state: () => client.liveState(),
		send: (message) => client.liveEvent(message),
		visible: () => document.visibilityState === 'visible',
		onVisibility: (fn) => {
			document.addEventListener('visibilitychange', fn);
			addEventListener('pageshow', fn);
		},
		onPageHide: (fn) => addEventListener('pagehide', fn),
		locks: navigator.locks,
		open: (url, socket) =>
			socket && typeof WebSocket !== 'undefined'
				? socketSource(url, {
						socket: (path) => {
							const target = new URL(path, location.href);
							target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
							return new WebSocket(target) as unknown as SocketWire;
						},
						events: (path) => new EventSource(path) as unknown as StreamSource
					})
				: (new EventSource(url) as unknown as StreamSource)
	};
}
