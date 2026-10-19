import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeListener } from '../../src/node/listener';
import { placeholder, slot, type Mode } from '../../src/protocol/index';
import {
	createSpool,
	defineRoute,
	memorySink,
	type Spool,
	type SpoolOptions
} from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { campus, type CampusData } from '../fixtures/graph';

/** seconds a hard or soft fixture route may go without validation */
export const BOUND = 3;

export type Hit = {
	method: string;
	path: string;
	search: string;
	body?: string;
	type?: string | null;
};

export type Fixture = {
	origin: string;
	hits: Hit[];
	/** the bodies of `/.spool/artifact` and `/.spool/sync` responses, in the order they were sent */
	responses: Array<{ path: string; search: string; text: string }>;
	spool: Spool;
	sink: ReturnType<typeof memorySink>;
	/** page bodies by id; change one, then invalidate its tag */
	db: Map<string, string>;
	/** the campus data, when the fixture was started with {@link startCampus} */
	campus?: CampusData;
	/** holds every /.spool/sync response until the returned function is called */
	holdSync(): () => void;
	stop(): Promise<void>;
};

const RUM =
	"navigator.sendBeacon('/cdn-cgi/rum',JSON.stringify({page:location.pathname,n:1}));" +
	"fetch('/cdn-cgi/rum',{method:'POST',body:JSON.stringify({page:location.pathname,n:2})});";

const NAV = ['/n/1', '/n/2', '/n/3', '/hard/1', '/soft/1', '/asm/about']
	.map((p) => `<a href="${p}">${p}</a>`)
	.join(' ');

const layout = (title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/site.css"></head><body><nav>${NAV}</nav><main><h1>${title}</h1><p>${body}</p></main><script>${RUM}</script></body></html>`;

const TEMPLATE = layout('{{title}}', '{{body}}');

const OTHER_ORIGIN =
	"<script>new Image().src=location.protocol+'//localhost:'+location.port+'/pixel.gif'</script>";
const XO_TEMPLATE = layout('{{title}}', `{{body}}${OTHER_ORIGIN}`);

const escape = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

export type FixtureOptions = { mode?: Mode; cdn?: SpoolOptions['cdn'] };

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const hits: Hit[] = [];
	const db = new Map<string, string>(
		['1', '2', '3', '4', '5', '6'].map((id) => [id, `body of ${id} <b>&</b>`])
	);
	const bodyOf = (id: string) => db.get(id) ?? 'unknown';
	const titleOf = (prefix: string, id: string) => `${prefix} ${id}`;

	const routes = [
		...(['n', 'hard', 'soft'] as const).map((kind) =>
			defineRoute(`/${kind}/:id`, {
				strategy: 'template',
				template: { source: TEMPLATE },
				depends: (ctx) => [`node:${ctx.params['id']}`],
				load: (ctx) => ({
					title: titleOf(kind, ctx.params['id'] as string),
					body: bodyOf(ctx.params['id'] as string)
				}),
				freshness:
					kind === 'n'
						? { maxStale: 3600, mode: 'soft' }
						: { maxStale: BOUND, mode: kind === 'hard' ? 'hard' : 'soft' }
			})
		),
		defineRoute('/xo/:id', {
			strategy: 'template',
			template: { source: XO_TEMPLATE },
			depends: (ctx) => [`node:${ctx.params['id']}`],
			load: (ctx) => ({
				title: titleOf('xo', ctx.params['id'] as string),
				body: bodyOf(ctx.params['id'] as string)
			})
		}),
		defineRoute('/div/:id', {
			strategy: 'template',
			template: { source: TEMPLATE },
			depends: (ctx) => [`node:${ctx.params['id']}`],
			load: (ctx) => ({
				title: titleOf('div', ctx.params['id'] as string),
				body: bodyOf(ctx.params['id'] as string)
			}),
			freshness: { maxStale: 3600, mode: 'soft' }
		}),
		defineRoute('/cat/:id', {
			strategy: 'template',
			template: { source: TEMPLATE },
			depends: (ctx) => [`node:${ctx.params['id']}`],
			load: (ctx) => ({
				title: titleOf('cat', ctx.params['id'] as string),
				body: bodyOf(ctx.params['id'] as string)
			}),
			freshness: { maxStale: 3600, mode: 'soft' }
		}),
		defineRoute('/home', {
			strategy: 'template',
			template: { source: TEMPLATE },
			depends: () => ['home'],
			load: () => ({ title: 'home', body: bodyOf('1') }),
			freshness: { maxStale: 3600, mode: 'soft' },
			catalogue: () => [
				{ path: '/cat/1', p: 0.9 },
				{ path: '/cat/2', p: 0.9 }
			]
		}),
		defineRoute('/asm/:slug', {
			strategy: 'assembly',
			depends: () => ['menu'],
			load: (ctx) => ({
				shell: layout(
					`asm ${ctx.params['slug']}`,
					`${placeholder('lead')} ${slot('year')}`
				),
				fragments: { lead: '<em>lead</em>' },
				slots: { year: '2026' }
			})
		})
	];

	const sink = memorySink();
	const spool = createSpool({
		routes,
		store: memoryStore(),
		sink,
		beacons: ['/cdn-cgi/rum'],
		mode: options.mode,
		cdn: options.cdn
	});

	const html = (text: string) =>
		new Response(text, {
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=0' }
		});

	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const [, kind, id = ''] = pathname.split('/');
		if (kind === 'n' || kind === 'hard' || kind === 'soft') {
			const ok = db.has(id);
			if (!ok) return new Response('missing', { status: 404 });
			return html(layout(titleOf(kind, id), escape(bodyOf(id))));
		}
		if (kind === 'xo') {
			if (!db.has(id)) return new Response('missing', { status: 404 });
			return html(layout(titleOf('xo', id), `${escape(bodyOf(id))}${OTHER_ORIGIN}`));
		}
		if (pathname === '/pixel.gif') {
			const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
			return new Response(Buffer.from(gif, 'base64'), {
				headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' }
			});
		}
		if (kind === 'cat') {
			if (!db.has(id)) return new Response('missing', { status: 404 });
			return html(layout(titleOf('cat', id), escape(bodyOf(id))));
		}
		if (pathname === '/home') return html(layout('home', escape(bodyOf('1'))));
		if (kind === 'div') {
			if (!db.has(id)) return new Response('missing', { status: 404 });
			return html(layout(`network div ${id}`, escape(bodyOf(id))));
		}
		if (kind === 'asm') {
			return html(layout(`asm ${id}`, `<em>lead</em> 2026`));
		}
		if (pathname === '/site.css') {
			return new Response('main{max-width:60ch}', {
				headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000' }
			});
		}
		if (pathname === '/data.json') {
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
		if (pathname === '/cdn-cgi/rum') return new Response(null, { status: 204 });
		return new Response('not found', { status: 404 });
	};

	return { ...(await listen(hits, spool, app)), hits, spool, sink, db };
}

