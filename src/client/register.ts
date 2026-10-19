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
	/** where `spool:cleared` is dispatched; default `window` */
	target?: Pick<EventTarget, 'dispatchEvent'>;
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
	// the worker tells every page when it wipes the principal store, so a page can blank what it shows
	container.addEventListener?.('message', (event) => {
		const data = event.data as { type?: unknown; reason?: unknown } | null;
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
	const worker = registration.active;
	if (!worker) throw new Error('the worker is not active');
	const hello = await ask<Hello>(
		worker,
		{ type: 'spool:hello', protocol: PROTOCOL_VERSION },
		timeout
	);
	return {
		registration,
		hello,
		status: () => ask<Status>(registration.active ?? worker, { type: 'spool:status' }, timeout),
		view: async (path = location.pathname) =>
			(
				await ask<ViewId>(
					registration.active ?? worker,
					{ type: 'spool:view', path },
					timeout
				)
			).id,
		reportLoads: (id, count, origins) =>
			(registration.active ?? worker).postMessage({
				type: 'spool:loads',
				view: id,
				count,
				origins
			}),
		track: (db) => closeOnPageHide(db)
	};
}
