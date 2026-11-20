import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
	compileTemplate,
	datasetProof,
	defineDataset,
	defineResource,
	defineRoute,
	equivalent,
	injectClientTag,
	inlineElement,
	interpretTemplate,
	parseArtifact,
	placeholder,
	PROOF_MISMATCH,
	ProtocolError,
	readInline,
	setProof,
	shellHash,
	viewsWithLoads,
	type SwConfig
} from '../../src/protocol/index';
import {
	buildBundle,
	createSpool,
	memoryBundleStore,
	memorySink,
	viewsOf,
	type SpoolOptions
} from '../../src/server/index';
import { packReader } from '../../src/server/stub';
import { memoryStore } from '../../src/stores/index';
import { createPackStore } from '../../src/sw/index';
import { idbPartitions, idbVault } from '../../src/sw/partition';
import { allowedPolicy } from '../../src/sw/policy';
import { renderLocal } from '../../src/sw/render';
import { classify } from '../../src/sw/router';
import { createRuntime } from '../../src/sw/runtime';
import { MAX_STATIC_BYTES, readCapped } from '../../src/sw/static';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { artifact, fakeCaches, freshIndexedDB, nav, ORIGIN, sub } from './helpers';
import { rig as familyRig } from './rig';

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const body = (id: string) => `<html><head></head><body>${id}</body></html>`;
const tpl = { source: '<html><head></head><body>{{id}}</body></html>' };
const dep = (ctx: { params: Record<string, string> }) => [`node:${ctx.params['id']}`];
const load = (ctx: { params: Record<string, string> }) => ({ id: ctx.params['id'] });

const routes = [
	defineRoute('/soft/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'soft' }
	}),
	defineRoute('/hard/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'hard' }
	}),
	defineRoute('/strict/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		freshness: { maxStale: 60, mode: 'hard' },
		offline: 'refuse'
	}),
	defineRoute('/volatile/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load,
		persist: false
	}),
	defineRoute('/page/:slug', {
		strategy: 'assembly',
		depends: () => ['menu'],
		load: (ctx) => ({
			shell: `<html><head></head><body>${placeholder('nav')}${ctx.params['slug']}</body></html>`,
			fragments: { nav: '<nav></nav>' }
		})
	}),
	defineRoute('/badpage', {
		strategy: 'assembly',
		load: () => ({ shell: `<html><body>${placeholder('missing')}</body></html>` })
	}),
	defineRoute('/acct', {
		strategy: 'template',
		scope: 'principal',
		template: { source: 'x' },
		load: () => ({})
	})
];

