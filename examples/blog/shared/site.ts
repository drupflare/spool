import { escapeHtml, interpretTemplate } from '@drupflare/spool/protocol';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	type Spool
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Author = { id: string; name: string; bio: string };
export type Post = {
	id: string;
	title: string;
	author: string;
	tag: string;
	date: string;
	archive: string;
	body: string;
};

export const AUTHORS: Author[] = [
	{ id: 'ada', name: 'Ada Park', bio: 'Writes about caching and the browser.' },
	{ id: 'bo', name: 'Bo Lin', bio: 'Writes about forms and content models.' },
	{ id: 'cy', name: 'Cy Ortiz', bio: 'Writes about routing and releases.' }
];

export const PAGE_SIZE = 10;

const SEARCH_LIMIT = 200;
const TAGS = ['web', 'ops', 'design', 'data'];
const SUBJECTS = [
	'Caching',
	'Forms',
	'Routing',
	'Images',
	'Search',
	'Themes',
	'Releases',
	'Security'
];
const DAY_MS = 86_400_000;
const FIRST_DAY = Date.UTC(2024, 0, 1);
const SITE_URL = 'https://blog.test/';
const LIST = '<ul>{{#each posts}}<li><a href="/posts/{{id}}">{{title}}</a></li>{{/each}}</ul>';
const NAV = '<nav><a href="/">Home</a> <a href="/tags">Tags</a> <a href="/search">Search</a></nav>';
const FOOTER = `<footer><nav>${AUTHORS.map((author) => `<a href="/authors/${encodeURIComponent(author.id)}">${escapeHtml(author.name)}</a>`).join(' ')}</nav></footer>`;
const shellOf = (layout: string) => (title: string, body: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body>${NAV}<main data-spool-swap>${body}</main>${FOOTER}${layout}</body></html>`;

/** filler letters for the padding hook; a multiplicative hash keeps them near random for gzip */
const filler = (length: number): string =>
	Array.from({ length }, (_, i) =>
		String.fromCharCode(97 + ((Math.imul(i, 2654435761) >>> 24) % 26))
	).join('');

/** a hidden block of `bytes` bytes in the page layout; none when 0, which is the default */
const layoutOf = (bytes: number): string =>
	bytes === 0 ? '' : `<div hidden>${filler(bytes - 18)}</div>`;

/** ids count down as posts are added, so ascending key order lists the newest post first */
export function postId(seq: number): string {
	return String(10_000 - seq).padStart(5, '0');
}

function pick<T>(list: readonly T[], index: number): T {
	return list[index % list.length] as T;
}

/** the generated posts, oldest first, five days apart */
export function posts(count = 60): Post[] {
	return Array.from({ length: count }, (_, index) => {
		const date = dateOf(index);
		return {
			id: postId(index + 1),
			title: `${pick(SUBJECTS, index)} notes ${index + 1}`,
			author: pick(AUTHORS, index).id,
			tag: pick(TAGS, index),
			date,
			archive: archiveOf(date),
			body: `Part ${index + 1} of the series.`
		};
	});
}

const dateOf = (index: number) =>
	new Date(FIRST_DAY + index * 5 * DAY_MS).toISOString().slice(0, 10);
const archiveOf = (date: string) => date.slice(0, 7).replace('-', '/');

async function blogBuild(spooled: boolean, docBytes: number) {
	const shell = shellOf(layoutOf(docBytes));
	const all = posts();
	const log: Array<{ cursor: number; key: string }> = [];
	let cursor = 1;
	const newestFirst = (): Post[] => [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
	const inMonth = (year: string, month: string): Post[] =>
		newestFirst().filter((post) => post.date.startsWith(`${year}-${month}`));
	const byAuthor = (id: string) => ({
		author: AUTHORS.find((row) => row.id === id) ?? { id, name: '', bio: '' },
		posts: newestFirst().filter((post) => post.author === id)
	});

	const postRows = defineDataset<Post>('posts', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => newestFirst(),
		read: (ids) => all.filter((row) => ids.includes(row.id)),
		changes: (since) => ({
			cursor,
			puts: [
				...new Set(log.filter((entry) => entry.cursor > since).map((entry) => entry.key))
			],
			deletes: []
		}),
		horizon: () => 1,
		head: () => ({ cursor }),
		schema: 'post-1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});

	const authorRows = defineDataset<Author>('authors', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => AUTHORS,
		read: (ids) => AUTHORS.filter((row) => ids.includes(row.id)),
		changes: () => ({ cursor: 1, puts: [], deletes: [] }),
		horizon: () => 1,
		head: () => ({ cursor: 1 }),
		schema: 'author-1',
		maxRows: 100,
		maxBytes: 100_000
	});

	const homeRoute = defineRoute('/', {
		strategy: 'template',
		template: {
			source: shell(
				'Blog',
				`<h1>{{#if query}}Page {{query.page}} of {{query.pages}}{{else}}Newest Posts{{/if}}</h1>${LIST}`
			)
		},
		depends: () => ['posts'],
		load: () => ({ posts: newestFirst().slice(0, PAGE_SIZE) }),
		query: { list: 'posts', dataset: 'posts', pageSize: PAGE_SIZE }
	});

	const postRoute = defineRoute('/posts/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p>{{row.date}}</p><p>{{row.body}}</p><p><a href="/">All posts</a> <a href="/tags?tag={{row.tag}}">{{row.tag}}</a> <a href="/authors/{{row.author}}">{{row.author}}</a> <a href="/archive/{{row.archive}}">Archive</a></p>'
			)
		},
		family: { dataset: 'posts', key: 'id' },
		load: (ctx) => all.find((row) => row.id === ctx.params['id'])
	});

	const tagRoute = defineRoute('/tags', {
		strategy: 'template',
		template: {
			source: shell(
				'Tags',
				`<h1>{{#if query}}Tagged Posts{{else}}Tags{{/if}}</h1>{{#if query}}<p>{{query.total}} posts, page {{query.page}} of {{query.pages}}</p>${LIST}{{else}}<p>Add a tag to the address.</p><p>${TAGS.map((tag) => `<a href="/tags?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(' ')}</p>{{/if}}`
			)
		},
		depends: () => ['posts'],
		load: () => ({}),
		query: {
			list: 'posts',
			dataset: 'posts',
			filter: { tag: 'string' },
			pageSize: PAGE_SIZE
		}
	});

	const searchRoute = defineRoute('/search', {
		strategy: 'template',
		template: {
			source: shell(
				'Search',
				`<h1>{{#if query}}Search Results{{else}}Search{{/if}}</h1>{{#if query}}<p>{{query.total}} matches, page {{query.page}} of {{query.pages}}</p>${LIST}{{else}}<p>Search the post titles.</p><p><a href="/search?q=Caching">Caching notes</a></p>{{/if}}`
			)
		},
		depends: () => ['posts'],
		load: () => ({}),
		query: {
			list: 'posts',
			dataset: 'posts',
			plan: {
				from: ['id', 'title', 'date'],
				where: [
					{ field: 'title', op: 'prefix', param: 'q', type: 'string', fold: 'ascii' }
				],
				pageSize: PAGE_SIZE,
				limit: SEARCH_LIMIT
			}
		}
	});

	const authorRoute = defineRoute('/authors/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p>{{row.bio}}</p><p><a href="/authors/{{row.id}}/posts">Posts by {{row.name}}</a></p>'
			)
		},
		family: { dataset: 'authors', key: 'id' },
		load: (ctx) => AUTHORS.find((row) => row.id === ctx.params['id'])
	});

	const authorPostsRoute = defineRoute('/authors/:id/posts', {
		strategy: 'template',
		template: {
			source: shell('{{author.name}}', `<h1>Posts by {{author.name}}</h1>${LIST}`)
		},
		depends: () => ['posts'],
		load: (ctx) => byAuthor(ctx.params['id'] ?? '')
	});

	const archiveRoute = defineRoute('/archive/:year/:month', {
		strategy: 'template',
		template: {
			source: shell('Archive', `<h1>Archive {{year}}-{{month}}</h1>${LIST}`)
		},
		depends: () => ['posts'],
		load: (ctx) => {
			const year = ctx.params['year'] ?? '';
			const month = ctx.params['month'] ?? '';
			return { year, month, posts: inMonth(year, month) };
		}
	});

	const cssRoute = defineRoute('/site.css', { strategy: 'static', depends: () => ['site'] });

	const routes = [
		homeRoute,
		postRoute,
		tagRoute,
		searchRoute,
		authorRoute,
		authorPostsRoute,
		archiveRoute,
		cssRoute
	];

	const store = memoryStore();
	const bundles = memoryBundleStore();
	const spool = spooled
		? createSpool({
				routes,
				datasets: [postRows, authorRows],
				store,
				bundles
			})
		: undefined;

	const html = (body: string) =>
		new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
	const reply = (body: string, status: number) => new Response(body, { status });

	const listing = (rows: Post[], params: URLSearchParams) => {
		const page = Number(params.get('page') ?? 1);
		return {
			posts: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
			query: { total: rows.length, page, pages: Math.ceil(rows.length / PAGE_SIZE) }
		};
	};

	/** the origin answer; a query string it does not use is ignored */
	const page = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);

		if (pathname === '/') {
			if (searchParams.size === 0) {
				return html(
					interpretTemplate(homeRoute.template!, {
						posts: newestFirst().slice(0, PAGE_SIZE)
					})
				);
			}
			return html(
				interpretTemplate(homeRoute.template!, listing(newestFirst(), searchParams))
			);
		}
		if (pathname === '/tags') {
			if (searchParams.size === 0) return html(interpretTemplate(tagRoute.template!, {}));
			const tag = searchParams.get('tag');
			const rows = newestFirst().filter((post) => tag === null || post.tag === tag);
			return html(interpretTemplate(tagRoute.template!, listing(rows, searchParams)));
		}
		if (pathname === '/search') {
			if (searchParams.size === 0) return html(interpretTemplate(searchRoute.template!, {}));
			const q = searchParams.get('q');
			const rows = newestFirst().filter(
				(post) => q === null || post.title.toLowerCase().startsWith(q.toLowerCase())
			);
			return html(interpretTemplate(searchRoute.template!, listing(rows, searchParams)));
		}
		const post = /^\/posts\/(\w+)$/.exec(pathname)?.[1];
		if (post !== undefined) {
			const row = all.find((entry) => entry.id === post);
			return row
				? html(interpretTemplate(postRoute.template!, { params: { id: post }, row }))
				: reply('not found', 404);
		}
		const authorPosts = /^\/authors\/(\w+)\/posts$/.exec(pathname)?.[1];
		if (authorPosts !== undefined) {
			return html(interpretTemplate(authorPostsRoute.template!, byAuthor(authorPosts)));
		}
		const author = /^\/authors\/(\w+)$/.exec(pathname)?.[1];
		if (author !== undefined) {
			const row = AUTHORS.find((entry) => entry.id === author);
			return row
				? html(interpretTemplate(authorRoute.template!, { params: { id: author }, row }))
				: reply('not found', 404);
		}
		const archive = /^\/archive\/(\d{4})\/(\d{2})$/.exec(pathname);
		if (archive) {
			const year = archive[1] ?? '';
			const month = archive[2] ?? '';
			return html(
				interpretTemplate(archiveRoute.template!, {
					year,
					month,
					posts: inMonth(year, month)
				})
			);
		}
		if (pathname === '/site.css') {
			return new Response('body{margin:0}', {
				headers: { 'content-type': 'text/css; charset=utf-8' }
			});
		}
		if (pathname === '/robots.txt') {
			return new Response('User-agent: *\nAllow: /\n', {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}
		return reply('not found', 404);
	};

	/** adds a post and publishes the next pack, which held clients receive as a delta */
	async function addPost(
		fields: Omit<Post, 'id' | 'archive'>
	): Promise<{ version: number; bytes: number }> {
		if (!spool) throw new Error('addPost needs the spool');
		const post: Post = {
			...fields,
			id: postId(all.length + 1),
			archive: archiveOf(fields.date)
		};
		all.push(post);
		cursor += 1;
		log.push({ cursor, key: post.id });
		await spool.invalidate(['posts']);
		return spool.publish(new URL(SITE_URL));
	}

	await store.bump(['posts']);
	const version = spool ? (await spool.publish(new URL(SITE_URL))).version : undefined;

	return { spool, page, addPost, version };
}

type Built = Awaited<ReturnType<typeof blogBuild>>;

/** the blog with its spool and first pack; `spool: false` skips the spool, so `page` is the origin alone */
export function blogSite(options: {
	spool: false;
	docBytes?: number;
}): Promise<Built & { spool: undefined }>;
export function blogSite(options?: {
	spool?: true;
	docBytes?: number;
}): Promise<Built & { spool: Spool; version: number }>;
export function blogSite(options: { spool?: boolean; docBytes?: number } = {}) {
	return blogBuild(options.spool !== false, options.docBytes ?? 0);
}
