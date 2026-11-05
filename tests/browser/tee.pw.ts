import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { splitBody } from '../../src/sw/static';

// A service worker answers a navigation with a body that errors after `failAfter` chunks.
// `bare` returns the body; `tee` also reads a clone eagerly, as the runtime did; `tee-gap` does
// the same with a task between chunks; `split` returns splitBody's visitor stream. The probe
// records what each variant shows. Only the control that closes normally is asserted: a mid-stream
// error renders partly in some runs and not in others in chromium, so it is a reading.

const WORKER = `
const encoder = new TextEncoder();
function source(failAfter, gap, fails) {
	let next = 0;
	return new ReadableStream({
		async pull(controller) {
			if (gap) await new Promise((resolve) => setTimeout(resolve, 0));
			if (next === failAfter && !fails) return controller.close();
			if (next === failAfter) return controller.error(new Error('source failed'));
			controller.enqueue(encoder.encode('<i>c' + next + '</i>'));
			next += 1;
		}
	}, { highWaterMark: 0 });
}
function drain(stream) {
	return (async () => {
		const reader = stream.getReader();
		try {
			for (;;) if ((await reader.read()).done) break;
		} catch {}
	})();
}
${splitBody.toString()}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (!url.pathname.startsWith('/probe/')) return;
	const [mode, failAfter, end] = url.pathname.split('/').slice(2);
	const body = source(Number(failAfter), mode === 'tee-gap', end !== 'close');
	const headers = { 'content-type': 'text/html; charset=utf-8' };
	if (mode === 'split') {
		const { visitor, capture } = splitBody(body);
		void drain(capture);
		return event.respondWith(new Response(visitor, { headers }));
	}
	const response = new Response(body, { headers });
	if (mode !== 'bare') void drain(response.clone().body);
	event.respondWith(response);
});
`;

const PAGE = '<!doctype html><html><head><title>probe</title></head><body>probe</body></html>';

let origin = '';
let close: () => Promise<void> = async () => {};

test.beforeAll(async () => {
	const server = createServer((request, response) => {
		if (request.url === '/sw.js') {
			response.writeHead(200, { 'content-type': 'text/javascript' });
			return response.end(WORKER);
		}
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end(PAGE);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	close = () => new Promise<void>((done) => server.close(() => done()));
});

test.afterAll(async () => {
	await close();
});

const FAIL_AFTER = 3;
const sent = Array.from({ length: FAIL_AFTER }, (_, i) => `c${i}`);

test('the split visitor shows what the bare body shows, in every engine', async ({ page }) => {
	await page.goto(`${origin}/`);
	await page.evaluate(async () => {
		await navigator.serviceWorker.register('/sw.js');
		await navigator.serviceWorker.ready;
	});

	const visit = async (mode: string, end: string) => {
		const outcome = await page
			.goto(`${origin}/probe/${mode}/${FAIL_AFTER}/${end}`, {
				waitUntil: 'commit',
				timeout: 5000
			})
			.then(() => 'committed')
			.catch((error: Error) => error.message.split('\n')[0]);
		await page.waitForTimeout(1000);
		const html = await page
			.content()
			.catch((error: Error) => `content failed: ${error.message}`);
		const got = [...html.matchAll(/<i>(c\d+)<\/i>/g)].map((m) => m[1]);
		console.log(
			'PROBE',
			JSON.stringify({ engine: test.info().project.name, mode, end, outcome, sent, got })
		);
		return got;
	};

	expect(await visit('bare', 'close')).toEqual(sent);
	await visit('bare', 'error');
	await visit('split', 'error');
	await visit('tee', 'error');
	await visit('tee-gap', 'error');
});
