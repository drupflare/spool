import { SPOOL_PAGES_FILE, type NextPageRegistration } from '@drupflare/spool/next';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Article = { id: string; title: string };

export const rows: Article[] = [
	{ id: '1', title: 'First article' },
	{ id: '2', title: 'Second article' }
];

// the registrations the adapter wrote at `next build`; empty before the first build
const file = join(process.cwd(), '.next', SPOOL_PAGES_FILE);
export const pages: NextPageRegistration[] = existsSync(file)
	? JSON.parse(readFileSync(file, 'utf8'))
	: [];

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

// the prerendered article params: the app declares the family the plugin reported
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