function rig(
	options: {
		storage?: ReplicaStorage;
		fetchWrap?: (r: Response) => Response | Promise<Response>;
		spool?: Partial<SpoolOptions>;
		routes?: typeof routes;
		app?: (request: Request) => Response | Promise<Response> | undefined;
		/** the worker's config where it differs from the server's, such as a worker with no lease */
		config?: Partial<Record<keyof SwConfig, unknown>>;
		broadcast?: (message: unknown) => void;
	} = {}
) {
	const store = memoryStore();
	const sink = memorySink();
	const spool = createSpool({
		routes: options.routes ?? routes,
		store,
		sink,
		beacons: ['/cdn-cgi/rum'],
		...options.spool,
		identity: {
			secret: 's',
			resolve: (r) => (r.headers.has('x-user') ? { principal: 'u' } : null)
		}
	});
	const log: string[] = [];
	let online = true;
	let gate: Promise<void> | null = null;
	const requests: Request[] = [];
	const received: Array<{ body: string; type: string | null; search: string }> = [];

	const app = async (request: Request): Promise<Response> => {
		const custom = options.app?.(request);
		if (custom) return custom;
		const { pathname, search } = new URL(request.url);
		if (request.method === 'POST' && pathname === '/cdn-cgi/rum') {
			received.push({
				body: await request.text(),
				type: request.headers.get('content-type'),
				search
			});
			return new Response(null, { status: 204 });
		}
		if (request.method === 'POST' && pathname === '/form') {
			await spool.invalidate(['node:1']);
			return new Response('saved');
		}
		const [, first, second] = pathname.split('/');
		if (['soft', 'hard', 'strict', 'volatile'].includes(first ?? '')) {
			return new Response(body(second ?? ''), { headers: HTML });
		}
		if (first === 'page') {
			return new Response(`<html><head></head><body><nav></nav>${second}</body></html>`, {
				headers: HTML
			});
		}
		if (pathname === '/badpage' || pathname === '/acct') {
			return new Response(body(pathname), { headers: HTML });
		}
		if (pathname === '/site.css') {
			return new Response('css', {
				headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
			});
		}
		if (pathname === '/asset.js') {
			return new Response('js', {
				headers: { 'content-type': 'text/javascript', 'cache-control': 'public, immutable' }
			});
		}
		if (pathname === '/app.js') {
			return new Response('js', { headers: { 'cache-control': 'max-age=60' } });
		}
		if (pathname === '/aged.js') {
			return new Response('js', { headers: { age: '30' } });
		}
		return new Response('missing', { status: 404, headers: HTML });
	};

	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		const url = new URL(request.url);
		log.push(`${request.method} ${url.pathname}`);
		requests.push(request);
		if (!online) throw new TypeError('offline');
		if (gate && url.pathname === '/.spool/sync') await gate;
		const response = await spool.handle(request, app);
		return options.fetchWrap ? options.fetchWrap(response) : response;
	};

	let t = 1_700_000_000_000;
	const caches = fakeCaches();
	const storage = options.storage ?? memoryStorage();
	const make = (renderers?: Parameters<typeof createRuntime>[0]['renderers']) =>
		createRuntime({
			config: { ...spool.config, ...options.config } as SwConfig,
			storage,
			fetch: fetchImpl,
			caches,
			origin: ORIGIN,
			now: () => t,
			renderers,
			...(options.broadcast ? { broadcast: options.broadcast } : {})
		});
	const runtime = make();

	async function drive(request: Request, target = runtime): Promise<Response> {
		const waited: Promise<unknown>[] = [];
		const pending = target.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('request was ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}

	return {
		spool,
		sink,
		store,
		log,
		requests,
		received,
		runtime,
		storage,
		caches,
		make,
		drive,
		advance: (seconds: number) => void (t += seconds * 1000),
		offline: (value: boolean) => void (online = !value),
		hold: () => {
			let release: () => void = () => {};
			gate = new Promise<void>((resolve) => (release = resolve));
			return () => {
				gate = null;
				release();
			};
		}
	};
}

const rum = (r: { received: Array<{ body: string }> }) => r.received;

const visit = async (r: ReturnType<typeof rig>, path: string) => {
	const response = await r.drive(nav(path));
	return response.text();
};

describe('a route served from the replica', () => {
	it('goes to the network on first sight, provisions the artifact once, then makes 0 requests', async () => {
		const r = rig();
		const first = await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'GET /.spool/artifact']);
		expect(await r.runtime.replica.ids()).toEqual(['/soft/1']);

		r.log.length = 0;
		const second = await visit(r, '/soft/1');
		expect(r.log).toEqual([]);
		expect(equivalent(second, first).equal).toBe(true);
		expect(second).toContain('data-spool-gate');
	});

	it('renders the same page locally as the network does, for template and assembly routes', async () => {
		const r = rig();
		for (const path of ['/soft/9', '/page/about']) {
			const network = await visit(r, path);
			r.log.length = 0;
			const local = await visit(r, path);
			expect(r.log).toEqual([]);
			const verdict = equivalent(local, network);
			expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
		}
	});

	it('shares one artifact request between two first visits at once', async () => {
		const r = rig();
		await Promise.all([visit(r, '/soft/5'), visit(r, '/soft/5')]);
		expect(r.log.filter((l) => l === 'GET /.spool/artifact')).toHaveLength(1);
	});

	it('does not provision a route the server did not describe, or a failed page', async () => {
		const r = rig();
		await visit(r, '/nothing');
		await visit(r, '/soft');
		expect(r.log).toEqual(['GET /nothing', 'GET /soft']);
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('leaves a principal route to the network', async () => {
		const r = rig();
		await r.drive(nav('/acct', { headers: { 'x-user': 'u' } }));
		await r.drive(nav('/acct', { headers: { 'x-user': 'u' } }));
		expect(r.log).toEqual(['GET /acct', 'GET /acct']);
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('falls back to the network when the local render is refused', async () => {
		const r = rig();
		await visit(r, '/badpage');
		r.log.length = 0;
		const html = await visit(r, '/badpage');
		expect(r.log).toEqual(['GET /badpage']);
		expect(html).toContain('/badpage');
	});

	it('serves a persist:false artifact until the worker restarts', async () => {
		const r = rig();
		await visit(r, '/volatile/1');
		r.log.length = 0;
		await visit(r, '/volatile/1');
		expect(r.log).toEqual([]);
		const restarted = r.make();
		await r.drive(nav('/volatile/1'), restarted);
		expect(r.log).toEqual(['GET /volatile/1', 'GET /.spool/artifact']);
	});

	describe('a stored template route whose template reads row.title', () => {
		const source =
			'<!doctype html><html><head><title>{{row.title}}</title></head><body><h1>{{row.title}}</h1></body></html>';
		const row = { id: '101', title: 'Intro to Drupal' };
		// the template data is the load result, so only a load that returns { row } fills row.title
		const heading = async (load: () => unknown) => {
			const route = defineRoute('/courses/:id', {
				strategy: 'template',
				template: { source },
				depends: () => ['courses'],
				load
			});
			const r = rig({
				routes: [route],
				app: (request) =>
					new URL(request.url).pathname.startsWith('/courses/')
						? new Response(
								interpretTemplate(route.template!, { params: { id: '101' }, row }),
								{ headers: HTML }
							)
						: undefined
			});
			const network = await visit(r, '/courses/101');
			const local = await visit(r, '/courses/101');
			expect(r.log).toEqual(['GET /courses/101', 'GET /.spool/artifact']);
			return { network, local, h1: /<h1>(.*?)<\/h1>/.exec(local)?.[1] };
		};

		it('renders an empty heading locally when load returns the row itself', async () => {
			const out = await heading(() => row);
			expect(out.network).toContain('<h1>Intro to Drupal</h1>');
			expect(out.h1).toBe('');
		});

		it('renders the title locally when load returns { row }', async () => {
			const out = await heading(() => ({ row }));
			expect(out.h1).toBe('Intro to Drupal');
		});
	});

	it('uses a custom renderer for its route pattern', async () => {
		const r = rig();
		const custom = r.make({ '/soft/:id': (a) => `<p>custom ${JSON.stringify(a.body)}</p>` });
		await r.drive(nav('/soft/3'), custom);
		const html = await (await r.drive(nav('/soft/3'), custom)).text();
		expect(html).toContain('custom {"data":{"id":"3"}}');
	});
});

describe('the artifact in the page', () => {
	const inline = { inlineMaxBytes: 2048 };
	const asked = 'GET /.spool/artifact';
	const stored = async (r: ReturnType<typeof rig>, path: string) =>
		(await r.runtime.replica.get(path))?.artifact;
	const built = async (r: ReturnType<typeof rig>, path: string) =>
		parseArtifact(
			await (
				(await r.spool.respond(
					new Request(`${ORIGIN}/.spool/artifact?path=${path}`)
				)) as Response
			).json()
		);
	const html = (response: Response) =>
		(response.headers.get('content-type') ?? '').includes('text/html');
	const rewrite =
		(
			change: (text: string, response: Response) => BodyInit,
			headers: Record<string, string> = {}
		) =>
		async (response: Response) => {
			if (!html(response)) return response;
			const next = new Headers(response.headers);
			next.delete('content-length');
			for (const [name, value] of Object.entries(headers)) next.set(name, value);
			return new Response(change(await response.text(), response), {
				status: response.status,
				headers: next
			});
		};
	const nasty = defineRoute('/nasty/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load: () => ({
			id: `</script><b>&amp;${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
		})
	});
	const big = defineRoute('/big/:id', {
		strategy: 'template',
		template: tpl,
		depends: dep,
		load: () => ({ id: 'x'.repeat(3000) })
	});
	const pages = (request: Request) => {
		const [, first, second] = new URL(request.url).pathname.split('/');
		return first === 'nasty' || first === 'big'
			? new Response(body(second ?? ''), { headers: HTML })
			: undefined;
	};

	it('stores the artifact a template page carries and asks for nothing', async () => {
		const r = rig({ spool: inline });
		const first = await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /soft/1']);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
		const [entry] = r.runtime.ledger.entries();
		expect(entry).toMatchObject({ id: '/soft/1', requests: 0, views: 0 });
		expect((entry as { bytes: number }).bytes).toBeGreaterThan(0);
		expect(first).toContain('data-spool-artifact');

		r.log.length = 0;
		const second = await visit(r, '/soft/1');
		expect(r.log).toEqual([]);
		expect(equivalent(second, first).equal).toBe(true);
		expect(second).not.toContain('data-spool-artifact');
	});

	it('drops a captured page when the replica is wiped while its body is still being read', async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const r = rig({
			spool: inline,
			fetchWrap: async (response) => {
				if (!html(response) || !response.headers.has('spool-artifact')) return response;
				const text = await response.text();
				const headers = new Headers(response.headers);
				headers.delete('content-length');
				return new Response(
					new ReadableStream({
						async start(controller) {
							await held;
							controller.enqueue(new TextEncoder().encode(text));
							controller.close();
						}
					}),
					{ status: response.status, headers }
				);
			}
		});
		const pending = r.drive(nav('/soft/1'));
		await new Promise((resolve) => setTimeout(resolve, 25));
		await r.runtime.replica.wipe();
		release();
		await pending;
		expect(r.log).toEqual(['GET /soft/1', asked]);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});

	it('names the hash of the element text and keeps the element before the last body close', async () => {
		const r = rig({ spool: inline });
		const response = await r.drive(nav('/soft/1'));
		const text = await response.text();
		const element = readInline(text);
		expect(element).not.toBeNull();
		expect(response.headers.get('spool-artifact')).toContain(
			`h=${await shellHash(element as string)}`
		);
		expect(text.indexOf(inlineElement(element as string))).toBe(
			text.lastIndexOf('</body>') - inlineElement(element as string).length
		);
		expect(parseArtifact(JSON.parse(element as string)).id).toBe('/soft/1');
	});

	it('escapes the data so it cannot end the element, and the worker reads it back whole', async () => {
		const r = rig({
			spool: inline,
			routes: [...routes, nasty],
			app: pages
		});
		const text = await visit(r, '/nasty/1');
		const element = readInline(text) as string;
		expect(element).not.toMatch(/[<>&]/);
		expect(element).not.toContain(String.fromCharCode(0x2028));
		expect(element).not.toContain(String.fromCharCode(0x2029));
		expect(text.match(/<\/script/gi)).toHaveLength(2);
		const artifact = parseArtifact(JSON.parse(element));
		expect(artifact.body).toEqual({
			data: {
				id: `</script><b>&amp;${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
			}
		});
		expect(r.log).toEqual(['GET /nasty/1']);
		expect(await stored(r, '/nasty/1')).toEqual(await built(r, '/nasty/1'));
	});

	it('leaves an artifact over the limit out of the page', async () => {
		const r = rig({ spool: inline, routes: [...routes, big], app: pages });
		const response = await r.drive(nav('/big/1'));
		expect(await response.text()).not.toContain('data-spool-artifact');
		expect(response.headers.get('spool-artifact')).not.toContain('h=');
		expect(r.log).toEqual(['GET /big/1', asked]);
		expect(await stored(r, '/big/1')).toEqual(await built(r, '/big/1'));
	});

	it('puts nothing in a page with inlineMaxBytes 0', async () => {
		const r = rig({ spool: { inlineMaxBytes: 0 } });
		const response = await r.drive(nav('/soft/1'));
		expect(await response.text()).not.toContain('data-spool-artifact');
		expect(response.headers.get('spool-artifact')).not.toContain('h=');
		expect(r.log).toEqual(['GET /soft/1', asked]);
	});

	it('refuses a limit that is not a non-negative number', () => {
		for (const inlineMaxBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createSpool({ routes, store: memoryStore(), inlineMaxBytes })).toThrow(
				ProtocolError
			);
		}
	});

	it('never puts an assembly page or a principal page in a page', async () => {
		const r = rig({ spool: inline });
		const assembly = await r.drive(nav('/page/about'));
		expect(await assembly.text()).not.toContain('data-spool-artifact');
		expect(assembly.headers.get('spool-artifact')).not.toContain('h=');
		const account = await r.drive(nav('/acct', { headers: { 'x-user': 'u' } }));
		expect(await account.text()).not.toContain('data-spool-artifact');
		expect(account.headers.get('spool-artifact')).toContain('scope=principal');
		expect(account.headers.get('spool-artifact')).not.toContain('h=');
	});

	const fallbacks: Array<[string, ReturnType<typeof rewrite>]> = [
		[
			'an element that does not match the hash',
			rewrite((t) => t.replace('"id":"1"', '"id":"2"'))
		],
		[
			'a later element the page did not get from the server',
			rewrite(
				(t) =>
					`${t}${inlineElement(
						JSON.stringify({
							protocol: 1,
							id: '/soft/1',
							scope: 'public',
							strategy: 'template',
							deps: ['node:1'],
							vector: 0,
							body: { data: { id: 'evil' } }
						})
					)}`
			)
		],
		[
			'a header with no hash',
			async (response) => {
				const next = new Headers(response.headers);
				next.set(
					'spool-artifact',
					(next.get('spool-artifact') ?? '').replace(/; h=[\w-]+/, '')
				);
				return new Response(response.body, { status: response.status, headers: next });
			}
		],
		['a compressed body', rewrite((t) => gzipSync(t), { 'content-encoding': 'gzip' })],
		[
			'a body that is not UTF-8',
			rewrite((t) => Buffer.concat([Buffer.from(t), Buffer.from([0xff])]))
		]
	];

	it.each(fallbacks)('asks for the artifact once after %s', async (_name, wrap) => {
		const r = rig({ spool: inline, fetchWrap: wrap });
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /soft/1', asked]);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
		expect(r.runtime.ledger.entries()).toMatchObject([{ id: '/soft/1', requests: 1 }]);
	});

	it('leaves a route in shadow mode to the beacon, as without the element', async () => {
		const shadow = rig({ spool: { ...inline, mode: 'shadow' } });
		await visit(shadow, '/soft/1');
		const bare = rig({ spool: { inlineMaxBytes: 0, mode: 'shadow' } });
		await visit(bare, '/soft/1');
		expect(shadow.log).toEqual(bare.log);
		expect(shadow.log).not.toContain(asked);
		expect(await stored(shadow, '/soft/1')).toEqual(await stored(bare, '/soft/1'));
	});

	const encode = (text: string) => new TextEncoder().encode(text);
	const pageOf = (text: string, bytes: number) =>
		text.replace('<head>', `<head>${' '.repeat(bytes - encode(text).length)}`);
	const drain = async (body: ReadableStream<Uint8Array>) => {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let got = '';
		for (;;) {
			try {
				const { done, value } = await reader.read();
				if (done) return { got, error: null as unknown };
				got += decoder.decode(value, { stream: true });
			} catch (error) {
				return { got, error };
			}
		}
	};
	/** a body of `chunks` chunks of `size` bytes, counting what is pulled and cancelled */
	const counted = (chunks: number, size: number, headers: Record<string, string> = {}) => {
		const counts = { delivered: 0, cancels: 0 };
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (counts.delivered === chunks) return controller.close();
					counts.delivered += 1;
					controller.enqueue(new Uint8Array(size));
				},
				cancel() {
					counts.cancels += 1;
				}
			},
			{ highWaterMark: 0 }
		);
		return { response: { headers: new Headers(headers), body } as unknown as Response, counts };
	};

	it('reads a body of exactly the cap, and returns null for one byte more', async () => {
		const exact = await readCapped(
			new Response(new Uint8Array(MAX_STATIC_BYTES)),
			MAX_STATIC_BYTES
		);
		expect(exact?.byteLength).toBe(MAX_STATIC_BYTES);
		const over = await readCapped(
			new Response(new Uint8Array(MAX_STATIC_BYTES + 1)),
			MAX_STATIC_BYTES
		);
		expect(over).toBeNull();
	});

	it('pulls no more than the cap plus one chunk, and cancels the copy once over', async () => {
		const size = 1024;
		const cap = 10 * size + size / 2;
		const { response, counts } = counted(100, size);
		expect(await readCapped(response, cap)).toBeNull();
		expect(counts).toEqual({ delivered: Math.floor(cap / size) + 1, cancels: 1 });
	});

	it('reads a body that ends at the cap without a cancel', async () => {
		const { response, counts } = counted(10, 1024);
		expect((await readCapped(response, 10 * 1024))?.byteLength).toBe(10 * 1024);
		expect(counts).toEqual({ delivered: 10, cancels: 0 });
	});

	it('does not read a body that content-length puts over the cap, and cancels it', async () => {
		const { response, counts } = counted(100, 1024, {
			'content-length': String(MAX_STATIC_BYTES + 1)
		});
		expect(await readCapped(response, MAX_STATIC_BYTES)).toBeNull();
		expect(counts).toEqual({ delivered: 0, cancels: 1 });
	});

	it('keeps a page of exactly MAX_STATIC_BYTES, and the visitor gets all of it', async () => {
		const r = rig({ spool: inline, fetchWrap: rewrite((t) => pageOf(t, MAX_STATIC_BYTES)) });
		const text = await visit(r, '/soft/1');
		expect(encode(text).byteLength).toBe(MAX_STATIC_BYTES);
		expect(r.log).toEqual(['GET /soft/1']);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});

	it('does not keep a page one byte over MAX_STATIC_BYTES, and the visitor gets all of it', async () => {
		const r = rig({
			spool: inline,
			fetchWrap: rewrite((t) => pageOf(t, MAX_STATIC_BYTES + 1))
		});
		const text = await visit(r, '/soft/1');
		expect(encode(text).byteLength).toBe(MAX_STATIC_BYTES + 1);
		expect(r.log).toEqual(['GET /soft/1', asked]);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});

	it('does not keep a page that content-length puts over the cap, and the visitor gets all of it', async () => {
		const r = rig({
			spool: inline,
			fetchWrap: rewrite((t) => pageOf(t, MAX_STATIC_BYTES + 1), {
				'content-length': String(MAX_STATIC_BYTES + 1)
			})
		});
		const text = await visit(r, '/soft/1');
		expect(encode(text).byteLength).toBe(MAX_STATIC_BYTES + 1);
		expect(r.log).toEqual(['GET /soft/1', asked]);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});

	it.each([
		['before the first chunk', 0, true],
		['after the first chunk', 1, true],
		['after two of four chunks', 2, true],
		['after the first chunk, in the same task', 1, false],
		['after two of four chunks, in the same task', 2, false]
	])(
		'keeps nothing when the body fails %s, and the visitor gets what was sent',
		async (_name, sent, gap) => {
			const failure = new Error('connection reset');
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => void unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			let parts: string[] = [];
			let broken = true;
			try {
				const r = rig({
					spool: inline,
					fetchWrap: async (response) => {
						if (!broken || !html(response) || !response.headers.has('spool-artifact')) {
							return response;
						}
						broken = false;
						const text = await response.text();
						const quarter = Math.ceil(text.length / 4);
						parts = [0, 1, 2, 3].map((i) => text.slice(i * quarter, (i + 1) * quarter));
						const headers = new Headers(response.headers);
						headers.delete('content-length');
						let next = 0;
						const body = new ReadableStream<Uint8Array>(
							{
								async pull(controller) {
									if (gap) await new Promise((resolve) => setTimeout(resolve, 0));
									if (next === sent) controller.error(failure);
									else controller.enqueue(encode(parts[next++] as string));
								}
							},
							{ highWaterMark: 0 }
						);
						return new Response(body, { status: response.status, headers });
					}
				});
				const waited: Promise<unknown>[] = [];
				const pending = r.runtime.handle(nav('/soft/1'), (p) => void waited.push(p));
				if (!pending) throw new Error('request was ignored');
				const response = await pending;
				const visitor = drain(response.body as ReadableStream<Uint8Array>);
				await Promise.all(waited);
				const { got, error } = await visitor;
				expect(got).toBe(parts.slice(0, sent).join(''));
				expect(error).toBe(failure);
				expect(r.log).toEqual(['GET /soft/1', asked]);
				expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));

				await r.runtime.replica.drop(['/soft/1']);
				r.log.length = 0;
				await visit(r, '/soft/1');
				expect(r.log).toEqual(['GET /soft/1']);
				expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
			expect(unhandled).toEqual([]);
		}
	);

	it('stores one artifact when a second navigation to the path arrives while the first copy is read', async () => {
		let begun = (): void => {};
		const started = new Promise<void>((resolve) => (begun = resolve));
		let release = (): void => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let first = true;
		const r = rig({
			spool: inline,
			fetchWrap: async (response) => {
				if (!first || !html(response) || !response.headers.has('spool-artifact'))
					return response;
				first = false;
				const text = await response.text();
				const headers = new Headers(response.headers);
				headers.delete('content-length');
				begun();
				const body = new ReadableStream({
					async start(controller) {
						await held;
						controller.enqueue(encode(text));
						controller.close();
					}
				});
				return new Response(body, { status: response.status, headers });
			}
		});
		const { replica } = r.runtime;
		const put = replica.put.bind(replica);
		let puts = 0;
		replica.put = (artifact, persist) => {
			if (artifact.id === '/soft/1') puts += 1;
			return put(artifact, persist);
		};
		const waited: Promise<unknown>[] = [];
		const pending = r.drive(nav('/soft/1'));
		await started;
		const later = r.runtime.handle(nav('/soft/1'), (p) => void waited.push(p));
		if (!later) throw new Error('request was ignored');
		await later;
		while (!(await stored(r, '/soft/1')))
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(puts).toBe(1);
		release();
		await pending;
		await Promise.all(waited);
		expect(r.log).toEqual(['GET /soft/1', 'GET /soft/1']);
		expect(puts).toBe(1);
		expect(r.runtime.ledger.entries()).toMatchObject([{ id: '/soft/1', requests: 0 }]);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});

	it("settles a second navigation's background work while the first body is still held", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let first = true;
		const r = rig({
			spool: inline,
			fetchWrap: async (response) => {
				if (!first || !html(response) || !response.headers.has('spool-artifact')) {
					return response;
				}
				first = false;
				const text = await response.text();
				const headers = new Headers(response.headers);
				headers.delete('content-length');
				const body = new ReadableStream({
					async start(controller) {
						await held;
						controller.enqueue(encode(text));
						controller.close();
					}
				});
				return new Response(body, { status: response.status, headers });
			}
		});
		const firstWaited: Promise<unknown>[] = [];
		const pendingFirst = r.runtime.handle(nav('/soft/1'), (p) => void firstWaited.push(p));
		if (!pendingFirst) throw new Error('request was ignored');
		await pendingFirst;
		const secondWaited: Promise<unknown>[] = [];
		const later = r.runtime.handle(nav('/soft/1'), (p) => void secondWaited.push(p));
		if (!later) throw new Error('request was ignored');
		await later;
		await Promise.all(secondWaited);
		release();
		await Promise.all(firstWaited);
		expect(r.log).toEqual(['GET /soft/1', 'GET /soft/1']);
		expect(await stored(r, '/soft/1')).toEqual(await built(r, '/soft/1'));
	});
});

