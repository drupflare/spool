import type { BundleDelta } from '../protocol/bundle.js';
import { BUNDLE_DELTA_PREFIX, COOKIES } from '../protocol/config.js';
import { DELTA_ELEMENT_ID, type Ring, RING_ELEMENT_ID } from '../protocol/ring.js';
import type { SerializedRoute } from '../protocol/route.js';
import type { CompiledTemplate } from '../protocol/template/compile.js';
import { engineOf } from '../protocol/view.js';
import { viewStamps } from '../protocol/views.js';
import type { PackHead, PackStore } from '../sw/pack/store.js';
import { askPersistence } from './persist.js';

/** what `bootstrap` takes; every field but `store` defaults to the page */
export type BootstrapOptions = {
	store: PackStore;
	/** the document that carries the ring and any delta; default `document` */
	doc?: Pick<Document, 'getElementById'> & Partial<Pick<Document, 'querySelector'>>;
	/** keeps the view and lifetime counts; `null` counts every load as a first view */
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	/** fetches the pack and a delta; default `fetch` */
	fetch?: typeof fetch;
	/** the storage manager persistence is asked of; default `navigator.storage` */
	manager?: Pick<StorageManager, 'persist' | 'persisted'>;
	/** picks the engine; default `navigator.userAgent` */
	userAgent?: string;
	/** writes the held-version cookie; default sets `document.cookie` */
	cookie?: (value: string) => void;
	/**
	 * the pack the boot script carried, as base64; a ring at the same version installs it at once,
	 * with no request, on any view. It is decoded only when the install needs it.
	 */
	pack?: { version: number; data: string };
	/**
	 * the routes and templates the boot script carried, with the id the ring's `boot` names. A ring
	 * with no routes of its own takes them from here when the ids match; otherwise the boot script
	 * was cached before a deploy changed them, and `current` is false.
	 */
	shape?: { id: string; routes: SerializedRoute[]; templates: Record<string, CompiledTemplate> };
	/**
	 * a client router took the click that loaded the boot script, so the page never makes the
	 * document views that register the worker; it registers on this view
	 */
	router?: boolean;
};

type HeldDelta = { from: number; to: number; text: string };

const VIEWS_KEY = 'spool:views';
const STAMPS_KEY = 'spool:stamps';
const LIFETIMES_KEY = 'spool:lifetimes';
const BOOT_KEY = 'spool:boot';
/** the cookie outlives a browser restart, so the first navigation after one still carries its version */
const HELD_MAX_AGE = 604_800;

function isPack(value: unknown): boolean {
	const pack = value as { url?: unknown; bytes?: unknown } | null;
	return (
		typeof pack === 'object' &&
		pack !== null &&
		typeof pack.url === 'string' &&
		Number.isSafeInteger(pack.bytes)
	);
}

/** the ring a document carries, or null when the text is missing, not JSON or not a ring */
export function parseRing(text: string | null | undefined): Ring | null {
	if (!text) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const ring = value as Record<string, unknown>;
	const ok =
		ring['protocol'] === 1 &&
		Number.isSafeInteger(ring['version']) &&
		typeof ring['digest'] === 'string' &&
		(ring['routes'] === undefined || Array.isArray(ring['routes'])) &&
		(ring['templates'] === undefined ||
			(typeof ring['templates'] === 'object' &&
				ring['templates'] !== null &&
				!Array.isArray(ring['templates']))) &&
		typeof ring['tables'] === 'object' &&
		ring['tables'] !== null &&
		!Array.isArray(ring['tables']) &&
		typeof ring['complete'] === 'boolean' &&
		(ring['bootstrap'] === 'first-view' || ring['bootstrap'] === 'second-view') &&
		(ring['worker'] === 'auto' || ring['worker'] === 'never') &&
		(ring['pack'] === undefined ? ring['complete'] === true : isPack(ring['pack'])) &&
		(ring['writes'] === undefined || Array.isArray(ring['writes'])) &&
		(ring['lease'] === undefined || Number.isSafeInteger(ring['lease']));
	return ok ? (value as Ring) : null;
}

/** adds one to the count at `key`; a throwing storage or a non-count value starts at 1 */
function bump(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key: string): number {
	try {
		const seen = Number(storage?.getItem(key) ?? 0);
		const next = (Number.isSafeInteger(seen) && seen >= 0 ? seen : 0) + 1;
		storage?.setItem(key, String(next));
		return next;
	} catch {
		return 1;
	}
}

/**
 * the views this page counts: the ones a lease period still covers when the ring names a lease, else
 * the lifetime count; a throwing storage counts one, as `bump` does
 */
