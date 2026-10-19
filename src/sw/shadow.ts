import type { SwConfig } from '../protocol/config.js';
import { equivalent } from '../protocol/normalise.js';
import type { SerializedRoute } from '../protocol/route.js';
import type { Mode } from '../protocol/view.js';

/** the mode a route runs in: its own, else the server's, else `serve` */
export function modeFor(config: SwConfig, route: SerializedRoute): Mode {
	return route.mode ?? config.mode ?? 'serve';
}

/**
 * Whether this view runs in shadow: always on a shadow route, and on `shadowSample` of the views
 * of a serve route. A sampled view goes to the network like a shadow one, which is what the sample costs.
 */
export function runsShadow(
	config: SwConfig,
	route: SerializedRoute,
	random: () => number
): boolean {
	if (route.strategy === 'static') return false;
	if (modeFor(config, route) === 'shadow') return true;
	const sample = config.shadowSample ?? 0;
	return sample > 0 && random() < sample;
}

/**
 * Whether the network's answer differs from the local render after normalisation. Anything but a
 * 200 counts as a difference, since local would have shown a page where the origin did not. Reads
 * the body, so pass a clone.
 */
export async function differs(local: string, network: Response): Promise<boolean> {
	if (network.status !== 200) return true;
	return !equivalent(local, await network.text()).equal;
}