describe('a static copy that is not kept', () => {
	const file = defineRoute('/file/:name', { strategy: 'static', depends: () => ['site'] });
	const cases: Array<[string, number, string, () => Response]> = [
		['a 404', 404, 'missing', () => new Response('missing', { status: 404 })],
		[
			'a 206',
			206,
			'par',
			() => new Response('par', { status: 206, headers: { 'content-range': 'bytes 0-2/9' } })
		],
		['a 304', 304, '', () => new Response(null, { status: 304 })]
	];

	it.each(cases)(
		'hands the visitor %s, cancels its copy, keeps nothing, and asks the network again',
		async (_name, status, text, make) => {
			const cancelled = vi.spyOn(ReadableStream.prototype, 'cancel');
			try {
				const r = rig({
					routes: [...routes, file],
					app: (request) =>
						new URL(request.url).pathname.startsWith('/file/') ? make() : undefined
				});
				const first = await r.drive(sub('/file/a'));
				expect(first.status).toBe(status);
				expect(await first.text()).toBe(text);
				await new Promise((resolve) => setTimeout(resolve, 0));
				// a body-less answer has no copy stream to cancel
				expect(cancelled).toHaveBeenCalledTimes(text === '' ? 0 : 1);
				expect(await r.runtime.replica.ids()).toEqual([]);

				r.log.length = 0;
				await r.drive(sub('/file/a'));
				expect(r.log).toEqual(['GET /file/a']);
			} finally {
				cancelled.mockRestore();
			}
		}
	);
});

describe('hard freshness', () => {
	it('past the bound, shows nothing until a required sync completes, then shows the local page', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.log.length = 0;
		r.advance(61);

		const release = r.hold();
		let shown = false;
		const pending = r.drive(nav('/hard/1')).then((response) => {
			shown = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(shown).toBe(false);
		expect(r.log).toEqual(['GET /.spool/sync']);

		release();
		const html = await (await pending).text();
		expect(html).toContain('1');
		expect(r.log).toEqual(['GET /.spool/sync']);
	});

	it('past the bound, a sync that reports a change drops the artifact and the network answers', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		await r.spool.invalidate(['node:1']);
		r.log.length = 0;
		r.advance(61);
		await visit(r, '/hard/1');
		expect(r.log).toEqual(['GET /.spool/sync', 'GET /hard/1', 'GET /.spool/artifact']);

		r.log.length = 0;
		await visit(r, '/hard/1');
		expect(r.log).toEqual([]);
	});

	it('syncs once for a burst of navigations past the bound', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		await visit(r, '/hard/2');
		r.log.length = 0;
		r.advance(61);
		await Promise.all([visit(r, '/hard/1'), visit(r, '/hard/2'), visit(r, '/hard/1')]);
		expect(r.log).toEqual(['GET /.spool/sync']);
	});

	it('stays local, with no sync, inside the bound', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.log.length = 0;
		r.advance(60);
		await visit(r, '/hard/1');
		expect(r.log).toEqual([]);
	});

	it('serves the stale page when the sync fails and the route allows offline', async () => {
		const r = rig();
		await visit(r, '/hard/1');
		r.advance(61);
		r.offline(true);
		const html = await visit(r, '/hard/1');
		expect(html).toContain('1');
	});

	it('refuses the stale page when the sync fails and the route says refuse', async () => {
		const r = rig();
		await visit(r, '/strict/1');
		r.advance(61);
		r.offline(true);
		await expect(visit(r, '/strict/1')).rejects.toThrow('offline');
		r.offline(false);
		r.log.length = 0;
		await visit(r, '/strict/1');
		expect(r.log).toEqual(['GET /.spool/sync']);
	});
});

describe('soft freshness', () => {
	it('past the bound, shows the local page with no request and syncs on the next network view', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(61);
		const html = await visit(r, '/soft/1');
		expect(html).toContain('1');
		expect(r.log).toEqual([]);

		await visit(r, '/soft/1');
		await visit(r, '/soft/1');
		expect(r.log).toEqual([]);

		await visit(r, '/soft/2');
		expect(r.log.filter((l) => l === 'GET /.spool/sync')).toEqual(['GET /.spool/sync']);
		r.log.length = 0;
		await visit(r, '/soft/3');
		expect(r.log.filter((l) => l === 'GET /.spool/sync')).toEqual([]);
	});

	it('shows the stale page while a change waits for a network view, then goes to the network', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.spool.invalidate(['node:1']);
		r.log.length = 0;
		r.advance(61);
		await visit(r, '/soft/1');
		expect(r.log).toEqual([]);
		await visit(r, '/soft/2');
		r.log.length = 0;
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['GET /soft/1', 'GET /.spool/artifact']);
	});

	it('makes 0 requests for 100 held URLs with analytics on', async () => {
		const r = rig();
		for (let n = 1; n <= 100; n++) await visit(r, `/soft/${n}`);
		const beacon = sub('/cdn-cgi/rum', {
			method: 'POST',
			body: '{"n":1}',
			headers: { 'content-type': 'application/json' }
		});
		await r.drive(beacon);
		r.log.length = 0;
		for (let n = 1; n <= 100; n++) expect(await visit(r, `/soft/${n}`)).toContain(String(n));
		expect(r.log).toEqual([]);
	});

	it('survives a failed background sync', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.advance(61);
		r.offline(true);
		expect(await visit(r, '/soft/1')).toContain('1');
	});
});

describe('soft sync at the lease', () => {
	const LEASE = 86_400;
	const syncs = (r: ReturnType<typeof rig>) => r.log.filter((l) => l === 'GET /.spool/sync');

	it('sends nothing for a queued soft sync before the lease passes', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(LEASE - 1);
		await visit(r, '/soft/1');
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual([]);
	});

	it('sends one sync from a local view once the queue has waited a lease, then none', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.spool.invalidate(['node:1']);
		r.log.length = 0;
		r.advance(LEASE);
		const html = await visit(r, '/soft/1');
		expect(html).toContain('1');
		expect(syncs(r)).toEqual(['GET /.spool/sync']);

		r.log.length = 0;
		await visit(r, '/soft/1');
		await visit(r, '/soft/2');
		expect(syncs(r)).toEqual([]);
	});

	it('sends one sync for two local views in the same burst', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await visit(r, '/soft/2');
		r.log.length = 0;
		r.advance(LEASE);
		await Promise.all([visit(r, '/soft/1'), visit(r, '/soft/2'), visit(r, '/soft/1')]);
		expect(syncs(r)).toEqual(['GET /.spool/sync']);
	});

	it('leaves the next local view to retry a failed sync, once and not in a loop', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(LEASE);
		r.offline(true);
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual(['GET /.spool/sync']);

		r.offline(false);
		r.log.length = 0;
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual(['GET /.spool/sync']);
		r.log.length = 0;
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual([]);
	});

	it('shows a day-old page, sends one sync and then shows the edit, with a stub update and a beacon flush between', async () => {
		let title = 'old';
		const edit = defineRoute('/edit/:id', {
			strategy: 'template',
			template: { source: '<html><head></head><body>{{title}}</body></html>' },
			depends: dep,
			load: () => ({ title })
		});
		const r = rig({
			routes: [edit],
			config: { stamp: 2 },
			app: (request) =>
				new URL(request.url).pathname.startsWith('/edit/')
					? new Response(`<html><head></head><body>${title}</body></html>`, {
							headers: HTML
						})
					: undefined
		});
		await visit(r, '/edit/1');
		expect(await visit(r, '/edit/1')).toContain('old');
		title = 'new';
		await r.spool.invalidate(['node:1']);
		r.advance(LEASE + 3600);
		const next = r.make();
		await next.install({} as never);
		r.log.length = 0;

		const first = await (await r.drive(nav('/edit/1'), next)).text();
		expect(first).toContain('old');
		expect([...r.log].sort()).toEqual(['GET /.spool/sync', 'POST /.spool/beacon']);

		r.log.length = 0;
		expect(await (await r.drive(nav('/edit/1'), next)).text()).toContain('new');
		expect(r.log.filter((l) => l === 'GET /edit/1')).toHaveLength(1);
		expect(syncs(r)).toEqual([]);
	});

	it('counts the sync as the contact the page hears about', async () => {
		const broadcasts: unknown[] = [];
		const r = rig({ broadcast: (message) => void broadcasts.push(message) });
		await visit(r, '/soft/1');
		broadcasts.length = 0;
		r.advance(LEASE);
		await visit(r, '/soft/1');
		expect(broadcasts).toEqual([{ type: 'spool:contact', at: expect.any(Number) }]);
	});

	it('sends nothing from a worker that has no lease', async () => {
		const r = rig({ config: { lease: undefined } });
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(LEASE * 3);
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual([]);
	});

	it('sends nothing from a worker in shadow mode', async () => {
		const r = rig({ config: { mode: 'shadow' } });
		await visit(r, '/soft/1');
		r.log.length = 0;
		r.advance(LEASE * 3);
		await visit(r, '/soft/1');
		expect(syncs(r)).toEqual([]);
	});
});

describe('beacons', () => {
	const post = (body: string, type = 'application/json') =>
		sub('/cdn-cgi/rum', { method: 'POST', body, headers: { 'content-type': type } });

	it('queues them with 0 requests and sends them in one flush on the next network moment', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		for (const n of [1, 2, 3, 4]) {
			const response = await r.drive(post(`{"n":${n}}`));
			expect(response.status).toBe(204);
		}
		await visit(r, '/soft/1');
		expect(r.log).toEqual([]);

		await visit(r, '/soft/2');
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toHaveLength(1);
		expect(r.log.filter((l) => l === 'POST /cdn-cgi/rum')).toHaveLength(4);
		expect(rum(r).map((e) => e.body)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}']);
		expect(r.received.every((e) => e.type === 'application/json')).toBe(true);
		expect(r.received.every((e) => e.search === '')).toBe(true);
		expect(r.sink.events.some((e) => e.path === '/cdn-cgi/rum')).toBe(false);
		expect(viewsOf(r.sink.events).map((v) => v.reason)).toEqual(['cold', 'fresh', 'cold']);
	});

	it('keeps them when the flush fails and sends them on a later moment', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.drive(post('{"n":1}'));
		const write = () => sub('/form', { method: 'POST', body: 'x' });
		r.offline(true);
		await visit(r, '/soft/1');
		await r.drive(write()).catch(() => undefined);
		expect(r.sink.events).toEqual([]);

		r.offline(false);
		await r.drive(write());
		expect(rum(r)).toHaveLength(1);
	});

	it('does not treat a cacheable GET as a network moment, since the HTTP cache may answer it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.drive(post('{"n":1}'));
		r.log.length = 0;
		await r.drive(sub('/app.js'));
		expect(r.log).toEqual(['GET /app.js']);
		expect(r.sink.events).toEqual([]);
	});

	it('sends a binary beacon straight to the network', async () => {
		const r = rig();
		await r.drive(post('x', 'application/octet-stream'));
		expect(r.log).toEqual(['POST /cdn-cgi/rum']);
	});

	it('sends a held beacon on its own once it is a day old', async () => {
		const r = rig();
		await r.drive(post('{"n":1}'));
		r.advance(25 * 60 * 60);
		await r.drive(nav('/soft/1'));
		expect(r.log.filter((l) => l === 'POST /cdn-cgi/rum')).toHaveLength(1);
		expect(rum(r).map((e) => e.body)).toEqual(['{"n":1}']);
	});
});

