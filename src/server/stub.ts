import type { SwConfig } from '../protocol/config.js';
import { SW_CORE } from './embedded.js';

/** the worker script: the config as data, then the shared core or the site's own bundle */
export function workerScript(config: SwConfig, core: string = SW_CORE): string {
	return `self.__SPOOL_CONFIG__=${JSON.stringify(config)};\n${core}`;
}

/**
 * The `/spool-sw.js` response. The script lives a day in the browser's cache, which is what lets
 * a controlled navigation skip the update check; a deploy changes the bytes and is picked up
 * within that bound.
 */
export function workerResponse(script: string): Response {
	return new Response(script, {
		headers: {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'max-age=86400',
			'service-worker-allowed': '/'
		}
	});
}
