import next from 'next/dist/server/next.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spool } from './server/spool.ts';

// Next answers on a loopback port; spool.handle sits in front of it, so its pages are decorated.
const port = Number(process.env['PORT'] ?? 5610);
const dir = fileURLToPath(new URL('.', import.meta.url));
const app = next({ dev: false, dir });
await app.prepare();
const handle = app.getRequestHandler();
const inner = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => inner.listen(0, '127.0.0.1', resolve));
const innerOrigin = `http://127.0.0.1:${(inner.address() as AddressInfo).port}`;

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

// fetch decodes a gzip body but keeps the header, so the forwarded body is sent as identity
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

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
	const request = await toRequest(req, url);
	await send(res, await spool.handle(request, forward));
}).listen(port, '127.0.0.1');
