import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
	toNodeListener,
	toRequest,
	writeResponse,
	type FetchHandler,
	type NodeListenerOptions
} from '../../src/node/listener';
import { decodeEnvelope, defineRoute } from '../../src/protocol/index';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

const servers: Server[] = [];

async function serve(
	handler: FetchHandler,
	options?: NodeListenerOptions,
	wrap?: (listener: ReturnType<typeof toNodeListener>) => Parameters<typeof createServer>[1]
): Promise<string> {
	const listener = toNodeListener(handler, options);
	const server = createServer(wrap ? wrap(listener) : listener);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(s) =>
				new Promise<void>((resolve) => {
					s.closeAllConnections();
					s.close(() => resolve());
				})
		)
	);
});

describe('toNodeListener', () => {
	it('serves a spool-wrapped page end to end, envelope and client tag included', async () => {
		const spool = createSpool({
			store: memoryStore(),
			routes: [
				defineRoute('/node/:id', {
					strategy: 'template',
					template: { source: '<html><head></head><body>{{id}}</body></html>' },
					depends: (ctx) => [`node:${ctx.params['id']}`],
					load: (ctx) => ({ id: ctx.params['id'] })
				})
			]
		});
		const app = () =>
			new Response('<html><head></head><body>4</body></html>', {
				headers: { 'content-type': 'text/html' }
			});
		const base = await serve((request) => spool.handle(request, app));

		const page = await fetch(`${base}/node/4`);
		expect(page.status).toBe(200);
		expect(decodeEnvelope(page.headers).artifact?.deps).toEqual(['node:4']);
		expect(await page.text()).toContain('data-spool-client');

		const sync = await fetch(`${base}/.spool/sync?from=0`);
		expect(((await sync.json()) as { cursor: number }).cursor).toBe(0);
		const sw = await fetch(`${base}/spool-sw.js`);
		expect(sw.headers.get('cache-control')).toBe('max-age=86400');
	});

	it('streams a request body to the handler and the response body back', async () => {
		const base = await serve(
			async (request) => new Response(await request.text(), { status: 201 })
		);
		const response = await fetch(`${base}/echo`, { method: 'POST', body: 'payload' });
		expect(response.status).toBe(201);
		expect(await response.text()).toBe('payload');
	});

	it('passes method, path, query and headers through and joins repeated headers', async () => {
		let seen: Request | undefined;
		const base = await serve((request) => {
			seen = request;
			return new Response('ok');
		});
		await fetch(`${base}/a/b?x=1`, { headers: { 'x-one': '1', cookie: 'a=1' } });
		expect(seen?.method).toBe('GET');
		expect(new URL(seen?.url ?? '').pathname + new URL(seen?.url ?? '').search).toBe(
			'/a/b?x=1'
		);
		expect(seen?.headers.get('x-one')).toBe('1');
		expect(seen?.headers.get('cookie')).toBe('a=1');
	});

	it('writes several set-cookie headers and the status text', async () => {
		const base = await serve(() => {
			const headers = new Headers();
			headers.append('set-cookie', 'a=1');
			headers.append('set-cookie', 'b=2');
			return new Response('x', { status: 202, statusText: 'Taken', headers });
		});
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(202);
		expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
	});

	it('answers HEAD without a body', async () => {
		const base = await serve(() => new Response('body', { headers: { 'x-a': '1' } }));
		const response = await fetch(`${base}/`, { method: 'HEAD' });
		expect(response.headers.get('x-a')).toBe('1');
		expect(await response.text()).toBe('');
	});

	it('writes an empty body response', async () => {
		const base = await serve(() => new Response(null, { status: 204 }));
		expect((await fetch(`${base}/`)).status).toBe(204);
	});

	it('answers 404 when the handler returns undefined and no next exists', async () => {
		const base = await serve(() => undefined);
		expect((await fetch(`${base}/`)).status).toBe(404);
	});

	it('calls next when the handler returns undefined, as Express middleware', async () => {
		const base = await serve(
			() => undefined,
			undefined,
			(listener) => (req, res) => void listener(req, res, () => res.end('from next'))
		);
		expect(await (await fetch(`${base}/`)).text()).toBe('from next');
	});

	it('answers 500 when the handler throws, or hands the error to next', async () => {
		const failing: FetchHandler = () => {
			throw new Error('boom');
		};
		const base = await serve(failing);
		const response = await fetch(`${base}/`);
		expect(response.status).toBe(500);
		expect(await response.text()).toBe('internal error');

		let received: unknown;
		const viaNext = await serve(failing, undefined, (listener) => (req, res) => {
			void listener(req, res, (error) => {
				received = error;
				res.statusCode = 502;
				res.end();
			});
		});
		expect((await fetch(`${viaNext}/`)).status).toBe(502);
		expect((received as Error).message).toBe('boom');
	});

	it('destroys the socket when the body fails after headers are out', async () => {
		const base = await serve(() => {
			const body = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('partial'));
					setTimeout(() => controller.error(new Error('cut')), 10);
				}
			});
			return new Response(body);
		});
		await expect(fetch(`${base}/`).then((r) => r.text())).rejects.toThrow();
	});

	it('builds URLs from the origin option when given', async () => {
		let url = '';
		const base = await serve(
			(request) => {
				url = request.url;
				return new Response('ok');
			},
			{ origin: 'https://example.edu' }
		);
		await fetch(`${base}/p?q=1`);
		expect(url).toBe('https://example.edu/p?q=1');
	});

	it('aborts the request signal when the client goes away', async () => {
		let signal: AbortSignal | undefined;
		let release: () => void = () => {};
		const aborted = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = await serve(async (request) => {
			signal = request.signal;
			request.signal.addEventListener('abort', () => release());
			await aborted;
			return new Response('late');
		});
		const controller = new AbortController();
		const pending = fetch(`${base}/`, { signal: controller.signal }).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		await pending;
		await aborted;
		expect(signal?.aborted).toBe(true);
	});
});

describe('toRequest and writeResponse', () => {
	const fakeReq = (extra: Partial<IncomingMessage> = {}) =>
		Object.assign(
			Readable.from([]),
			{
				method: 'GET',
				url: '/x?y=1',
				headers: { host: 'site.test', 'x-multi': ['a', 'b'], skipped: undefined },
				socket: { encrypted: true }
			},
			extra
		) as unknown as IncomingMessage;
	const fakeRes = () =>
		Object.assign(new EventEmitter(), {
			writableFinished: false
		}) as unknown as ServerResponse;

	it('uses https for an encrypted socket and appends array header values', () => {
		const request = toRequest(fakeReq(), fakeRes());
		expect(request.url).toBe('https://site.test/x?y=1');
		expect(request.headers.get('x-multi')).toBe('a, b');
		expect(request.headers.has('skipped')).toBe(false);
	});

	it('falls back to localhost without a Host header and to / without a url', () => {
		const request = toRequest(
			fakeReq({ headers: {}, url: undefined, socket: {} as never }),
			fakeRes()
		);
		expect(request.url).toBe('http://localhost/');
	});

	it('does not abort when the response finished before close', () => {
		const res = fakeRes();
		(res as unknown as { writableFinished: boolean }).writableFinished = true;
		const request = toRequest(fakeReq(), res);
		res.emit('close');
		expect(request.signal.aborted).toBe(false);
	});

	it('writeResponse ends a HEAD reply without reading the body', async () => {
		const written: string[] = [];
		const res = {
			setHeader: () => {},
			end: () => written.push('end')
		} as unknown as ServerResponse;
		await writeResponse(res, new Response('body'), true);
		expect(written).toEqual(['end']);
	});
});
