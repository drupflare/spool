import { defineEventHandler, toWebRequest, type H3Event } from 'h3';
import { devCoverage } from '../../plugins/coverage.js';
import { PATHS } from '../../protocol/config.js';
import type { Spool } from '../../server/spool.js';

/** the Nitro handler for `/spool-sw.js` and `/.spool/**`, answered from `spool` */
export function spoolHandler(spool: Spool) {
	return defineEventHandler(async (event) => {
		const request = toWebRequest(event);
		if (new URL(request.url).pathname === PATHS.worker && request.method === 'GET') {
			return spool.stub(request);
		}
		return (await spool.respond(request)) ?? new Response('not found', { status: 404 });
	});
}

type RenderResponse = {
	body?: unknown;
	headers?: Record<string, string | string[]>;
	statusCode?: number;
};

type NitroApp = {
	hooks: {
		hook(
			name: 'render:response',
			fn: (response: RenderResponse, context: { event: H3Event }) => Promise<void>
		): unknown;
		hook(name: 'request', fn: (event: H3Event) => void): unknown;
	};
};

/**
 * The Nitro plugin that decorates each server-rendered page with spool's envelope and tag. In
 * development (`NODE_ENV` is not `production`) it also logs each fetch or XHR GET of this server that
 * no data family covers.
 */
export function spoolPlugin(spool: Spool) {
	return (nitroApp: NitroApp) => {
		const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
			.process?.env;
		if (env !== undefined && env['NODE_ENV'] !== 'production') {
			const watch = devCoverage(spool.config.routes, (line) => console.info(line));
			nitroApp.hooks.hook('request', (event) => {
				const request = toWebRequest(event);
				watch({
					method: request.method,
					url: request.url,
					fetchDest: request.headers.get('sec-fetch-dest')
				});
			});
		}
		nitroApp.hooks.hook('render:response', async (response, { event }) => {
			if (typeof response.body !== 'string') return;
			const headers = new Headers();
			for (const [name, value] of Object.entries(response.headers ?? {})) {
				headers.set(name, String(value));
			}
			const answer = new Response(response.body, {
				status: response.statusCode ?? 200,
				headers
			});
			const decorated = await spool.decorate(toWebRequest(event), answer);
			const out: Record<string, string | string[]> = {};
			for (const [name, value] of decorated.headers) {
				if (name !== 'set-cookie' && name !== 'content-length') out[name] = value;
			}
			const cookies = decorated.headers.getSetCookie();
			if (cookies.length > 0) out['set-cookie'] = cookies;
			response.headers = out;
			response.body = await decorated.text();
		});
	};
}
