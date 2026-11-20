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
		expect(await page.text()).toContain('data-spool-gate');

		const sync = await fetch(`${base}/.spool/sync?from=0`);
		expect(((await sync.json()) as { cursor: number }).cursor).toBe(0);
		const sw = await fetch(`${base}/spool-sw.js`);
		expect(sw.headers.get('cache-control')).toBe('max-age=86400');
	});

	it('writes a 304 for the worker script with no body and keeps its headers', async () => {
		const spool = createSpool({ store: memoryStore(), routes: [] });
		const base = await serve((request) => spool.stub(request));
		const full = await fetch(`${base}/spool-sw.js`);
		const etag = full.headers.get('etag')!;
		const same = await fetch(`${base}/spool-sw.js`, { headers: { 'if-none-match': etag } });
		expect(same.status).toBe(304);
		expect(await same.text()).toBe('');
		expect(same.headers.get('etag')).toBe(etag);
		expect(same.headers.get('cache-control')).toBe('max-age=86400');
		const head = await fetch(`${base}/spool-sw.js`, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('etag')).toBe(etag);
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

	it('keeps the close listeners on one response within the default limit', async () => {
		let peak = 0;
		const base = await serve(
			() => new Response('body'),
			undefined,
			(listener) => (req, res) => {
				res.on('newListener', (event) => {
					if (event === 'close') peak = Math.max(peak, res.listenerCount('close') + 1);
				});
				return listener(req, res);
			}
		);
		expect(await (await fetch(`${base}/`)).text()).toBe('body');
		expect(peak).toBeLessThanOrEqual(EventEmitter.defaultMaxListeners);
	});

	it('cancels the reply body when the client goes away', async () => {
		let cancelled!: () => void;
		const canceled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const base = await serve(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('first'));
						},
						cancel() {
							cancelled();
						}
					})
				)
		);
		const client = new AbortController();
		const response = await fetch(`${base}/`, { signal: client.signal });
		await response.body!.getReader().read();
		client.abort();
		await canceled;
	});
});

describe('toNodeListener with a public page the response gate declines', () => {
	it('writes a page that sets a cookie as the application wrote it, with no spool header', async () => {
		const spool = createSpool({
			routes: [
				defineRoute('/gated/:kind', {
					strategy: 'template',
					template: { source: '<!doctype html><h1>gated {{kind}}</h1>' },
					load: () => ({})
				})
			],
			store: memoryStore()
		});
		const origin = () =>
			new Response('<!doctype html><h1>gated</h1>', {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'set-cookie': 'sid=1; Path=/'
				}
			});
		const base = await serve((request) => spool.handle(request, origin));
		const response = await fetch(`${base}/gated/x`);
		expect(response.headers.get('set-cookie')).toBe('sid=1; Path=/');
		expect([...response.headers.keys()].filter((name) => name.startsWith('spool-'))).toEqual(
			[]
		);
		expect(await response.text()).toBe('<!doctype html><h1>gated</h1>');
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

	describe('writeResponse on a live socket', () => {
		type Report = {
			outcome: 'resolved' | 'rejected';
			message?: string;
			/** listeners added to the response by writeResponse, against the count before it ran */
			listeners: Record<'close' | 'error' | 'finish', number>;
		};

		/** answers each request through writeResponse and reports, once the socket closed, how the write settled */
		async function answerWith(respond: () => Response) {
			const reports: Report[] = [];
			const server = createServer((req, res) => {
				const counts = () => ({
					close: res.listenerCount('close'),
					error: res.listenerCount('error'),
					finish: res.listenerCount('finish')
				});
				let before = { close: 0, error: 0, finish: 0 };
				let write: Promise<Pick<Report, 'outcome' | 'message'>> = Promise.resolve({
					outcome: 'resolved'
				});
				res.on('close', () =>
					setImmediate(async () => {
						const now = counts();
						reports.push({
							...(await write),
							listeners: {
								close: now.close - before.close,
								error: now.error - before.error,
								finish: now.finish - before.finish
							}
						});
					})
				);
				before = counts();
				write = writeResponse(res, respond(), req.method === 'HEAD').then(
					(): Pick<Report, 'outcome' | 'message'> => ({ outcome: 'resolved' }),
					(error: unknown): Pick<Report, 'outcome' | 'message'> => ({
						outcome: 'rejected',
						message: error instanceof Error ? error.message : String(error)
					})
				);
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const reportOf = () =>
				new Promise<Report>((resolve) => {
					const timer = setInterval(() => {
						if (reports.length === 0) return;
						clearInterval(timer);
						resolve(reports[0] as Report);
					}, 5);
				});
			return { base, reportOf };
		}

		const slowBody = (cancelled: { count: number }) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('first'));
				},
				cancel() {
					cancelled.count++;
				}
			});

		it('settles with the stream error when the body fails after one chunk, and leaves no listener', async () => {
			let sent = false;
			const { base, reportOf } = await answerWith(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (sent) controller.error(new Error('cut'));
								else {
									sent = true;
									controller.enqueue(new TextEncoder().encode('first'));
								}
							}
						})
					)
			);
			await fetch(`${base}/`)
				.then((r) => r.text())
				.catch(() => undefined);
			expect(await reportOf()).toEqual({
				outcome: 'rejected',
				message: 'cut',
				listeners: { close: 0, error: 0, finish: 0 }
			});
		});

		it('cancels the body and leaves no listener when the client aborts mid-body', async () => {
			const cancelled = { count: 0 };
			const { base, reportOf } = await answerWith(() => new Response(slowBody(cancelled)));
			const client = new AbortController();
			const response = await fetch(`${base}/`, { signal: client.signal });
			await response.body!.getReader().read();
			client.abort();
			const report = await reportOf();
			expect(report.listeners).toEqual({ close: 0, error: 0, finish: 0 });
			expect(cancelled.count).toBe(1);
		});

		it('cancels the body of a HEAD reply it does not send, and leaves no listener', async () => {
			const cancelled = { count: 0 };
			const { base, reportOf } = await answerWith(() => new Response(slowBody(cancelled)));
			await fetch(`${base}/`, { method: 'HEAD' });
			expect(await reportOf()).toEqual({
				outcome: 'resolved',
				listeners: { close: 0, error: 0, finish: 0 }
			});
			expect(cancelled.count).toBe(1);
		});

		it('ends a zero-length body with 200 and no listener', async () => {
			const { base, reportOf } = await answerWith(
				() => new Response(new Uint8Array(0), { status: 200 })
			);
			const response = await fetch(`${base}/`);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('');
			expect(await reportOf()).toEqual({
				outcome: 'resolved',
				listeners: { close: 0, error: 0, finish: 0 }
			});
		});
	});
});
