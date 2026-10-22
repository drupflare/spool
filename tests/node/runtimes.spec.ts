import { createApp, createRouter, toWebHandler } from 'h3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdnClientUrl } from '../../src/cdn/location';
import { toNodeListener } from '../../src/node/listener';
import { decodeEnvelope, interpretTemplate, parseManifest } from '../../src/protocol/index';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';
import { closeServers, exercise, listen, overFetch, overHttp } from './exercise';
import { spool as analytics } from './readme/analytics';
import { about } from './readme/assembly';
import bunApp from './readme/bun';
import { spool as catalogue, course as catalogueCourse, home } from './readme/catalogue';
import { spool as cdn } from './readme/cdn';
import denoApp from './readme/deno';
import { proxy as dictionaryProxy } from './readme/dictionary';
import { app as express } from './readme/express';
import { notice, stock } from './readme/freshness';
import { course } from './readme/graph';
import hono from './readme/hono';
import { mediaProxy } from './readme/media';
import { proxy as nextProxy } from './readme/next-proxy';
import { GET as nextRoute } from './readme/next-route';
import { server as nodeHttp } from './readme/node-http';
import nuxtMiddleware from './readme/nuxt-middleware';
import nuxtRoute from './readme/nuxt-route';
import { rewriteProxy } from './readme/rewrites';
import { canary, shadowed } from './readme/shadow';
import { about as staticAbout } from './readme/static';
import { news } from './readme/template';
import { manifest as trimManifest, proxy as trimProxy } from './readme/trim';
import vercel from './readme/vercel';

const root = join(import.meta.dirname, '../..');
afterEach(closeServers);

describe('the README examples run', () => {
	it('node:http', async () => {
		await exercise(overHttp(await listen(nodeHttp)));
	});

	it('Express', async () => {
		await exercise(overHttp(await listen(createServer(express))));
	});

	it('Hono, through app.fetch and through a node server', async () => {
		await exercise(overFetch((request) => hono.fetch(request)));
		await exercise(
			overHttp(await listen(createServer(toNodeListener((request) => hono.fetch(request)))))
		);
	});

	it('Vercel Functions, Bun and Deno export a fetch handler', async () => {
		for (const handler of [vercel, bunApp, denoApp]) {
			await exercise(overFetch((request) => handler.fetch(request)));
		}
		expect(bunApp.port).toBe(3000);
	});

	it('Next.js: the proxy answers spool paths and passes the rest on, the route handler decorates', async () => {
		const request = (path: string) => new Request(`https://site.test${path}`);
		expect(await nextProxy(request('/node/1'))).toBeUndefined();
		const route = (path: string) => nextRoute(request(path));
		await exercise(async (path) => (await nextProxy(request(path))) ?? route(path));
	});

	it('Nuxt and Nitro through h3', async () => {
		const app = createApp();
		app.use(nuxtMiddleware);
		const router = createRouter();
		router.get('/node/:id', nuxtRoute);
		app.use(router);
		const handle = toWebHandler(app);
		await exercise((path) => handle(new Request(`https://site.test${path}`)));
	});

	it('the proxy fixture forwards to its origin, tags the page and takes a purge', async () => {
		const asked: string[] = [];
		const originUrl = await listen(
			createServer((req, res) => {
				asked.push(req.url ?? '');
				res.writeHead(200, { 'content-type': 'text/html', 'cache-tag': 'node:1,menu' });
				res.end('<!doctype html><html><head></head><body><h1>Node 1</h1></body></html>');
			})
		);
		process.env['ORIGIN'] = originUrl;
		process.env['PURGE_SECRET'] = 'readme-secret';
		const { server } = await import('./readme/proxy-node');
		const front = await listen(server);

		const page = await fetch(`${front}/node/1`);
		expect(await page.text()).toContain('data-spool-client');
		const artifact = decodeEnvelope(page.headers).artifact;
		expect(artifact?.deps).toEqual(['node:1', 'menu']);
		expect((await fetch(`${front}/spool-sw.js`)).status).toBe(200);
		expect(asked).toEqual(['/node/1']);

		const purge = (secret: string) =>
			fetch(`${front}/.spool/purge`, {
				method: 'POST',
				headers: { authorization: `Bearer ${secret}` },
				body: JSON.stringify({ tags: ['node:1'] })
			});
		expect((await purge('wrong')).status).toBe(401);
		expect((await purge('readme-secret')).status).toBe(200);
		delete process.env['ORIGIN'];
		delete process.env['PURGE_SECRET'];
	});

	it('Bun serves the export default object', async () => {
		const harness = `
			const mod = (await import(process.env.FIXTURE)).default;
			const server = Bun.serve({ ...mod, port: 0 });
			const base = 'http://127.0.0.1:' + server.port;
			const page = await fetch(base + '/node/4');
			const sw = await fetch(base + '/spool-sw.js');
			console.log(JSON.stringify({
				status: page.status,
				artifact: page.headers.get('spool-artifact'),
				body: await page.text(),
				sw: sw.status
			}));
			server.stop(true);
		`;
		const out = execFileSync('bun', ['-e', harness], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, FIXTURE: join(root, 'tests/node/readme/bun.ts') }
		});
		const read = JSON.parse(out) as {
			status: number;
			artifact: string;
			body: string;
			sw: number;
		};
		expect(read.status).toBe(200);
		expect(read.body).toContain('<h1>Node 4</h1>');
		expect(read.body).toContain('data-spool-client');
		expect(decodeURIComponent(read.artifact)).toContain('id=/node/4');
		expect(read.sw).toBe(200);
	});
});