describe('subresources', () => {
	it('serves an immutable asset from the cache after the first fetch', async () => {
		const r = rig();
		for (const path of ['/site.css', '/asset.js']) {
			await r.drive(sub(path));
			r.log.length = 0;
			expect(await (await r.drive(sub(path))).text()).not.toBe('');
			expect(r.log).toEqual([]);
		}
	});

	it('does not cache a short-lived asset, a Range request, or a failure', async () => {
		const r = rig();
		await r.drive(sub('/app.js'));
		await r.drive(sub('/app.js'));
		await r.drive(sub('/asset.js', { headers: { range: 'bytes=0-1' } }));
		await r.drive(sub('/asset.js', { headers: { range: 'bytes=0-1' } }));
		await r.drive(sub('/gone'));
		await r.drive(sub('/gone'));
		expect(r.log).toEqual([
			'GET /app.js',
			'GET /app.js',
			'GET /asset.js',
			'GET /asset.js',
			'GET /gone',
			'GET /gone'
		]);
	});

	it('lets the browser handle cross-origin requests', () => {
		const r = rig();
		expect(r.runtime.handle(new Request('https://other.test/x.js'), () => {})).toBeUndefined();
	});
});

describe('the navigation route and the cache probe', () => {
	const NAVIGATE = [{ condition: { requestMode: 'navigate' }, source: 'fetch-event' }];
	const timing = (encodedBodySize: number) =>
		vi.spyOn(performance, 'getEntriesByName').mockReturnValue([{ encodedBodySize }] as never);
	const clientLoads = (log: string[]) => log.filter((line) => line.endsWith('/client.js'));

	it('routes navigations to the fetch event once at install where the browser has addRoutes', async () => {
		const r = rig();
		const seen: unknown[] = [];
		await r.runtime.install({ addRoutes: async (list) => void seen.push(list) });
		expect(seen).toEqual([NAVIGATE]);
	});

	it('installs unchanged where addRoutes is missing or refuses the route', async () => {
		const r = rig();
		await expect(r.runtime.install({})).resolves.toBeUndefined();
		await expect(
			r.runtime.install({
				addRoutes: async () => {
					throw new TypeError('bad rule');
				}
			})
		).resolves.toBeUndefined();
		await expect(
			r.runtime.install({
				addRoutes: () => {
					throw new TypeError('bad rule');
				}
			})
		).resolves.toBeUndefined();
	});

	it('forwards a subresource in passthrough mode only after the probe hits', async () => {
		const r = rig({ spool: { assets: 'passthrough' } });
		expect(r.runtime.handle(sub('/site.css'), () => undefined)).toBeUndefined();
		const spy = timing(0);
		try {
			await r.drive(nav('/page/1'));
			expect(clientLoads(r.log)).toHaveLength(1);
			r.log.length = 0;
			expect(await (await r.drive(sub('/site.css'))).text()).toBe('css');
			expect(r.log).toEqual(['GET /site.css']);
		} finally {
			spy.mockRestore();
		}
	});

	it('leaves a subresource to the browser after a probe that finds no cache entry', async () => {
		const r = rig({ spool: { assets: 'passthrough' } });
		const spy = timing(4096);
		try {
			await r.drive(nav('/page/1'));
			expect(clientLoads(r.log)).toHaveLength(1);
			expect(r.runtime.handle(sub('/site.css'), () => undefined)).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});

	it('probes once per worker lifetime, and only where the worker sends assets to the browser', async () => {
		const passthrough = rig({ spool: { assets: 'passthrough' } });
		const spy = timing(0);
		try {
			await passthrough.drive(nav('/page/1'));
			await passthrough.drive(nav('/page/2'));
			expect(clientLoads(passthrough.log)).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
		const cached = rig();
		await cached.drive(nav('/page/1'));
		expect(clientLoads(cached.log)).toEqual([]);
	});
});

describe('piggybacked sync', () => {
	it('evicts stale artifacts and moves the cursor from a response to a request that was happening anyway', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await visit(r, '/page/a');
		const syncedBefore = r.runtime.replica.syncedAt;
		await r.spool.invalidate(['node:1']);
		r.advance(10);

		await r.drive(sub('/app.js'));
		const request = r.requests[r.requests.length - 1] as Request;
		expect(request.headers.get('spool-vector-seen')).toBe('0');
		expect(r.runtime.replica.cursor).toBe(1);
		expect(r.runtime.replica.syncedAt).toBeGreaterThan(syncedBefore);
		expect(await r.runtime.replica.ids()).toEqual(['/page/a']);
	});

	it('applies the invalidation but does not extend freshness when the response is aged', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-vector')) headers.set('age', '30');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		const syncedBefore = r.runtime.replica.syncedAt;
		await r.spool.invalidate(['node:1']);
		r.advance(10);
		await r.drive(sub('/app.js'));
		expect(await r.runtime.replica.ids()).toEqual([]);
		expect(r.runtime.replica.syncedAt).toBe(syncedBefore);
	});

	it('learns of a write the app made while answering it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		r.log.length = 0;
		await r.drive(sub('/form', { method: 'POST', body: 'x' }));
		expect(await r.runtime.replica.ids()).toEqual([]);
		await visit(r, '/soft/1');
		expect(r.log).toEqual(['POST /form', 'GET /soft/1', 'GET /.spool/artifact']);
	});

	it('ignores spool headers from another protocol version', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-protocol')) headers.set('spool-protocol', '2');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('ignores malformed spool headers', async () => {
		const r = rig({
			fetchWrap: (response) => {
				const headers = new Headers(response.headers);
				if (headers.has('spool-protocol')) headers.set('spool-vector', 'junk');
				return new Response(response.body, { status: response.status, headers });
			}
		});
		await visit(r, '/soft/1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});
});

describe('the runtime itself', () => {
	it('falls back to the network when its storage fails', async () => {
		const broken: ReplicaStorage = {
			...memoryStorage(),
			getMeta: async () => {
				throw new Error('quota');
			}
		};
		const r = rig({ storage: broken });
		const html = await visit(r, '/soft/1');
		expect(html).toContain('1');
		expect(r.log).toContain('GET /soft/1');
	});

	it('wipes the replica when the runtime version changes', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const next = createRuntime({
			config: { ...r.spool.config, version: 'next' } as SwConfig,
			storage: r.storage,
			fetch: async () => new Response('x'),
			caches: r.caches,
			origin: ORIGIN
		});
		await next.activate();
		expect(await next.replica.ids()).toEqual([]);
	});

	it('drops asset caches from older versions on activate and keeps its own', async () => {
		const r = rig();
		await r.caches.open('spool-assets-old');
		await r.caches.open('unrelated');
		await r.drive(sub('/site.css'));
		await r.runtime.activate();
		expect(r.caches.names().sort()).toEqual([
			`spool-assets-${r.spool.config.version}`,
			'unrelated'
		]);
	});

	it('answers the version handshake and the status request, and ignores other messages', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		expect(await r.runtime.message({ type: 'spool:hello', protocol: 1 })).toEqual({
			type: 'spool:hello',
			protocol: 1,
			version: r.spool.config.version,
			compatible: true,
			contact: expect.any(Number),
			lease: r.spool.config.lease
		});
		expect(await r.runtime.message({ type: 'spool:hello', protocol: 9 })).toMatchObject({
			compatible: false
		});
		expect(await r.runtime.message({ type: 'spool:status' })).toEqual({
			type: 'spool:status',
			cursor: 0,
			syncedAt: 0,
			artifacts: ['/soft/1'],
			beacons: 1
		});
		expect(await r.runtime.message({ type: 'other' })).toBeUndefined();
		expect(await r.runtime.message(null)).toBeUndefined();
	});
});

describe('the view id and the loads report', () => {
	it('gives the page the id of its latest view and queues its report against it', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const reply = (await r.runtime.message({ type: 'spool:view', path: '/soft/1' })) as {
			id: string | null;
		};
		expect(reply.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await r.runtime.message({ type: 'spool:view', path: '/never' })).toEqual({
			type: 'spool:view',
			id: null
		});
		expect(await r.runtime.message({ type: 'spool:view', path: 5 })).toEqual({
			type: 'spool:view',
			id: null
		});

		expect(
			await r.runtime.message({ type: 'spool:loads', view: reply.id, count: 2 })
		).toBeUndefined();
		await r.runtime.message({ type: 'spool:loads', view: 5, count: 2 });
		await r.runtime.message({ type: 'spool:loads', view: 'x', count: 'many' });
		const held = (await r.storage.readBeacons()).map((b) => b.event);
		const views = viewsWithLoads(held);
		expect(views.map((v) => [v.id, v.crossOriginLoads])).toEqual([[reply.id, 2]]);
		expect(held.filter((e) => e.path === '/.spool/loads')).toHaveLength(1);
	});

	it('names each view differently and the newest wins for a path', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await visit(r, '/soft/1');
		const ids = (await r.storage.readBeacons()).map((b) => JSON.parse(b.event.body).id);
		expect(new Set(ids).size).toBe(2);
		const latest = (await r.runtime.message({ type: 'spool:view', path: '/soft/1' })) as {
			id: string;
		};
		expect(latest.id).toBe(ids[1]);
	});

	it('does not queue a report when views are off', async () => {
		const r = rig();
		const off = createRuntime({
			config: { ...r.spool.config, views: false } as SwConfig,
			storage: r.storage,
			fetch: async () => new Response('x'),
			caches: r.caches,
			origin: ORIGIN
		});
		await off.message({ type: 'spool:loads', view: 'v', count: 1 });
		expect(await r.storage.readBeacons()).toEqual([]);
	});

	it('does not count a loads report as another site beacon when deciding to flush', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.runtime.message({ type: 'spool:loads', view: 'v', count: 1 });
		r.log.length = 0;
		await visit(r, '/soft/1');
		await visit(r, '/soft/2');
		expect(r.log.filter((l) => l === 'POST /.spool/beacon')).toEqual([]);
	});
});

