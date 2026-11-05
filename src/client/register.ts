import { PROTOCOL_VERSION } from '../protocol/artifact.js';
import { PATHS } from '../protocol/config.js';
import type { Hello, Status, ViewId } from '../sw/runtime.js';
import { closeOnPageHide, type Closable } from './lifecycle.js';

/** what `register` takes */
export type RegisterOptions = {
	/** the worker script; default `/spool-sw.js` */
	workerUrl?: string;
	scope?: string;
	/** how long to wait for the worker's answer to the handshake; default 5000 */
	helloTimeoutMs?: number;
	/** the container to register on; default `navigator.serviceWorker` */
	container?: ServiceWorkerContainer;
	/** where `spool:cleared` and `spool:persisted` are dispatched; default `window` */
	target?: Pick<EventTarget, 'dispatchEvent'>;
	/** the storage manager asked for persistence; default `navigator.storage` */
	storage?: Pick<StorageManager, 'persist' | 'persisted'>;
};

/** the page's handle on the worker */
export type SpoolClient = {
	registration: ServiceWorkerRegistration;
	/** the version handshake; `compatible` is false when the worker speaks another protocol */
	hello: Hello;
	/** asks the worker what it holds */
	status(): Promise<Status>;
	/** the id of this page's view, which the worker made when it handled the navigation; null if it made none */
	view(path?: string): Promise<string | null>;
	/** tells the worker how many cross-origin resources the page loaded, for view `id`, and from which origins */
	reportLoads(id: string, count: number, origins?: Record<string, number>): void;
	/** whether the browser granted persistent storage, or null until the worker held a dataset and the page asked */
	persisted(): boolean | null;
	/** closes `db` when the page is hidden, so the page stays eligible for the back/forward cache */
	track(db: Closable): () => void;
};

function ask<T>(worker: ServiceWorker, message: object, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const channel = new MessageChannel();
		const timer = setTimeout(() => {
			channel.port1.close();
			reject(new Error('the worker did not answer'));
		}, timeoutMs);
		channel.port1.onmessage = (event) => {
			clearTimeout(timer);
			channel.port1.close();
			resolve(event.data as T);
		};
		worker.postMessage(message, [channel.port2]);
	});
}

/**
 * Registers the worker with `updateViaCache: 'all'`, so a controlled navigation skips the script
 * update check inside the script's one-day cache lifetime, then runs the version handshake.
 * Resolves to `null` where service workers do not exist; the page then works as it always did.
 */
export async function register(options: RegisterOptions = {}): Promise<SpoolClient | null> {
	const container = options.container ?? navigator.serviceWorker;
	if (!container) return null;
	const timeout = options.helloTimeoutMs ?? 5000;
	let granted: boolean | null = null;
	let asked = false;
	let worker: ServiceWorker | undefined;
	// persist() is Window-only, so the worker asks a page once after it first holds a dataset; the
	// grant covers IndexedDB the worker writes. Nothing waits on the answer.
	const persist = async () => {
		if (asked) return;
		asked = true;
		const storage = options.storage ?? navigator.storage;
		try {
			granted =
				(await storage?.persisted?.()) === true || (await storage?.persist?.()) === true;
		} catch {
			granted = false;
		}
		(options.target ?? window).dispatchEvent(
			new CustomEvent('spool:persisted', { detail: { granted } })
		);
		(worker ?? container.controller)?.postMessage({ type: 'spool:persisted', granted });
	};
	// the worker tells every page when it wipes the principal store, so a page can blank what it shows
	container.addEventListener?.('message', (event) => {
		const data = event.data as { type?: unknown; reason?: unknown } | null;
		if (data?.type === 'spool:persist') void persist();
		if (data?.type !== 'spool:cleared') return;
		(options.target ?? window).dispatchEvent(
			new CustomEvent('spool:cleared', { detail: { reason: data.reason } })
		);
	});
	await container.register(options.workerUrl ?? PATHS.worker, {
		scope: options.scope,
		updateViaCache: 'all'
	});
	const registration = await container.ready;
	const active = registration.active;
	if (!active) throw new Error('the worker is not active');
	worker = active;
	const hello = await ask<Hello>(
		active,
		{ type: 'spool:hello', protocol: PROTOCOL_VERSION },
		timeout
	);
	return {
		registration,
		hello,
		status: () => ask<Status>(registration.active ?? active, { type: 'spool:status' }, timeout),
		view: async (path = location.pathname) =>
			(
				await ask<ViewId>(
					registration.active ?? active,
					{ type: 'spool:view', path },
					timeout
				)
			).id,
		reportLoads: (id, count, origins) =>
			(registration.active ?? active).postMessage({
				type: 'spool:loads',
				view: id,
				count,
				origins
			}),
		persisted: () => granted,
		track: (db) => closeOnPageHide(db)
	};
}
