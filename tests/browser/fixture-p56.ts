import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CollectorConfig } from '../../src/protocol/index';
import { createSpool, defineRoute, memorySink, type SpoolOptions } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { listen, type Fixture } from './fixture';

const layout = (title: string, body: string, extra = '') =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body><nav><a href="/grades">grades</a> <a href="/inbox">inbox</a> <a href="/about">about</a> <a href="/logout">logout</a></nav><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const GRADES = layout('grades', 'grades of {{owner}} score {{mark.score}}');
const INBOX = layout('inbox', 'inbox of {{owner}}');

export type AuthFixture = Fixture & {
	marks: Record<string, number>;
	/** every `Cookie`-bearing request the server saw, by path, for what the page actually sent */
	logins: string[];
};

function cookieUser(request: Request): string | null {
	return /(?:^|;\s*)user=([A-Za-z0-9]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
}

/** principal routes behind a cookie login, with logout and a hard-reset page */
export async function startAuth(): Promise<AuthFixture> {
	const hits: Fixture['hits'] = [];
	const marks: Record<string, number> = { A: 91, B: 47 };
	const logins: string[] = [];
	const sink = memorySink();
	type Ctx = {
		identity: { principal: string } | null;
		record(id: string, data: unknown): unknown;
	};
	const who = (ctx: Ctx) => (ctx.identity as { principal: string }).principal;
	const principal = (retention: 'persistent' | 'session', source: string) => ({
		strategy: 'template' as const,
		scope: 'principal' as const,
		retention,
		template: { source },
		depends: (ctx: Ctx) => [`perm:${who(ctx)}`, `grades:${who(ctx)}`, `mark:${who(ctx)}`],
		load: (ctx: Ctx) => ({
			owner: who(ctx),
			mark: ctx.record(`mark:${who(ctx)}`, { score: marks[who(ctx)] })
		})
	});
	const spool = createSpool({
		routes: [
			defineRoute('/grades', principal('persistent', GRADES)),
			defineRoute('/inbox', principal('session', INBOX)),
			defineRoute('/about', {
				strategy: 'template',
				template: { source: layout('about', 'about this site') },
				load: () => ({})
			})
		],
		store: memoryStore(),
		sink,
		logout: ['/logout'],
		identity: {
			secret: 'fixture-secret',
			resolve: (request) => {
				const user = cookieUser(request);
				return user ? { principal: user } : null;
			}
		}
	});

	const html = (text: string, headers: Record<string, string> = {}, status = 200) =>
		new Response(text, {
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0',
				...headers
			}
		});

	const app = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const user = cookieUser(request);
		if (url.pathname === '/login') {
			const as = url.searchParams.get('as') as string;
			logins.push(as);
			return html(layout('welcome', `signed in as ${as}`), {
				'set-cookie': `user=${as}; Path=/`,
				'spool-partition': await spool.partition(as)
			});
		}
		if (url.pathname === '/logout') {
			return html(layout('bye', 'signed out'), { 'set-cookie': 'user=; Path=/; Max-Age=0' });
		}
		if (url.pathname === '/hard-reset') {
			return html(layout('reset', 'reset'), {
				'set-cookie': 'user=; Path=/; Max-Age=0',
				'spool-clear': '*',
				'clear-site-data': '"storage"'
			});
		}
		if (request.method === 'POST' && url.pathname === '/grades/edit') {
			if (!user) return new Response('no', { status: 401 });
			marks[user] = (marks[user] as number) + 1;
			await spool.invalidate([`grades:${user}`, `mark:${user}`]);
			return new Response('saved');
		}
		if (url.pathname === '/grades' || url.pathname === '/inbox') {
			if (!user) return html(layout('sign in', 'please sign in'), {}, 401);
			const title = url.pathname.slice(1);
			return html(
				layout(
					title,
					url.pathname === '/grades'
						? `grades of ${user} score ${marks[user]}`
						: `inbox of ${user}`
				)
			);
		}
		if (url.pathname === '/about') return html(layout('about', 'about this site'));
		if (url.pathname === '/data.json') {
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
		return new Response('not found', { status: 404 });
	};

	return { ...(await listen(hits, spool, app)), hits, spool, sink, db: new Map(), marks, logins };
}

export type OtherOrigin = {
	origin: string;
	hits: Array<{ method: string; path: string; search: string; body: string }>;
	stop(): Promise<void>;
};

