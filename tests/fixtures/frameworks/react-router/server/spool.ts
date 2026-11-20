import { reactRouterPages } from '@drupflare/spool/react-router';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import routes from '../app/routes';
import config from '../react-router.config';

type Article = { id: string; title: string };

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
const statics = reactRouterPages(routes, config).flatMap((page) =>
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

export const spool = createSpool({
	routes: [...statics, article],
	datasets: [articles],
	store: memoryStore(),
	bundles: memoryBundleStore()
});