describe('defensive paths', () => {
	it('drops an artifact that is stored but already outdated, and asks the network', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		await r.spool.invalidate(['node:1']);
		r.advance(61);
		await r.runtime.replica.applySync({
			protocol: 1,
			cursor: 1,
			changed: { 'node:1': 1 },
			dropped: [],
			reset: false
		});
		await r.storage.putArtifact({
			artifact: artifact({ id: '/soft/1', vector: 0 }),
			fetchedAt: 1
		});
		r.log.length = 0;
		await visit(r, '/soft/1');
		expect(r.log[0]).toBe('GET /soft/1');
		expect(await r.runtime.replica.get('/soft/1')).toBeDefined();
	});

	it('still answers when a background task fails', async () => {
		let saves = 0;
		const base = memoryStorage();
		const flaky: ReplicaStorage = {
			...base,
			setMeta: async (meta) => {
				if (saves++ > 0) throw new Error('quota');
				return base.setMeta(meta);
			}
		};
		const r = rig({ storage: flaky });
		expect(await visit(r, '/soft/1')).toContain('1');
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('sends a request unchanged when the cursor header cannot be added', async () => {
		const r = rig();
		await visit(r, '/soft/1');
		const hostile = sub('/app.js');
		Object.defineProperty(hostile, 'headers', {
			get() {
				throw new TypeError('locked');
			}
		});
		expect(await (await r.drive(hostile)).text()).toBe('js');
	});
});

describe('classify', () => {
	const config = rig().spool.config;
	it('sorts requests', () => {
		expect(classify(config, new Request('https://other.test/'), ORIGIN).kind).toBe('ignore');
		expect(classify(config, sub('/cdn-cgi/rum', { method: 'POST' }), ORIGIN).kind).toBe(
			'beacon'
		);
		expect(classify(config, sub('/other', { method: 'POST' }), ORIGIN).kind).toBe('pass');
		expect(classify(config, sub('/app.js'), ORIGIN).kind).toBe('asset');
		expect(classify(config, nav('/nowhere'), ORIGIN).kind).toBe('pass');
		const hit = classify(config, nav('/soft/4'), ORIGIN);
		expect(hit).toMatchObject({ kind: 'navigation', path: '/soft/4', params: { id: '4' } });
	});

	it('never answers a query string from a path artifact', () => {
		expect(classify(config, nav('/soft/4?page=2'), ORIGIN).kind).toBe('pass');
		const data = {
			...config,
			routes: [
				...config.routes,
				{
					pattern: '/api/:id',
					strategy: 'data' as const,
					scope: 'public' as const,
					freshness: { maxStale: 60, mode: 'soft' as const },
					persist: true,
					offline: 'serve' as const,
					sync: 'background' as const
				}
			]
		};
		expect(classify(data, sub('/api/1'), ORIGIN).kind).toBe('data');
		expect(classify(data, sub('/api/1?q=x'), ORIGIN).kind).toBe('asset');
	});

	it('lets a route that declares a query schema take a query string, and no other', () => {
		const route = (pattern: string, strategy: 'template' | 'data', over = {}) => ({
			pattern,
			strategy,
			scope: 'public' as const,
			freshness: { maxStale: 60, mode: 'soft' as const },
			persist: true,
			offline: 'serve' as const,
			sync: 'background' as const,
			...over
		});
		const query = { list: 'rows' };
		const queried = {
			...config,
			routes: [
				route('/people', 'template', { query }),
				route('/api/plain', 'data'),
				route('/api/:id', 'data', { query }),
				route('/plain', 'template')
			]
		};
		expect(classify(queried, nav('/people?page=2'), ORIGIN)).toMatchObject({
			kind: 'navigation',
			path: '/people'
		});
		expect(classify(queried, sub('/api/1?page=2'), ORIGIN)).toMatchObject({
			kind: 'data',
			path: '/api/1'
		});
		expect(classify(queried, nav('/plain?page=2'), ORIGIN).kind).toBe('pass');
		expect(classify(queried, sub('/api/plain?page=2'), ORIGIN).kind).toBe('asset');
	});
});

describe('a family route answers from the row the device holds', () => {
	const COURSES = [
		{ id: 'c1', title: 'Algebra' },
		{ id: 'c2', title: 'Biology' }
	];
	const page = {
		source: '<html><head></head><body><h1>{{row.title}}</h1><p>{{params.id}}</p></body></html>'
	};
	const compiled = compileTemplate(page);
	const family = { dataset: 'courses', key: 'id' };
	const routes = [
		defineRoute('/courses/:id', {
			strategy: 'template',
			template: page,
			family,
			load: (ctx) => COURSES.find((course) => course.id === ctx.params['id'])
		}),
		defineRoute('/bare/:id', { strategy: 'template', template: page, family })
	];
	const app = (request: Request) => {
		const id = /^\/courses\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1] ?? '';
		const row = COURSES.find((course) => course.id === id);
		if (!row) return new Response('not found', { status: 404 });
		return new Response(interpretTemplate(compiled, { params: { id }, row }), {
			headers: HTML
		});
	};
	async function setup() {
		const proof = await setProof(new Map(COURSES.map((row) => [row.id, row])));
		const courses = defineDataset('courses', {
			scope: 'public',
			schema: 'v1',
			maxRows: 1000,
			maxBytes: 1_000_000,
			key: (row) => row.id,
			seed: () => COURSES,
			read: (ids) => COURSES.filter((row) => ids.includes(row.id)),
			changes: () => ({ cursor: 0, puts: [], deletes: [], proof }),
			horizon: () => 0,
			head: () => ({ cursor: 0, proof })
		});
		const r = familyRig({ routes, app, spool: { datasets: [courses] } });
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [courses],
			version: 1,
			url: new URL(ORIGIN),
			routes
		});
		const pack = createPackStore(freshIndexedDB());
		await pack.installPack(once(built.bytes));
		return { ...r, target: r.make({ pack }) };
	}
	async function* once(bytes: Uint8Array<ArrayBuffer>) {
		yield bytes;
	}

	it('renders a key the page never fetched with no request, equal to the server page', async () => {
		const r = await setup();
		await r.visit('/courses/c1', r.target);
		await r.visit('/courses/c1', r.target);
		r.reset();
		const local = await r.visit('/courses/c2', r.target);
		expect(r.log).toEqual([]);
		const network = await (await r.spool.handle(nav('/courses/c2'), app)).text();
		const verdict = equivalent(local, network);
		expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
	});

	it('goes to the network for a key the dataset does not hold', async () => {
		const r = await setup();
		await r.visit('/courses/c1', r.target);
		await r.visit('/courses/c1', r.target);
		r.reset();
		await r.visit('/courses/c9', r.target);
		expect(r.log).toEqual(['GET /courses/c9']);
	});

	it('goes to the network for every family URL when no pack is held', async () => {
		const r = await setup();
		await r.visit('/courses/c1');
		expect(r.log).toContain('GET /courses/c1');
	});

	it('builds the server artifact with the { params, row } context, and refuses a family with no load', async () => {
		const r = await setup();
		const built = await r.spool.handle(
			new Request(`${ORIGIN}/.spool/artifact?path=/courses/c1`),
			app
		);
		expect(built.status).toBe(200);
		expect((await built.json()).body).toEqual({
			data: { params: { id: 'c1' }, row: COURSES[0] }
		});
		const bare = await r.spool.handle(
			new Request(`${ORIGIN}/.spool/artifact?path=/bare/c1`),
			app
		);
		expect(bare.status).toBe(404);
	});

	async function coursesOf(rows: typeof COURSES) {
		const proof = await setProof(new Map(rows.map((row) => [row.id, row])));
		return defineDataset('courses', {
			scope: 'public',
			schema: 'v1',
			maxRows: 1000,
			maxBytes: 1_000_000,
			key: (row) => row.id,
			seed: () => rows,
			read: (ids) => rows.filter((row) => ids.includes(row.id)),
			changes: () => ({ cursor: 0, puts: [], deletes: [], proof }),
			horizon: () => 0,
			head: () => ({ cursor: 0, proof })
		});
	}

	/** a device holding pack 1, a server holding packs 1 and 2, and the stub a device at 2 would get */
	async function twoVersions() {
		const bundles = memoryBundleStore();
		const first = await coursesOf(COURSES);
		const second = await coursesOf([...COURSES, { id: 'c3', title: 'Chemistry' }]);
		await buildBundle({ store: bundles, datasets: [first], version: 1, url: new URL(ORIGIN) });
		await buildBundle({ store: bundles, datasets: [second], version: 2, url: new URL(ORIGIN) });
		const pack = createPackStore(freshIndexedDB());
		await pack.installPack(once((await bundles.get(1)) as Uint8Array<ArrayBuffer>));
		const r = familyRig({ routes, app, spool: { bundles } });
		return { pack, r, reader: packReader(bundles) };
	}

	it('installs nothing when the stub names the version the device holds', async () => {
		const { pack, r, reader } = await twoVersions();
		const runtime = r.make({
			config: { ...r.spool.config, pack: (await reader.stub(1))! },
			pack
		});
		await runtime.install({} as never);
		expect((await pack.head())?.version).toBe(1);
		expect(r.log).toEqual([]);
	});

	it('applies the inline delta from the held version with no request', async () => {
		const { pack, r, reader } = await twoVersions();
		const stub = (await reader.stub(2))!;
		const runtime = r.make({ config: { ...r.spool.config, pack: stub }, pack });
		await runtime.install({} as never);
		expect((await pack.head())?.version).toBe(2);
		expect(await pack.getRow('courses', 'c3')).toEqual({ id: 'c3', title: 'Chemistry' });
		expect(r.log).toEqual([]);
	});

	it('fetches one delta when no inline delta reaches the held version', async () => {
		const { pack, r, reader } = await twoVersions();
		const stub = (await reader.stub(2))!;
		const runtime = r.make({
			config: { ...r.spool.config, pack: { ...stub, deltas: [] } },
			pack
		});
		await runtime.install({} as never);
		expect(r.log).toEqual(['GET /.spool/bundle/delta/1/2']);
		expect((await pack.head())?.version).toBe(2);
	});

	it('fails the install on a corrupted delta and keeps the rows answering', async () => {
		const { pack, r, reader } = await twoVersions();
		const stub = (await reader.stub(2))!;
		const corrupt = {
			...stub,
			deltas: stub.deltas.map((d) => ({ ...d, digest: '0'.repeat(64) }))
		};
		const runtime = r.make({ config: { ...r.spool.config, pack: corrupt }, pack });
		await expect(runtime.install({} as never)).rejects.toThrow();
		expect((await pack.head())?.version).toBe(1);
		expect(await pack.getRow('courses', 'c1')).toEqual(COURSES[0]);
		const held = r.make({ pack });
		await r.visit('/courses/c1', held);
		await r.visit('/courses/c1', held);
		r.reset();
		const answer = await r.visit('/courses/c1', held);
		expect(answer).toContain('Algebra');
		expect(r.log).toEqual([]);
	});

	it('renders the same bytes in the worker as the server template for one row', async () => {
		const r = await setup();
		const served = r.spool.config.routes.find((x) => x.pattern === '/courses/:id')!;
		const data = { params: { id: 'c2' }, row: COURSES[1] };
		const local = await renderLocal(
			r.spool.config,
			served,
			artifact({ strategy: 'template', body: { data } })
		);
		expect(local).toEqual({
			ok: true,
			html: injectClientTag(interpretTemplate(compiled, data), r.spool.config.clientTag)
		});
	});
});

describe('a family route with no load', () => {
	const page = { source: '<html><head></head><body>{{params.id}}</body></html>' };
	const family = { dataset: 'courses', key: 'id' };
	const routes = [
		defineRoute('/bare/:id', { strategy: 'template', template: page, family }),
		defineRoute('/gone/:id', {
			strategy: 'template',
			template: page,
			family,
			load: () => undefined
		}),
		defineRoute('/has/:id', {
			strategy: 'template',
			template: page,
			family,
			load: (ctx) => ({ id: ctx.params['id'] })
		})
	];
	const app = (request: Request) => {
		const id = new URL(request.url).pathname.split('/')[2] ?? '';
		return new Response(`<html><head></head><body>${id}</body></html>`, { headers: HTML });
	};
	const artifactRequests = (r: ReturnType<typeof familyRig>) =>
		r.urls.filter((url) => url.startsWith('GET /.spool/artifact'));

	it('sends no artifact request for a family route with no load, on any view', async () => {
		const r = familyRig({ routes, app });
		for (let i = 0; i < 10; i++) await r.visit('/bare/c1');
		expect(r.urls).toEqual(Array(10).fill('GET /bare/c1'));
	});

	it('advertises no artifact for a family route with no load', async () => {
		const r = familyRig({ routes, app });
		const bare = await r.spool.handle(nav('/bare/c1'), app);
		expect(bare.headers.has('spool-artifact')).toBe(false);
		const has = await r.spool.handle(nav('/has/c1'), app);
		expect(has.headers.has('spool-artifact')).toBe(true);
	});

	it('asks for an artifact the server cannot build once, and again only after the version changes', async () => {
		const r = familyRig({ routes, app });
		for (let i = 0; i < 10; i++) await r.visit('/gone/c9');
		expect(artifactRequests(r)).toEqual(['GET /.spool/artifact?path=%2Fgone%2Fc9']);
		await r.spool.invalidate(['node:unrelated']);
		for (let i = 0; i < 3; i++) await r.visit('/gone/c9');
		expect(artifactRequests(r)).toHaveLength(2);
	});

	it('fetches the artifact of a route that has one once, across ten views', async () => {
		const r = familyRig({ routes, app });
		for (let i = 0; i < 10; i++) await r.visit('/has/c1');
		expect(artifactRequests(r)).toEqual(['GET /.spool/artifact?path=%2Fhas%2Fc1']);
	});
});

