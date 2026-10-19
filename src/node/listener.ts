import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** a Fetch-style handler; return `undefined` to hand the request to the next Node middleware */
export type FetchHandler = (
	request: Request
) => Response | undefined | Promise<Response | undefined>;

/** options for {@link toNodeListener} */
export type NodeListenerOptions = {
	/** the origin to build request URLs from, such as `https://example.edu`; default is the Host header */
	origin?: string;
};

/** the Fetch `Request` for a Node request */
export function toRequest(
	req: IncomingMessage,
	res: ServerResponse,
	options: NodeListenerOptions = {}
): Request {
	const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
	const origin =
		options.origin ?? `${encrypted ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
	}
	const controller = new AbortController();
	res.once('close', () => {
		if (!res.writableFinished) controller.abort();
	});
	const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
	return new Request(new URL(req.url ?? '/', origin), {
		method: req.method,
		headers,
		signal: controller.signal,
		...(body ? { body: body as ReadableStream, duplex: 'half' } : {})
	} as RequestInit);
}

/** writes a Fetch `Response` to a Node response, streaming the body */
export async function writeResponse(
	res: ServerResponse,
	response: Response,
	head = false
): Promise<void> {
	res.statusCode = response.status;
	if (response.statusText) res.statusMessage = response.statusText;
	for (const [name, value] of response.headers) {
		if (name !== 'set-cookie') res.setHeader(name, value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) res.setHeader('set-cookie', cookies);
	if (head || !response.body) {
		res.end();
		return;
	}
	await pipeline(Readable.fromWeb(response.body as never), res);
}

/**
 * Bridges `node:http` to a Fetch handler, with no dependency. The result is also an Express
 * middleware: when the handler returns `undefined` and a `next` callback exists it is called,
 * otherwise the reply is a 404. A handler that throws gets a 500 (or the socket is destroyed if
 * headers are already out).
 */
export function toNodeListener(
	handler: FetchHandler,
	options: NodeListenerOptions = {}
): (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => Promise<void> {
	return async (req, res, next) => {
		try {
			const response = await handler(toRequest(req, res, options));
			if (!response) {
				if (next) return next();
				res.statusCode = 404;
				res.end();
				return;
			}
			await writeResponse(res, response, req.method === 'HEAD');
		} catch (error) {
			if (res.headersSent) {
				res.destroy(error instanceof Error ? error : undefined);
				return;
			}
			if (next) return next(error);
			res.statusCode = 500;
			res.setHeader('content-type', 'text/plain');
			res.end('internal error');
		}
	};
}
