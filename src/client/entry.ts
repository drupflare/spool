import { CLIENT_TAG_ATTR } from '../protocol/tag.js';
import type { WriteRefusal } from '../protocol/write.js';
import { browserActivityHost, createActivity } from './activity.js';
import { crossOriginLoads, crossOriginOrigins } from './loads.js';
import { register, type SpoolClient } from './register.js';

const ready: Promise<SpoolClient | null> = register().catch(() => null);

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

(
	globalThis as {
		spool?: {
			ready: Promise<SpoolClient | null>;
			activity: ReturnType<typeof createActivity>;
		} & typeof writes;
	}
).spool = { ready, activity: createActivity(browserActivityHost()), ...writes };

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