function windowed(
	storage: Pick<Storage, 'getItem' | 'setItem'> | null,
	lifetime: number,
	lease: number | undefined
): number {
	if (!((lease ?? 0) > 0)) return lifetime;
	try {
		const stamps = viewStamps(
			storage?.getItem(STAMPS_KEY) ?? '',
			Date.now(),
			(lease ?? 0) * 1000
		);
		storage?.setItem(STAMPS_KEY, stamps.join());
		return stamps.length;
	} catch {
		return 1;
	}
}

/** the text of the ring element; null where there is no document to read it from */
function ringText(doc: BootstrapOptions['doc']): string | null | undefined {
	try {
		return (doc ?? document).getElementById(RING_ELEMENT_ID)?.textContent;
	} catch {
		return null;
	}
}

/** the delta a document carries for a page that holds an older version; no text is a pointer to fetch */
function heldDelta(doc: BootstrapOptions['doc']): HeldDelta | undefined {
	try {
		const element = (doc ?? document).getElementById(DELTA_ELEMENT_ID);
		if (!element) return undefined;
		const from = Number(element.getAttribute('data-from'));
		const to = Number(element.getAttribute('data-to'));
		if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from)
			return undefined;
		return { from, to, text: element.textContent ?? '' };
	} catch {
		return undefined;
	}
}

/**
 * whether the page must not ask for a worker: the ring says so, or the page tag does when there is
 * no ring. A ring page on WebKit asks only when the site chose `always`; the engine is read from the
 * user agent.
 */
function neverPage(doc: BootstrapOptions['doc'], ring: Ring | null, userAgent: string): boolean {
	if (ring) {
		return (
			ring.worker === 'never' ||
			(ring.webkitWorker !== true && engineOf(userAgent) === 'webkit')
		);
	}
	try {
		return (doc ?? document).querySelector?.('script[data-spool-worker="never"]') != null;
	} catch {
		return false;
	}
}

function localStore(): Storage | null {
	try {
		return localStorage;
	} catch {
		return null;
	}
}

/** sends the pack count to the worker that controls this page, if any */
function reportLifetimes(storage: Pick<Storage, 'getItem'> | null): void {
	try {
		const count = Number(storage?.getItem(LIFETIMES_KEY) ?? 0);
		if (Number.isSafeInteger(count) && count > 0) {
			navigator.serviceWorker?.controller?.postMessage({ type: 'spool:lifetimes', count });
		}
	} catch {
		// a throwing storage or a page without a worker API keeps the view as it was
	}
}

/**
 * What a view does. A `second-view` ring fetches the pack from view 2 (view 1 only writes the ring)
 * and registers the worker from view 3, where `view` counts the views in one lease period; `first-view`
 * does both on view 1. A document with no ring
 * keeps the old path: the worker registers at once, unless the page names no worker. A pack the
 * boot script carried at the ring's version installs on any view, since it costs no request. A
 * `router` view, one a client router's click loaded the boot script for, registers the worker too.
 */
function gate(
	ring: Ring | null,
	view: number,
	never: boolean,
	carried: boolean,
	router: boolean
): { pack: boolean; worker: boolean } {
	if (!ring) return { pack: false, worker: !never };
	const late = ring.bootstrap === 'second-view';
	return {
		pack: !ring.complete && (carried || view >= (late ? 2 : 1)),
		worker: !never && (router || view >= (late ? 3 : 1))
	};
}

async function* chunks(body: ReadableStream<Uint8Array<ArrayBuffer>>) {
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		yield value;
	}
}

async function* fromBoot(data: string) {
	const text = atob(data);
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	yield bytes;
}

/** writes the ring, then the pack when the gate asks; returns the version the store now holds in full */
async function install(
	options: BootstrapOptions,
	storage: Pick<Storage, 'getItem' | 'setItem'> | null,
	ring: Ring,
	fetchPack: boolean
): Promise<number | undefined> {
	const { store } = options;
	try {
		// a partial head holds a ring, not a pack, so it does not count as held
		const head = (await store.head()) as (PackHead & { partial?: boolean }) | undefined;
		if (head && head.partial !== true && head.version >= ring.version) {
			// routes and templates have no version, so the same version refreshes them
			if (head.version === ring.version && ring.routes) {
				await store.putRoutes(ring.routes, ring.templates);
			}
			return head.version;
		}
		const placed = await store.installRing(ring);
		if (ring.complete) return placed?.installed ? ring.version : undefined;
		if (!fetchPack || !ring.pack) return undefined;
		const fit = await store.estimateBeforeInstall(ring.pack.bytes);
		if (!fit.fits) return undefined;
		let source: AsyncIterable<Uint8Array<ArrayBuffer>>;
		if (options.pack?.version === ring.version) {
			source = fromBoot(options.pack.data);
		} else {
			const response = await (options.fetch ?? fetch)(ring.pack.url);
			if (!response.ok || !response.body) return undefined;
			source = chunks(response.body);
		}
		const outcome = await store.installPack(source, { bytes: ring.pack.bytes });
		if (!outcome.installed) return undefined;
		if (ring.routes) await store.putRoutes(ring.routes, ring.templates);
		bump(storage, LIFETIMES_KEY);
		// Chromium decides by heuristics and does not prompt; Firefox asks the user, so it is left out
		if (engineOf(options.userAgent ?? navigator.userAgent) === 'chromium') {
			await askPersistence(options.manager ?? navigator.storage);
		}
		return ring.version;
	} catch {
		// the page keeps working from the network and the ring
		return undefined;
	}
}

