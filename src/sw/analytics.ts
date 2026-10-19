import { PROTOCOL_VERSION } from '../protocol/artifact.js';
import {
	DROPPED_PATH,
	MAX_BEACON_BYTES,
	OWN_PREFIX,
	type BeaconBatch,
	type BeaconEvent,
	type CatalogueAsk
} from '../protocol/beacon.js';
import type { CollectorConfig } from '../protocol/collector.js';
import { LOADS_PATH, VIEW_PATH } from '../protocol/view.js';
import type { FlushState, ReplicaStorage } from './storage.js';

/** a held request older than this goes out on its own flush, at most once per such window */
export const MAX_HOLD_MS = 24 * 60 * 60 * 1000;

const CHECK_EVERY_MS = 60 * 60 * 1000;

/** views alone wait for this many to be held before a network moment sends them */
export const VIEW_BATCH = 20;

/** or until the oldest has been held this long */
export const VIEW_HOLD_MS = 60 * 60 * 1000;

/** a page's catalogue is asked for again after this long; the record survives a worker restart */
export const CATALOGUE_REASK_MS = 24 * 60 * 60 * 1000;

/** page paths whose last catalogue ask is kept */
export const MAX_CATALOGUE_ASKED = 256;

/** most events one request carries, so a long offline stretch never builds a body the server refuses */
export const FLUSH_CHUNK = 100;

/** how long a logout waits for the held same-origin requests to go out before it drops them */
export const LOGOUT_SEND_MS = 3000;

/** the vendor name a dropped same-origin request is counted under */
export const SAME_ORIGIN_VENDOR = 'same-origin';

export { MAX_BEACON_BYTES };

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const encoder = new TextEncoder();

/** whether the flush to `/.spool/beacon` carries the event; the rest the worker replays itself */
const inBatch = (event: BeaconEvent) =>
	event.path.startsWith(OWN_PREFIX) || event.deliver === 'sink';

/** what the queue needs from the outside world */
export type QueueDeps = {
	storage: ReplicaStorage;
	now(): number;
	/** posts a batch; true when the server took it or refused it for good, false to retry later */
	send(batch: BeaconBatch): Promise<boolean>;
	/**
	 * sends one held request to the URL it was meant for; true when it was delivered or refused for
	 * good, false to retry later
	 */
	replay(event: BeaconEvent): Promise<boolean>;
	/** artifact paths to ask for with the next flush; sent once, with the first batch */
	want?(): string[] | Promise<string[]>;
	/**
	 * the catalogue to ask for, sent with the first batch of a flush unless that path was asked
	 * within {@link CATALOGUE_REASK_MS}. A due ask makes {@link BeaconQueue.flushAtMoment} flush
	 * and nothing else does, so it adds no request on a local view or with nothing held
	 */
	catalogue?(): CatalogueAsk | undefined;
};

/**
 * Holds beacon requests on the device. A beacon that reaches the network on its own wakes the
 * radio, so the queue waits for a request that is happening anyway and leaves with it. Spool's
 * own events travel in one batch to `/.spool/beacon`; a site's beacon is replayed to the URL it was
 * meant for, with its method, content type and body, so the vendor receives what the page sent. An
 * event past its age cap is dropped and counted, never sent late.
 */
export class BeaconQueue {
	readonly #deps: QueueDeps;
	#flushing: Promise<boolean> | null = null;
	#state: FlushState | undefined;
	/** events dropped past their age cap since the worker started, by vendor */
	readonly dropped = new Map<string, number>();

	constructor(deps: QueueDeps) {
		this.#deps = deps;
	}

	/** queues an event the worker made itself, such as a view */
	async record(event: BeaconEvent): Promise<void> {
		await this.#deps.storage.addBeacon(event);
	}