/** a second origin on `localhost`, so a page on `127.0.0.1` sees its files as cross-origin */
export async function startOther(
	answer: (path: string) => { type: string; body: string | Buffer } | undefined
): Promise<OtherOrigin> {
	const hits: OtherOrigin['hits'] = [];
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			hits.push({
				method: req.method ?? 'GET',
				path: url.pathname,
				search: url.search,
				body: Buffer.concat(chunks).toString()
			});
			const found = answer(url.pathname);
			const cors = {
				'access-control-allow-origin': req.headers.origin ?? '*',
				'access-control-allow-credentials': 'true',
				'access-control-allow-headers': 'content-type'
			};
			if (req.method === 'OPTIONS') {
				res.writeHead(204, cors).end();
				return;
			}
			if (!found) {
				res.writeHead(204, cors).end();
				return;
			}
			res.writeHead(200, {
				...cors,
				'content-type': found.type,
				'cache-control': 'no-store'
			});
			res.end(found.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
	return {
		origin,
		hits,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

export type P6Fixture = Fixture & { other: OtherOrigin; marks: Record<string, number> };

const FONT = Buffer.from('d09GMgABAAAAAAAA', 'base64');

/** bundles a worker entry with Bun, as a site does for its `projection` renderers */
function bundleWorker(): string {
	const dir = mkdtempSync(join(tmpdir(), 'spool-bundle-'));
	const entry = join(dir, 'sw.ts');
	const root = join(import.meta.dirname, '../../src/sw/serve');
	writeFileSync(
		entry,
		`import { serve } from '${root}';
serve((self as unknown as { __SPOOL_CONFIG__: never }).__SPOOL_CONFIG__, {
	'/p/:id': (artifact) => {
		const data = (artifact as unknown as { body: { data: { id: string; label: string } } }).body.data;
		return '<!doctype html><html><head><meta charset="utf-8"><title>projection</title></head><body><h1>projection ' + data.id + '</h1><p>' + data.label + '</p></body></html>';
	}
});
`
	);
	const out = join(dir, 'sw.js');
	execFileSync('bun', ['build', entry, '--target=browser', '--format=iife', `--outfile=${out}`]);
	return readFileSync(out, 'utf8');
}

/**
 * The P6 fixture: a data route, a projection route served by a bundled worker, a page that loads a
 * versioned font and script from a second origin, and a collector on that origin.
 */
export async function startP6(
	options: { assets?: SpoolOptions['assets']; collectors?: CollectorConfig[] } = {}
): Promise<P6Fixture> {
	const hits: Fixture['hits'] = [];
	const marks: Record<string, number> = {};
	const other = await startOther((path) => {
		if (path.endsWith('.woff2')) return { type: 'font/woff2', body: FONT };
		if (path.endsWith('.js'))
			return { type: 'text/javascript', body: 'window.__third = true;' };
		return undefined;
	});
	const sink = memorySink();
	const collectors: CollectorConfig[] = options.collectors ?? [
		{
			vendor: 'pixel',
			match: `${other.origin}/collect`,
			maxAgeMs: 24 * 3_600_000,
			delivery: 'replay',
			stamp: { param: 'qt', kind: 'age-ms' }
		}
	];
	const thirdPage = (extra: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>third</title><style>@font-face{font-family:T;src:url(${other.origin}/s/t/v1/a.woff2) format('woff2')}body{font-family:T,sans-serif}</style><script src="${other.origin}/lib.3f9a1c2b4d.js" crossorigin="anonymous"></script></head><body><nav><a href="/third/1">t1</a> <a href="/third/2">t2</a> <a href="/p/1">p1</a></nav><h1>third {{id}}</h1><script>${extra}</script></body></html>`;
	const collect = `navigator.sendBeacon('${other.origin}/collect?cid=7&p='+encodeURIComponent(location.pathname),'hit');`;
	const spool = createSpool({
		routes: [
			defineRoute('/third/:id', {
				strategy: 'template',
				template: { source: thirdPage(collect) },
				depends: (ctx) => [`third:${ctx.params['id']}`],
				load: (ctx) => ({ id: ctx.params['id'] }),
				freshness: { maxStale: 3600, mode: 'soft' }
			}),
			defineRoute('/p/:id', {
				strategy: 'projection',
				depends: (ctx) => [`p:${ctx.params['id']}`],
				load: (ctx) => ({ id: ctx.params['id'], label: `label ${ctx.params['id']}` }),
				provision: { reuse: 1, futureViews: 5 }
			}),
			defineRoute('/api/course/:id', {
				strategy: 'data',
				depends: (ctx) => [`course:${ctx.params['id']}`],
				load: (ctx) => ({ id: ctx.params['id'], title: `Course ${ctx.params['id']}` }),
				provision: { reuse: 1, futureViews: 5 }
			}),
			defineRoute('/data-page', {
				strategy: 'template',
				template: {
					source: '<!doctype html><html><head><meta charset="utf-8"><title>data</title></head><body><h1>data</h1><pre id="out"></pre><script>fetch("/api/course/1").then(r=>r.json()).then(j=>{document.getElementById("out").textContent=j.title})</script></body></html>'
				},
				load: () => ({})
			})
		],
		store: memoryStore(),
		sink,
		beacons: ['/cdn-cgi/rum'],
		collectors,
		assets: options.assets,
		thirdParty: { allow: [other.origin] },
		worker: bundleWorker()
	});
	const html = (text: string) =>
		new Response(text, {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' }
		});
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		if (pathname.startsWith('/third/')) {
			const id = pathname.split('/').pop();
			return html(thirdPage(collect).replace('{{id}}', id as string));
		}
		if (pathname.startsWith('/p/')) {
			const id = pathname.split('/').pop();
			return html(
				`<!doctype html><html><head><meta charset="utf-8"><title>projection</title></head><body><h1>projection ${id}</h1><p>label ${id}</p></body></html>`
			);
		}
		if (pathname.startsWith('/api/course/')) {
			const id = pathname.split('/').pop();
			return new Response(JSON.stringify({ id, title: `Course ${id}` }), {
				headers: { 'content-type': 'application/json' }
			});
		}
		if (pathname === '/data-page') {
			return html(
				'<!doctype html><html><head><meta charset="utf-8"><title>data</title></head><body><h1>data</h1><pre id="out"></pre><script>fetch("/api/course/1").then(r=>r.json()).then(j=>{document.getElementById("out").textContent=j.title})</script></body></html>'
			);
		}
		if (pathname === '/cdn-cgi/rum') return new Response(null, { status: 204 });
		if (pathname === '/data.json') {
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
		return new Response('not found', { status: 404 });
	};
	const base = await listen(hits, spool, app);
	return {
		...base,
		hits,
		spool,
		sink,
		db: new Map(),
		other,
		marks,
		stop: async () => {
			await base.stop();
			await other.stop();
		}
	};
}
