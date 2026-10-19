import type { SwConfig } from '../protocol/config.js';

/** one rule of `InstallEvent.addRoutes`, the parts spool writes */
export type RouterRule = {
	condition: Record<string, unknown>;
	source: 'fetch-event' | 'network';
};

/** the `InstallEvent` of a browser with Static Routing; `addRoutes` is absent elsewhere */
export type RoutableInstall = { addRoutes?(rules: RouterRule[]): Promise<void> };

/**
 * The rules that send only what the worker handles to its `fetch` event and every other
 * same-origin request to the network: navigations, the beacon, logout and routed paths first, and
 * cross-origin requests too when collectors or a third-party cache are configured. Rules apply in
 * order, so the last one catches the rest of the origin. Spool path patterns (`/n/:id`) are valid
 * URLPattern syntax, so they pass through as written.
 */
export function staticRoutingRules(config: SwConfig, origin: string): RouterRule[] {
	const at = (path: string) => `${origin}${path}`;
	const rules: RouterRule[] = [{ condition: { requestMode: 'navigate' }, source: 'fetch-event' }];
	for (const path of config.beacons) {
		rules.push({
			condition: { urlPattern: at(path), requestMethod: 'POST' },
			source: 'fetch-event'
		});
	}
	for (const path of config.logout ?? []) {
		rules.push({ condition: { urlPattern: at(path) }, source: 'fetch-event' });
	}
	for (const route of config.routes) {
		if (route.strategy === 'static' || route.strategy === 'data') {
			rules.push({ condition: { urlPattern: at(route.pattern) }, source: 'fetch-event' });
		}
	}
	if ((config.collectors?.length ?? 0) > 0 || config.thirdParty) {
		rules.push({
			condition: { not: { urlPattern: at('/*') } },
			source: 'fetch-event'
		});
	}
	rules.push({ condition: { urlPattern: at('/*') }, source: 'network' });
	return rules;
}

/**
 * Registers the rules when the browser has the API. Returns whether they took effect; a browser
 * without `addRoutes`, or one that refuses a rule, leaves the worker to act as `passthrough`.
 */
export async function installRoutes(
	event: RoutableInstall,
	config: SwConfig,
	origin: string
): Promise<boolean> {
	if (typeof event.addRoutes !== 'function') return false;
	try {
		await event.addRoutes(staticRoutingRules(config, origin));
		return true;
	} catch {
		return false;
	}
}
