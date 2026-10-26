import { chromium } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { spoolProxy } from '../../src/proxy/index.ts';
import { createSpool, defineRoute, memorySink } from '../../src/server/index.ts';
import { memoryStore } from '../../src/stores/index.ts';
import {
	MEASUREMENTS_DIR,
	isMain,
	localMachine,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';

/** what a run changes: `off` is the v0.2 flow, `1` derives an assembly artifact, `2` inlines a template one */
export type Lever = 'off' | '1' | '2';

export type Arm = {
	name: string;
	strategy: 'assembly' | 'template';
	lever: Lever;
};

export const ARMS: Arm[] = [
	{ name: 'assembly, off', strategy: 'assembly', lever: 'off' },
	{ name: 'assembly, lever 1', strategy: 'assembly', lever: '1' },
	{ name: 'template, off', strategy: 'template', lever: 'off' },
	{ name: 'template, lever 2', strategy: 'template', lever: '2' }
];

const ROUNDS = 5;
const INLINE_BYTES = 2048;
const IDS = [1, 2, 3];

const nav = (prefix: string) =>
	IDS.map((n) => `<a href="${prefix}/${n}">${prefix}/${n}</a>`).join(' ');
const sentence = (n: number) =>
	`Paragraph ${n} of a university news page, with enough words to look like prose and no more. `;
const prose = (count: number) => Array.from({ length: count }, (_, i) => sentence(i)).join('');
const layout = (prefix: string, title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body><nav>${nav(prefix)}</nav><main><h1>${title}</h1><p id="note">${body}</p></main></body></html>`;

/** body text of a template page: small enough for a 2048-byte artifact */
const TEMPLATE_BODY = prose(8);
/** body text of an assembly page, which the proxy keeps whole */
const ASSEMBLY_BODY = prose(120);

type Fixture = {
	front: string;
	/** paths the front received, in order, without the browser's favicon probe */
	hits: string[];
	/** socket bytes (read + written) the front has moved so far */
	bytes(): { read: number; written: number };
	/** what the application behind the front did */
	backend(): Record<string, number>;
	stop(): Promise<void>;
};

/**
 * An http server that counts HTTP/1.1 text sizes: the request line, headers and body in, the status
 * line, headers and body out. Bun's `Socket.bytesRead` and `bytesWritten` stay at 0, so the sizes
 * are summed from what the handler reads and writes, plus the `Date`, `Connection` and `Keep-Alive`
 * headers Node adds to a response (about 90 bytes), which are counted and not sent.
 */
async function serve(handler: (request: Request) => Promise<Response>) {
	const hits: string[] = [];
	const total = { read: 0, written: 0 };
	const server: Server = createServer(
		(req, res) =>
			void (async () => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(req.headers)) {
					for (const one of Array.isArray(value) ? value : [value]) {
						if (one !== undefined) headers.append(name, one);
					}
				}
				const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
				const probe = url.pathname === '/favicon.ico';
				if (!probe) hits.push(url.pathname);
				const read = req.method === 'GET' || req.method === 'HEAD';
				const body = read ? Buffer.alloc(0) : Buffer.concat(await req.toArray());
				const response = await handler(
					new Request(url, { method: req.method, headers, ...(read ? {} : { body }) })
				);
				const out = Buffer.from(await response.arrayBuffer());
				const kept = Object.fromEntries(
					[...response.headers].filter(
						([name]) =>
							!['connection', 'date', 'keep-alive', 'transfer-encoding'].includes(
								name
							)
					)
				);
				const sent: Record<string, string> = {
					...kept,
					'content-length': String(out.length)
				};
				const counted = {
					...sent,
					date: new Date().toUTCString(),
					connection: 'keep-alive',
					'keep-alive': 'timeout=5'
				};
				if (!probe) {
					const lines = (pairs: Array<[string, string]>) =>
						pairs.reduce((sum, [k, v]) => sum + Buffer.byteLength(`${k}: ${v}\r\n`), 2);
					const asked: Array<[string, string]> = [];
					for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
						asked.push([req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string]);
					}
					total.read +=
						Buffer.byteLength(`${req.method} ${req.url} HTTP/1.1\r\n`) +
						lines(asked) +
						body.length;
					total.written +=
						Buffer.byteLength(
							`HTTP/1.1 ${response.status} ${response.statusText}\r\n`
						) +
						lines(Object.entries(counted)) +
						out.length;
				}
				res.writeHead(response.status, sent);
				res.end(out);
			})().catch((error) => {
				console.error(error);
				res.destroy();
			})
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const front = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		front,
		hits,
		bytes: () => ({ ...total }),
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

const css = () =>
	new Response('main{max-width:60ch}', {
		headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
	});

/** a plain origin behind `spoolProxy`; `off` strips the hash so the worker asks for the artifact */
async function assemblyFixture(lever: Lever): Promise<Fixture> {
	const origin: string[] = [];
	const upstream: Server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const id = /^\/n\/(\d+)$/.exec(path)?.[1];
		if (path === '/site.css') {
			res.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'public, max-age=31536000'
			});
			return void res.end('main{max-width:60ch}');
		}
		if (!id) {
			res.writeHead(404);
			return void res.end('not found');
		}
		origin.push(path);
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'max-age=0, public',
			'cache-tag': `node:${id},menu`
		});
		res.end(layout('/n', `Page ${id}`, ASSEMBLY_BODY));
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const proxy = spoolProxy({
		origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
		spool: { store: memoryStore() },
		routes: [{ pattern: '/n/:id', freshness: { maxStale: 3600, mode: 'soft' } }]
	});
	const fixture = await serve(async (request) => {
		const response = await proxy(request);
		const header = response.headers.get('spool-artifact');
		if (lever !== 'off' || !header) return response;
		// a front that drops the field is exactly a v0.2 server as far as the worker can tell
		const headers = new Headers(response.headers);
		headers.set('spool-artifact', header.replace(/; h=[\w-]+/, ''));
		return new Response(response.body, { status: response.status, headers });
	});
	return {
		...fixture,
		backend: () => ({ originPageFetches: origin.length }),
		stop: async () => {
			await fixture.stop();
			await new Promise<void>((resolve) => {
				upstream.closeAllConnections();
				upstream.close(() => resolve());
			});
		}
	};
}

/** a spool server with one template route; `off` is `inlineMaxBytes: 0` */
async function templateFixture(lever: Lever): Promise<Fixture> {
	let loads = 0;
	let renders = 0;
	const template = { source: layout('/t', '{{title}}', '{{body}}') };
	const spool = createSpool({
		routes: [
			defineRoute('/t/:id', {
				strategy: 'template',
				template,
				depends: (ctx) => [`node:${ctx.params['id']}`],
				load: (ctx) => {
					loads++;
					return { title: `Page ${ctx.params['id']}`, body: TEMPLATE_BODY };
				},
				freshness: { maxStale: 3600, mode: 'soft' }
			})
		],
		store: memoryStore(),
		sink: memorySink(),
		inlineMaxBytes: lever === '2' ? INLINE_BYTES : 0
	});
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const id = /^\/t\/(\d+)$/.exec(pathname)?.[1];
		if (pathname === '/site.css') return css();
		if (!id) return new Response('not found', { status: 404 });
		renders++;
		return new Response(layout('/t', `Page ${id}`, TEMPLATE_BODY), {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' }
		});
	};
	const fixture = await serve((request) => spool.handle(request, app));
	return { ...fixture, backend: () => ({ loads, renders }) };
}

type SpoolWindow = { spool: { ready: Promise<{ status(): Promise<{ artifacts: string[] }> }> } };

/** waits until the front has seen no new request for a moment, so a flush started by the last view has landed */
async function quiet(fixture: Fixture): Promise<void> {
	for (let last = -1; fixture.hits.length !== last;) {
		last = fixture.hits.length;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

const delta = (
	after: { read: number; written: number },
	before: { read: number; written: number }
) => ({ read: after.read - before.read, written: after.written - before.written });

/** the bytes and sizes of the page a plain GET (no worker) returns, which a view that needs no artifact pays for */
async function networkView(front: string, path: string) {
	const response = await fetch(`${front}${path}`, { headers: { 'accept-encoding': 'identity' } });
	const body = Buffer.from(await response.arrayBuffer());
	const header = response.headers.get('spool-artifact') ?? '';
	const text = body.toString('utf8');
	const element =
		/<script type="application\/spool\+json" data-spool-artifact>([^]*?)<\/script>/.exec(text);
	return {
		path,
		bodyBytes: body.length,
		gzipBytes: gzipSync(body).length,
		brotliBytes: brotliCompressSync(body).length,
		spoolArtifactHeaderBytes: Buffer.byteLength(header),
		inlineElementBytes: element ? Buffer.byteLength(element[0]) : 0
	};
}

async function round(arm: Arm, index: number): Promise<Record<string, unknown>> {
	const fixture =
		arm.strategy === 'assembly'
			? await assemblyFixture(arm.lever)
			: await templateFixture(arm.lever);
	const prefix = arm.strategy === 'assembly' ? '/n' : '/t';
	const [first, second] = [`${prefix}/1`, `${prefix}/2`] as [string, string];
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(`${fixture.front}${first}`);
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
		await page.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
		await quiet(fixture);

		const coldFrom = {
			hits: fixture.hits.length,
			bytes: fixture.bytes(),
			backend: fixture.backend()
		};
		await page.goto(`${fixture.front}${second}`);
		const held = async () =>
			page.evaluate(async () => {
				const client = await (window as unknown as SpoolWindow).spool.ready;
				return (await client.status()).artifacts;
			});
		for (let wait = 0; wait < 100 && !(await held()).includes(second); wait++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await quiet(fixture);
		const coldPaths = fixture.hits.slice(coldFrom.hits);
		const cold = {
			requests: coldPaths.length,
			paths: coldPaths,
			artifactRequests: coldPaths.filter((p) => p === '/.spool/artifact').length,
			bytes: delta(fixture.bytes(), coldFrom.bytes),
			backend: Object.fromEntries(
				Object.entries(fixture.backend()).map(([k, v]) => [
					k,
					v - (coldFrom.backend[k] ?? 0)
				])
			)
		};

		const localFrom = { hits: fixture.hits.length, bytes: fixture.bytes() };
		await page.goto(`${fixture.front}${second}`);
		await page.locator('h1').waitFor();
		await quiet(fixture);
		const localPaths = fixture.hits.slice(localFrom.hits);
		const local = {
			requests: localPaths.length,
			paths: localPaths,
			bytes: delta(fixture.bytes(), localFrom.bytes)
		};
		const version = browser.version();
		await context.close();
		return {
			arm: arm.name,
			strategy: arm.strategy,
			lever: arm.lever,
			round: index,
			engine: 'chromium',
			engineVersion: version,
			cold,
			local,
			networkView: await networkView(fixture.front, `${prefix}/3`)
		};
	} finally {
		await browser.close();
		await fixture.stop();
	}
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		machine: values.machine,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'first-payload',
					date: utcDate(),
					arms: ARMS.map((a) => a.name),
					rounds: ROUNDS,
					out: args.out
				},
				null,
				2
			)
		);
	} else {
		const rows: Array<Record<string, unknown>> = [];
		for (const arm of ARMS) {
			for (let index = 0; index < ROUNDS; index++) rows.push(await round(arm, index));
		}
		const draft: Draft = {
			rig: 'first-payload',
			date: utcDate(),
			layer: 'L1',
			question:
				'requests and bytes at the origin from the first controlled visit to a page to the first strict local view, with the artifact derived from the response, inlined, or fetched',
			instrument:
				'request log and socket byte counters (bytesRead and bytesWritten) of an in-process server, Chromium through Playwright',
			machine: localMachine(args.machine),
			software: { browser: 'Chromium, Playwright bundled build' },
			method: {
				rounds: ROUNDS,
				window: 'from the SW controlling a page and idle to the second view of a second page, which is local; setup page excluded',
				strategies: 'assembly behind spoolProxy, template behind createSpool',
				'lever off':
					'assembly: the front drops the h field of Spool-Artifact; template: inlineMaxBytes 0',
				'lever 1': 'assembly page kept from its own response',
				'lever 2': `template artifact inlined, inlineMaxBytes ${INLINE_BYTES}`,
				'assembly page': `${Buffer.byteLength(layout('/n', 'Page 1', ASSEMBLY_BODY))} bytes of HTML, uncompressed`,
				'template page': `${Buffer.byteLength(layout('/t', 'Page 1', TEMPLATE_BODY))} bytes of HTML, uncompressed`,
				networkView: 'a plain GET of a third page, no worker, identity encoding',
				compression:
					'none on the wire; gzip and brotli sizes are of the same body, computed offline',
				origin: 'loopback'
			},
			exclusions: [],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