/** the campus fixture: three graph routes over shared records, soft bound of {@link BOUND} seconds */
export async function startCampus(): Promise<Fixture> {
	const hits: Hit[] = [];
	const world = campus({ freshness: { maxStale: BOUND, mode: 'soft' } });
	const sink = memorySink();
	const spool = createSpool({ routes: world.routes, store: memoryStore(), sink });
	const app = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const body = world.html(pathname);
		if (body !== undefined) {
			return new Response(body, {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'max-age=0'
				}
			});
		}
		if (pathname === '/data.json') {
			return new Response('{}', { headers: { 'content-type': 'application/json' } });
		}
		return new Response('not found', { status: 404 });
	};
	return {
		...(await listen(hits, spool, app)),
		hits,
		spool,
		sink,
		db: new Map(),
		campus: world.db
	};
}

export async function listen(
	hits: Hit[],
	spool: Spool,
	app: (request: Request) => Response | Promise<Response>
): Promise<Pick<Fixture, 'origin' | 'responses' | 'holdSync' | 'stop'>> {
	const responses: Fixture['responses'] = [];
	let gate: Promise<void> | null = null;
	const listener = toNodeListener(async (request) => {
		const { pathname } = new URL(request.url);
		const hit: Hit = {
			method: request.method,
			path: pathname,
			search: new URL(request.url).search
		};
		if (request.method === 'POST' && pathname === '/cdn-cgi/rum') {
			hit.body = await request.clone().text();
			hit.type = request.headers.get('content-type');
		}
		hits.push(hit);
		if (gate && pathname === '/.spool/sync') await gate;
		const response = await spool.handle(request, app);
		if (pathname === '/.spool/sync' || pathname === '/.spool/artifact') {
			responses.push({
				path: pathname,
				search: new URL(request.url).search,
				text: await response.clone().text()
			});
		}
		return response;
	});

	const server: Server = createServer((req, res) => void listener(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		origin,
		responses,
		holdSync() {
			let release: () => void = () => {};
			gate = new Promise<void>((resolve) => (release = resolve));
			return () => {
				gate = null;
				release();
			};
		},
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}
