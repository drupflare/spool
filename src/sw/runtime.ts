import { parseArtifact, PROTOCOL_VERSION, type Artifact } from '../protocol/artifact.js';
import { MAX_WANT, type BeaconEvent, type CatalogueAsk } from '../protocol/beacon.js';
import type { BundleDelta } from '../protocol/bundle.js';
import { applyStamp, type CollectorConfig } from '../protocol/collector.js';
import {
	BUNDLE_DELTA_PREFIX,
	clientPath,
	PATHS,
	type AssetMode,
	type StubPack,
	type SwConfig
} from '../protocol/config.js';
import {
	decodeEnvelope,
	decodeEnvelopeOrClear,
	HEADERS,
	parseLiveDelta,
	type Envelope,
	type EnvelopeArtifact,
	type LiveDelta
} from '../protocol/envelope.js';
import { shellHash } from '../protocol/hash.js';
import { readInline } from '../protocol/inline.js';
import { manifestRoutes, parseManifest } from '../protocol/manifest.js';
import { PROOF_MISMATCH } from '../protocol/query.js';
import { matchRoute, type Retention, type SerializedRoute } from '../protocol/route.js';
import { encodeHeld, parseSyncResponse, type SyncResponse } from '../protocol/sync.js';
import {
	engineOf,
	FROM_EXTERNAL,
	loadsToBeacon,
	REASON_TIER,
	viewToBeacon,
	type ViewEvent,
	type ViewReason
} from '../protocol/view.js';
import {
	ifMatch,
	WRITE_HEADERS,
	writeFor,
	type ResourceWrite,
	type WriteFlush,
	type WriteQueued,
	type WriteRefusal,
	type WriteResolved,
	type WriteStatus
} from '../protocol/write.js';
import { BeaconQueue, LOGOUT_SEND_MS } from './analytics.js';
import { collectorAnswer } from './collect.js';
import {
	principalGuard,
	syncDataset,
	type DatasetOutcome,
	type DatasetRefusal
} from './dataset-sync.js';
import { collectionPage, familyPage } from './family.js';
import { verdict, type Verdict } from './freshness.js';
import { createPackStore, type PackStore } from './pack/store.js';
import type { PartitionHost } from './partition.js';
import { allowedPolicy, policyHeaders, type HeaderSet } from './policy.js';
import { probeCache, resourceTiming, shouldForward, type CacheProbe } from './probe.js';
import {
	Ledger,
	plan,
	priorFrom,
	type LedgerEntry,
	type LedgerTotals,
	type Opportunity
} from './provision.js';
import { renderLocal, type Renderers } from './render.js';
import { Replica } from './replica.js';
import { classify } from './router.js';
import { installRoutes, type RoutableInstall } from './routing.js';
import { Scheduler } from './scheduler.js';
import { differs, modeFor, runsShadow } from './shadow.js';
import {
	branch,
	matchesVersion,
	MAX_STATIC_BYTES,
	readCapped,
	replayHeaders,
	STATIC_CACHE
} from './static.js';
import type { DatasetMeta, ReplicaStorage } from './storage.js';
import { THIRD_CACHE, THIRD_HEADERS, versionClass, type VersionClass } from './thirdparty.js';
import { settleWrite, WriteQueue, type WriteRecord, type WriteTimers } from './write.js';

/** the slice of a `Cache` the runtime uses */
export type CacheLike = {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
	keys(): Promise<readonly Request[]>;
	delete(request: Request): Promise<boolean>;
};

/** the slice of `CacheStorage` the runtime uses */
export type CachesLike = {
	open(name: string): Promise<CacheLike>;
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
};

/** everything the runtime touches outside itself, injected so a test can drive it */
export type RuntimeDeps = {
	config: SwConfig;
	storage: ReplicaStorage;
	/**
	 * the pack store family routes read their rows from and a served pack is adopted into; default the
	 * browser's IndexedDB, and none where there is none, so family routes go to the network
	 */
	pack?: PackStore;
	fetch(input: Request | string, init?: RequestInit): Promise<Response>;
	caches: CachesLike;
	/** the worker's own origin */
	origin: string;
	now?: () => number;
	renderers?: Renderers;
	/** a number in [0, 1) for the shadow sample; default `Math.random` */
	random?: () => number;
	/** the browser's user agent, which names the engine in view events; default `navigator.userAgent` */
	userAgent?: string;
	/**
	 * where principal routes keep their sealed stores; without it the worker sends every principal
	 * route to the network and keeps nothing for them
	 */
	partitions?: PartitionHost;
	/** tells every page of the origin something, such as that a wipe happened */
	broadcast?(message: unknown): void;
	/** the storage the origin may use and has used; default `navigator.storage.estimate` */
	estimate?(): Promise<{ quota?: number; usage?: number }>;
	/** the timers the declared-write deadlines run on; default the global timers */
	timers?: WriteTimers;
	/** how long the second lease renewal waits for a page to open the stream before it renews; default 3000 */
	liveWaitMs?: number;
};

/** the worker's answer to a page's `spool:hello` */
export type Hello = {
	type: 'spool:hello';
	protocol: number;
	version: string;
	compatible: boolean;
	/** seconds the browser holds the worker script; absent from a worker built before the lease */
	lease?: number;
	/** epoch milliseconds of the worker's last server answer; absent until it has one */
	contact?: number;
};

/** the worker's answer to `spool:status` */
export type Status = {
	type: 'spool:status';
	cursor: number | null;
	syncedAt: number;
	artifacts: string[];
	/** beacons held for the next flush */
	beacons: number;
};

/** the worker's answer to `spool:view`: the id of the latest view of a path, for the page's report */
export type ViewId = { type: 'spool:view'; id: string | null };

/** the worker's answer to `spool:graph`: what it holds in records and projections */
export type GraphStatus = { type: 'spool:graph'; records: string[]; projections: string[] };

/** the worker's answer to `spool:ledger`: bytes and requests spent provisioning, against views served */
export type LedgerStatus = {
	type: 'spool:ledger';
	entries: LedgerEntry[];
	totals: LedgerTotals;
};

/** the worker's answer to `spool:partition`: the principal store in use and what it holds */
export type PartitionStatus = {
	type: 'spool:partition';
	partition: string | null;
	artifacts: string[];
	records: string[];
	projections: string[];
	/** the principal datasets held for this partition; always empty while the flag is off */
	datasets: DatasetMeta[];
};

/**
 * the worker's answer to `spool:live-state`: the site's stream setting (null when it has none), the
 * partition held and the lowest cursor a side holds, which a stream starts its catch-up from
 */
export type LiveState = {
	type: 'spool:live-state';
	live: NonNullable<SwConfig['live']> | null;
	partition: string | null;
	have: number | null;
};

/** what a page tells the worker it read from its stream; `partition` is the one the stream was opened for */
export type LiveMessage = { partition: string | null } & (
	| { event: 'delta'; delta: LiveDelta }
	| { event: 'lease'; leaseMs: number }
	| { event: 'revoked' }
	/** a visible session began: the worker counts lease renewals from zero */
	| { event: 'session' }
);

/** the worker's answer to `spool:live`: false when a delta did not follow the cursor the worker holds, so the page connects again */
export type LiveAck = { type: 'spool:live'; ok: boolean };

/** the worker's answer to `spool:assets`: the mode asked for and whether Static Routing took effect */
export type AssetsStatus = { type: 'spool:assets'; mode: AssetMode; routed: boolean };

/** the worker's answer to `spool:held`: events dropped past a vendor's cap, and the third-party files held */
export type HeldStatus = {
	type: 'spool:held';
	dropped: Record<string, number>;
	third: string[];
};

/**
 * the worker's answer to `spool:datasets`: what it holds, how each sync ended (counts by
 * `<name>:<status>` or `<name>:refused:<reason>`), the datasets it will not retry this run, the
 * datasets it found damaged and cleared, and whether a page was granted persistent storage
 */
export type DatasetStatus = {
	type: 'spool:datasets';
	datasets: DatasetMeta[];
	outcomes: Record<string, number>;
	refused: Record<string, DatasetRefusal>;
	evicted: number;
	persisted: boolean | null;
};

/** the worker's answer to `spool:write`, `spool:flush`, `spool:writes` and `spool:resolve` */
export type WriteReply =
	| { type: 'spool:write'; result: WriteQueued | WriteRefusal }
	| { type: 'spool:flush'; result: ({ ok: true } & WriteFlush) | WriteRefusal }
	| { type: 'spool:writes'; result: { ok: true; writes: WriteStatus[] } | WriteRefusal }
	| { type: 'spool:resolve'; result: WriteResolved | WriteRefusal };

/** every reply the worker gives a page */
export type Reply =
	| WriteReply
	| Hello
	| Status
	| ViewId
	| DatasetStatus
	| GraphStatus
	| LedgerStatus
	| PartitionStatus
	| LiveState
	| LiveAck
	| AssetsStatus
	| HeldStatus;

/** the object `serve` wires to service worker events */
export type Runtime = {
	/** a response promise for a request the worker handles, `undefined` for one it leaves alone */
	handle(
		request: Request,
		wait: (promise: Promise<unknown>) => void
	): Promise<Response> | undefined;
	/** run on install: asks for Static Routing when the config does and the browser has it */
	install(event: RoutableInstall): Promise<void>;
	/** run on activation: loads the replica and drops asset caches from older versions */
	activate(): Promise<void>;
	/** answers a page message, or `undefined` for one that is not spool's */
	message(data: unknown): Promise<Reply | undefined>;
	readonly replica: Replica;
	readonly ledger: Ledger;
};

/** the strategies a catalogue entry may have: data for a template or renderer the device holds */
const ENTRY_STRATEGIES: readonly string[] = ['template', 'projection', 'data'];

const ASSET_CACHE = 'spool-assets-';
const CACHE_PREFIXES = [ASSET_CACHE, STATIC_CACHE];
const YEAR = 31_536_000;
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

/** a static file's key is its pathname plus query string; this is the pathname a route matches */
const pathOf = (key: string) => key.split('?', 1)[0] as string;

/** a data route answered from held rows: an item family, or a collection of a cross-origin API */
const isDataFamily = (route: SerializedRoute) =>
	route.strategy === 'data' && (route.family !== undefined || route.origin !== undefined);