describe('a stored artifact after a pack moves', () => {
	type Row = { id: string; title: string };
	type Bundles = ReturnType<typeof memoryBundleStore>;
	const ROWS: Row[] = [
		{ id: 'c1', title: 'Algebra' },
		{ id: 'c2', title: 'Biology' }
	];
	const ITEMS: Row[] = [{ id: 'r1', title: 'One' }];
	const server = { courses: ROWS, items: ITEMS };
	const page = { source: '<html><head></head><body><h1>{{row.title}}</h1></body></html>' };
	const compiled = compileTemplate(page);
	const family = { dataset: 'courses', key: 'id' };
	const routes = [
		defineRoute('/courses/:id', {
			strategy: 'template',
			template: page,
			family,
			load: (ctx) => server.courses.find((row) => row.id === ctx.params['id'])
		}),
		defineRoute('/tpl/:id', {
			strategy: 'template',
			template: page,
			depends: () => ['courses'],
			load: (ctx) => ({ row: server.courses.find((row) => row.id === ctx.params['id']) })
		}),
		...defineResource('/rows', { dataset: 'rows', key: 'id' }).routes
	];
	const app = (request: Request) => {
		const [, first = '', id = ''] = new URL(request.url).pathname.split('/');
		if (first === 'rows') return Response.json(server.items);
		const row = server.courses.find((c) => c.id === id);
		if (!row) return new Response('not found', { status: 404 });
		return new Response(interpretTemplate(compiled, { params: { id }, row }), {
			headers: HTML
		});
	};
	const artifactOf = (path: string) => `GET /.spool/artifact?path=${encodeURIComponent(path)}`;

	async function dataset(name: string, rows: Row[]) {
		const proof = await setProof(new Map(rows.map((row) => [row.id, row])));
		return defineDataset(name, {
			scope: 'public',
			schema: 'v1',
			maxRows: 1000,
			maxBytes: 1_000_000,
			key: (row) => row.id,
			seed: () => rows,
			read: (ids) => rows.filter((row) => ids.includes(row.id)),
			changes: () => ({ cursor: 0, puts: [], deletes: [], proof }),
			horizon: () => 0,
			head: () => ({ cursor: 0, proof })
		});
	}

	/** the server's rows now, built as the pack of `version` */
	async function packAt(bundles: Bundles, version: number) {
		await buildBundle({
			store: bundles,
			datasets: [
				await dataset('courses', server.courses),
				await dataset('rows', server.items)
			],
			routes,
			version,
			url: new URL(ORIGIN)
		});
	}

	async function* once(bytes: Uint8Array<ArrayBuffer>) {
		yield bytes;
	}

	type Rig = ReturnType<typeof familyRig>;

	/** a runtime whose fetch sets the response url, as a browser fetch does */
	function make(r: Rig, over: Partial<Parameters<typeof createRuntime>[0]> = {}) {
		return createRuntime({
			config: r.spool.config,
			storage: r.storage,
			caches: r.caches,
			origin: ORIGIN,
			now: r.t,
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				const url = new URL(request.url);
				r.urls.push(`${request.method} ${url.pathname}${url.search}`);
				const response = await r.spool.handle(request, app);
				Object.defineProperty(response, 'url', { value: request.url });
				return response;
			},
			...over
		});
	}

	const visit = async (r: Rig, path: string, target: ReturnType<typeof make>) =>
		(await r.drive(nav(path), target)).text();
	// a data route is read by a page's script, not a navigation
	const read = async (r: Rig, path: string, target: ReturnType<typeof make>) =>
		(await r.drive(sub(path), target)).text();

	/** a device holding pack 1; the server holds packs 1 and 2 once `publish` has run */
	async function device() {
		server.courses = ROWS;
		server.items = ITEMS;
		const bundles = memoryBundleStore();
		const datasets = [await dataset('courses', ROWS), await dataset('rows', ITEMS)];
		const r = familyRig({ routes, app, spool: { bundles, datasets } });
		const version = await r.spool.invalidate(['courses', 'rows']);
		await packAt(bundles, version);
		const pack = createPackStore(freshIndexedDB());
		await pack.installPack(once((await bundles.get(version)) as Uint8Array<ArrayBuffer>));
		const runtime = make(r, { pack });
		// a network page sets the site policy, which a local page needs
		await visit(r, '/tpl/c2', runtime);
		r.reset();
		return { r, bundles, pack, runtime };
	}

	/** the server's rows change: the courses and rows tags move and pack 2 is built */
	async function publish(r: ReturnType<typeof familyRig>, bundles: Bundles) {
		server.courses = [
			{ id: 'c1', title: 'Algebra II' },
			{ id: 'c2', title: 'Biology' }
		];
		server.items = [{ id: 'r1', title: 'One II' }];
		const version = await r.spool.invalidate(['courses', 'rows']);
		await packAt(bundles, version);
		return version;
	}

	it('a family route shows a row an inline delta moved, with 0 requests', async () => {
		const { r, bundles, runtime } = await device();
		const version = await publish(r, bundles);
		expect(version).toBe(2);
		await visit(r, '/courses/c9', runtime);
		r.reset();
		expect(await visit(r, '/courses/c1', runtime)).toContain('<h1>Algebra II</h1>');
		expect(r.urls).toEqual([]);
	});

	it('a family route shows a row a fresh install of the stub holds, with 0 requests', async () => {
		const { r, bundles, pack } = await device();
		const version = await publish(r, bundles);
		const stub = (await packReader(bundles).stub(version))!;
		const fresh = make(r, { config: { ...r.spool.config, pack: stub }, pack });
		await fresh.install({} as never);
		r.reset();
		expect(await visit(r, '/courses/c1', fresh)).toContain('<h1>Algebra II</h1>');
		expect(r.urls).toEqual([]);
	});

	it('a template route with tags drops its stored page when an inline delta moves its tag', async () => {
		const { r, bundles, runtime } = await device();
		await visit(r, '/tpl/c1', runtime);
		r.reset();
		expect(await visit(r, '/tpl/c1', runtime)).toContain('<h1>Algebra</h1>');
		expect(r.urls).toEqual([]);
		await publish(r, bundles);
		await visit(r, '/courses/c9', runtime);
		r.reset();
		expect(await visit(r, '/tpl/c1', runtime)).toContain('<h1>Algebra II</h1>');
		expect(r.urls).toEqual(['GET /tpl/c1', artifactOf('/tpl/c1')]);
	});

	it('a template route with tags shows the new row after a fresh install of the stub moves its tag', async () => {
		const { r, bundles, pack, runtime } = await device();
		await visit(r, '/tpl/c1', runtime);
		r.reset();
		const version = await publish(r, bundles);
		const stub = (await packReader(bundles).stub(version))!;
		const fresh = make(r, { config: { ...r.spool.config, pack: stub }, pack });
		await fresh.install({} as never);
		r.reset();
		const text = await visit(r, '/tpl/c1', fresh);
		expect(r.urls).toEqual(['GET /tpl/c1', artifactOf('/tpl/c1')]);
		expect(text).toContain('<h1>Algebra II</h1>');
	});

	it('a family page has no age: a day after an edit with no pack built it shows the held row, reports fresh and syncs nothing', async () => {
		const { r, bundles, pack } = await device();
		server.courses = [
			{ id: 'c1', title: 'Algebra II' },
			{ id: 'c2', title: 'Biology' }
		];
		await r.spool.invalidate(['courses']);
		expect(await packReader(bundles).stub(2)).toBeUndefined();
		r.advance(25 * 3600);
		const fresh = make(r, { config: { ...r.spool.config, stamp: 2 }, pack });
		await fresh.install({} as never);
		r.reset();
		expect(await visit(r, '/courses/c1', fresh)).toContain('<h1>Algebra</h1>');
		r.advance(25 * 3600);
		expect(await visit(r, '/courses/c1', fresh)).toContain('<h1>Algebra</h1>');
		const views = viewsOf(r.sink.events).filter((v) => v.route === '/courses/:id');
		expect(views.map((v) => [v.reason, v.tier, v.staleSec])).toEqual([['fresh', 'local', 0]]);
		expect(r.urls.filter((u) => !u.endsWith('/.spool/beacon'))).toEqual([]);
	});

	it('a collection read from the pack shows an inline delta with 0 requests', async () => {
		const { r, bundles, runtime } = await device();
		await publish(r, bundles);
		await visit(r, '/courses/c9', runtime);
		r.reset();
		expect(await read(r, '/rows', runtime)).toContain('One II');
		expect(r.urls).toEqual([]);
	});

	it('a collection read from the pack shows a fresh install of the stub with 0 requests', async () => {
		const { r, bundles, pack } = await device();
		const version = await publish(r, bundles);
		const stub = (await packReader(bundles).stub(version))!;
		const fresh = make(r, { config: { ...r.spool.config, pack: stub }, pack });
		await fresh.install({} as never);
		r.reset();
		expect(await read(r, '/rows', fresh)).toContain('One II');
		expect(r.urls).toEqual([]);
	});
});

