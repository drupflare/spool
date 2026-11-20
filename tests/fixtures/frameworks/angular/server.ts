import { spoolAngular } from '@drupflare/spool/angular';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { reqHandler, routes, serverRoutes } from './dist/angular-app/server/server.mjs';

type Article = { id: string; title: string };

const port = Number(process.env['PORT'] ?? 4950);
const browserDir = new URL('./dist/angular-app/browser', import.meta.url).pathname;
const pages = spoolAngular({ routes, serverRoutes });

const rows: Article[] = [
	{ id: '1', title: 'First article' },
	{ id: '2', title: 'Second article' }
];

const articles = defineDataset<Article>('articles', {
	scope: 'public',
	key: (row) => row.id,
	seed: () => rows,
	read: (ids) => rows.filter((row) => ids.includes(row.id)),
	changes: () => ({ cursor: 1, puts: [], deletes: [] }),
	horizon: () => 1,
	head: () => ({ cursor: 1 }),
	schema: 'article-1',
	maxRows: 1000,
	maxBytes: 1_000_000
});

const shell = (title: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

// the static pages the plugin registered; a route it left on the network stays there
const statics = pages.flatMap((page) =>
	page.pattern && page.register !== 'network' && !page.pattern.includes(':')
		? [
				defineRoute(page.pattern, {
					strategy: 'template',
					template: { source: shell(page.path) },
					depends: () => [page.path],
					load: () => ({})
				})
			]
		: []
);

// a parameter route: the plugin cannot enumerate its params, so the app declares its family
const article = defineRoute('/articles/:id', {
	strategy: 'template',
	template: { source: shell('{{row.title}}') },
	family: { dataset: 'articles', key: 'id' },
	load: (ctx) => ({ row: rows.find((row) => row.id === ctx.params['id']) })
});

const spool = createSpool({
	routes: [...statics, article],
	datasets: [articles],
	store: memoryStore(),
	bundles: memoryBundleStore()
});

// the request log the browser test reads; assets and the log itself are not logged
const hits: string[] = [];

await spool.publish(new URL(`http://127.0.0.1:${port}/`));

Bun.serve({
	port,
	hostname: '127.0.0.1',
	async fetch(request) {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === '/api/hits') {
			const out = [...hits];
			if (searchParams.has('reset')) hits.length = 0;
			return Response.json(out);
		}
		if (pathname === '/api/pages') return Response.json(pages);
		if (/\.[a-z0-9]+$/i.test(pathname)) {
			const file = Bun.file(`${browserDir}${pathname}`);
			if (await file.exists()) return new Response(file);
		}
		hits.push(pathname);
		return spool.handle(request, (req) => reqHandler(req));
	}
});