function immutable(response: Response): boolean {
	const control = response.headers.get('cache-control') ?? '';
	if (/(?:^|,)\s*immutable\b/i.test(control)) return true;
	const age = /max-age=(\d+)/i.exec(control);
	return age !== null && Number(age[1]) >= YEAR;
}

/** what the worker decided for one navigation, before it acts on it */
type Decision = {
	reason: ViewReason;
	/** the local page, or the JSON text of a data route, when the worker could show one */
	html?: string;
	/** the site's security headers to answer `html` with */
	headers?: HeaderSet;
	/** the stored file of a static route, when the worker could show it */
	response?: Response;
	staleSec: number | null;
};

/** one replica with the scheduler that syncs it; the public one and the one of the current partition */
type Side = {
	/** the partition id; null for the public side */
	id: string | null;
	replica: Replica;
	scheduler: Scheduler;
	deferred: Set<string>;
	loaded: Promise<void>;
	/** the declared-writes queue of this partition, made on first use */
	writes?: WriteQueue;
	/** set when the side is replaced or wiped; a sync that began under it discards its result */
	dead: boolean;
	/** a live stream has delivered every tag change since this side's cursor, so held pages are current */
	covered: boolean;
	/** the time, in this worker's clock, until which the stream's lease holds; 0 when none is open */
	leaseUntil: number;
};

