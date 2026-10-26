import { CLIENT_TAG_ATTR } from '../protocol/tag.js';
import { browserActivityHost, createActivity } from './activity.js';
import { crossOriginLoads, crossOriginOrigins } from './loads.js';
import { register, type SpoolClient } from './register.js';

const ready: Promise<SpoolClient | null> = register().catch(() => null);

(
	globalThis as {
		spool?: {
			ready: Promise<SpoolClient | null>;
			activity: ReturnType<typeof createActivity>;
		};
	}
).spool = { ready, activity: createActivity(browserActivityHost()) };

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