describe("the held pack on the device's own requests", () => {
	const page = { source: '<html><head></head><body>{{row.title}}</body></html>' };
	const family = { dataset: 'courses', key: 'id' };
	const app = () =>
		new Response('<html><head></head><body>page</body></html>', { headers: HTML });
	const withUrl = (response: Response, url: string) =>
		Object.defineProperty(response, 'url', { value: url });
	async function* once(bytes: Uint8Array<ArrayBuffer>) {
		yield bytes;
	}

	/** a server whose courses are at version 0, then at version 1 with one more row and `extra` long ones */
	async function server(extra = 0) {
		const live: Array<{ id: string; title: string }> = [
			{ id: 'c1', title: 'Algebra' },
			{ id: 'c2', title: 'Biology' }
		];
		const routes = [
			defineRoute('/courses/:id', {
				strategy: 'template',
				template: page,
				family,
				load: (ctx) => live.find((row) => row.id === ctx.params['id'])
			})
		];
		const bundles = memoryBundleStore();
		const proof = await setProof(new Map(live.map((row) => [row.id, row])));
		const courses = defineDataset('courses', {
			scope: 'public',
			schema: 'v1',
			maxRows: 10_000,
			maxBytes: 10_000_000,
			key: (row) => row.id,
			seed: () => live,
			read: (ids) => live.filter((row) => ids.includes(row.id)),
			changes: () => ({ cursor: 0, puts: [], deletes: [], proof }),
			horizon: () => 0,
			head: () => ({ cursor: 0, proof })
		});
		const spool = createSpool({
			routes,
			store: memoryStore(),
			sink: memorySink(),
			datasets: [courses],
			bundles
		});
		await spool.publish(new URL(ORIGIN));
		const held = createPackStore(freshIndexedDB());
		await held.installPack(once((await bundles.get(0)) as Uint8Array<ArrayBuffer>));
		live.push({ id: 'c3', title: 'Chemistry' });
		for (let n = 0; n < extra; n++) live.push({ id: `x${n}`, title: 'x'.repeat(60) });
		await spool.invalidate(['courses']);
		await spool.publish(new URL(ORIGIN));
		return { spool, held, bundles };
	}

	type Server = Awaited<ReturnType<typeof server>>['spool'];
	function device(
		spool: Server,
		pack?: Awaited<ReturnType<typeof server>>['held'],
		sent: Request[] = [],
		over: Partial<Parameters<typeof createRuntime>[0]> = {}
	) {
		return createRuntime({
			config: spool.config,
			storage: memoryStorage(),
			fetch: async (input: Request | string, init?: RequestInit) => {
				const request = new Request(input as string, init);
				sent.push(request);
				return withUrl(await spool.handle(request, app), request.url);
			},
			caches: fakeCaches(),
			origin: ORIGIN,
			pack,
			...over
		});
	}
	async function drive(runtime: ReturnType<typeof device>, request: Request) {
		const waited: Promise<unknown>[] = [];
		const pending = runtime.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('request was ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}
	const missed = (sent: Request[]) =>
		sent.find((request) => new URL(request.url).pathname === '/courses/c3');

	it('sends the held pack version as Spool-Have on a miss, and the answer carries the delta to it', async () => {
		const { spool, held } = await server();
		const sent: Request[] = [];
		const response = await drive(device(spool, held, sent), nav('/courses/c3'));
		expect(missed(sent)?.headers.get('spool-have')).toBe('0');
		const delta = JSON.parse(response.headers.get('spool-delta') ?? 'null') as {
			from: number;
			to: number;
		};
		expect([delta.from, delta.to]).toEqual([0, 1]);
	});

	it('applies that delta, so the row is held after one miss', async () => {
		const { spool, held } = await server();
		await drive(device(spool, held), nav('/courses/c3'));
		expect((await held.head())?.version).toBe(1);
		expect(await held.getRow('courses', 'c3')).toEqual({ id: 'c3', title: 'Chemistry' });
	});

	it('sends no Spool-Have without a held pack', async () => {
		const { spool } = await server();
		const sent: Request[] = [];
		await drive(device(spool, undefined, sent), nav('/courses/c3'));
		expect(missed(sent)?.headers.has('spool-have')).toBe(false);
	});

	it('adds Spool-Delta only for a request that names an older pack', async () => {
		const { spool } = await server();
		const at = (have?: string) =>
			spool.handle(
				nav('/courses/c3', have === undefined ? {} : { headers: { 'spool-have': have } }),
				app
			);
		expect((await at()).headers.get('spool-delta')).toBeNull();
		expect((await at('1')).headers.get('spool-delta')).toBeNull();
		expect((await at('x')).headers.get('spool-delta')).toBeNull();
		const older = await at('0');
		expect(older.headers.get('spool-delta')).not.toBeNull();
		expect(older.headers.get('vary')).toContain('spool-have');
	});

	it('sends no artifact request for a network document of a row the pack holds', async () => {
		const { spool, held } = await server();
		const sent: Request[] = [];
		const runtime = device(spool, held, sent);
		await drive(runtime, nav('/courses/c1'));
		expect(sent.map((request) => new URL(request.url).pathname)).toEqual(['/courses/c1']);
	});

	it('sends no artifact request for a miss, and the row is local on the next view', async () => {
		const { spool, held } = await server();
		const sent: Request[] = [];
		const runtime = device(spool, held, sent);
		const first = await (await drive(runtime, nav('/courses/c3'))).text();
		// the document names the row only through a ring, and a gate page's ring holds no rows
		expect(first).toContain('<html');
		expect(sent.map((request) => new URL(request.url).pathname)).toEqual(['/courses/c3']);
		sent.length = 0;
		const second = await (await drive(runtime, nav('/courses/c3'))).text();
		expect(second).toContain('Chemistry');
		expect(sent).toEqual([]);
	});

	describe('the site policy from a verified pack response', () => {
		const CSP = "default-src 'self'";
		const cspApp = () =>
			new Response('<html><head></head><body>page</body></html>', {
				headers: { ...HTML, 'content-security-policy': CSP }
			});
		const pathsOf = (sent: Request[]) => sent.map((request) => new URL(request.url).pathname);

		/** a device holding pack 0, a server at pack 1, and the stub a device at 1 would get with no inline delta */
		async function behind() {
			const { spool, held, bundles } = await server();
			const stub = (await packReader(bundles).stub(1))!;
			return { spool, held, stub: { ...stub, deltas: [] } };
		}

		it('a page message changes nothing', async () => {
			const { spool, held } = await server();
			const runtime = device(spool, held, []);
			expect(
				await runtime.message({
					type: 'spool:policy',
					policy: [['content-security-policy', "default-src 'none'"]]
				})
			).toBeUndefined();
			expect(runtime.replica.sitePolicy).toBeUndefined();
		});

		it('a pack response without the header leaves the first document on the network', async () => {
			const { spool, held, stub } = await behind();
			const sent: Request[] = [];
			const runtime = device(spool, held, sent, { config: { ...spool.config, pack: stub } });
			await runtime.install({} as never);
			expect((await held.head())?.version).toBe(1);
			sent.length = 0;
			await drive(runtime, nav('/courses/c1'));
			expect(pathsOf(sent)).toEqual(['/courses/c1']);
		});

		it('ignores a policy header on a navigation response', async () => {
			const { spool, held } = await server();
			const runtime = device(spool, held, [], {
				fetch: async () =>
					new Response('<html><head></head><body>page</body></html>', {
						headers: {
							...HTML,
							'spool-policy': JSON.stringify([['x-frame-options', 'DENY']])
						}
					})
			});
			await drive(runtime, nav('/courses/c3'));
			expect(runtime.replica.sitePolicy).toEqual([]);
		});

		it('keeps the adopted policy across a worker restart on the same storage', async () => {
			const { spool, held } = await server();
			const storage = memoryStorage();
			const first = device(spool, held, [], { storage });
			await first.replica.keepPolicy(null, [['content-security-policy', CSP]]);
			const restarted = device(spool, held, [], { storage });
			await restarted.message({ type: 'spool:status' });
			expect(restarted.replica.sitePolicy).toEqual([['content-security-policy', CSP]]);
		});

		it('takes the policy from the option, and refuses a name outside the allow list', () => {
			const base = { routes: [], store: memoryStore(), sink: memorySink() };
			expect(() =>
				createSpool({ ...base, policy: { 'content-security-policy': CSP } })
			).not.toThrow();
			expect(() => createSpool({ ...base, policy: { 'set-cookie': 'sid=1' } })).toThrow(
				ProtocolError
			);
		});

		it('a name outside the allow list is dropped from a policy', () => {
			expect(
				allowedPolicy([
					['x-frame-options', 'DENY'],
					['set-cookie', 'sid=1'],
					['authorization', 'Bearer x']
				])
			).toEqual([['x-frame-options', 'DENY']]);
			expect(allowedPolicy('x')).toBeUndefined();
		});
	});

	describe('the site policy the stub carries', () => {
		const CSP = "default-src 'self'";
		const CSP2 = "default-src 'none'";
		const cspApp = (value: string) => () =>
			new Response('<html><head></head><body>page</body></html>', {
				headers: { ...HTML, 'content-security-policy': value }
			});
		const pathsOf = (sent: Request[]) => sent.map((request) => new URL(request.url).pathname);
		const configOf = async (response: Response) =>
			JSON.parse(/self\.__SPOOL_CONFIG__=(.*?);\n/s.exec(await response.text())![1]!) as {
				policy?: Array<[string, string]>;
			};

		it('the stub names the policy the option gives, and none without one', async () => {
			const base = { routes: [], store: memoryStore(), sink: memorySink() };
			const withOption = createSpool({ ...base, policy: { 'content-security-policy': CSP } });
			expect(
				(
					await configOf(
						await withOption.handle(new Request(`${ORIGIN}/spool-sw.js`), cspApp(CSP))
					)
				).policy
			).toEqual([['content-security-policy', CSP]]);
			const plain = createSpool({ ...base });
			expect(
				(
					await configOf(
						await plain.handle(new Request(`${ORIGIN}/spool-sw.js`), cspApp(CSP))
					)
				).policy
			).toBeUndefined();
		});

		it('the stub names the last HTML page policy when the option is absent', async () => {
			const { spool } = await server();
			await spool.handle(nav('/courses/c1'), cspApp(CSP));
			const config = await configOf(
				await spool.handle(new Request(`${ORIGIN}/spool-sw.js`), cspApp(CSP))
			);
			expect(config.policy).toEqual([['content-security-policy', CSP]]);
		});

		it('the stub carries a known-empty policy, from an empty option or a page with no security header', async () => {
			const base = { routes: [], store: memoryStore(), sink: memorySink() };
			const empty = createSpool({ ...base, policy: {} });
			expect(
				(
					await configOf(
						await empty.handle(new Request(`${ORIGIN}/spool-sw.js`), cspApp(CSP))
					)
				).policy
			).toEqual([]);
			const bare = createSpool({ ...base });
			await bare.handle(nav('/page'), () => new Response('<html></html>', { headers: HTML }));
			expect(
				(
					await configOf(
						await bare.handle(new Request(`${ORIGIN}/spool-sw.js`), cspApp(CSP))
					)
				).policy
			).toEqual([]);
		});

		it('a worker that holds a known-empty policy answers the first document with 0 requests', async () => {
			const { spool, held } = await server();
			const sent: Request[] = [];
			const runtime = device(spool, held, sent, { config: { ...spool.config, policy: [] } });
			await runtime.activate();
			expect(runtime.replica.sitePolicy).toEqual([]);
			sent.length = 0;
			await drive(runtime, nav('/courses/c1'));
			expect(pathsOf(sent)).toEqual([]);
		});

		it('a later network navigation replaces a known-empty policy', async () => {
			const { spool, held } = await server();
			const runtime = device(spool, held, [], {
				config: { ...spool.config, policy: [] },
				fetch: async () => cspApp(CSP2)()
			});
			await runtime.activate();
			await drive(runtime, nav('/courses/c3'));
			expect(runtime.replica.sitePolicy).toEqual([['content-security-policy', CSP2]]);
		});

		it('a worker that holds a configured policy answers the first document with 0 requests', async () => {
			const { spool, held } = await server();
			const sent: Request[] = [];
			const runtime = device(spool, held, sent, {
				config: { ...spool.config, policy: [['content-security-policy', CSP]] }
			});
			await runtime.activate();
			expect(runtime.replica.sitePolicy).toEqual([['content-security-policy', CSP]]);
			sent.length = 0;
			await drive(runtime, nav('/courses/c1'));
			expect(pathsOf(sent)).toEqual([]);
		});

		it('without a configured policy the first document goes to the network', async () => {
			const { spool, held } = await server();
			const sent: Request[] = [];
			const runtime = device(spool, held, sent);
			await runtime.activate();
			sent.length = 0;
			await drive(runtime, nav('/courses/c1'));
			expect(pathsOf(sent)).toEqual(['/courses/c1']);
		});

		it('a later network navigation replaces the configured policy', async () => {
			const { spool, held } = await server();
			const runtime = device(spool, held, [], {
				config: { ...spool.config, policy: [['content-security-policy', CSP]] },
				fetch: async () => cspApp(CSP2)()
			});
			await runtime.activate();
			await drive(runtime, nav('/courses/c3'));
			expect(runtime.replica.sitePolicy).toEqual([['content-security-policy', CSP2]]);
		});

		it('a page message cannot change the configured policy', async () => {
			const { spool, held } = await server();
			const runtime = device(spool, held, [], {
				config: { ...spool.config, policy: [['content-security-policy', CSP]] }
			});
			await runtime.activate();
			expect(
				await runtime.message({
					type: 'spool:policy',
					policy: [['content-security-policy', "default-src 'none'"]]
				})
			).toBeUndefined();
			expect(runtime.replica.sitePolicy).toEqual([['content-security-policy', CSP]]);
		});

		it('a restarted worker keeps the configured policy', async () => {
			const { spool, held } = await server();
			const storage = memoryStorage();
			await device(spool, held, [], {
				storage,
				config: { ...spool.config, policy: [['content-security-policy', CSP]] }
			}).activate();
			const restarted = device(spool, held, [], { storage });
			await restarted.message({ type: 'spool:status' });
			expect(restarted.replica.sitePolicy).toEqual([['content-security-policy', CSP]]);
		});
	});

	it('leaves Spool-Delta out when the delta is over 16,384 bytes', async () => {
		const { spool } = await server(600);
		const response = await spool.handle(
			nav('/courses/c3', { headers: { 'spool-have': '0' } }),
			app
		);
		expect(response.headers.get('spool-delta')).toBeNull();
	});

	it('reports a contact for each answer from the server, and none for a local view', async () => {
		const { spool, held } = await server();
		const messages: unknown[] = [];
		const runtime = device(spool, held, [], { broadcast: (m) => messages.push(m) });
		await drive(runtime, nav('/courses/c3'));
		const after = messages.length;
		expect(after).toBeGreaterThan(0);
		expect(messages[0]).toEqual({ type: 'spool:contact', at: expect.any(Number) });
		await drive(runtime, nav('/courses/c3'));
		expect(messages).toHaveLength(after);
	});

	it('answers the handshake with the lease, and the script carries it', async () => {
		const { spool, held } = await server();
		const runtime = device(spool, held, [], { config: { ...spool.config, lease: 600 } });
		expect(await runtime.message({ type: 'spool:hello', protocol: 1 })).toMatchObject({
			lease: 600
		});
		const script = await (await spool.stub()).text();
		expect(script).toContain('"lease":86400');
	});

	it('answers the handshake with the time of the last contact, for a page that loads after it', async () => {
		const { spool, held } = await server();
		const messages: Array<{ type: string; at?: number }> = [];
		const runtime = device(spool, held, [], {
			config: { ...spool.config, lease: 600 },
			broadcast: (m) => messages.push(m as { type: string; at?: number })
		});
		expect(await runtime.message({ type: 'spool:hello', protocol: 1 })).not.toHaveProperty(
			'contact'
		);
		await drive(runtime, nav('/courses/c3'));
		const contact = messages.filter((m) => m.type === 'spool:contact').at(-1)?.at;
		expect(contact).toEqual(expect.any(Number));
		expect(await runtime.message({ type: 'spool:hello', protocol: 1 })).toMatchObject({
			contact
		});
	});

	it('records a contact when a stamped stub installs with nothing to apply', async () => {
		const { spool, held } = await server();
		const messages: Array<{ type: string }> = [];
		const runtime = device(spool, held, [], {
			config: { ...spool.config, stamp: 1 },
			broadcast: (m) => messages.push(m as { type: string })
		});
		await runtime.install({} as never);
		expect(messages).toEqual([{ type: 'spool:contact', at: expect.any(Number) }]);
		expect(await runtime.message({ type: 'spool:hello', protocol: 1 })).toMatchObject({
			contact: expect.any(Number)
		});
	});

	it('records a contact when an install applies the pack delta', async () => {
		const { spool, held, bundles } = await server();
		const stub = (await packReader(bundles).stub(1))!;
		const messages: Array<{ type: string }> = [];
		const runtime = device(spool, held, [], {
			config: { ...spool.config, pack: stub },
			broadcast: (m) => messages.push(m as { type: string })
		});
		await runtime.install({} as never);
		expect((await held.head())?.version).toBe(1);
		expect(messages).toEqual([{ type: 'spool:contact', at: expect.any(Number) }]);
	});

	it('records no contact for an install whose stub has neither a stamp nor a pack', async () => {
		const { spool, held } = await server();
		const messages: unknown[] = [];
		const runtime = device(spool, held, [], { broadcast: (m) => messages.push(m) });
		await runtime.install({} as never);
		expect(messages).toEqual([]);
	});
});

describe('renderLocal', () => {
	const config = rig().spool.config;
	const route = (pattern: string) => config.routes.find((x) => x.pattern === pattern)!;
	const tagged = (html: string) => injectClientTag(html, config.clientTag);

	it('renders a template artifact and tags it', async () => {
		const result = await renderLocal(
			config,
			route('/soft/:id'),
			artifact({ body: { data: { id: 'z' } } })
		);
		expect(result).toEqual({ ok: true, html: tagged(body('z')) });
	});

	it('renders an assembly artifact', async () => {
		const result = await renderLocal(
			config,
			route('/page/:slug'),
			artifact({
				strategy: 'assembly',
				body: { shell: `<body>${placeholder('a')}</body>`, fragments: { a: 'A' } }
			})
		);
		expect(result).toEqual({ ok: true, html: tagged('<body>A</body>') });
	});

	it('refuses an unfilled assembly, a strategy mismatch and a missing template', async () => {
		const unfilled = await renderLocal(
			config,
			route('/page/:slug'),
			artifact({ strategy: 'assembly', body: { shell: placeholder('a') } })
		);
		expect(unfilled.ok).toBe(false);
		const mismatch = await renderLocal(config, route('/page/:slug'), artifact());
		expect(mismatch).toEqual({ ok: false, reason: 'artifact is template, route is assembly' });
		const noTemplate = await renderLocal(
			{ ...config, templates: {} },
			route('/soft/:id'),
			artifact()
		);
		expect(noTemplate).toEqual({ ok: false, reason: 'no template for /soft/:id' });
	});

	it('refuses when a custom renderer throws, with its message or a default', async () => {
		const thrown = await renderLocal(config, route('/soft/:id'), artifact(), {
			'/soft/:id': () => {
				throw new Error('nope');
			}
		});
		expect(thrown).toEqual({ ok: false, reason: 'nope' });
		const odd = await renderLocal(config, route('/soft/:id'), artifact(), {
			'/soft/:id': () => {
				throw 'text';
			}
		});
		expect(odd).toEqual({ ok: false, reason: 'render failed' });
	});

	it('prefers a custom renderer, even for an artifact of another strategy', async () => {
		const result = await renderLocal(config, route('/page/:slug'), artifact(), {
			'/page/:slug': () => '<p>mine</p>'
		});
		expect(result).toEqual({ ok: true, html: tagged('<p>mine</p>') });
	});

	describe('with a query string', () => {
		const people = defineRoute('/people', {
			strategy: 'template',
			template: {
				source: '<html><head></head><body>{{query.total}}:{{#each rows}}{{n}}{{/each}}</body></html>'
			},
			load: () => ({}),
			query: { list: 'rows', pageSize: 2 }
		});
		const queried = createSpool({ routes: [people], store: memoryStore() }).config;
		const rows = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
		const stored = async (over: object = {}) =>
			artifact({
				id: '/people',
				body: { data: { rows, proof: await datasetProof(rows), ...over } }
			});
		const render = async (search: string | undefined, source = stored()) =>
			renderLocal(queried, queried.routes[0]!, await source, {}, search);

		it('renders the page of items and the page numbers the query selects', async () => {
			expect(await render('?page=2')).toEqual({
				ok: true,
				html: injectClientTag(
					'<html><head></head><body>3:c</body></html>',
					queried.clientTag
				)
			});
			expect(await render('?page=1')).toMatchObject({
				html: expect.stringContaining('3:ab')
			});
		});

		it('renders the stored data as it is with no query string or an empty one', async () => {
			for (const search of [undefined, '']) {
				expect(await render(search)).toMatchObject({
					html: expect.stringContaining('<body>:abc</body>')
				});
			}
		});

		it('ignores a query string for a route that declares no schema', async () => {
			const plain = await renderLocal(config, route('/soft/:id'), artifact(), {}, '?page=2');
			expect(plain).toEqual({ ok: true, html: tagged(body('1')) });
		});

		it('refuses with the proof reason when the proof does not match, whatever the query says', async () => {
			const proof = await datasetProof(rows);
			for (const bad of [
				{ proof: { ...proof, count: 2 } },
				{ proof: { ...proof, digest: 'x' } }
			]) {
				expect(await render('?page=2', stored(bad))).toEqual({
					ok: false,
					reason: PROOF_MISMATCH
				});
				expect(await render('?colour=red', stored(bad))).toEqual({
					ok: false,
					reason: PROOF_MISMATCH
				});
			}
		});

		it('refuses a query the schema does not declare, and an artifact that is not data', async () => {
			expect(await render('?colour=red')).toEqual({
				ok: false,
				reason: 'query is not one the route declares'
			});
			expect(await render('?page=3')).toMatchObject({ ok: false });
			const assembly = artifact({ strategy: 'assembly', body: { shell: 's' } });
			expect(await render('?page=2', Promise.resolve(assembly))).toEqual({
				ok: false,
				reason: 'assembly artifact cannot answer a query'
			});
		});
	});
});

describe('a signed-in page held a day', () => {
	type Member = { id: string; name: string };
	const secure = { ...HTML, 'content-security-policy': "default-src 'self'" };

	async function world(
		maxStaleMs: number,
		tracked = true,
		views = 3,
		retention: 'persistent' | 'session' = 'persistent',
		failSeed = false
	) {
		const rows: Member[] = [{ id: 'ada', name: 'Ada' }];
		const feed: string[] = [];
		const members = defineDataset<Member>(
			'members',
			{
				scope: 'principal',
				maxStaleMs,
				schema: 'v1',
				maxRows: 10,
				maxBytes: 10_000,
				key: (row) => row.id,
				seed: () => rows,
				read: (ids) => rows.filter((row) => ids.includes(row.id)),
				changes: (since) => ({
					cursor: feed.length,
					puts: [...new Set(feed.slice(since))],
					deletes: []
				}),
				horizon: () => 0,
				head: () => ({ cursor: feed.length })
			},
			{ principalDatasets: true }
		);
		const me = defineRoute('/me', {
			strategy: 'template',
			auth: 'principal',
			family: { dataset: 'members', key: 'viewer.id' },
			retention,
			...(tracked ? { depends: () => ['members'] } : {}),
			template: { source: '<html><head></head><body>{{row.name}}</body></html>' }
		} as never);
		const app = (request: Request) =>
			new URL(request.url).pathname === '/me'
				? new Response(`<html><head></head><body>${rows[0]?.name}</body></html>`, {
						headers: secure
					})
				: new Response('missing', { status: 404, headers: HTML });
		const session = { live: true };
		const flaky = { fail: failSeed };
		const r = familyRig({
			routes: [me],
			app,
			spool: {
				datasets: [members],
				principalDatasets: true,
				identity: {
					secret: 's',
					resolve: () => (session.live ? { principal: 'ada' } : null)
				}
			}
		});
		const factory = freshIndexedDB();
		const open = () =>
			r.make({
				partitions: idbPartitions(factory, idbVault(factory)),
				broadcast: () => undefined,
				fetch: async (input, init) => {
					const request = new Request(input as string, init);
					const url = new URL(request.url);
					r.urls.push(`${request.method} ${url.pathname}${url.search}`);
					if (flaky.fail && url.pathname === '/.spool/dataset')
						throw new TypeError('offline');
					return r.spool.handle(request, app);
				}
			});
		let runtime = open();
		const visit = async () => (await r.drive(nav('/me'), runtime)).text();
		// a restart keeps the stores and the persistent key and drops the worker's memory
		const restart = () => void (runtime = open());
		for (let i = 0; i < views; i++) await visit();
		const dayZero = [...r.urls];
		r.reset();
		if (views > 1) {
			await visit();
			expect(r.urls).toEqual([]);
		}
		const sent = () => r.urls.filter((u) => !u.endsWith('/.spool/beacon'));
		const edit = async (name: string) => {
			(rows[0] as Member).name = name;
			feed.push('ada');
			await r.spool.invalidate(['members']);
		};
		return { r, visit, sent, edit, restart, dayZero, session, flaky };
	}

	const need = expect.stringContaining('GET /.spool/sync?need=');
	const dataset = expect.stringContaining('GET /.spool/dataset?');

	it('refreshes before it shows when the dataset is past maxStaleMs: a sync and a dataset request, no document, then local', async () => {
		const w = await world(600_000);
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada');
		expect(w.sent()).toEqual([need, dataset]);
		w.r.reset();
		await w.visit();
		expect(w.r.urls).toEqual([]);
	});

	it('shows the refreshed row when the dataset moved and the page does not depend on its tag', async () => {
		const w = await world(600_000, false);
		await w.edit('Ada II');
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada</body>');
		expect(w.sent()).toEqual([need, dataset]);
	});

	it('goes to the network when the refresh finds the page stale, after the sync and the dataset request', async () => {
		const w = await world(600_000);
		await w.edit('Ada II');
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada II');
		expect(w.sent()).toEqual([
			need,
			dataset,
			'GET /me',
			expect.stringContaining('/.spool/artifact')
		]);
	});

	it('shows nothing held and goes to the network when the session ended, with no dataset request', async () => {
		const w = await world(600_000);
		w.session.live = false;
		w.r.advance(25 * 3600);
		await w.visit();
		expect(w.sent()).toEqual([need, 'GET /me']);
		w.r.reset();
		await w.visit();
		expect(w.sent()).toEqual(['GET /me']);
	});

	it('goes to the network when the dataset request fails during the refresh', async () => {
		const w = await world(600_000);
		w.flaky.fail = true;
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada');
		expect(w.sent()).toEqual([need, dataset, 'GET /me']);
	});

	it('asks for no dataset a second view the same day when the first view applied it seconds ago', async () => {
		const w = await world(2 * 86_400_000, true, 1, 'persistent', true);
		w.flaky.fail = false;
		w.restart();
		w.r.advance(25 * 3600);
		await w.visit();
		expect(w.sent()).toEqual([seed, 'GET /me']);
		w.r.reset();
		await w.visit();
		expect(w.sent()).toEqual([need]);
		w.r.reset();
		await w.visit();
		expect(w.r.urls).toEqual([]);
	});

	it('syncs first and shows the held page with no document request when maxStaleMs covers the gap', async () => {
		const w = await world(2 * 86_400_000);
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada');
		expect(w.sent()).toEqual([need, dataset]);
		w.r.reset();
		await w.visit();
		expect(w.r.urls).toEqual([]);
	});

	it('drops the held page when that sync finds its tag moved, and the view goes to the network', async () => {
		const w = await world(2 * 86_400_000);
		await w.edit('Ada II');
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada II');
		expect(w.sent()).toEqual([
			need,
			dataset,
			'GET /me',
			expect.stringContaining('/.spool/artifact')
		]);
	});

	const seed = expect.stringMatching(/^GET \/\.spool\/dataset\?name=members(?!.*since)/);

	it('seeds a persistent principal dataset when it stores the page, so the first return after a restart syncs and makes no document request', async () => {
		const w = await world(2 * 86_400_000, true, 1);
		expect(w.dayZero.filter((u) => u.includes('/.spool/dataset'))).toEqual([seed]);
		w.restart();
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada');
		expect(w.sent()).toEqual([need, dataset]);
		w.r.reset();
		await w.visit();
		expect(w.r.urls).toEqual([]);
	});

	it('stores the page when the seed request fails', async () => {
		const w = await world(2 * 86_400_000, true, 1, 'persistent', true);
		expect(w.dayZero.filter((u) => u.includes('/.spool/dataset'))).toEqual([seed]);
		expect(w.dayZero.filter((u) => u.includes('/.spool/artifact'))).toHaveLength(1);
		w.restart();
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada');
		expect(w.sent().filter((u) => u.includes('/.spool/artifact'))).toEqual([]);
	});

	it('seeds the dataset once across the first three views, not again at the next view', async () => {
		const w = await world(2 * 86_400_000, true, 3);
		expect(w.dayZero.filter((u) => u.includes('/.spool/dataset'))).toEqual([seed]);
	});

	it('makes no seed request when the page is stored again over a held dataset', async () => {
		const w = await world(2 * 86_400_000, true, 3);
		await w.edit('Ada II');
		w.r.advance(25 * 3600);
		await w.visit();
		expect(w.sent().filter((u) => u.includes('/.spool/dataset'))).toEqual([dataset]);
	});

	it('leaves a session-retention principal dataset to the first view that finds the page stored', async () => {
		const w = await world(2 * 86_400_000, true, 1, 'session');
		expect(w.dayZero.filter((u) => u.includes('/.spool/dataset'))).toEqual([]);
		w.restart();
		w.r.advance(25 * 3600);
		await w.visit();
		expect(w.sent()).toEqual([seed, 'GET /me', expect.stringContaining('/.spool/artifact')]);
	});

	it('shows the row the page was built with when the route does not depend on the dataset tag', async () => {
		const w = await world(2 * 86_400_000, false);
		await w.edit('Ada II');
		w.r.advance(25 * 3600);
		expect(await w.visit()).toContain('Ada</body>');
		expect(w.sent()).toEqual([need, dataset]);
	});
});
