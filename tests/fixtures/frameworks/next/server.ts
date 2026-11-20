import next from 'next';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { pages, spool } from './server/spool.ts';

// Next answers on a loopback port; spool.handle sits in front of it, so its pages are decorated.
// The request log the browser test reads; _next assets are not logged.
const port = Number(process.env['PORT'] ?? 4920);
const dir = fileURLToPath(new URL('.', import.meta.url));
const app = next({ dev: false, dir });
await app.prepare();
const handle = app.getRequestHandler();
const inner = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve));
const innerOrigin = `http://127.0.0.1:${(inner.address() as AddressInfo).port}`;

const hits: string[] = [];

function json(res: ServerResponse, body: unknown): void {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function toRequest(req: IncomingMessage, url: URL): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value === 'string') headers.set(name, value);
	}
	const method = req.method ?? 'GET';
	const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
	return new Request(url, { method, headers, body });
}

// fetch decodes a gzip body (Next's prerender cache sends one whatever accept-encoding says) but keeps
// the header, so the decoded body goes out without it; decorate then sees an identity page
async function forward(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	headers.set('accept-encoding', 'identity');
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: await request.arrayBuffer();
	const upstream = await fetch(`${innerOrigin}${url.pathname}${url.search}`, {
		method: request.method,
		headers,
		body,
		redirect: 'manual'
	});
	const out = new Headers(upstream.headers);
	out.delete('content-encoding');
	out.delete('content-length');
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: out
	});
}

async function send(res: ServerResponse, response: Response): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of response.headers) {
		if (name !== 'set-cookie' && name !== 'content-length' && name !== 'transfer-encoding') {
			headers[name] = value;
		}
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) headers['set-cookie'] = cookies;
	res.writeHead(response.status, headers);
	res.end(Buffer.from(await response.arrayBuffer()));
}

await spool.publish(new URL(`http://127.0.0.1:${port}/`));

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
	if (url.pathname === '/api/pages') return json(res, pages);
	if (url.pathname === '/api/hits') {
		const out = [...hits];
		if (url.searchParams.has('reset')) hits.length = 0;
		return json(res, out);
	}
	// browsers request /favicon.ico on their own, so it is not a page request
	if (!url.pathname.startsWith('/_next/') && url.pathname !== '/favicon.ico') {
		hits.push(url.pathname);
	}
	const request = await toRequest(req, url);
	await send(res, await spool.handle(request, forward));
}).listen(port, '127.0.0.1');