/** builds the request pipeline: local render, sync, provisioning, asset cache and beacon queue */
export function createRuntime(deps: RuntimeDeps): Runtime {
	const { config, storage, origin, renderers } = deps;
	const host = deps.partitions;
	const now = deps.now ?? Date.now;
	const random = deps.random ?? Math.random;
	const engine = engineOf(
		deps.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
	);
	const prior = priorFrom(config.provision);
	const pack = deps.pack ?? (typeof indexedDB === 'undefined' ? undefined : createPackStore());
	// only a new runtime empties what the device holds; a new content version keeps it
	const codeVersion = config.runtime ?? config.version;
	const replica = new Replica(storage, codeVersion, now);
	const ledger = new Ledger();
	const background = new Set<Promise<unknown>>();
	const provisioning = new Map<string, Promise<void>>();
	const declined = new Map<string, string | null>();
	// a 404 or a decline holds for the version it came back at
	const unavailable = new Map<string, number>();
	const wants = new Set<string>();
	const asked = new Set<string>();
	let currentPath: string | null = null;
	const latestView = new Map<string, string>();
	const assetCache = `${ASSET_CACHE}${codeVersion}`;
	const staticCache = `${STATIC_CACHE}${codeVersion}`;
	const keyOf = (path: string) => new Request(`${origin}${path}`);
	const startedAt = now();
	const assetMode: AssetMode = config.assets ?? 'cache';
	let routed = false;
	let lastViewAt: number | null = null;
	let lifetimes: number | undefined;
	let loaded: Promise<void> | undefined;
	let manifestLoad: Promise<void> | undefined;
	let partitionLoad: Promise<void> | undefined;
	let principal: Side | null = null;
	let exclusive: Promise<unknown> = Promise.resolve();
	const observing = config.mode === 'shadow';
	// unanswered subresources are forwarded only after the probe finds the disk cache
	const forwardsAssets = assetMode !== 'cache' && !observing;
	let cachePath: CacheProbe | undefined;
	let probed = false;
	const manifestPending = () => config.manifest !== undefined && config.routes.length === 0;

	const handles = new Map<string, Promise<CacheLike>>();
	/** opens a cache once and keeps the handle, so a hot request does not reopen it */
	const cacheNamed = (name: string): Promise<CacheLike> => {
		let handle = handles.get(name);
		if (!handle) {
			handle = deps.caches.open(name);
			handles.set(name, handle);
			handle.catch(() => handles.delete(name));
		}
		return handle;
	};

	const ready = async () => {
		await (loaded ??= replica.load());
		if (manifestPending()) await (manifestLoad ??= loadManifest());
		if (host) await (partitionLoad ??= loadPartition());
	};

	const track = (promise: Promise<unknown>) => {
		const settled = promise.then(
			() => undefined,
			() => undefined
		);
		background.add(settled);
		void settled.then(() => background.delete(settled));
	};

	// only work begun after `before` is waited for, not an earlier request's held body
	const settleBackground = async (before: Set<Promise<unknown>>) => {
		const fresh = () => [...background].filter((p) => !before.has(p));
		while (fresh().length > 0) await Promise.allSettled(fresh());
	};

	/** runs `fn` after every earlier partition change, so two responses never swap the store at once */
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = exclusive.then(fn, fn);
		exclusive = run.catch(() => undefined);
		return run;
	};

	async function fetchSync(from: number, need?: Record<string, number>): Promise<SyncResponse> {
		if (config.manifest) return refreshManifest();
		const query = need ? `need=${encodeURIComponent(encodeHeld(need))}` : `from=${from}`;
		const response = await deps.fetch(`${origin}${PATHS.sync}?${query}`, {
			cache: 'no-store',
			credentials: 'same-origin'
		});
		if (!response.ok) throw new Error(`sync answered ${response.status}`);
		// the answer names who the server sees, so a sign-in the worker never saw ends here
		await early(decodeEnvelopeOrClear(response.headers), true);
		return parseSyncResponse(await response.json());
	}

	/**
	 * A declared write goes to the server once. A 2xx answer brings the held pack to the version the
	 * server reached before the page gets the answer, so the next local read sees the change.
	 */
	async function declaredWrite(request: Request, write: ResourceWrite): Promise<Response> {
		const body = await request
			.clone()
			.json()
			.catch(() => undefined);
		const response = await deps.fetch(await withHave(request));
		const envelope = decodeEnvelopeOrClear(response.headers);
		await early(envelope, false);
		const expected = write.origin ?? origin;
		if (response.ok && pack) {
			await settleWrite(response, pack, fetchDelta, expected, {
				write,
				url: new URL(request.url),
				body,
				routes: config.routes
			}).catch(() => undefined);
		}
		track(observe(response.headers, envelope, null, false, true, false, async () => undefined));
		return response;
	}

	/** the delta from `from` to `to`, which the server answers for any two packs it holds */
	async function fetchDelta(from: number, to: number): Promise<BundleDelta> {
		const response = await deps.fetch(`${origin}${BUNDLE_DELTA_PREFIX}${from}/${to}`, {
			credentials: 'same-origin'
		});
		if (!response.ok) throw new Error(`delta answered ${response.status}`);
		return (await response.json()) as BundleDelta;
	}

	/**
	 * Moves a held pack to the version the worker script carries. A pack behind it takes the inline
	 * delta from its version, or one fetched delta when the inline ones do not reach it. The store
	 * checks the digest before it writes, so a refused delta leaves the pack as it was.
	 */
	async function adoptPack(pack: PackStore, target: StubPack): Promise<void> {
		// the replica loads first: applyEnvelope would save its meta over the stored one
		await ready();
		const head = await pack.head();
		if (!head || head.version >= target.version) return;
		const inline = target.deltas.find((delta) => delta.from === head.version);
		await moveTo(pack, inline ?? (await fetchDelta(head.version, target.version)));
	}

	/**
	 * Applies a pack delta, then tells the replica which tags it moved, so an artifact built on an
	 * older row is dropped whichever path delivered the delta. A refused delta throws before either
	 * step.
	 */
	async function moveTo(store: PackStore, delta: BundleDelta): Promise<void> {
		await store.applyDelta(delta);
		const moved = Object.keys(delta.tables).map((tag) => [tag, delta.to] as const);
		await replica.applyEnvelope({ invalidate: Object.fromEntries(moved) }, null, false);
	}

	/** the request with `Spool-Have` naming the pack the device holds; same-origin requests only */
	async function withHave(request: Request): Promise<Request> {
		if (!pack || new URL(request.url).origin !== origin) return request;
		let version: number | undefined;
		try {
			version = (await pack.head())?.version;
		} catch {
			return request;
		}
		if (version === undefined) return request;
		try {
			const headers = new Headers(request.headers);
			headers.set(HEADERS.have, String(version));
			return new Request(request, { headers });
		} catch {
			return request;
		}
	}

	/**
	 * Applies the `Spool-Delta` a same-origin answer carries to the held pack, then tells the replica
	 * which tags moved, so an artifact built on an older row is dropped. A refused delta changes nothing.
	 */
	async function applyServerDelta(response: Response): Promise<void> {
		const text = response.headers.get(HEADERS.delta);
		if (text === null || !pack || !response.url) return;
		if (new URL(response.url).origin !== origin) return;
		try {
			await moveTo(pack, JSON.parse(text) as BundleDelta);
		} catch {
			// a refused delta leaves the pack as it was
		}
	}

	const policy = {
		changesPerDay: prior.changesPerDay,
		staleBytes: prior.avoidedBytes,
		syncBytes: prior.requestBytes
	};

	/** paths to ask the next flush for: visited routes in shadow, then the hot list, best first */
	async function wantList(): Promise<string[]> {
		const out: string[] = [];
		for (const path of wants) if (!(await replica.get(path))) out.push(path);
		const hot: Opportunity[] = [];
		for (const path of config.provision?.hot ?? []) {
			if (asked.has(path) || out.includes(path) || (await replica.get(path))) continue;
			const hit = matchRoute(config.routes, path);
			if (!hit || hit.route.scope !== 'public' || hit.route.strategy === 'static') continue;
			if (hit.route.family || hit.route.origin !== undefined) continue;
			hot.push({
				id: path,
				kind: 'route',
				provision: { bytes: ledger.meanFetchBytes() ?? prior.artifactBytes, requests: 0 },
				avoided: { bytes: prior.avoidedBytes, requests: 1 }
			});
		}
		return [...out, ...plan(hot, prior).map((o) => o.id)].slice(0, MAX_WANT);
	}

	async function accept(artifact: Artifact, bytes: number, requests: number): Promise<void> {
		const hit = matchRoute(config.routes, artifact.id);
		if (!hit || artifact.scope !== 'public' || artifact.strategy !== hit.route.strategy) return;
		if (await replica.put(artifact, hit.route.persist)) {
			ledger.spend(artifact.id, { bytes, requests });
		}
	}

	/** the page the last view was on, when its route declares a catalogue; the queue skips a recent ask */
	// a complete held pack already has every page the catalogue would name, so no ask is sent
	const catalogueAsk = async (): Promise<CatalogueAsk | undefined> => {
		if (currentPath === null) return undefined;
		const head = await pack?.head().catch(() => undefined);
		if (head && !head.partial) return undefined;
		return { path: currentPath, sweep: true };
	};

	/**
	 * Stores the entries a flush brought, each marked unopened. An entry is kept only for a route
	 * whose strategy and scope match it. A principal entry is kept only when the answer names the
	 * partition the worker holds, and one the device already holds is left as it is. Every entry is
	 * charged to the ledger as received.
	 */
	async function acceptCatalogue(list: unknown, partition: string | null): Promise<void> {
		if (!Array.isArray(list)) return;
		for (const raw of list) {
			let artifact: Artifact;
			try {
				artifact = parseArtifact(raw);
			} catch {
				continue;
			}
			ledger.spend(
				artifact.id,
				{ bytes: encoder.encode(JSON.stringify(raw)).length, requests: 0 },
				true
			);
			const hit = matchRoute(config.routes, artifact.id);
			if (!hit || !ENTRY_STRATEGIES.includes(artifact.strategy)) continue;
			if (artifact.strategy !== hit.route.strategy || artifact.scope !== hit.route.scope)
				continue;
			let side: Side | null = publicSide;
			if (artifact.scope === 'principal') {
				side = await principalSide();
				if (!side || side.id !== partition) continue;
			}
			if (await side.replica.get(artifact.id)) continue;
			await side.replica.put(artifact, hit.route.persist, true);
		}
	}

	async function replay(event: BeaconEvent): Promise<boolean> {
		const entry = config.collectors?.find((c) => c.vendor === event.vendor);
		let search = event.search ?? '';
		if (entry?.stamp) search = applyStamp(search, entry.stamp, event.at, now());
		const method = event.method ?? 'POST';
		const init: RequestInit = {
			method,
			credentials: event.origin ? 'omit' : 'same-origin'
		};
		if (method === 'POST') {
			init.body = event.body;
			if (event.contentType) init.headers = { 'content-type': event.contentType };
		}
		if (event.origin) {
			const type = event.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
			const simple = ['', 'text/plain', 'application/x-www-form-urlencoded'].includes(type);
			init.mode = simple ? 'no-cors' : 'cors';
		}
		const response = await deps.fetch(`${event.origin ?? origin}${event.path}${search}`, init);
		return (
			response.type === 'opaque' ||
			response.ok ||
			(response.status >= 400 && response.status < 500)
		);
	}

	const analytics = new BeaconQueue({
		storage,
		now,
		want: wantList,
		catalogue: catalogueAsk,
		replay,
		async send(batch) {
			const response = await deps.fetch(`${origin}${PATHS.beacon}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(batch),
				credentials: 'same-origin'
			});
			if (response.status === 200 && (batch.want || batch.catalogue)) {
				const body = (await response.json()) as {
					artifacts?: unknown;
					catalogue?: unknown;
				};
				if (batch.want) {
					const list = Array.isArray(body.artifacts) ? body.artifacts : [];
					for (const raw of list) {
						const artifact = parseArtifact(raw);
						await accept(artifact, encoder.encode(JSON.stringify(raw)).length, 0);
					}
					for (const path of batch.want) {
						wants.delete(path);
						asked.add(path);
					}
				}
				if (batch.catalogue) {
					await acceptCatalogue(body.catalogue, response.headers.get(HEADERS.partition));
				}
			}
			return response.ok || (response.status >= 400 && response.status < 500);
		}
	});

	const makeScheduler = (target: Replica) =>
		new Scheduler({
			replica: target,
			fetchSync,
			onNetwork: () => track(analytics.flushAtMoment()),
			policy
		});

	const publicSide: Side = {
		id: null,
		replica,
		scheduler: makeScheduler(replica),
		deferred: new Set(),
		loaded: Promise.resolve(),
		dead: false,
		covered: false,
		leaseUntil: 0
	};
	const scheduler = publicSide.scheduler;

	// #region datasets

	const datasetRuns = new Map<string, Promise<DatasetOutcome>>();
	const datasetCounts: Record<string, number> = {};
	const datasetRefused = new Map<string, DatasetRefusal>();
	const datasetsDeferred = new Set<string>();
	/** principal datasets whose held rows are past maxStaleMs; the next network moment syncs them */
	const principalDeferred = new Set<string>();
	let persistAsked = false;
	let persisted: boolean | null = null;

	const estimate = async () => {
		if (deps.estimate) return deps.estimate();
		return (
			(typeof navigator === 'undefined'
				? undefined
				: await navigator.storage?.estimate?.()) ?? {}
		);
	};

	/** the bytes of rows one dataset may take: the headroom times the declared share; unknown when the browser will not say */
	const datasetBudget = async (): Promise<number | undefined> => {
		try {
			const { quota, usage } = await estimate();
			if (quota === undefined || usage === undefined) return undefined;
			return Math.max(0, (quota - usage) * (config.datasetShare ?? 1));
		} catch {
			return undefined;
		}
	};

	const tally = (outcome: DatasetOutcome) => {
		const key =
			outcome.status === 'refused'
				? `${outcome.name}:refused:${outcome.reason}`
				: `${outcome.name}:${outcome.status}`;
		datasetCounts[key] = (datasetCounts[key] ?? 0) + 1;
		if (outcome.status === 'refused') {
			datasetRefused.set(outcome.name, outcome.reason);
			if (outcome.reason === 'declined') declined.set(outcome.name, outcome.by ?? null);
		} else if (outcome.status !== 'offline') datasetRefused.delete(outcome.name);
		const held = outcome.status !== 'offline' && outcome.status !== 'refused';
		if (held && !persistAsked) {
			persistAsked = true;
			deps.broadcast?.({ type: 'spool:persist' });
		}
	};

	/** the principal datasets the server declared, with how long each may answer after a confirmed sync */
	const principalLimits = () =>
		new Map((config.principalDatasets ?? []).map((d) => [d.name, d.maxStaleMs]));

	/**
	 * A principal dataset's request, read for who it answers. A late answer for a partition the
	 * worker has left is returned untouched, since the sync discards it; a session that ended wipes
	 * the store, and an answer for another partition swaps it, exactly as a navigation does.
	 */
	async function principalFetch(side: Side, url: string, init?: RequestInit): Promise<Response> {
		const response = await deps.fetch(url, init);
		if (side.dead || principal !== side) return response;
		if (response.status === 401) await wipePartition('session-ended');
		else if (response.ok) {
			if (response.headers.has(HEADERS.partition)) {
				await early(decodeEnvelopeOrClear(response.headers), true);
			} else await wipePartition('session-ended');
		}
		return response;
	}

	/** brings one dataset current; a second caller joins the run in flight, for the same side */
	function syncDatasetOnce(name: string, side: Side = publicSide): Promise<DatasetOutcome> {
		const key = `${side.id ?? ''}\u0000${name}`;
		const running = datasetRuns.get(key);
		if (running) return running;
		const partition = side.id;
		const run = syncDataset(
			{
				store: side.replica.datasets,
				fetch:
					partition === null
						? (url, init) => deps.fetch(url, init)
						: (url, init) => principalFetch(side, url, init),
				origin,
				epoch: () => (side.dead ? -1 : side.replica.epoch),
				budget: datasetBudget,
				...(partition === null ? {} : { guard: principalGuard(partition) })
			},
			name
		)
			.then((outcome) => {
				tally(outcome);
				return outcome;
			})
			.finally(() => datasetRuns.delete(key));
		datasetRuns.set(key, run);
		return run;
	}

	const datasetCurrent = (outcome: DatasetOutcome) =>
		outcome.status !== 'offline' && outcome.status !== 'refused';

	/** seeds a dataset in the background unless this run already learned it will not be held */
	function seedDataset(name: string, side: Side = publicSide): void {
		if (side !== publicSide && !principalLimits().has(name)) return;
		const key = `${side.id ?? ''}\u0000${name}`;
		if (!datasetRefused.has(name) && !datasetRuns.has(key)) track(syncDatasetOnce(name, side));
	}

	// #endregion

	// #region partitions

	const retentionOf = (id: string): Retention =>
		matchRoute(config.routes, id)?.route.retention ?? 'session';
	const sharedRetention = (): Retention =>
		config.routes.some((r) => r.scope === 'principal' && r.retention === 'persistent')
			? 'persistent'
			: 'session';

	function makeSide(id: string): Side {
		const sealed = (host as PartitionHost).open(
			id,
			retentionOf,
			sharedRetention(),
			config.principalDatasets !== undefined
		);
		const target = new Replica(sealed, codeVersion, now);
		return {
			id,
			replica: target,
			scheduler: makeScheduler(target),
			deferred: new Set(),
			loaded: target.load(),
			dead: false,
			covered: false,
			leaseUntil: 0
		};
	}

	async function loadPartition(): Promise<void> {
		const id = await (host as PartitionHost).current();
		if (id && !principal) principal = makeSide(id);
	}

	/** the side of the partition in use, loaded; null when no principal is signed in as far as the worker knows */
	async function principalSide(): Promise<Side | null> {
		await ready();
		const side = principal;
		if (!side) return null;
		await side.loaded;
		return side;
	}

	/** marks a side left for good, and forgets what the next principal must not inherit */
	function retire(side: Side): void {
		side.dead = true;
		principalDeferred.clear();
		for (const name of principalLimits().keys()) datasetRefused.delete(name);
	}

	/** shuts the principal store, shreds its keys and deletes it; true when there was one. `only` limits it to that partition */
	function wipePartition(reason: string, only?: string): Promise<boolean> {
		return serial(async () => {
			await ready();
			if (only !== undefined && principal?.id !== only) return false;
			const old = principal;
			principal = null;
			old?.writes?.kill();
			if (old) retire(old);
			if (!old || !host) return false;
			await host.setCurrent(null);
			await host.destroy(old.id as string);
			deps.broadcast?.({ type: 'spool:cleared', reason });
			return true;
		});
	}

	/** makes `id` the partition in use; the one before it is destroyed first */
	function switchTo(id: string): Promise<void> {
		return serial(async () => {
			await ready();
			const old = principal;
			if (old?.id === id) return;
			principal = makeSide(id);
			swept = false;
			old?.writes?.kill();
			if (old) retire(old);
			await (host as PartitionHost).setCurrent(id);
			if (old) {
				await (host as PartitionHost).destroy(old.id as string);
				deps.broadcast?.({ type: 'spool:cleared', reason: 'partition' });
			}
		});
	}

	// #region live stream

	/** what the page needs to open a stream: whether the site has one, the partition held and the cursor to start from */
	async function liveState(): Promise<LiveState> {
		const side = await principalSide();
		const cursors = [replica.cursor, side?.replica.cursor ?? null].filter(
			(c): c is number => c !== null
		);
		return {
			type: 'spool:live-state',
			live: config.live ?? null,
			partition: side?.id ?? null,
			have: cursors.length > 0 ? Math.min(...cursors) : null
		};
	}

	/**
	 * Applies what the page read from its stream. The partition names the stream's own, so a late event
	 * for a partition this worker has left changes nothing. A delta is applied to a side only when it
	 * starts at or below that side's cursor; a gap ends the side's lease and tells the page to connect
	 * again. A `revoked` event wipes the partition exactly as a logout does.
	 */
	/** lease renewals paid in this visible session; the second asks a page for the stream instead */
	let liveRenewals = 0;
	const liveWaiters = new Set<() => void>();

	/** asks the pages to open the stream; true when a lease covered `side` before the wait ran out */
	function wantLive(): Promise<boolean> {
		if (!deps.broadcast) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const ready = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				liveWaiters.delete(ready);
				resolve(false);
			}, deps.liveWaitMs ?? 3000);
			liveWaiters.add(ready);
			deps.broadcast?.({ type: 'spool:want-live' });
		});
	}

	async function liveEvent(message: LiveMessage): Promise<LiveAck> {
		if (message.event === 'session') {
			liveRenewals = 0;
			return { type: 'spool:live', ok: true };
		}
		if (message.event === 'revoked') {
			if (message.partition !== null) await wipePartition('revoked', message.partition);
			return { type: 'spool:live', ok: true };
		}
		return serial(async () => {
			await ready();
			const own = principal && principal.id === message.partition ? principal : null;
			const publicLive = config.live?.public === true;
			const sides = [...(own ? [own] : []), ...(publicLive ? [publicSide] : [])];
			if (message.event === 'lease') {
				const until = now() + message.leaseMs;
				for (const side of sides) if (side.covered) side.leaseUntil = until;
				if (own?.covered) {
					for (const ready of [...liveWaiters]) ready();
					liveWaiters.clear();
				}
				return { type: 'spool:live', ok: true };
			}
			let ok = true;
			for (const side of sides) {
				if (side.dead) continue;
				const cursor = side.replica.cursor;
				if (cursor === null) continue;
				if (cursor < message.delta.from) {
					side.covered = false;
					side.leaseUntil = 0;
					ok = false;
					continue;
				}
				await side.replica.applySync(message.delta);
				side.covered = true;
			}
			return { type: 'spool:live', ok };
		});
	}

	// #endregion

	// a page that loads after a navigation contact never hears its broadcast, so the hello carries it
	let lastContact = 0;
	function contacted(): void {
		lastContact = now();
		deps.broadcast?.({ type: 'spool:contact', at: lastContact });
	}

	/**
	 * What a response says about who is signed in, applied before the response is handed back so no
	 * later view reads a store the response outdated. `Spool-Clear` wipes everything or one
	 * partition; a different `Spool-Partition` replaces the store; a navigation the server decorated
	 * with no partition means the session ended. A sync answer is read the same way, so the first
	 * required sync after a sign-in the worker never saw swaps the store before its result is used.
	 */
	async function early(
		envelope: Envelope | undefined,
		navigation: boolean,
		signedOut = false
	): Promise<void> {
		// a response from the server is a contact; the page's lease clock resets on it
		if (envelope?.protocol === PROTOCOL_VERSION) contacted();
		if (!host || !envelope || envelope.protocol !== PROTOCOL_VERSION) return;
		await ready();
		const clear = envelope.clear ?? [];
		if (clear.includes('*') || (principal && clear.includes(principal.id as string))) {
			await analytics.dropSameOrigin();
			await wipePartition('clear');
			return;
		}
		// the answer to a logout request still names the identity of the request it answered
		if (signedOut) return;
		if (envelope.partition !== undefined) {
			if (principal?.id !== envelope.partition) {
				await analytics.dropSameOrigin();
				await switchTo(envelope.partition);
			}
		} else if (navigation && principal) {
			await analytics.dropSameOrigin();
			await wipePartition('session-ended');
		}
	}

	// #endregion

	// #region writes

	// a worker in shadow mode only observes, so it queues nothing
	const writesOn = () => config.writes !== undefined && config.mode !== 'shadow';
	const writeRefusal = (code: WriteRefusal['code'], message: string): WriteRefusal => ({
		ok: false,
		code,
		message
	});

	async function sendWrite(record: WriteRecord): Promise<{ status: number; body?: unknown }> {
		const query = `name=${encodeURIComponent(record.name)}&key=${encodeURIComponent(record.key)}`;
		const request = await withHave(
			new Request(`${origin}${PATHS.write}?${query}`, {
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					'if-match': ifMatch(record.base),
					[WRITE_HEADERS.id]: record.id
				},
				body: JSON.stringify({ value: record.value }),
				cache: 'no-store',
				credentials: 'same-origin'
			})
		);
		const response = await deps.fetch(request);
		// the write answer carries no envelope, so the answer itself is the contact
		contacted();
		const body: unknown = await response.json().catch(() => undefined);
		return { status: response.status, body };
	}

	function queueOf(side: Side): WriteQueue | null {
		if (!writesOn() || !host?.openWrites) return null;
		side.writes ??= new WriteQueue({
			store: host.openWrites(side.id as string),
			classes: () => config.writes ?? [],
			now,
			send: sendWrite,
			onFlush: (flush) => deps.broadcast?.({ type: 'spool:written', ...flush }),
			timers: deps.timers
		});
		return side.writes;
	}

	async function pageQueue(): Promise<WriteQueue | WriteRefusal> {
		if (!writesOn()) return writeRefusal('writes-off', 'declared writes are off');
		const side = await principalSide();
		if (!side) return writeRefusal('no-partition', 'no signed-in principal is held');
		return queueOf(side) ?? writeRefusal('unavailable', 'this worker has no partition storage');
	}

	/** sends the signed-in partition's queue at a network moment that is happening anyway */
	async function flushWrites(): Promise<void> {
		const queue = principal ? queueOf(principal) : null;
		if (queue) await queue.flush();
	}

	// a worker that was stopped leaves its deadlines behind; the first contact of each start checks them
	let swept = false;
	function sweepWrites(): Promise<void> | undefined {
		if (swept) return undefined;
		swept = true;
		return principalSide()
			.then((side) => (side ? queueOf(side)?.flushDue() : undefined))
			.then(
				() => undefined,
				() => undefined
			);
	}

	// #endregion

	/** whether the held pack renders a public family page, so no artifact for it is needed */
	async function packRenders(path: string, route: SerializedRoute): Promise<boolean> {
		if (route.family === undefined || route.scope !== 'public') return false;
		const dataset = route.family.dataset;
		const held = async (key: string) => (pack ? pack.getRow(dataset, key) : undefined);
		return (await familyPage(held, route, path, now())) !== undefined;
	}

	async function provision(
		path: string,
		route: SerializedRoute,
		version: number,
		partition?: string
	): Promise<void> {
		const side = route.scope === 'principal' ? await principalSide() : publicSide;
		if (!side || (route.scope === 'principal' && side.id !== partition)) return;
		const have = await side.replica.held();
		const query =
			Object.keys(have).length > 0 ? `&have=${encodeURIComponent(encodeHeld(have))}` : '';
		const response = await deps.fetch(
			`${origin}${PATHS.artifact}?path=${encodeURIComponent(path)}${query}`,
			{ cache: 'no-store', credentials: 'same-origin' }
		);
		if (response.status === 204 && response.headers.get(HEADERS.provision) === 'declined') {
			declined.set(path, response.headers.get(HEADERS.provisionReason));
			unavailable.set(path, version);
			return;
		}
		if (!response.ok) {
			if (response.status === 404) unavailable.set(path, version);
			if (route.scope === 'principal' && [401, 403, 404].includes(response.status)) {
				await side.replica.drop([path]);
			}
			return;
		}
		const text = await response.text();
		const artifact = parseArtifact(JSON.parse(text));
		if (artifact.scope !== route.scope || artifact.id !== path) return;
		if (artifact.strategy !== route.strategy) return;
		if (route.scope === 'principal') {
			if (response.headers.get(HEADERS.partition) !== partition) return;
			if (principal !== side) return;
		}
		if (await side.replica.put(artifact, route.persist)) {
			ledger.spend(path, { bytes: encoder.encode(text).length, requests: 1 });
			// a persistent key outlives the worker, so rows seeded now are readable at the next return
			if (route.scope === 'principal' && route.retention === 'persistent') {
				await seedOwnRows(side, route).catch(() => undefined);
			}
		}
	}

	/** seeds the principal datasets `route` reads that this side does not hold */
	async function seedOwnRows(side: Side, route: SerializedRoute): Promise<void> {
		const names = new Set([
			...(route.family ? [route.family.dataset] : []),
			...(route.query?.dataset ? [route.query.dataset] : []),
			...(route.query?.plan?.join ?? []).map((j) => j.dataset)
		]);
		for (const name of names) {
			if (!(await side.replica.datasets.get(name))) seedDataset(name, side);
		}
	}

	async function drainDeferred(side: Side): Promise<void> {
		const paths = [...side.deferred];
		side.deferred.clear();
		if (await side.scheduler.drain())
			for (const path of paths) await side.replica.validate(path);
	}

	let leaseDrain: Promise<void> | undefined;
	/** sends the public side's queued syncs without waiting for a network moment; one run at a time */
	function drainAtLease(): void {
		if (leaseDrain) return;
		leaseDrain = (async () => {
			await drainDeferred(publicSide);
			const names = [...datasetsDeferred];
			datasetsDeferred.clear();
			for (const name of names) await syncDatasetOnce(name);
		})()
			.catch(() => undefined)
			.finally(() => {
				leaseDrain = undefined;
			});
		track(leaseDrain);
	}

	async function observe(
		headers: Headers,
		envelope: Envelope | undefined,
		sent: number | null,
		navigation: boolean,
		moment: boolean,
		provisionable: boolean,
		keep: () => Promise<void>
	): Promise<void> {
		await keep();
		if (envelope && envelope.protocol === PROTOCOL_VERSION) {
			await replica.applyEnvelope(envelope, sent, headers.has('age'));
			const side = principal;
			if (side) {
				await side.loaded;
				await side.replica.applyEnvelope(envelope, null, true);
			}

			const advertised = envelope.artifact;
			if (provisionable && advertised) {
				const hit = matchRoute(config.routes, advertised.id);
				const own = advertised.scope === 'principal' ? await principalSide() : publicSide;
				const fits =
					hit &&
					hit.route.strategy !== 'static' &&
					hit.route.provisionable !== false &&
					hit.route.scope === advertised.scope &&
					!declined.has(advertised.id) &&
					unavailable.get(advertised.id) !== advertised.version &&
					own &&
					(advertised.scope === 'public' || own.id === envelope.partition);
				if (
					hit &&
					own &&
					fits &&
					!(await packRenders(advertised.id, hit.route)) &&
					!(await own.replica.get(advertised.id))
				) {
					if (advertised.scope === 'public' && modeFor(config, hit.route) === 'shadow') {
						wants.add(advertised.id);
					} else {
						const key = `${advertised.scope}:${advertised.id}`;
						const pending =
							provisioning.get(key) ??
							provision(
								advertised.id,
								hit.route,
								advertised.version,
								envelope.partition
							);
						provisioning.set(key, pending);
						try {
							await pending;
						} catch {
							// a failed provision leaves the network view as the only one
						} finally {
							provisioning.delete(key);
						}
					}
				}
			}
		}
		if (moment) {
			await drainDeferred(publicSide);
			if (principal) await drainDeferred(principal);
			const names = [...datasetsDeferred];
			datasetsDeferred.clear();
			for (const name of names) await syncDatasetOnce(name);
			const owed = [...principalDeferred];
			principalDeferred.clear();
			const side = principal;
			if (side) for (const name of owed) await syncDatasetOnce(name, side);
			await analytics.flushAtMoment();
			await flushWrites();
			await revalidateThirdParty();
		}
	}

	/**
	 * Keeps the security headers of a network view so a local render can replay them: the site-wide
	 * set from any HTML navigation, and the set of the route's own path. Errors, redirects and
	 * queried URLs are never kept, since no local render answers them.
	 */
	async function keepPolicy(
		request: Request,
		response: Response,
		envelope: Envelope | undefined,
		navigation: boolean,
		after?: { route?: SerializedRoute; signedOut?: boolean }
	): Promise<void> {
		if (request.method !== 'GET' || response.status !== 200 || response.redirected) return;
		if (after?.signedOut) return;
		if (navigation && !/text\/html/i.test(response.headers.get('content-type') ?? '')) return;
		const set = policyHeaders(response.headers);
		if (navigation) await replica.keepPolicy(null, set);
		const route = after?.route;
		const url = new URL(request.url);
		if (!route || route.strategy === 'static' || url.search !== '') return;
		const side =
			route.scope === 'principal'
				? principal?.id === envelope?.partition
					? principal
					: null
				: publicSide;
		if (!side) return;
		await side.loaded;
		await side.replica.keepPolicy(url.pathname, set);
	}

	async function passthrough(
		request: Request,
		navigation: boolean,
		after?: {
			clone?: boolean | ((response: Response, envelope: Envelope | undefined) => boolean);
			provision?: boolean;
			signedOut?: boolean;
			/** the route a navigation or data read matched, so its own headers are kept */
			route?: SerializedRoute;
			run(copy: Response | null, envelope: Envelope | undefined): Promise<void>;
		}
	): Promise<Response> {
		let outgoing = request;
		let sent: number | null = null;
		if (
			!config.manifest &&
			!navigation &&
			request.method === 'GET' &&
			replica.cursor !== null
		) {
			try {
				const headers = new Headers(request.headers);
				headers.set(HEADERS.vectorSeen, String(replica.cursor));
				outgoing = new Request(request, { headers });
				sent = replica.cursor;
			} catch {
				outgoing = request;
			}
		}
		outgoing = await withHave(outgoing);
		const response = await deps.fetch(outgoing);
		const envelope = decodeEnvelopeOrClear(response.headers);
		await early(envelope, navigation, after?.signedOut);
		// a cacheable GET may be answered by the HTTP cache with no radio wake, so only these count
		const moment = navigation || request.method !== 'GET';
		const clone = after?.clone;
		const kept = typeof clone === 'function' ? clone(response, envelope) : clone;
		const { visitor, copy } = kept ? branch(response) : { visitor: response, copy: null };
		track(
			(async () => {
				await applyServerDelta(response);
				try {
					await after?.run(copy, envelope);
				} catch {
					// a view that cannot be recorded must not stop the response being observed
				}
				await observe(
					response.headers,
					envelope,
					sent,
					navigation,
					moment,
					after?.provision ?? navigation,
					() => keepPolicy(request, response, envelope, navigation, after)
				);
			})()
		);
		return visitor;
	}

	/**
	 * `search` is the request's query string; the stored artifact is always the path's own. A
	 * principal route answers from the signed-in partition and a public one from the public side.
	 */
	async function decide(
		path: string,
		route: SerializedRoute,
		dry: boolean,
		search = ''
	): Promise<Decision> {
		const principal = route.scope === 'principal';
		let side = publicSide;
		if (principal) {
			if (!host) return { reason: 'principal', staleSec: null };
			const own = await principalSide();
			if (!own) return { reason: 'cold', staleSec: null };
			side = own;
		}
		const { replica: rep, scheduler: sched } = side;
		// a signed-in read takes its row from the partition's dataset; a public one from the pack
		const heldRow = (dataset: string) => async (key: string) =>
			principal
				? (await rep.datasets.get(dataset))?.rows.get(key)
				: await pack?.getRow(dataset, key);
		const page = () => {
			if (route.family && route.family.key !== 'viewer.id') {
				return familyPage(heldRow(route.family.dataset), route, path, now());
			}
			if (route.origin !== undefined) return collectionPage(path, now());
			return rep.get(path);
		};
		// a same-origin collection answers from the held pack's rows, so a write the pack holds shows at once
		const packed = route.query?.dataset;
		if (
			packed !== undefined &&
			!principal &&
			pack &&
			route.strategy === 'data' &&
			route.family === undefined &&
			route.origin === undefined &&
			route.query?.plan === undefined
		) {
			const head = await pack.head();
			if (head && !head.partial && head.tables.includes(packed)) {
				const rows = (await pack.scanTable(packed)).map(([, row]) => row);
				const rendered = await renderLocal(
					config,
					route,
					collectionPage(path, now()).artifact,
					renderers,
					search,
					rows
				);
				const headers = rep.policyOf(path) ?? replica.sitePolicy;
				if (!rendered.ok || (!headers && !dry && !isDataFamily(route))) {
					return { reason: 'refused', staleSec: null };
				}
				return { reason: 'fresh', html: rendered.html, headers, staleSec: 0 };
			}
		}
		let stored = await page();
		if (!stored) {
			// a signed-in family miss seeds its dataset; this view still goes to the network
			if (
				principal &&
				route.family &&
				!dry &&
				!(await rep.datasets.get(route.family.dataset))
			) {
				seedDataset(route.family.dataset, side);
			}
			return { reason: 'cold', staleSec: null };
		}
		const staleSec = () =>
			stored ? Math.max(0, Math.floor((now() - rep.validatedAt(stored)) / 1000)) : null;
		if (!rep.isCurrent(stored.artifact)) {
			const age = staleSec();
			await rep.drop([path]);
			return { reason: 'invalidated', staleSec: age };
		}

		if (
			route.version !== undefined &&
			stored.artifact.strategy === 'static' &&
			stored.artifact.body.version !== route.version
		) {
			const age = staleSec();
			await rep.drop([path]);
			return { reason: 'invalidated', staleSec: age };
		}

		// a page answers from the rows the device holds, so their age bounds the answer too
		const queried = route.query?.dataset;
		const joined = (route.query?.plan?.join ?? []).map((j) => j.dataset);
		// a public list query reads the rows of a whole table the held pack carries
		const listHead =
			queried !== undefined &&
			search !== '' &&
			!principal &&
			route.scope === 'public' &&
			route.query?.plan === undefined &&
			pack
				? await pack.head()
				: undefined;
		const listRows =
			queried !== undefined &&
			listHead &&
			!listHead.partial &&
			listHead.tables.includes(queried) &&
			pack
				? (await pack.scanTable(queried)).map(([, row]) => row)
				: undefined;
		const dsNames = [
			...new Set([
				...(queried && listRows === undefined ? [queried] : []),
				...joined,
				...(principal && route.family ? [route.family.dataset] : []),
				...(await rep.datasetsOf(stored.artifact))
			])
		];
		// a principal side answers only from the principal datasets the server declared
		const limits = side === publicSide ? undefined : principalLimits();
		if (limits && dsNames.some((name) => !limits.has(name))) {
			return { reason: 'refused', staleSec: staleSec() };
		}
		const heldAt = async () =>
			Promise.all(
				dsNames.map(async (name) => (await rep.datasets.get(name))?.meta.appliedAt)
			);
		let appliedAt = await heldAt();
		const missing = dsNames.filter((_, i) => appliedAt[i] === undefined);
		if (missing.length > 0) {
			if (!dry) for (const name of missing) seedDataset(name, side);
			return { reason: 'refused', staleSec: staleSec() };
		}
		// held principal rows answer only while the last confirmed sync is inside maxStaleMs
		const pastLimit = () =>
			limits
				? dsNames.filter((name, i) => {
						const age = now() - (appliedAt[i] as number);
						return !(age >= 0 && age < (limits.get(name) as number));
					})
				: [];
		// rows past that bound are refreshed before the page shows, as a hard route does
		const refresh = pastLimit().length > 0;
		if (refresh && dry) return { reason: 'refused', staleSec: staleSec() };
		const known = (at: Array<number | undefined>) =>
			at.filter((v): v is number => v !== undefined);
		const fromCatalogue = stored.catalogue === true;
		// a lease the stream renews stands in for the bound; `isCurrent` and the dataset bounds above still apply
		let action: Verdict = refresh
			? 'sync-first'
			: side.covered && now() < side.leaseUntil
				? 'serve'
				: verdict(
						route.freshness,
						Math.min(rep.validatedAt(stored), ...known(appliedAt)),
						now()
					);
		// adaptive: the first renewal of a visible session is paid, the second becomes the stream
		if (
			action === 'sync-first' &&
			!refresh &&
			!dry &&
			side !== publicSide &&
			config.live?.mode === 'adaptive' &&
			(liveRenewals += 1) === 2 &&
			(await wantLive())
		) {
			action = 'serve';
		}
		const age = Math.max(
			staleSec() as number,
			...known(appliedAt).map((at) => Math.floor((now() - at) / 1000))
		);
		const base = rep.needFor(
			stored.artifact,
			route.sync === 'deferred' || route.scope === 'principal'
		);
		// a principal sync also names the catalogue entries no page has opened, so a revoked one is dropped
		const need =
			(route.scope === 'principal' && base ? await rep.sweep(base) : base) ?? undefined;
		let reason: ViewReason = 'fresh';
		if (action === 'sync-first') {
			reason = 'hard-sync';
			if (!dry) {
				const synced = await sched.sync(need, age);
				// a sync that ended the session wiped this side, so its rows are not asked for again
				if (side.dead) return { reason: 'refused', staleSec: age };
				// a dataset applied inside both the route's bound and its own is as current as the page may be
				const late = new Set(pastLimit());
				const due = dsNames.filter((name, i) => {
					const since = now() - (appliedAt[i] as number);
					return (
						late.has(name) || !(since >= 0 && since <= route.freshness.maxStale * 1000)
					);
				});
				const dsSynced = (
					await Promise.all(due.map((name) => syncDatasetOnce(name, side)))
				).every(datasetCurrent);
				if (!(synced && dsSynced) && route.offline === 'refuse')
					return { reason: 'hard-refused', staleSec: age };
				if (dsNames.length > 0) {
					appliedAt = await heldAt();
					if (appliedAt.includes(undefined) || pastLimit().length > 0) {
						return { reason: 'refused', staleSec: age };
					}
				}
				if (synced) {
					if (need) await rep.validate(path);
					stored = await page();
					if (!stored || !rep.isCurrent(stored.artifact)) {
						return { reason: 'stale-after-sync', staleSec: age };
					}
				}
				if (!(synced && dsSynced)) reason = 'offline-stale';
			}
		} else if (action === 'serve-then-sync') {
			// the sync waits for a network moment: a view made from the device's own copy sends nothing
			reason = route.sync === 'deferred' ? 'soft-deferred' : 'soft-sync';
			if (!dry) {
				// a deferred route syncs only the ids it names; a soft one syncs the whole replica when it names none
				const queued =
					route.sync === 'deferred'
						? need !== undefined && sched.defer(need, age)
						: sched.queue(need, age);
				if (queued && need) side.deferred.add(path);
				for (const name of dsNames) {
					(side === publicSide ? datasetsDeferred : principalDeferred).add(name);
				}
				// a queue that has waited a lease is sent now, so a device that reads only locally still syncs
				const waited = config.lease !== undefined && age >= config.lease;
				if (side === publicSide && waited && (queued || dsNames.length > 0)) drainAtLease();
			}
		}

		if (route.strategy === 'static') {
			const kept = await readStatic(path);
			if (!kept) {
				await rep.drop([path]);
				return { reason: 'refused', staleSec: age };
			}
			return { reason, response: kept, staleSec: age };
		}
		// a page answers only with the policy the site sent with it; an API family is no page
		const headers = rep.policyOf(path) ?? replica.sitePolicy;
		if (!headers && !dry && !isDataFamily(route)) return { reason: 'refused', staleSec: age };
		const plain = await rep.materialize(stored.artifact);
		if (!plain.ok) {
			// rows of a dataset not held yet: the page is sound, so keep it and seed the dataset
			if (plain.datasets) {
				if (!dry) for (const name of plain.datasets) seedDataset(name, side);
				return { reason: 'refused', staleSec: age };
			}
			// a reference with nothing behind it: drop the page so the next network view fetches it whole
			await rep.drop([path]);
			return { reason: 'refused', staleSec: age };
		}
		const planned = route.query?.plan !== undefined;
		// a bare public HTML list URL renders the stored page; other reads use the held rows
		const bareHtml = search === '' && route.strategy !== 'data' && route.scope === 'public';
		// stored data is the load output, not the origin's page; a bare plan goes to the network
		if (planned && bareHtml) return { reason: 'refused', staleSec: age };
		const rows =
			queried === undefined || planned || bareHtml
				? undefined
				: (listRows ?? (await rep.datasets.rows(queried)));
		if (queried !== undefined && !planned && !bareHtml && !rows)
			return { reason: 'refused', staleSec: age };
		const tables =
			queried !== undefined && planned
				? await rep.datasets.tables(queried, joined)
				: undefined;
		if (queried !== undefined && planned && !tables)
			return { reason: 'refused', staleSec: age };
		const rendered = await renderLocal(
			config,
			route,
			plain.artifact,
			renderers,
			search,
			rows,
			tables
		);
		if (!rendered.ok) {
			// a collection that fails its proof is dropped, so the next network view fetches it whole
			if (rendered.reason === PROOF_MISMATCH) await rep.drop([path]);
			return { reason: 'refused', staleSec: age };
		}
		if (fromCatalogue) {
			await rep.open(path);
			if (REASON_TIER[reason] === 'local') reason = 'catalogue';
		}
		return { reason, html: rendered.html, headers, staleSec: age };
	}

	/** the route pattern of a same-origin referrer, `external` for another origin, else undefined */
	function referrerRoute(referrer: string): string | undefined {
		let url: URL;
		try {
			url = new URL(referrer);
		} catch {
			return undefined;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
		if (url.origin !== origin) return FROM_EXTERNAL;
		return matchRoute(config.routes, url.pathname)?.route.pattern;
	}

	async function navigate(
		path: string,
		route: SerializedRoute,
		request: Request
	): Promise<Response> {
		const shadow = runsShadow(config, route, random);
		// a top-level load is a new page lifetime; a frame belongs to a page that stays open
		if (request.destination === '' || request.destination === 'document') liveRenewals = 0;
		const at = now();
		const gapMs = lastViewAt === null ? null : at - lastViewAt;
		lastViewAt = at;
		currentPath = route.catalogue ? path : null;
		const decision = await decide(path, route, shadow, new URL(request.url).search);

		const from = referrerRoute(request.referrer);
		const id = crypto.randomUUID();
		latestView.delete(path);
		latestView.set(path, id);
		if (latestView.size > 64) latestView.delete(latestView.keys().next().value as string);
		const view = (mismatch: boolean | null): ViewEvent => ({
			id,
			crossOriginLoads: null,
			tier: shadow ? 'shadow' : REASON_TIER[decision.reason],
			reason: decision.reason,
			staleSec: decision.staleSec,
			engine,
			scope: route.scope,
			strategy: route.strategy,
			route: route.pattern,
			mismatch,
			swAgeMs: at - startedAt,
			gapMs,
			...(from ? { from } : {}),
			...(lifetimes === undefined ? {} : { lifetimes })
		});
		const record = async (mismatch: boolean | null) => {
			if (config.views !== false) await analytics.record(viewToBeacon(view(mismatch), at));
		};

		if (shadow) {
			const html = decision.html;
			return passthrough(request, true, {
				clone: html !== undefined,
				route,
				run: async (network) => {
					await record(
						html === undefined || !network ? null : await differs(html, network)
					);
				}
			});
		}
		if (decision.response) {
			ledger.serve(path);
			track(record(null));
			return decision.response;
		}
		if (decision.html === undefined) {
			const keeps = route.strategy === 'static';
			const response = await passthrough(request, true, {
				clone: keeps || ((res, envelope) => derivable(path, route, res, envelope)),
				route,
				run: async (copy, envelope) => {
					if (keeps) await capture(path, route, copy);
					else await derive(path, route, copy, envelope);
					await record(null);
				}
			});
			if (route.scope === 'principal' && refusesSession(response)) await dropPrincipal(path);
			return response;
		}
		ledger.serve(path, decision.reason === 'catalogue');
		track(record(null));
		const headers = new Headers(decision.headers);
		headers.set('content-type', 'text/html; charset=utf-8');
		return new Response(decision.html, { headers });
	}

	/** whether the server answered a principal page with a refusal or a redirect, as to a signed-out visitor */
	function refusesSession(response: Response): boolean {
		return (
			response.status === 401 ||
			response.status === 403 ||
			response.type === 'opaqueredirect' ||
			(response.status >= 300 && response.status < 400)
		);
	}

	async function dropPrincipal(path: string): Promise<void> {
		const side = await principalSide();
		if (side) await side.replica.drop([path]);
	}

	/**
	 * answers a GET for a `data` route from the stored value; the page makes no request. A
	 * principal route answers from the signed-in partition, and a cross-origin one only a request
	 * with an `Authorization` header. A public route never answers one. A cross-origin miss goes
	 * out untouched: a spool header on it would force a CORS preflight.
	 * A bearer read of a public route goes out the same way, so the public store never sees it.
	 */
	async function dataFile(
		request: Request,
		path: string,
		route: SerializedRoute
	): Promise<Response> {
		const url = new URL(request.url);
		const remote = url.origin !== origin;
		const signed = request.headers.has('authorization');
		// a public route holds no copy per viewer, so a bearer read never takes the store
		const bearer = signed && route.scope === 'public';
		// the API answers a cross-origin read with no header as anonymous, so the partition never does
		const anonymous = remote && route.scope === 'principal' && !signed;
		const decision: Decision =
			bearer || anonymous
				? { reason: 'refused', staleSec: null }
				: await decide(path, route, false, url.search);
		if (decision.html !== undefined) {
			ledger.serve(path, decision.reason === 'catalogue');
			const headers = new Headers(decision.headers);
			headers.set('content-type', route.type ?? 'application/json');
			if (remote) {
				headers.set('access-control-allow-origin', origin);
				headers.set('vary', 'origin');
			}
			return new Response(decision.html, { headers });
		}
		if (remote || bearer) return deps.fetch(request);
		const response = await passthrough(request, false, {
			provision: true,
			route,
			run: async () => undefined
		});
		if (route.scope === 'principal' && refusesSession(response)) await dropPrincipal(path);
		return response;
	}

	/** the stored bytes of a static file, with the headers it was fetched with */
	async function readStatic(path: string): Promise<Response | undefined> {
		const cache = await cacheNamed(staticCache);
		return cache.match(keyOf(path));
	}

	/**
	 * Keeps the response a static route's network answer produced. The bytes go in the Cache
	 * first, then the replica record that makes them servable, so a record always has its bytes.
	 * Nothing is kept for a redirect, an error, a file over the cap, or one the manifest's version
	 * does not describe; the next view asks the network again.
	 */
	async function capture(
		path: string,
		asked: SerializedRoute,
		copy: Response | null
	): Promise<void> {
		if (!copy || copy.status !== 200 || copy.redirected) {
			// an unread tee branch holds every chunk the visitor reads
			void copy?.body?.cancel().catch(() => undefined);
			return;
		}
		// a sync in the same view may have replaced the manifest, so the route is read again
		const route = config.manifest ? matchRoute(config.routes, pathOf(path))?.route : asked;
		if (route?.strategy !== 'static') return;
		const bytes = await readCapped(copy, MAX_STATIC_BYTES);
		if (!bytes) return;
		const type = copy.headers.get('content-type') ?? 'application/octet-stream';
		let artifact: Artifact;
		if (config.manifest) {
			const version = route.version;
			if (version === undefined || !(await matchesVersion(version, bytes, copy.headers))) {
				return;
			}
			artifact = {
				protocol: PROTOCOL_VERSION,
				id: path,
				scope: 'public',
				strategy: 'static',
				deps: [],
				vector: 0,
				body: { type, bytes: bytes.byteLength, version }
			};
		} else {
			let envelope: Envelope;
			try {
				envelope = decodeEnvelope(copy.headers);
			} catch {
				return;
			}
			const advertised = envelope.artifact;
			if (envelope.protocol !== PROTOCOL_VERSION || !advertised) return;
			if (advertised.id !== path || advertised.scope !== 'public') return;
			artifact = {
				protocol: PROTOCOL_VERSION,
				id: path,
				scope: 'public',
				strategy: 'static',
				deps: advertised.deps,
				vector: advertised.version,
				body: { type, bytes: bytes.byteLength }
			};
		}
		const cache = await cacheNamed(staticCache);
		await cache.put(
			keyOf(path),
			new Response(bytes as BodyInit, { headers: replayHeaders(copy.headers) })
		);
		if (await replica.put(artifact, true)) {
			ledger.spend(path, { bytes: bytes.byteLength, requests: 0 });
		}
	}

	/** whether a cold navigation's body can stand in for the artifact its response advertises */
	function derivable(
		path: string,
		route: SerializedRoute,
		response: Response,
		envelope: Envelope | undefined
	): boolean {
		const advertised = envelope?.artifact;
		return (
			(route.strategy === 'assembly' || route.strategy === 'template') &&
			route.family === undefined &&
			route.scope === 'public' &&
			envelope?.protocol === PROTOCOL_VERSION &&
			advertised?.hash !== undefined &&
			advertised.id === path &&
			advertised.scope === 'public' &&
			modeFor(config, route) !== 'shadow' &&
			!declined.has(path) &&
			response.status === 200 &&
			!response.redirected &&
			/text\/html/i.test(response.headers.get('content-type') ?? '')
		);
	}

	/**
	 * The artifact a navigation body carries, or null. An `assembly` page is the artifact's shell
	 * once the client tag is out, and a `template` page holds the artifact's JSON in its inline
	 * element. Either must hash to the value `Spool-Artifact` named.
	 */
	async function carried(
		path: string,
		route: SerializedRoute,
		text: string,
		advertised: EnvelopeArtifact & { hash: string }
	): Promise<{ artifact: Artifact; bytes: number } | null> {
		if (route.strategy === 'template') {
			const json = readInline(text);
			if (json === null || (await shellHash(json)) !== advertised.hash) return null;
			const artifact = parseArtifact(JSON.parse(json));
			if (artifact.id !== path || artifact.scope !== 'public') return null;
			if (artifact.strategy !== 'template') return null;
			return { artifact, bytes: encoder.encode(json).length };
		}
		const at = text.indexOf(config.clientTag);
		const shells =
			at < 0 ? [text] : [text.slice(0, at) + text.slice(at + config.clientTag.length), text];
		for (const shell of shells) {
			if ((await shellHash(shell)) !== advertised.hash) continue;
			return {
				artifact: {
					protocol: PROTOCOL_VERSION,
					id: path,
					scope: 'public',
					strategy: 'assembly',
					deps: [...new Set(advertised.deps)],
					vector: advertised.version,
					body: { shell }
				},
				bytes: 0
			};
		}
		return null;
	}

	/**
	 * Keeps the artifact a navigation's own body carries, when it matches the hash `Spool-Artifact`
	 * named. Anything else leaves nothing stored, and the advertised artifact is then fetched as
	 * before.
	 */
	async function derive(
		path: string,
		route: SerializedRoute,
		copy: Response | null,
		envelope: Envelope | undefined
	): Promise<void> {
		const advertised = envelope?.artifact;
		if (!copy || !advertised?.hash || !derivable(path, route, copy, envelope)) return;
		// a wipe while the body is read means the copy predates it, so it is not kept
		const epoch = replica.epoch;
		try {
			const bytes = await readCapped(copy, MAX_STATIC_BYTES);
			if (!bytes) return;
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			const found = await carried(path, route, text, {
				...advertised,
				hash: advertised.hash
			});
			if (!found || (await replica.get(path)) || replica.epoch !== epoch) return;
			if (await replica.put(found.artifact, route.persist)) {
				ledger.spend(path, { bytes: found.bytes, requests: 0 });
			}
		} catch {
			// an unreadable body leaves the network fetch as the only way to the artifact
		}
	}

	async function staticFile(
		request: Request,
		path: string,
		route: SerializedRoute
	): Promise<Response> {
		const decision = await decide(path, route, false);
		if (decision.response) {
			ledger.serve(path);
			return decision.response;
		}
		return passthrough(request, false, {
			clone: true,
			run: (copy) => capture(path, route, copy)
		});
	}

	/** reads the manifest from the Cache, or the network when the Cache has none; leaves the routes empty if neither answers */
	async function loadManifest(): Promise<void> {
		try {
			const cache = await cacheNamed(staticCache);
			const kept = await cache.match(new Request(config.manifest as string));
			if (kept) {
				config.routes = manifestRoutes(parseManifest(JSON.parse(await kept.text())));
				return;
			}
			await refreshManifest();
		} catch {
			manifestLoad = undefined;
		}
	}

	/**
	 * Fetches the manifest and takes its routes. The sync answer names every stored file whose
	 * route is gone or whose version changed, which the replica then drops.
	 */
	async function refreshManifest(): Promise<SyncResponse> {
		const url = config.manifest as string;
		const response = await deps.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
		if (!response.ok) throw new Error(`manifest answered ${response.status}`);
		const text = await response.text();
		const routes = manifestRoutes(parseManifest(JSON.parse(text)));
		config.routes = routes;
		const cache = await cacheNamed(staticCache);
		await cache.put(
			new Request(url),
			new Response(text, { headers: { 'content-type': 'application/json' } })
		);
		const dropped: string[] = [];
		for (const id of await replica.ids()) {
			const stored = await replica.get(id);
			if (stored?.artifact.strategy !== 'static') continue;
			const hit = matchRoute(routes, pathOf(id));
			if (!hit || stored.artifact.body.version !== hit.route.version) dropped.push(id);
		}
		return {
			protocol: PROTOCOL_VERSION,
			cursor: replica.cursor ?? 0,
			changed: {},
			dropped,
			reset: false
		};
	}

	/** answers an immutable same-origin asset from its Cache entry; the handle is opened once */
	async function asset(request: Request): Promise<Response> {
		const cache = await cacheNamed(assetCache);
		const cacheable = !request.headers.has('range');
		if (cacheable) {
			const hit = await cache.match(request);
			if (hit) return hit;
		}
		await ready();
		const response = await passthrough(request, false);
		if (cacheable && response.status === 200 && immutable(response)) {
			track(cache.put(request, response.clone()));
		}
		return response;
	}

	/** holds a cross-origin collector hit and answers the page at once */
	async function collect(request: Request, collector: CollectorConfig): Promise<Response> {
		await ready();
		if (!(await analytics.enqueue(request, collector))) return deps.fetch(request);
		return collectorAnswer(request);
	}

	// #region third-party files

	const third = config.thirdParty;
	const thirdKey = (request: Request) => new Request(request.url);

	/** answers an allowed origin's GET from a held copy; a first sight goes to the network and may be kept */
	async function thirdParty(request: Request): Promise<Response> {
		const cache = await cacheNamed(THIRD_CACHE);
		const hit = await cache.match(thirdKey(request));
		if (hit) return hit;
		const response = await deps.fetch(request);
		if (response.status === 200 && (response.type !== 'opaque' || third?.allowOpaque)) {
			const kind: VersionClass | null =
				response.type === 'opaque'
					? 'immutable'
					: versionClass(new URL(request.url), response.headers, third?.versioned);
			if (kind) track(keepThird(request, response.clone(), kind));
		}
		return response;
	}

	async function keepThird(
		request: Request,
		response: Response,
		kind: VersionClass
	): Promise<void> {
		const cache = await cacheNamed(THIRD_CACHE);
		let stored = response;
		if (response.type !== 'opaque') {
			const headers = new Headers(response.headers);
			headers.set(THIRD_HEADERS.class, kind);
			headers.set(THIRD_HEADERS.fetched, String(now()));
			stored = new Response(await response.arrayBuffer(), { status: 200, headers });
		}
		await cache.put(thirdKey(request), stored);
		const keys = await cache.keys();
		const limit = third?.maxEntries ?? 64;
		if (keys.length <= limit) return;
		const aged: Array<{ key: Request; at: number }> = [];
		for (const key of keys) {
			const held = await cache.match(key);
			aged.push({ key, at: Number(held?.headers.get(THIRD_HEADERS.fetched) ?? 0) });
		}
		aged.sort((a, b) => a.at - b.at);
		for (const { key } of aged.slice(0, keys.length - limit)) await cache.delete(key);
	}

	/** checks the held copies that are only weakly versioned and old, at a network moment */
	async function revalidateThirdParty(): Promise<void> {
		if (!third) return;
		const cache = await cacheNamed(THIRD_CACHE);
		const after = third.revalidateAfterMs ?? DAY_MS;
		for (const key of await cache.keys()) {
			const held = await cache.match(key);
			if (!held || held.headers.get(THIRD_HEADERS.class) !== 'revalidate') continue;
			const fetchedAt = Number(held.headers.get(THIRD_HEADERS.fetched) ?? 0);
			if (now() - fetchedAt < after) continue;
			try {
				const fresh = await deps.fetch(
					new Request(key.url, { cache: 'no-cache', mode: 'cors', credentials: 'omit' })
				);
				if (fresh.status === 200 && fresh.type !== 'opaque') {
					await keepThird(key, fresh, 'revalidate');
				}
			} catch {
				// the held copy stays until a later moment reaches the origin
			}
		}
	}

	// #endregion

	async function run(request: Request): Promise<Response> {
		await ready();
		const declared = writeFor(
			config.resourceWrites ?? [],
			request.method,
			new URL(request.url),
			origin
		);
		if (declared) return declaredWrite(request, declared);
		const route = classify(config, request, origin);
		track(analytics.flushIfDue());
		if (route.kind === 'logout') {
			// held beacons still carry this session; sent after the logout they would carry the next one
			await analytics.sendSameOrigin(LOGOUT_SEND_MS).catch(() => undefined);
			await wipePartition('logout');
			return passthrough(request, request.mode === 'navigate', {
				signedOut: true,
				run: async () => undefined
			});
		}
		if (route.kind === 'collector') return collect(request, route.collector);
		if (route.kind === 'thirdparty') return thirdParty(request);
		if (route.kind === 'beacon') {
			if (await analytics.enqueue(request)) return new Response(null, { status: 204 });
			return passthrough(request, false);
		}
		if (route.kind === 'navigation') return navigate(route.path, route.route, request);
		if (route.kind === 'static') return staticFile(request, route.path, route.route);
		if (route.kind === 'data') return dataFile(request, route.path, route.route);
		if (route.kind === 'asset') return asset(request);
		return passthrough(request, request.mode === 'navigate');
	}

	// a cold worker otherwise loses the document to the network while it starts
	async function navigationRoute(event: RoutableInstall): Promise<void> {
		if (typeof event.addRoutes !== 'function') return;
		try {
			await event.addRoutes([
				{ condition: { requestMode: 'navigate' }, source: 'fetch-event' }
			]);
		} catch {
			// a refused route leaves the browser's default race in place
		}
	}

	return {
		replica,
		ledger,
		handle(request, wait) {
			const pending = sweepWrites();
			if (pending) wait(pending);
			const kind = classify(config, request, origin).kind;
			if (kind === 'ignore') return undefined;
			if (kind === 'asset' && assetMode !== 'cache') {
				return forwardsAssets && shouldForward(cachePath) ? deps.fetch(request) : undefined;
			}
			// a worker in shadow touches only navigations: subresources and beacons keep the browser's own path
			if (
				observing &&
				kind !== 'navigation' &&
				kind !== 'static' &&
				request.mode !== 'navigate'
			) {
				return undefined;
			}
			const before = new Set(background);
			if (forwardsAssets && request.mode === 'navigate' && !probed) {
				probed = true;
				const url = new URL(clientPath(config.version), origin).href;
				const probe = probeCache(
					url,
					(input, init) => deps.fetch(input, init),
					resourceTiming
				);
				track(
					probe.then((result) => {
						cachePath = result;
					})
				);
			}
			const work = kind === 'asset' && !manifestPending() ? asset(request) : run(request);
			return work
				.catch(() => deps.fetch(request))
				.finally(() => wait(settleBackground(before)));
		},
		async install(event) {
			if (assetMode === 'static-routing') routed = await installRoutes(event, config, origin);
			else await navigationRoute(event);
			if (config.pack && pack) await adoptPack(pack, config.pack);
			// the stub is the server's answer, so an install that reads it is a contact
			if (config.stamp !== undefined || config.pack !== undefined) contacted();
		},
		async activate() {
			const pending = sweepWrites();
			if (pending) track(pending);
			await ready();
			if (config.policy !== undefined && replica.sitePolicy === undefined) {
				const policy = allowedPolicy(config.policy);
				if (policy) await replica.keepPolicy(null, policy);
			}
			for (const name of await deps.caches.keys()) {
				const old = CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
				if (old && name !== assetCache && name !== staticCache)
					await deps.caches.delete(name);
			}
		},
		async message(data) {
			const pending = sweepWrites();
			if (pending) track(pending);
			const message = (data ?? {}) as { type?: unknown; protocol?: unknown };
			if (message.type === 'spool:hello') {
				return {
					type: 'spool:hello',
					protocol: PROTOCOL_VERSION,
					version: config.version,
					compatible: message.protocol === PROTOCOL_VERSION,
					...(config.lease === undefined ? {} : { lease: config.lease }),
					...(lastContact === 0 ? {} : { contact: lastContact })
				};
			}
			if (message.type === 'spool:status') {
				await ready();
				return {
					type: 'spool:status',
					cursor: replica.cursor,
					syncedAt: replica.syncedAt,
					artifacts: await replica.ids(),
					beacons: (await storage.readBeacons()).length
				};
			}
			if (message.type === 'spool:view') {
				const path = (message as { path?: unknown }).path;
				return {
					type: 'spool:view',
					id: (typeof path === 'string' && latestView.get(path)) || null
				};
			}
			if (message.type === 'spool:loads') {
				const { view, count, origins } = message as {
					view?: unknown;
					count?: unknown;
					origins?: unknown;
				};
				if (
					typeof view === 'string' &&
					typeof count === 'number' &&
					config.views !== false
				) {
					await ready();
					const named =
						typeof origins === 'object' && origins !== null && !Array.isArray(origins)
							? (origins as Record<string, number>)
							: undefined;
					await analytics.record(loadsToBeacon(view, count, now(), named));
				}
				return undefined;
			}
			if (message.type === 'spool:lifetimes') {
				const count = (message as { count?: unknown }).count;
				if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
					lifetimes = count;
				}
				return undefined;
			}
			if (message.type === 'spool:graph') {
				await ready();
				await replica.held();
				return {
					type: 'spool:graph',
					records: replica.graph.records.ids(),
					projections: replica.graph.projections.ids()
				};
			}
			if (message.type === 'spool:ledger') {
				return { type: 'spool:ledger', entries: ledger.entries(), totals: ledger.totals() };
			}
			if (message.type === 'spool:partition') {
				const side = await principalSide();
				if (!side) {
					return {
						type: 'spool:partition',
						partition: null,
						artifacts: [],
						records: [],
						projections: [],
						datasets: []
					};
				}
				await side.replica.held();
				return {
					type: 'spool:partition',
					partition: side.id,
					artifacts: await side.replica.ids(),
					records: side.replica.graph.records.ids(),
					projections: side.replica.graph.projections.ids(),
					datasets: await side.replica.datasets.list()
				};
			}
			if (message.type === 'spool:live-state') return liveState();
			if (message.type === 'spool:live') {
				const { partition, event, delta, leaseMs } = message as Record<string, unknown>;
				if (partition !== null && typeof partition !== 'string') return undefined;
				if (event === 'revoked') return liveEvent({ partition, event });
				if (event === 'session') return liveEvent({ partition: null, event });
				if (event === 'lease' && typeof leaseMs === 'number' && leaseMs > 0) {
					return liveEvent({ partition, event, leaseMs });
				}
				if (event === 'delta') {
					try {
						return liveEvent({ partition, event, delta: parseLiveDelta(delta) });
					} catch {
						return undefined;
					}
				}
				return undefined;
			}
			if (message.type === 'spool:assets') {
				return { type: 'spool:assets', mode: assetMode, routed };
			}
			if (message.type === 'spool:datasets') {
				await ready();
				return {
					type: 'spool:datasets',
					datasets: await replica.datasets.list(),
					outcomes: { ...datasetCounts },
					refused: Object.fromEntries(datasetRefused),
					declined: Object.fromEntries(declined),
					evicted: replica.datasets.evicted,
					persisted
				};
			}
			if (message.type === 'spool:persisted') {
				persisted = (message as { granted?: unknown }).granted === true;
				return undefined;
			}
			if (message.type === 'spool:write') {
				const { name, key, value, version } = message as Record<string, unknown>;
				const queue = await pageQueue();
				return {
					type: 'spool:write',
					result:
						queue instanceof WriteQueue
							? await queue.write(
									typeof name === 'string' ? name : '',
									typeof key === 'string' ? key : '',
									value,
									version
								)
							: queue
				};
			}
			if (message.type === 'spool:flush') {
				const queue = await pageQueue();
				return {
					type: 'spool:flush',
					result:
						queue instanceof WriteQueue ? { ok: true, ...(await queue.flush()) } : queue
				};
			}
			if (message.type === 'spool:writes') {
				const queue = await pageQueue();
				return {
					type: 'spool:writes',
					result:
						queue instanceof WriteQueue
							? { ok: true, writes: await queue.list() }
							: queue
				};
			}
			if (message.type === 'spool:resolve') {
				const { name, key, use } = message as Record<string, unknown>;
				const queue = await pageQueue();
				return {
					type: 'spool:resolve',
					result:
						queue instanceof WriteQueue
							? await queue.resolve(
									typeof name === 'string' ? name : '',
									typeof key === 'string' ? key : '',
									use as 'local' | 'server'
								)
							: queue
				};
			}
			if (message.type === 'spool:held') {
				const cache = await cacheNamed(THIRD_CACHE);
				return {
					type: 'spool:held',
					dropped: Object.fromEntries(analytics.dropped),
					third: (await cache.keys()).map((k) => k.url).sort()
				};
			}
			return undefined;
		}
	};
}
