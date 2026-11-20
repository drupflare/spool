/** how a framework renders a route, as the plugin reads it */
export type RenderMode = {
	/** `prerender` is built ahead, `server` per request, `client` in the browser, `streaming` as a stream */
	rendering: 'prerender' | 'server' | 'client' | 'streaming';
	/** every param set is known: no params, a declared dataset, or a params() enumerator */
	enumerable: boolean;
	/** seconds a revalidating route may serve stale; absent when the route does not revalidate */
	revalidate?: number;
};

/** what a route becomes in spool; `template` is for the server-side adapters, not framework routes */
export type Register = 'family' | 'template' | 'shell' | 'network';

/** the registration of one route, with `maxAge` in seconds when it revalidates */
export type Registration = { register: Register; maxAge?: number; reason: string };

/** maps a route's render mode to how spool registers it */
export function registerMode(mode: RenderMode): Registration {
	if (mode.rendering === 'streaming') {
		return {
			register: 'network',
			reason: 'streaming or server components: payload not captured per param'
		};
	}
	if (mode.rendering === 'client') {
		return { register: 'shell', reason: 'client-only: app shell plus data routes' };
	}
	const rendered = mode.rendering === 'prerender' ? 'prerendered' : 'server-rendered';
	if (!mode.enumerable) {
		return { register: 'network', reason: `${rendered} without enumerable params` };
	}
	const reason = `${rendered} with enumerable params`;
	return mode.revalidate === undefined
		? { register: 'family', reason }
		: { register: 'family', maxAge: mode.revalidate, reason };
}