	/**
	 * queues a beacon; false when it is binary or too large and should go to the network. A request
	 * to another origin passes the `collector` that matched it.
	 */
	async enqueue(request: Request, collector?: CollectorConfig): Promise<boolean> {
		const get = request.method === 'GET';
		const contentType = get ? '' : (request.headers.get('content-type') ?? 'text/plain');
		if (/octet-stream|multipart|image\//i.test(contentType)) return false;
		const body = get ? '' : await request.clone().text();
		if (encoder.encode(body).length > MAX_BEACON_BYTES) return false;
		const url = new URL(request.url);
		const at = this.#deps.now();
		const event: BeaconEvent = { path: url.pathname, body, contentType, at };
		if (url.search !== '') event.search = url.search;
		if (get) event.method = 'GET';
		if (collector) {
			event.origin = url.origin;
			event.vendor = collector.vendor;
			event.until = at + collector.maxAgeMs;
			if (collector.delivery === 'sink') event.deliver = 'sink';
		}
		await this.#deps.storage.addBeacon(event);
		return true;
	}

	/** sends everything held in one request, or joins the flush already running */
	flush(): Promise<boolean> {
		this.#flushing ??= this.#run().finally(() => {
			this.#flushing = null;
		});
		return this.#flushing;
	}

	/**
	 * Flushes at a network moment when it is worth a request: another site's beacon is held,
	 * artifacts are wanted, a catalogue ask is due, {@link VIEW_BATCH} views are held (their loads
	 * reports ride along), or the oldest has waited {@link VIEW_HOLD_MS}. A few views alone keep
	 * waiting for a later moment. With nothing held there is nothing to carry the ask, so no flush.
	 */
	async flushAtMoment(): Promise<boolean> {
		await this.#expire();
		const held = await this.#deps.storage.readBeacons();
		if (held.length === 0) return false;
		const own = (path: string) =>
			path === VIEW_PATH || path === LOADS_PATH || path === DROPPED_PATH;
		const others = held.some((b) => !own(b.event.path));
		const views = held.filter((b) => b.event.path === VIEW_PATH).length;
		const wanted = ((await this.#deps.want?.()) ?? []).length > 0;
		const asking = (await this.#due(this.#deps.catalogue?.())) !== undefined;
		const oldest = Math.min(...held.map((b) => b.event.at));
		const aged = this.#deps.now() - oldest >= VIEW_HOLD_MS;
		if (others || wanted || asking || aged || views >= VIEW_BATCH) return this.flush();
		return false;
	}

	/**
	 * Flushes on its own when the oldest held beacon is past {@link MAX_HOLD_MS}; looks hourly and
	 * at most once per such window. Both clocks are stored, so a worker restart does not reset them.
	 */
	async flushIfDue(): Promise<boolean> {
		const now = this.#deps.now();
		const state = await this.#read();
		// a stored time ahead of the clock cannot be trusted, so it counts as never
		const checked = state.checkedAt > now ? -Infinity : state.checkedAt;
		if (now - checked < CHECK_EVERY_MS) return false;
		state.checkedAt = now;
		await this.#write(state);
		await this.#expire();
		const held = await this.#deps.storage.readBeacons();
		const oldest = Math.min(...held.map((b) => b.event.at));
		if (held.length === 0 || now - oldest < MAX_HOLD_MS) return false;
		const last = state.lastStandalone > now ? -Infinity : state.lastStandalone;
		if (now - last < MAX_HOLD_MS) return false;
		state.lastStandalone = now;
		await this.#write(state);
		return this.flush();
	}

	async #read(): Promise<FlushState> {
		this.#state ??= (await this.#deps.storage.getFlush()) ?? {
			lastStandalone: -Infinity,
			checkedAt: -Infinity
		};
		return this.#state;
	}

	async #write(state: FlushState): Promise<void> {
		await this.#deps.storage.setFlush(state);
	}

	/** removes the events past their cap and queues one `dropped` record per vendor */
	async #expire(): Promise<void> {
		const { storage, now } = this.#deps;
		const at = now();
		const held = await storage.readBeacons();
		const late = held.filter((b) => b.event.until !== undefined && b.event.until < at);
		if (late.length === 0) return;
		await storage.removeBeacons(late.map((b) => b.key));
		await this.#report(late.map(({ event }) => event.vendor ?? 'unknown'));
	}

	/** counts dropped events by vendor and queues one `dropped` record per vendor */
	async #report(vendors: readonly string[]): Promise<void> {
		const counts = new Map<string, number>();
		for (const vendor of vendors) counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
		for (const [vendor, count] of counts) {
			this.dropped.set(vendor, (this.dropped.get(vendor) ?? 0) + count);
			await this.#deps.storage.addBeacon({
				path: DROPPED_PATH,
				body: JSON.stringify({ vendor, count }),
				contentType: 'application/json',
				at: this.#deps.now()
			});
		}
	}

	/**
	 * Sends the held same-origin requests now and drops whatever does not get through, counted under
	 * {@link SAME_ORIGIN_VENDOR}. A replay carries the browser's cookies, so after a logout it would
	 * be attributed to whoever signs in next. Run it while the session that made them is still the
	 * browser's. A request that fails, or a network that is down, loses the event for good.
	 */
	async sendSameOrigin(timeoutMs: number): Promise<void> {
		if (this.#flushing) await this.#flushing.catch(() => false);
		const { storage, replay } = this.#deps;
		const mine = (await storage.readBeacons()).filter(
			({ event }) => !inBatch(event) && event.origin === undefined
		);
		if (mine.length === 0) return;
		await storage.removeBeacons(mine.map((b) => b.key));
		let down = false;
		const lost: string[] = [];
		for (const { event } of mine) {
			let delivered = false;
			if (!down) {
				try {
					delivered = await within(replay(event), timeoutMs);
				} catch {
					down = true;
				}
			}
			if (!delivered) lost.push(SAME_ORIGIN_VENDOR);
		}
		await this.#report(lost);
	}

	async #run(): Promise<boolean> {
		const { storage, send, replay, want, catalogue } = this.#deps;
		await this.#expire();
		const held = await storage.readBeacons();
		if (held.length === 0) return false;
		let ok = true;
		for (const b of held.filter((h) => !inBatch(h.event))) {
			let delivered: boolean;
			try {
				delivered = await replay(b.event);
			} catch {
				delivered = false;
			}
			if (delivered) await storage.removeBeacons([b.key]);
			else ok = false;
		}
		const batched = held.filter((h) => inBatch(h.event));
		let wanted = (await want?.()) ?? [];
		let ask = await this.#due(catalogue?.());
		if (batched.length === 0 && wanted.length === 0) return ok;
		let done = true;
		for (let at = 0; at < Math.max(batched.length, 1); at += FLUSH_CHUNK) {
			const chunk = batched.slice(at, at + FLUSH_CHUNK);
			const batch: BeaconBatch = {
				protocol: PROTOCOL_VERSION,
				events: chunk.map(({ event: { until: _until, ...event } }) => event)
			};
			if (wanted.length > 0) batch.want = wanted;
			if (ask) batch.catalogue = ask;
			wanted = [];
			ask = undefined;
			try {
				done = await send(batch);
			} catch {
				done = false;
			}
			if (!done) return false;
			await storage.removeBeacons(chunk.map((b) => b.key));
			if (batch.catalogue) await this.#asked(batch.catalogue.path);
		}
		return ok && done;
	}

	/** `ask` unless its path was asked within {@link CATALOGUE_REASK_MS} */
	async #due(ask: CatalogueAsk | undefined): Promise<CatalogueAsk | undefined> {
		if (!ask) return undefined;
		const at = (await this.#read()).catalogue?.[ask.path];
		const now = this.#deps.now();
		// a stored time ahead of the clock cannot be trusted, so it counts as never
		return at === undefined || at > now || now - at >= CATALOGUE_REASK_MS ? ask : undefined;
	}

	/** stores when `path` was asked, keeping the latest {@link MAX_CATALOGUE_ASKED} paths */
	async #asked(path: string): Promise<void> {
		const state = await this.#read();
		const asked = { ...state.catalogue };
		delete asked[path];
		asked[path] = this.#deps.now();
		const paths = Object.keys(asked);
		for (const old of paths.slice(0, paths.length - MAX_CATALOGUE_ASKED)) delete asked[old];
		state.catalogue = asked;
		await this.#write(state);
	}
}
