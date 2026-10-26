import { parseArtifact, PROTOCOL_VERSION, type Artifact } from '../protocol/artifact.js';
import { MAX_WANT, type BeaconEvent, type CatalogueAsk } from '../protocol/beacon.js';
import { applyStamp, type CollectorConfig } from '../protocol/collector.js';
import { PATHS, type AssetMode, type SwConfig } from '../protocol/config.js';
import {
	decodeEnvelope,
	decodeEnvelopeOrClear,
	HEADERS,
	type Envelope,
	type EnvelopeArtifact
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
import { BeaconQueue, LOGOUT_SEND_MS } from './analytics.js';
import { collectorAnswer } from './collect.js';
import { verdict } from './freshness.js';
import type { PartitionHost } from './partition.js';
import { policyHeaders, type HeaderSet } from './policy.js';
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
	matchesVersion,
	MAX_STATIC_BYTES,
	readCapped,
	replayHeaders,
	STATIC_CACHE
} from './static.js';
import type { ReplicaStorage } from './storage.js';
import { THIRD_CACHE, THIRD_HEADERS, versionClass, type VersionClass } from './thirdparty.js';

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
};

/** the worker's answer to a page's `spool:hello` */
export type Hello = { type: 'spool:hello'; protocol: number; version: string; compatible: boolean };

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
};

/** the worker's answer to `spool:assets`: the mode asked for and whether Static Routing took effect */
export type AssetsStatus = { type: 'spool:assets'; mode: AssetMode; routed: boolean };

/** the worker's answer to `spool:held`: events dropped past a vendor's cap, and the third-party files held */
export type HeldStatus = {
	type: 'spool:held';
	dropped: Record<string, number>;
	third: string[];
};

