import { DurableObject } from 'cloudflare:workers';
import type { LiveDelta } from '../protocol/envelope.js';
import type { VectorDiff } from '../protocol/vector.js';
import {
	decodeOpen,
	encodeOpen,
	hibernatingSockets,
	SOCKET_OPEN_HEADER
} from '../server/live-sockets.js';
import { memoryHub, type LiveHub, type LiveOpen, type LiveStats } from '../server/live.js';
import type { VersionStore } from './version-store.js';

/**
 * The version vector in a SQLite-backed Durable Object: one row per tag and one cursor row, so it
 * survives eviction and restarts. Bind it as a Durable Object class and pass the namespace to
 * {@link durableObjectStore}.
 */
export class SpoolVersions extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(
			'CREATE TABLE IF NOT EXISTS spool_tags (tag TEXT PRIMARY KEY, version INTEGER NOT NULL) WITHOUT ROWID'
		);
		sql.exec(
			'CREATE TABLE IF NOT EXISTS spool_meta (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL)'
		);
		sql.exec('INSERT OR IGNORE INTO spool_meta (id, cursor) VALUES (0, 0)');
	}

	/** records a change to `tags` and returns the new cursor */
	bump(tags: string[]): number {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() => {
			const cursor = this.cursor();
			if (tags.length === 0) return cursor;
			const next = cursor + 1;
			for (const tag of new Set(tags)) {
				sql.exec(
					'INSERT INTO spool_tags (tag, version) VALUES (?, ?) ON CONFLICT (tag) DO UPDATE SET version = excluded.version',
					tag,
					next
				);
			}
			sql.exec('UPDATE spool_meta SET cursor = ? WHERE id = 0', next);
			return next;
		});
	}

	/** the cursor of the most recent bump */
	cursor(): number {
		return Number(
			this.ctx.storage.sql.exec('SELECT cursor FROM spool_meta WHERE id = 0').one()['cursor']
		);
	}

	/** every tag changed after `from`; see `VersionVector.diff` */
	diff(from: number): VectorDiff {
		const cursor = this.cursor();
		const reset = from > cursor;
		const rows = this.ctx.storage.sql
			.exec('SELECT tag, version FROM spool_tags WHERE version > ?', reset ? 0 : from)
			.toArray();
		const changed = Object.fromEntries(
			rows.map((r) => [String(r['tag']), Number(r['version'])])
		);
		return { cursor, changed, reset };
	}
}

/** a {@link VersionStore} over one named instance of the {@link SpoolVersions} namespace */
export function durableObjectStore(
	namespace: DurableObjectNamespace<SpoolVersions>,
	name = 'spool'
): VersionStore {
	const stub = () => namespace.getByName(name);
	return {
		bump: (tags) => stub().bump([...tags]),
		cursor: () => stub().cursor(),
		diff: (from) => stub().diff(from)
	};
}

/**
 * The live streams of every isolate, held by one Durable Object: a page's `/.spool/live` request
 * is forwarded here and its response is the stream, so a bump or a revocation from any isolate
 * reaches every open page. The object stays in memory while a stream is open and is billed for
 * that duration. One instance serves every stream of a site, which is its ceiling. Bind it as a
 * Durable Object class and pass the namespace to {@link durableObjectHub}.
 *
 * A WebSocket upgrade is accepted with the Hibernation API when the hub sets `hibernate`. Those
 * sockets hold no timer, so while no SSE stream is open the object hibernates between a publish, a
 * revoke, a maximum-age alarm and a message that is not a ping.
 */
export class SpoolLive extends DurableObject {
	readonly #hub = memoryHub();
	readonly #sockets = hibernatingSockets({
		pair: () => {
			const pair = new WebSocketPair();
			return [pair[0], pair[1]];
		},
		accept: (server, tags) => this.ctx.acceptWebSocket(server as WebSocket, tags),
		sockets: (tag) => this.ctx.getWebSockets(tag),
		autoResponse: (request, response) =>
			this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(request, response)),
		alarm: {
			get: () => this.ctx.storage.getAlarm(),
			set: (at) => this.ctx.storage.setAlarm(at)
		}
	});

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.#sockets.restore();
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
			const init = decodeOpen(request.headers.get(SOCKET_OPEN_HEADER));
			if (!init) return new Response('bad opening request', { status: 400 });
			const client = (await this.#sockets.open(init)) as WebSocket;
			return new Response(null, { status: 101, webSocket: client });
		}
		const init = (await request.json()) as Omit<LiveOpen, 'signal' | 'valid'>;
		return this.#hub.open({ ...init, signal: request.signal });
	}

	/** sends a delta to every open stream and socket */
	publish(delta: LiveDelta): void {
		this.#hub.publish(delta);
		this.#sockets.publish(delta);
	}

	/** sends `revoked` to every stream and socket of `partition` and closes them */
	revoke(partition: string): void {
		this.#hub.revoke(partition);
		this.#sockets.revoke(partition);
	}

	override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		this.#sockets.message(ws, message);
	}

	override webSocketClose(ws: WebSocket, code: number): void {
		// older compatibility dates need the reply; a newer runtime has sent it and ignores this
		try {
			if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code))
				ws.close(code);
			else ws.close();
		} catch {
			// already closed
		}
	}

	override webSocketError(ws: WebSocket): void {
		try {
			ws.close(1011, 'error');
		} catch {
			// already closed
		}
	}

	override async alarm(): Promise<void> {
		await this.#sockets.alarm();
	}

	/** what this object has counted since it started */
	stats(): LiveStats {
		return this.#hub.stats();
	}
}

/** the options of {@link durableObjectHub} */
export type DurableObjectHubOptions = {
	/** which instance of the namespace holds the streams; default `spool` */
	name?: string;
	/**
	 * Accept a page's WebSocket upgrade with the Hibernation API instead of holding an SSE response.
	 * The site's config then tells pages to open a socket, and a page whose upgrade fails falls back
	 * to SSE. Default false.
	 */
	hibernate?: boolean;
};

/**
 * A {@link LiveHub} over one named instance of the {@link SpoolLive} namespace. The hub cannot
 * call back into the app, so a session the app ends is revoked with `spool.revoke`, and one it
 * forgets to revoke is cut off when its stream reaches `maxAge`. The second argument is the
 * instance name or {@link DurableObjectHubOptions}.
 */
export function durableObjectHub(
	namespace: DurableObjectNamespace<SpoolLive>,
	options: string | DurableObjectHubOptions = {}
): LiveHub {
	const { name = 'spool', hibernate = false } =
		typeof options === 'string' ? { name: options } : options;
	const stub = () => namespace.getByName(name);
	return {
		sockets: hibernate,
		open: (init) => {
			if (hibernate && init.socket) {
				const header = encodeOpen(init);
				if (header === null)
					return new Response('opening frames too large', { status: 413 });
				return stub().fetch(
					new Request('https://spool.live/socket', {
						headers: { upgrade: 'websocket', [SOCKET_OPEN_HEADER]: header }
					})
				);
			}
			const { partition, first, leaseMs, keepaliveMs, maxAgeMs } = init;
			return stub().fetch(
				new Request('https://spool.live/open', {
					method: 'POST',
					body: JSON.stringify({ partition, first, leaseMs, keepaliveMs, maxAgeMs })
				})
			);
		},
		publish: (delta) => stub().publish(delta),
		revoke: (partition) => stub().revoke(partition)
	};
}
