import { PATHS } from '../protocol/config.js';
import { HEADERS } from '../protocol/envelope.js';
import { writeFor } from '../protocol/write.js';
import type { Spool } from '../server/spool.js';

/** the parts of a Hono context the middleware uses, so the package needs no `hono` types */
export type SpoolHonoContext = {
	/** the request side of the Hono context */
	req: {
		/** the Fetch `Request` for the incoming request */
		raw: Request;
	};
	/** the response the route produced, or `undefined` before one exists */
	res: Response | undefined;
};

/**
 * Hono middleware for a spool. Mount it with `app.use('*', spoolHono(spool))`. Spool's own paths
 * are answered before the routes run. A declared write runs through `spool.handle`: the route
 * answers it, and the answer carries `Spool-Delta` or the digest. A GET that a route answers with a
 * 200 HTML page gets the envelope and the client tag. Every other response is left as the
 * application made it.
 */
export function spoolHono(spool: Spool) {
	return async (
		c: SpoolHonoContext,
		next: () => Promise<void>
	): Promise<Response | undefined> => {
		const request = c.req.raw;
		if (new URL(request.url).pathname === PATHS.worker && request.method === 'GET') {
			return spool.stub(request);
		}
		const early = await spool.respond(request);
		if (early) return early;
		const url = new URL(request.url);
		if (writeFor(spool.config.resourceWrites ?? [], request.method, url, url.origin)) {
			const decorated = await spool.handle(request, async () => {
				await next();
				return c.res ?? new Response('not found', { status: 404 });
			});
			// the setter copies the old response's headers over the new one, so clear it first
			c.res = undefined;
			c.res = decorated;
			return undefined;
		}
		await next();
		const response = c.res;
		if (!response) return undefined;
		if (!isHtmlPage(request, response) && !request.headers.has(HEADERS.have)) return undefined;
		const decorated = await spool.decorate(request, response);
		// the setter copies the old response's headers over the new one, so clear it first
		c.res = undefined;
		c.res = decorated;
		return undefined;
	};
}

function isHtmlPage(request: Request, response: Response): boolean {
	return (
		request.method === 'GET' &&
		response.status === 200 &&
		(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html') &&
		!response.headers.has('content-encoding')
	);
}