/** every reply the worker gives a page */
export type Reply =
	| Hello
	| Status
	| ViewId
	| GraphStatus
	| LedgerStatus
	| PartitionStatus
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
	const replica = new Replica(storage, config.version, now);
	const ledger = new Ledger();
	const background = new Set<Promise<unknown>>();
	const provisioning = new Map<string, Promise<void>>();
	const declined = new Set<string>();
	const wants = new Set<string>();
	const asked = new Set<string>();
	let currentPath: string | null = null;
	const latestView = new Map<string, string>();
	const assetCache = `${ASSET_CACHE}${config.version}`;
	const staticCache = `${STATIC_CACHE}${config.version}`;
	const keyOf = (path: string) => new Request(`${origin}${path}`);
	const startedAt = now();
	const assetMode: AssetMode = config.assets ?? 'cache';
	let routed = false;
	let lastViewAt: number | null = null;
	let loaded: Promise<void> | undefined;
	let manifestLoad: Promise<void> | undefined;
	let partitionLoad: Promise<void> | undefined;
	let principal: Side | null = null;
	let exclusive: Promise<unknown> = Promise.resolve();
	const observing = config.mode === 'shadow';
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

	const settleBackground = async () => {
		while (background.size > 0) await Promise.allSettled([...background]);
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
	const catalogueAsk = (): CatalogueAsk | undefined =>
		currentPath !== null ? { path: currentPath, sweep: true } : undefined;

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
		loaded: Promise.resolve()
	};
	const scheduler = publicSide.scheduler;

	// #region partitions

	const retentionOf = (id: string): Retention =>
		matchRoute(config.routes, id)?.route.retention ?? 'session';
	const sharedRetention = (): Retention =>
		config.routes.some((r) => r.scope === 'principal' && r.retention === 'persistent')
			? 'persistent'
			: 'session';

	function makeSide(id: string): Side {
		const sealed = (host as PartitionHost).open(id, retentionOf, sharedRetention());
		const target = new Replica(sealed, config.version, now);
		return {
			id,
			replica: target,
			scheduler: makeScheduler(target),
			deferred: new Set(),
			loaded: target.load()
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

	/** shuts the principal store, shreds its keys and deletes it; true when there was one */
	function wipePartition(reason: string): Promise<boolean> {
		return serial(async () => {
			await ready();
			const old = principal;
			principal = null;
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
			await (host as PartitionHost).setCurrent(id);
			if (old) {
				await (host as PartitionHost).destroy(old.id as string);
				deps.broadcast?.({ type: 'spool:cleared', reason: 'partition' });
			}
		});
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
		if (!host || !envelope || envelope.protocol !== PROTOCOL_VERSION) return;
		await ready();
		const clear = envelope.clear ?? [];
		if (clear.includes('*') || (principal && clear.includes(principal.id as string))) {
			await wipePartition('clear');
			return;
		}
		// the answer to a logout request still names the identity of the request it answered
		if (signedOut) return;
		if (envelope.partition !== undefined) {
			if (principal?.id !== envelope.partition) await switchTo(envelope.partition);
		} else if (navigation && principal) await wipePartition('session-ended');
	}

	// #endregion

	async function provision(
		path: string,
		route: SerializedRoute,
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
			declined.add(path);
			return;
		}
		if (!response.ok) {
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
		}
	}

	async function drainDeferred(side: Side): Promise<void> {
		const paths = [...side.deferred];
		side.deferred.clear();
		if (await side.scheduler.drain())
			for (const path of paths) await side.replica.validate(path);
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
					hit.route.scope === advertised.scope &&
					!declined.has(advertised.id) &&
					own &&
					(advertised.scope === 'public' || own.id === envelope.partition);
				if (hit && own && fits && !(await own.replica.get(advertised.id))) {
					if (advertised.scope === 'public' && modeFor(config, hit.route) === 'shadow') {
						wants.add(advertised.id);
					} else {
						const key = `${advertised.scope}:${advertised.id}`;
						const pending =
							provisioning.get(key) ??
							provision(advertised.id, hit.route, envelope.partition);
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
			await analytics.flushAtMoment();
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
		const response = await deps.fetch(outgoing);
		const envelope = decodeEnvelopeOrClear(response.headers);
		await early(envelope, navigation, after?.signedOut);
		// a cacheable GET may be answered by the HTTP cache with no radio wake, so only these count
		const moment = navigation || request.method !== 'GET';
		const clone = after?.clone;
		const copy = (typeof clone === 'function' ? clone(response, envelope) : clone)
			? response.clone()
			: null;
		track(
			(async () => {
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
		return response;
	}

	/** `search` is the request's query string; the stored artifact is always the path's own */
	async function decide(
		path: string,
		route: SerializedRoute,
		dry: boolean,
		search = ''
	): Promise<Decision> {
		let side = publicSide;
		if (route.scope === 'principal') {
			if (!host) return { reason: 'principal', staleSec: null };
			const own = await principalSide();
			if (!own) return { reason: 'cold', staleSec: null };
			side = own;
		}
		const { replica: rep, scheduler: sched } = side;
		let stored = await rep.get(path);
		if (!stored) return { reason: 'cold', staleSec: null };
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

		const fromCatalogue = stored.catalogue === true;
		const action = verdict(route.freshness, rep.validatedAt(stored), now());
		const age = staleSec() as number;
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
				if (!synced && route.offline === 'refuse')
					return { reason: 'hard-refused', staleSec: age };
				if (synced) {
					if (need) await rep.validate(path);
					stored = await rep.get(path);
					if (!stored || !rep.isCurrent(stored.artifact)) {
						return { reason: 'stale-after-sync', staleSec: age };
					}
				} else reason = 'offline-stale';
			}
		} else if (action === 'serve-then-sync') {
			if (route.sync === 'deferred') {
				reason = 'soft-deferred';
				if (!dry && need && sched.defer(need, age)) side.deferred.add(path);
			} else {
				reason = 'soft-sync';
				if (!dry) {
					track(
						sched.sync(need, age).then(async (ok) => {
							if (ok && need) await rep.validate(path);
						})
					);
				}
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
		// never answer a page locally without the policy the site sent with it
		const headers = rep.policyOf(path) ?? replica.sitePolicy;
		if (!headers && !dry) return { reason: 'refused', staleSec: age };
		const plain = await rep.materialize(stored.artifact);
		if (!plain.ok) {
			// a reference with nothing behind it: drop the page so the next network view fetches it whole
			await rep.drop([path]);
			return { reason: 'refused', staleSec: age };
		}
		const rendered = await renderLocal(config, route, plain.artifact, renderers, search);
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
			...(from ? { from } : {})
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

	/** answers a GET for a `data` route from the stored value; the page makes no request */
	async function dataFile(
		request: Request,
		path: string,
		route: SerializedRoute
	): Promise<Response> {
		const decision = await decide(path, route, false, new URL(request.url).search);
		if (decision.html !== undefined) {
			ledger.serve(path, decision.reason === 'catalogue');
			const headers = new Headers(decision.headers);
			headers.set('content-type', route.type ?? 'application/json');
			return new Response(decision.html, { headers });
		}
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
		if (!copy || copy.status !== 200 || copy.redirected) return;
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

	return {
		replica,
		ledger,
		handle(request, wait) {
			const kind = classify(config, request, origin).kind;
			if (kind === 'ignore') return undefined;
			if (kind === 'asset' && assetMode !== 'cache') return undefined;
			// a worker in shadow touches only navigations: subresources and beacons keep the browser's own path
			if (
				observing &&
				kind !== 'navigation' &&
				kind !== 'static' &&
				request.mode !== 'navigate'
			) {
				return undefined;
			}
			const work = kind === 'asset' && !manifestPending() ? asset(request) : run(request);
			return work.catch(() => deps.fetch(request)).finally(() => wait(settleBackground()));
		},
		async install(event) {
			if (assetMode === 'static-routing') routed = await installRoutes(event, config, origin);
		},
		async activate() {
			await ready();
			for (const name of await deps.caches.keys()) {
				const old = CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
				if (old && name !== assetCache && name !== staticCache)
					await deps.caches.delete(name);
			}
		},
		async message(data) {
			const message = (data ?? {}) as { type?: unknown; protocol?: unknown };
			if (message.type === 'spool:hello') {
				return {
					type: 'spool:hello',
					protocol: PROTOCOL_VERSION,
					version: config.version,
					compatible: message.protocol === PROTOCOL_VERSION
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
						projections: []
					};
				}
				await side.replica.held();
				return {
					type: 'spool:partition',
					partition: side.id,
					artifacts: await side.replica.ids(),
					records: side.replica.graph.records.ids(),
					projections: side.replica.graph.projections.ids()
				};
			}
			if (message.type === 'spool:assets') {
				return { type: 'spool:assets', mode: assetMode, routed };
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
