import { PROTOCOL_VERSION } from '../protocol/artifact.js';
import type { SwConfig } from '../protocol/config.js';
import { idbStorage } from './idb.js';
import { idbPartitions } from './partition.js';
import type { Renderers } from './render.js';
import { createRuntime } from './runtime.js';

/** the runtime version of a worker that has no server; a new value empties what an old one stored */
export const STATIC_RUNTIME = 'static-1';

/** the file a static site serves beside `spool-sw.js` */
export const MANIFEST_FILE = 'spool.json';

/** the config of a worker with no spool server: its routes come from `spool.json` next to `workerUrl` */
export function manifestConfig(workerUrl: string): SwConfig {
	return {
		protocol: PROTOCOL_VERSION,
		version: STATIC_RUNTIME,
		routes: [],
		templates: {},
		beacons: [],
		clientTag: '',
		views: false,
		manifest: new URL(MANIFEST_FILE, workerUrl).href
	};
}

/**
 * Starts the worker: registers the install, activate, fetch and message handlers on the worker
 * scope. `renderers` replaces the built-in render for the route patterns it names. The shared
 * core calls this with the config the server prepended; a site that bundles its own worker calls
 * it directly.
 */
export function serve(config: SwConfig, renderers?: Renderers): void {
	const scope = self as unknown as ServiceWorkerGlobalScope;
	const runtime = createRuntime({
		config,
		storage: idbStorage(),
		fetch: (input, init) => fetch(input, init),
		caches,
		origin: scope.location.origin,
		renderers,
		partitions: typeof indexedDB === 'undefined' ? undefined : idbPartitions(),
		broadcast: (message) =>
			void scope.clients
				.matchAll({ type: 'window', includeUncontrolled: true })
				.then((all) => all.forEach((client) => client.postMessage(message)))
	});

	scope.addEventListener('install', (event) =>
		event.waitUntil(
			Promise.all([
				scope.skipWaiting(),
				runtime.install(event as unknown as Parameters<typeof runtime.install>[0])
			])
		)
	);
	scope.addEventListener('activate', (event) =>
		event.waitUntil(Promise.all([runtime.activate(), scope.clients.claim()]))
	);
	scope.addEventListener('fetch', (event) => {
		const response = runtime.handle(event.request, (promise) => event.waitUntil(promise));
		if (response) event.respondWith(response);
	});
	scope.addEventListener('message', (event) => {
		event.waitUntil(
			runtime.message(event.data).then((reply) => {
				if (!reply) return;
				const port = event.ports[0];
				if (port) port.postMessage(reply);
				else (event.source as Client | null)?.postMessage(reply);
			})
		);
	});
}
