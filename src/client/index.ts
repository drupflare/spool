import type { createActivity } from './activity.js';
import type { SpoolFetch } from './declared.js';
import type { SpoolClient } from './register.js';

export type { Hello, Status } from '../sw/runtime.js';
export * from './activity.js';
export * from './lifecycle.js';
export { enableNavigation, type NavigateOptions } from './navigate.js';
export * from './register.js';

declare global {
	interface Window {
		/** the page runtime, set once it loads; absent on a page without spool */
		spool?: {
			/** resolves to the client handle, or to null where service workers do not exist */
			ready: Promise<SpoolClient | null>;
			/** lets the page hand spool a pause and a resume for one of its loops */
			activity: ReturnType<typeof createActivity>;
			/** a fetch for a page without a worker; settles declared writes and passes other requests on */
			fetch: SpoolFetch;
			/** queues a value as the newest for a declared write class and key */
			write: SpoolClient['write'];
			/** sends every queued value now; call it before a logout navigation */
			flush: SpoolClient['flush'];
			/** the state of each queued value of the signed-in partition, without the values */
			writes: SpoolClient['writes'];
			/** settles a conflicted key with the local value or the server's */
			resolve: SpoolClient['resolve'];
		};
	}
}
