import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { toRequest, writeResponse } from '../node/listener.js';
import { PATHS, SPOOL_PREFIX } from '../protocol/config.js';
import { HEADERS } from '../protocol/envelope.js';
import { writeFor } from '../protocol/write.js';
import type { Spool } from '../server/spool.js';

/** the continuation an Express middleware calls; pass an error to fail the request */
export type Next = (error?: unknown) => void;

/**
 * Express middleware for a spool. Mount it with `app.use` before the routes. Spool's own paths are
 * answered here. A declared write runs through `spool.handle`: the application's handler answers it,
 * and the answer carries `Spool-Delta` or the digest. A GET that the application answers with a 200
 * HTML page gets the envelope and the client tag. Every other request reaches the application untouched.
 */
export function spoolExpress(spool: Spool) {
	return async (req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		if (path === PATHS.worker && req.method === 'GET') {
			await writeResponse(res, await spool.stub(toRequest(req, res)));
			return;
		}
		if (path.startsWith(SPOOL_PREFIX)) {
			const early = await spool.respond(toRequest(req, res));
			if (early) {
				await writeResponse(res, early, req.method === 'HEAD');
				return;
			}
		}
		if (req.method !== 'GET') {
			const request = requestHead(req);
			const url = new URL(request.url);
			if (writeFor(spool.config.resourceWrites ?? [], request.method, url, url.origin)) {
				const saved = res.getHeaders();
				try {
					await writeResponse(res, await spool.handle(request, () => replyOf(res, next)));
				} catch (error) {
					if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
					else {
						restoreHeaders(res, saved);
						next(error);
					}
				}
				return;
			}
		}
		if (req.method === 'GET') holdForEnvelope(spool, req, res, next);
		next();
	};
}

/**
 * Holds a GET reply's writes until it ends. A 200 HTML reply goes through `spool.decorate`; any
 * other reply is written through as the application made it.
 */
function holdForEnvelope(
	spool: Spool,
	req: IncomingMessage,
	res: ServerResponse,
	next: Next
): void {
	const { write, end } = res;
	const request = toRequest(req, res);
	const held: Buffer[] = [];
	let holding: boolean | undefined;
	const restoreHead = captureWriteHead(res);
	const restore = () => {
		res.write = write;
		res.end = end;
		restoreHead();
	};
	const holds = (): boolean => {
		if (holding === undefined) {
			holding = isHtmlReply(res) || req.headers[HEADERS.have] !== undefined;
		}
		return holding;
	};

	res.write = ((chunk: unknown, ...args: unknown[]) => {
		if (!holds()) {
			restore();
			return Reflect.apply(write, res, [chunk, ...args]) as boolean;
		}
		held.push(toBuffer(chunk, args[0]));
		const callback = args.at(-1);
		if (typeof callback === 'function') process.nextTick(callback);
		return true;
	}) as ServerResponse['write'];

	res.end = ((chunk?: unknown, ...args: unknown[]) => {
		if (!holds()) {
			restore();
			return Reflect.apply(end, res, [chunk, ...args]) as ServerResponse;
		}
		const done = typeof chunk === 'function' ? chunk : args.at(-1);
		if (chunk !== undefined && typeof chunk !== 'function') held.push(toBuffer(chunk, args[0]));
		restore();
		sendWithEnvelope(spool, request, res, Buffer.concat(held).toString()).then(
			() => {
				if (typeof done === 'function') done();
			},
			(error: unknown) => {
				if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
				else next(error);
			}
		);
		return res;
	}) as ServerResponse['end'];
}

/**
 * The request's URL and headers as a Fetch `Request` without a body. `toRequest` wraps `req` as a body
 * stream, which would take the stream from the application's own body parser.
 */
function requestHead(req: IncomingMessage): Request {
	const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
	const origin = `${encrypted ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
	}
	return new Request(new URL(req.url ?? '/', origin), { method: req.method, headers });
}

/** runs the rest of the Express chain and resolves with the reply it writes, held back from the socket */
function replyOf(res: ServerResponse, next: Next): Promise<Response> {
	return new Promise((resolve) => {
		const { write, end } = res;
		const held: Buffer[] = [];
		const restoreHead = captureWriteHead(res);
		res.write = ((chunk: unknown, ...args: unknown[]) => {
			held.push(toBuffer(chunk, args[0]));
			const callback = args.at(-1);
			if (typeof callback === 'function') process.nextTick(callback);
			return true;
		}) as ServerResponse['write'];
		res.end = ((chunk?: unknown, ...args: unknown[]) => {
			res.write = write;
			res.end = end;
			restoreHead();
			if (chunk !== undefined && typeof chunk !== 'function')
				held.push(toBuffer(chunk, args[0]));
			const done = typeof chunk === 'function' ? chunk : args.at(-1);
			if (typeof done === 'function') process.nextTick(done);
			resolve(replyResponse(res, held));
			return res;
		}) as ServerResponse['end'];
		next();
	});
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function replyResponse(res: ServerResponse, held: Buffer[]): Response {
	const empty = NULL_BODY_STATUS.has(res.statusCode) || held.length === 0;
	return new Response(empty ? null : Buffer.concat(held), {
		status: res.statusCode,
		headers: headersOf(res)
	});
}

/**
 * Turns `res.writeHead(status, headers)` into `statusCode` and `setHeader` calls until the returned
 * function runs. The real writeHead would fix the header block, and the adapter writes the reply
 * itself later; Node's implicit header write uses the same headers.
 */
function captureWriteHead(res: ServerResponse): () => void {
	const writeHead = res.writeHead;
	res.writeHead = ((status: number, ...rest: unknown[]) => {
		res.statusCode = status;
		const headers = typeof rest[0] === 'string' ? rest[1] : rest[0];
		if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
			for (const [name, value] of Object.entries(headers)) {
				if (value !== undefined) res.setHeader(name, value);
			}
		}
		return res;
	}) as ServerResponse['writeHead'];
	return () => {
		res.writeHead = writeHead;
	};
}

function restoreHeaders(res: ServerResponse, saved: OutgoingHttpHeaders): void {
	for (const name of res.getHeaderNames()) res.removeHeader(name);
	for (const [name, value] of Object.entries(saved)) {
		if (value !== undefined) res.setHeader(name, value);
	}
}

function headersOf(res: ServerResponse): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(res.getHeaders())) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) headers.append(name, String(item));
		}
	}
	return headers;
}

function isHtmlReply(res: ServerResponse): boolean {
	const type = String(res.getHeader('content-type') ?? '').toLowerCase();
	return (
		res.statusCode === 200 && type.includes('text/html') && !res.hasHeader('content-encoding')
	);
}

async function sendWithEnvelope(
	spool: Spool,
	request: Request,
	res: ServerResponse,
	body: string
): Promise<void> {
	const headers = headersOf(res);
	const response = await spool.decorate(
		request,
		new Response(body, { status: res.statusCode, headers })
	);
	for (const name of res.getHeaderNames()) res.removeHeader(name);
	await writeResponse(res, response);
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
	if (typeof chunk !== 'string') return Buffer.from(chunk as Uint8Array);
	return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
}