/** the ring with the routes and templates this page can trust: its own, or the boot script's when the ids match */
function withRoutes(ring: Ring, shape: BootstrapOptions['shape']): Ring | undefined {
	if (ring.routes && ring.templates) return ring;
	const id = /[?&]r=([0-9a-f]+)/.exec(ring.boot ?? '')?.[1];
	if (!shape || id === undefined || shape.id !== id) return undefined;
	return { ...ring, routes: shape.routes, templates: shape.templates };
}

/** applies a delta to the complete head it starts from; returns the version the store now holds */
async function applyHeld(options: BootstrapOptions, delta: HeldDelta): Promise<number | undefined> {
	const { store } = options;
	const head = (await store.head()) as (PackHead & { partial?: boolean }) | undefined;
	if (!head || head.partial === true || head.version !== delta.from) return undefined;
	let body: BundleDelta | undefined = delta.text ? JSON.parse(delta.text) : undefined;
	if (!body) {
		const response = await (options.fetch ?? fetch)(
			`${BUNDLE_DELTA_PREFIX}${delta.from}/${delta.to}`
		);
		if (!response.ok) return undefined;
		body = (await response.json()) as BundleDelta;
	}
	await store.applyDelta(body);
	return delta.to;
}

/** keeps the version this page holds in a cookie, so the next document navigation can carry its delta */
export function holdCookie(options: Pick<BootstrapOptions, 'cookie'>, version: number): void {
	const value = `${COOKIES.held}=${version}; path=/; max-age=${HELD_MAX_AGE}; samesite=lax`;
	try {
		if (options.cookie) options.cookie(value);
		else document.cookie = value;
	} catch {
		// without the cookie the next navigation carries no delta and the page is still correct
	}
}

/** applies the delta and the ring, then holds the version a no-worker page ends on */
async function settle(
	options: BootstrapOptions,
	storage: Pick<Storage, 'getItem' | 'setItem'> | null,
	ring: Ring | null,
	fetchPack: boolean,
	never: boolean
): Promise<void> {
	let version: number | undefined;
	try {
		const delta = heldDelta(options.doc);
		if (delta) version = await applyHeld(options, delta);
		if (ring) version = (await install(options, storage, ring, fetchPack)) ?? version;
		if (version === undefined) {
			const head = (await options.store.head()) as
				(PackHead & { partial?: boolean }) | undefined;
			if (head && head.partial !== true) version = head.version;
		}
		if (never && version !== undefined) holdCookie(options, version);
	} catch {
		// the page keeps working from the network and the ring
	}
}

/**
 * Counts this view, reads the ring from `doc` and starts the install the view calls for. `worker`
 * says whether the page registers the worker now; `installed` settles once the ring, any delta and
 * any pack are in the store. Never throws.
 */
export function bootstrap(options: BootstrapOptions): {
	worker: boolean;
	installed: Promise<void>;
	current: boolean;
} {
	const storage = options.storage === undefined ? localStore() : options.storage;
	const lifetime = bump(storage, VIEWS_KEY);
	reportLifetimes(storage);
	const ring = parseRing(ringText(options.doc));
	const trusted = ring && withRoutes(ring, options.shape);
	const current = ring === null || trusted !== undefined;
	if (!current) {
		try {
			// the next click loads the boot script the ring names, which holds the current routes
			storage?.setItem(BOOT_KEY, '');
		} catch {
			// the stored boot script is checked again on the next document
		}
	}
	const never = neverPage(
		options.doc,
		ring,
		options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
	);
	const decision = gate(
		ring,
		windowed(storage, lifetime, ring?.lease),
		never,
		ring !== null && options.pack?.version === ring.version,
		options.router === true
	);
	const installed = settle(options, storage, trusted ?? null, decision.pack, never);
	return { worker: decision.worker, installed, current };
}