describe('the README strategy and configuration examples run', () => {
	const artifactOf = async (
		route: Parameters<typeof createSpool>[0]['routes'][number],
		path: string
	) => {
		const spool = createSpool({ routes: [route], store: memoryStore() });
		const response = await spool.respond(
			new Request(`https://site.test/.spool/artifact?path=${path}`)
		);
		return (await response?.json()) as Record<string, any>;
	};

	it('assembly: a shell with a hole, its fragment and its slot', async () => {
		const artifact = await artifactOf(about, '/about');
		expect(artifact['strategy']).toBe('assembly');
		expect(artifact['body'].shell).toContain('data-spool-placeholder="menu"');
		expect(artifact['body'].fragments.menu).toContain('<nav>');
		expect(artifact['deps']).toEqual(['menu']);
	});

	it('records and projections: shared records stored once, the menu projection over them', async () => {
		const artifact = await artifactOf(course, '/courses/101');
		expect(artifact['records'].map((r: { id: string }) => r.id).sort()).toEqual([
			'course:101',
			'course:102'
		]);
		expect(artifact['projections'].map((p: { id: string }) => p.id)).toEqual(['menu']);
		expect(artifact['deps'].sort()).toEqual(['course:101', 'course:102']);
	});

	it('templates: each, if with else, @index and a trusted field', () => {
		const html = interpretTemplate(news.template!, {
			title: 'Hello',
			byline: null,
			body: '<p>Trusted markup</p>',
			tags: ['a', 'b']
		});
		expect(html).toContain('<h1>Hello</h1>');
		expect(html).toContain('<p>Staff</p>');
		expect(html).toContain('<div><p>Trusted markup</p></div>');
		expect(html).toContain('<li>0 a</li><li>1 b</li>');
	});

	it('freshness: the declared bounds replace the defaults', () => {
		expect(stock.freshness).toEqual({ maxStale: 60, mode: 'hard' });
		expect(stock.offline).toBe('refuse');
		expect(notice.freshness).toEqual({ maxStale: 3600, mode: 'soft' });
		expect(notice.sync).toBe('deferred');
	});

	it('catalogue: the home route suggests two courses and the server sends both', async () => {
		expect(home.catalogue).toBeTypeOf('function');
		expect(catalogueCourse.documentBytes).toBe(17_000);
		expect(catalogue.config.routes.find((r) => r.pattern === '/')?.catalogue).toBe(true);
		const response = await catalogue.respond(
			new Request('https://site.test/.spool/beacon', {
				method: 'POST',
				body: JSON.stringify({ protocol: 1, events: [], catalogue: { path: '/' } })
			})
		);
		const ids = response?.status === 200 ? await response.json() : { catalogue: [] };
		expect((ids as { catalogue: Array<{ id: string }> }).catalogue.map((a) => a.id)).toEqual([
			'/courses/101',
			'/courses/102'
		]);
	});

	it('analytics: a flushed beacon reaches the JSON lines sink', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const event = {
			path: '/cdn-cgi/rum',
			body: '{"a":1}',
			contentType: 'application/json',
			at: 5
		};
		const response = await analytics.respond(
			new Request('https://site.test/.spool/beacon', {
				method: 'POST',
				body: JSON.stringify({ protocol: 1, events: [event] })
			})
		);
		expect(response?.status).toBe(204);
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
			path: '/cdn-cgi/rum'
		});
		log.mockRestore();
		expect(analytics.config.beacons).toEqual(['/cdn-cgi/rum']);
	});

	it('shadow: the mode and the canary share reach the worker config', () => {
		expect(shadowed.config.mode).toBe('shadow');
		expect(canary.config.shadowSample).toBe(0.05);
		expect(canary.config.mode).toBe('serve');
	});

	it('trim: the manifest drops the one rule no page or script can match, and the proxy serves it', async () => {
		const full = '.hero{a:b}.button{c:d}.open{e:f}.print-only{g:h}';
		expect(trimManifest.styles['/css/site.css']).toMatchObject({
			css: '.hero{a:b}.button{c:d}.open{e:f}',
			missing: ['print-only'],
			scripts: ['/js/site.js']
		});
		vi.stubGlobal(
			'fetch',
			async () => new Response(full, { headers: { 'content-type': 'text/css' } })
		);
		try {
			const response = await trimProxy(new Request('https://site.test/css/site.css'));
			expect(await response.text()).toBe('.hero{a:b}.button{c:d}.open{e:f}');
			expect({ ...trimProxy.trim }).toEqual({ served: 1, mismatched: 0, guarded: 0 });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('media: the proxy converts an image with the encoder it is given and defers video for a slow visitor', async () => {
		const jpeg = new Uint8Array(10_000).fill(7);
		jpeg.set([0xff, 0xd8, 0xff]);
		const page = '<html><body><video autoplay src="a.mp4"></video></body></html>';
		const encoder = vi.fn(async (input: Uint8Array) => ({
			bytes: new Uint8Array(input.length / 4)
		}));
		vi.stubGlobal('fetch', async (request: Request) =>
			new URL(request.url).pathname === '/hero.jpg'
				? new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
				: new Response(page, { headers: { 'content-type': 'text/html' } })
		);
		try {
			const proxy = mediaProxy(encoder);
			const image = await proxy(
				new Request('https://site.test/hero.jpg', { headers: { accept: 'image/webp' } })
			);
			expect(image.headers.get('x-spool-image')).toBe('10000->2500; q=80; w=1600');
			expect(encoder).toHaveBeenCalledWith(expect.any(Uint8Array), {
				format: 'webp',
				quality: 80,
				width: 1600,
				budgetMs: 10_000
			});
			const slow = await proxy(new Request('https://site.test/', { headers: { ect: '3g' } }));
			expect(await slow.text()).toContain(
				'<video data-spool-autoplay src="a.mp4" controls preload="none">'
			);
			const fast = await proxy(new Request('https://site.test/'));
			expect(await fast.text()).toContain('<video autoplay src="a.mp4">');
			expect({ ...proxy.video }).toEqual({ pages: 1, rewritten: 1 });
			expect(proxy.images.converted).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('rewrites: the proxy rewrites a page, answers a listed width and encodes a PNG both ways', async () => {
		const png = new Uint8Array(10_000).fill(7);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const imgs = [1, 2, 3, 4].map((n) => `<img src="/p${n}.png">`).join('');
		const page = `<html><head></head><body>${imgs}<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Tour"></iframe></body></html>`;
		const encoder = vi.fn(async (input: Uint8Array, options: { lossless?: boolean }) => ({
			bytes: new Uint8Array(input.length / (options.lossless ? 8 : 4))
		}));
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (request: Request) => {
			seen.push(request.url);
			return new URL(request.url).pathname.endsWith('.png')
				? new Response(png, { headers: { 'content-type': 'image/png' } })
				: new Response(page, { headers: { 'content-type': 'text/html' } });
		});
		try {
			const proxy = rewriteProxy(encoder);
			const html = await (await proxy(new Request('https://site.test/'))).text();
			expect(html).toContain(
				'<img src="/p1.png" srcset="/p1.png?spool-w=480 480w, /p1.png?spool-w=960 960w, /p1.png?spool-w=1440 1440w" sizes="(min-width: 60em) 50vw, 100vw">'
			);
			expect(html.match(/loading="lazy"/g)).toHaveLength(1);
			expect(html).toContain('<iframe title="Tour" srcdoc="');
			expect(html).not.toContain('ytimg');
			const image = await proxy(
				new Request('https://site.test/p1.png?spool-w=960', {
					headers: { accept: 'image/webp', 'sec-ch-width': '2000' }
				})
			);
			expect(seen.at(-1)).toBe('https://origin.example.edu/p1.png');
			expect(image.headers.get('x-spool-image')).toBe('10000->1250; q=80; w=960');
			expect(
				encoder.mock.calls.map(([, options]) => Boolean(options.lossless)).sort()
			).toEqual([false, true]);
			expect({ ...proxy.images }).toMatchObject({ converted: 1, lazied: 1, responsive: 4 });
			expect(proxy.embeds.rewritten).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('dictionary: a stylesheet is registered, then served as dcz against the one the request names', async () => {
		const css = (rule: string) => new TextEncoder().encode(rule.repeat(400));
		const files: Record<string, Uint8Array> = {
			'/css/a.css': css('.card{margin:0 auto;padding:12px}'),
			'/css/b.css': css('.card{margin:0 auto;padding:14px}')
		};
		vi.stubGlobal('fetch', async (request: Request) => {
			const body = files[new URL(request.url).pathname];
			return body
				? new Response(body as BodyInit, { headers: { 'content-type': 'text/css' } })
				: new Response('none', { status: 404 });
		});
		try {
			const first = await dictionaryProxy(new Request('https://site.test/css/a.css'));
			expect(first.headers.get('use-as-dictionary')).toBe(
				'match="/css/*", match-dest=("style")'
			);
			const hash = createHash('sha256')
				.update(files['/css/a.css'] as Uint8Array)
				.digest('base64');
			const second = await dictionaryProxy(
				new Request('https://site.test/css/b.css', {
					headers: { 'accept-encoding': 'br, dcz', 'available-dictionary': `:${hash}:` }
				})
			);
			expect(second.headers.get('content-encoding')).toBe('dcz');
			const body = new Uint8Array(await second.arrayBuffer());
			expect(
				new Uint8Array(
					zstdDecompressSync(body.subarray(40), {
						dictionary: files['/css/a.css'] as Uint8Array
					})
				)
			).toEqual(files['/css/b.css']);
			expect({ ...dictionaryProxy.dictionary }).toMatchObject({ registered: 2, encoded: 1 });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('page runtime: the tag points at this version on the CDN with the hash', () => {
		expect(cdn.config.clientTag).toContain(`src="${cdnClientUrl(VERSION)}"`);
		expect(cdn.config.clientTag).toContain('crossorigin="anonymous"');
	});
});

describe('the README matches the fixtures', () => {
	const readme = readFileSync(join(root, 'README.md'), 'utf8');
	const specifiers: Record<string, string> = {
		'@drupflare/spool/protocol': '../../../src/protocol/index',
		'@drupflare/spool/proxy': '../../../src/proxy/index',
		'@drupflare/spool/report': '../../../src/report/index',
		'@drupflare/spool/sw': '../../../src/sw/index',
		'@drupflare/spool/server': '../../../src/server/index',
		'@drupflare/spool/stores': '../../../src/stores/index',
		'@drupflare/spool/stores/durable-object': '../../../src/stores/durable-object',
		'@drupflare/spool/node': '../../../src/node/listener',
		'@drupflare/spool/trim': '../../../src/trim/index',
		'@drupflare/spool/media': '../../../src/media/index'
	};

	const sections = new Map<string, string[]>();
	for (const part of readme.split(/^(?=#{2,3} )/m)) {
		const title = /^#{2,3} (.+)$/m.exec(part)?.[1]?.replace(/^[^\p{L}\p{N}]+/u, '');
		if (!title) continue;
		const fences = [...part.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((m) => m[1] as string);
		if (fences.length > 0) sections.set(title, fences);
	}

	const normal = (source: string): string =>
		source
			.replace(/from '(@drupflare\/spool[^']*)'/g, (_, spec: string) => {
				return `from '${specifiers[spec] ?? spec}'`;
			})
			.replace(/\s+/g, '');

	const cases: Array<[string, string[]]> = [
		['Declare Routes', ['routes.ts', 'store.ts', 'spool.ts']],
		['Page Runtime', ['cdn.ts']],
		['Strategies', ['assembly.ts']],
		['Static Files', ['static.ts']],
		['Projection and Data Routes', ['projection.ts', 'sw.ts']],
		['Authenticated Data', ['authenticated.ts']],
		['Catalogue', ['catalogue.ts']],
		['Collectors', ['collectors.ts']],
		['Third-Party Files', ['third-party.ts']],
		['Subresource Handling', ['assets.ts']],
		['Records and Projections', ['graph.ts']],
		['Templates', ['template.ts']],
		['Freshness Contracts', ['freshness.ts']],
		['Analytics Batching', ['analytics.ts']],
		['Shadow Mode', ['shadow.ts']],
		['Proxy Mode', ['proxy-node.ts', '../../fixtures/readme/proxy-workers.ts']],
		['Trimmed Stylesheets', ['trim.ts']],
		['Images and Video', ['media.ts']],
		['Page Rewrites', ['rewrites.ts']],
		['Dictionary Transport', ['dictionary.ts']],
		['Cloudflare Workers', ['../../fixtures/readme/workers.ts']],
		['Cloudflare Pages Functions', ['cloudflare-pages.ts']],
		['Hono', ['hono.ts']],
		['Elysia', ['elysia.ts']],
		['itty-router', ['itty-router.ts']],
		['Netlify Functions', ['netlify-functions.ts']],
		['Netlify Edge Functions', ['netlify-edge.ts']],
		['AWS Lambda', ['lambda.ts']],
		['Azure Functions', ['azure.ts']],
		['Fastify', ['fastify.ts']],
		['Koa', ['koa.ts']],
		['hapi', ['hapi.ts']],
		['NestJS', ['nest.ts']],
		['Google Cloud Functions', ['google-cloud.ts']],
		['Node', ['node-http.ts']],
		['Express', ['express.ts']],
		['Bun', ['bun.ts']],
		['Deno', ['deno.ts']],
		['Vercel Functions', ['vercel.ts']],
		['Next.js', ['next-proxy.ts', 'next-route.ts']],
		['Nuxt and Nitro', ['nuxt-middleware.ts', 'nuxt-route.ts']]
	];

	it.each(cases)('%s', (title, files) => {
		const fences = sections.get(title);
		expect(fences, `README has no ts fences under "${title}"`).toBeDefined();
		expect(fences).toHaveLength(files.length);
		files.forEach((file, i) => {
			const fixture = readFileSync(join(root, 'tests/node/readme', file), 'utf8');
			expect(normal(fences?.[i] ?? '')).toEqual(normal(fixture));
		});
	});

	it('has a fixture for every ts fence', () => {
		const fences = [...sections.values()].reduce((sum, list) => sum + list.length, 0);
		const mapped = cases.reduce((sum, [, files]) => sum + files.length, 0);
		expect(fences).toBe(mapped);
	});

	it('links every table of contents entry to a heading', () => {
		const slugs = new Set(
			[...readme.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
				(m[1] as string)
					.toLowerCase()
					.replace(/[^\p{L}\p{N}\s-]/gu, '')
					.replace(/ /g, '-')
			)
		);
		const links = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
		expect(links.length).toBeGreaterThan(10);
		for (const link of links) expect(slugs.has(link), link).toBe(true);
	});

	it('shows a spool.json the worker accepts', () => {
		const block = /```json\n(\{\n  "schema"[\s\S]*?)```/.exec(readme)?.[1];
		expect(block).toBeDefined();
		const manifest = parseManifest(JSON.parse(block as string));
		expect(manifest.routes.map((route) => route.pattern)).toEqual([
			'/',
			'/about',
			'/css/site.css',
			'/client.js'
		]);
	});

	it('static: the route is a static route with its tag and bound', () => {
		expect(staticAbout.strategy).toBe('static');
		expect(staticAbout.depends({} as never)).toEqual(['site']);
		expect(staticAbout.freshness).toEqual({ maxStale: 3600, mode: 'soft' });
	});

	it('projection: the renderer in the bundled worker escapes the names it renders', async () => {
		const serve = vi.fn();
		vi.resetModules();
		vi.doMock('../../src/sw/index', () => ({ serve }));
		vi.stubGlobal('CONFIG', '{}');
		try {
			await import('./readme/sw');
		} finally {
			vi.doUnmock('../../src/sw/index');
			vi.unstubAllGlobals();
			vi.resetModules();
		}
		const render = serve.mock.calls[0]?.[1]['/rosters/:id'];
		const html = render({
			body: { data: { names: ['Ada', '<script>alert(1)</script>', 'Bo & "Co"'] } }
		});
		expect(html).toContain('<li>Ada</li>');
		expect(html).toContain('<li>&lt;script&gt;alert(1)&lt;/script&gt;</li>');
		expect(html).toContain('<li>Bo &amp; &quot;Co&quot;</li>');
		expect(html).not.toContain('<script>');
	});
});
