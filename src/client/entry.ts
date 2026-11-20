import { navigatePath } from '../protocol/config.js';
import { RING_ELEMENT_ID, WRITES_ELEMENT_ID } from '../protocol/ring.js';
import { CLIENT_TAG_ATTR } from '../protocol/tag.js';
import type { ResourceWrite, WriteRefusal } from '../protocol/write.js';
import { createPackStore } from '../sw/pack/store.js';
import { VERSION } from '../version.js';
import { browserActivityHost, createActivity } from './activity.js';
import { bootstrap, parseRing } from './bootstrap.js';
import { declaredFetch, parseWrites, type SpoolFetch } from './declared.js';
import { browserLiveDeps, startLive } from './live.js';
import { crossOriginLoads, crossOriginOrigins } from './loads.js';
import type { NavigateOptions } from './navigate.js';
import { register, type SpoolClient } from './register.js';

function openStore(): ReturnType<typeof createPackStore> | null {
	try {
		return createPackStore();
	} catch {
		return null;
	}
}

type Navigation = { go(url: URL): void };
type EnableNavigation = (options: NavigateOptions) => Navigation;

/** what the gate and the boot script leave for the runtime: the clicked URL and the carried pack */
type Boot = {
	to?: string;
	router?: true;
	pack?: { version: number; data: string };
	shape?: NonNullable<Parameters<typeof bootstrap>[0]['shape']>;
};

/** the navigation script is in the boot script, or loads here and sets `spoolNavigate` */
function loadNavigation(): Promise<EnableNavigation> {
	const navigate = () =>
		(globalThis as { spoolNavigate?: { enableNavigation: EnableNavigation } }).spoolNavigate;
	const present = navigate();
	if (present) return Promise.resolve(present.enableNavigation);
	return new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = navigatePath(VERSION);
		script.onload = () => {
			const loaded = navigate();
			if (loaded) resolve(loaded.enableNavigation);
			else reject(new Error('navigation script did not register'));
		};
		script.onerror = () => reject(new Error('navigation script failed to load'));
		document.head.append(script);
	});
}

const carried = (globalThis as { __SPOOL_BOOT__?: Boot }).__SPOOL_BOOT__;
// the click the gate held back, loaded as a document if the held pack cannot answer it
const pending = carried?.to;
const leave = () => (pending ? location.assign(pending) : undefined);

// no IndexedDB leaves the page on the old path: the worker registers at once
const store = openStore();
const boot = store
	? bootstrap({
			store,
			...(carried?.pack ? { pack: carried.pack } : {}),
			...(carried?.shape ? { shape: carried.shape } : {}),
			router: carried?.router === true
		})
	: { worker: true, installed: Promise.resolve(), current: true };
const ready: Promise<SpoolClient | null> = (boot.worker ? register() : Promise.resolve(null)).catch(
	() => null
);

// in-page navigation needs a held site pack; a page without one navigates as it always did
void boot.installed
	.then(async () => {
		// the routes held are older than this page's, so it navigates by document until a click reloads them
		if (!store || !boot.current || !(await store.head())) return leave();
		const enable = await loadNavigation();
		const templates = await store.getTemplates();
		const tag = document.querySelector<HTMLScriptElement>(`script[${CLIENT_TAG_ATTR}]`);
		const navigation = enable({ store, clientTag: tag?.outerHTML ?? '', templates });
		if (pending) navigation.go(new URL(pending));
	})
	.catch(leave);

const gone: WriteRefusal = {
	ok: false,
	code: 'unavailable',
	message: 'there is no worker on this page'
};
let queued = false;

/** the write calls, each answered with a refusal when the page has no worker */
const writes = {
	write: async (...args: Parameters<SpoolClient['write']>) => {
		const result = await ready.then((client) => client?.write(...args) ?? gone);
		if (result.ok) queued = true;
		return result;
	},
	flush: () => ready.then((client) => client?.flush() ?? gone),
	writes: () => ready.then((client) => client?.writes() ?? gone),
	resolve: (...args: Parameters<SpoolClient['resolve']>) =>
		ready.then((client) => client?.resolve(...args) ?? gone)
};

/** the writes a no-worker page declares: its ring's, or the element a page with no ring carries */
function declaredWrites(): ResourceWrite[] {
	const ring = parseRing(document.getElementById(RING_ELEMENT_ID)?.textContent);
	if (ring) return ring.writes ?? [];
	return parseWrites(document.getElementById(WRITES_ELEMENT_ID)?.textContent);
}

// a page with a worker sends writes through fetch, where the worker settles them
const declared = store && !boot.worker ? declaredWrites() : [];
const spoolFetch: SpoolFetch =
	store && declared.length > 0
		? declaredFetch({ store, writes: declared, origin: location.origin })
		: (input, init) => fetch(input, init);

(
	globalThis as {
		spool?: {
			ready: Promise<SpoolClient | null>;
			activity: ReturnType<typeof createActivity>;
			fetch: SpoolFetch;
		} & typeof writes;
	}
).spool = {
	ready,
	activity: createActivity(browserActivityHost()),
	fetch: spoolFetch,
	...writes
};

// queued values go out when the page is hidden, which is a moment the browser gives us
const flushQueued = () => {
	if (queued) void writes.flush();
};
void ready.then((client) => {
	if (!client) return;
	addEventListener('pagehide', flushQueued);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushQueued();
	});
});

void ready.then(async (client) => {
	const id = await client?.view().catch(() => null);
	if (!client || !id) return;
	let last = -1;
	const report = () => {
		const own = document.querySelector<HTMLScriptElement>(`script[${CLIENT_TAG_ATTR}]`)?.src;
		const entries = performance.getEntriesByType('resource');
		const count = crossOriginLoads(entries, location.origin, own ? [own] : []);
		if (count === last) return;
		last = count;
		client.reportLoads(
			id,
			count,
			crossOriginOrigins(entries, location.origin, own ? [own] : [])
		);
	};
	addEventListener('pagehide', report);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') report();
	});
});

// the stream a visible page holds for the principal lease; a wipe or a switch reopens it for the new partition
void ready.then((client) => {
	const deps = client && browserLiveDeps(client);
	if (!deps) return;
	const live = startLive(deps);
	addEventListener('spool:cleared', live.reconcile);
	addEventListener('spool:want-live', live.arm);
});
