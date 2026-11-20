import { access, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { StaticSink } from '../server/static.js';

/** a static sink that writes each path under `root`, creating folders as it goes */
export function fileStaticSink(root: string): StaticSink {
	return {
		async put(path, bytes) {
			const file = join(root, path);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, bytes);
		},
		async has(path) {
			return access(join(root, path)).then(
				() => true,
				() => false
			);
		}
	};
}

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
		...(body ? { body: body as unknown as ReadableStream, duplex: 'half' } : {})
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
		void response.body?.cancel().catch(() => undefined);
		res.end();
		return;
	}
	// pipeline attaches many close listeners to the reply; pipe with ended attaches few
	const body = Readable.fromWeb(response.body as never);
	// the reply only sees 'close' when the socket is destroyed, so the body's own error is kept for the caller
	let failure: unknown;
	body.on('error', (error) => {
		failure = error;
		res.destroy(error);
	});
	res.once('close', () => body.destroy());
	body.pipe(res);
	await ended(res).catch((error: unknown) => {
		throw failure ?? error;
	});
}

/**
 * Settles when the reply finishes, fails or closes, and removes its own listeners. `stream.finished`
 * keeps listeners on the response after it settles.
 */
function ended(res: ServerResponse): Promise<void> {
	return new Promise((resolve, reject) => {
		const detach = () => {
			res.off('finish', onFinish);
			res.off('error', onError);
			res.off('close', onClose);
		};
		const onFinish = () => {
			detach();
			resolve();
		};
		const onError = (error: Error) => {
			detach();
			reject(error);
		};
		const onClose = () => {
			detach();
			reject(new Error('the connection closed before the reply ended'));
		};
		res.on('finish', onFinish);
		res.on('error', onError);
		res.on('close', onClose);
	});
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
