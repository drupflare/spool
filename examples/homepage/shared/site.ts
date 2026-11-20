import {
	escapeHtml,
	interpretTemplate,
	matchRoute,
	setProof,
	type Plain,
	type RouteDeclaration
} from '@drupflare/spool/protocol';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	routesFromPages,
	type PageLike,
	type Spool
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Department = { id: string; name: string };
export type Program = { id: string; name: string; department: string; level: string };
export type Person = { id: string; name: string; department: string; title: string };
export type Article = { slug: string; title: string; published: string };
export type Event = { id: string; title: string; starts: string; place: string };
export type Topic = { slug: string; title: string; body: string };

export const PAGE_SIZE = 10;
export const HOME_ITEMS = 3;

export const NEWS_FRESHNESS = { maxStale: 300, mode: 'soft' } as const;
export const EVENTS_FRESHNESS = { maxStale: 300, mode: 'soft' } as const;
export const PROGRAMS_FRESHNESS = { maxStale: 86_400, mode: 'hard' } as const;
export const ABOUT_FRESHNESS = { maxStale: 86_400, mode: 'hard' } as const;

export const SITE_CSS = 'body{margin:0;font-family:sans-serif}';

const ORIGIN = new URL('https://site.test/');
const pad = (n: number) => String(n).padStart(2, '0');

export const DEPARTMENTS: Department[] = [
	{ id: 'biology', name: 'Biology' },
	{ id: 'chemistry', name: 'Chemistry' },
	{ id: 'history', name: 'History' },
	{ id: 'computing', name: 'Computing' },
	{ id: 'music', name: 'Music' },
	{ id: 'english', name: 'English' }
];

const TRACKS = [
	{ name: 'Major', level: 'undergraduate' },
	{ name: 'Minor', level: 'undergraduate' },
	{ name: 'Certificate', level: 'undergraduate' },
	{ name: 'Master', level: 'graduate' },
	{ name: 'Doctorate', level: 'graduate' }
];

export const PROGRAMS: Program[] = DEPARTMENTS.flatMap((department) =>
	TRACKS.map((track) => ({
		id: `${department.id}-${track.name.toLowerCase()}`,
		name: `${department.name} ${track.name}`,
		department: department.id,
		level: track.level
	}))
);

const FIRST_NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana'];
const LAST_NAMES = ['Park', 'Lin', 'Ortiz', 'Shah', 'Reyes'];

export const PEOPLE: Person[] = Array.from(
	{ length: FIRST_NAMES.length * LAST_NAMES.length },
	(_, i) => {
		const first = FIRST_NAMES[i % FIRST_NAMES.length];
		const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
		const name = `${first} ${last}`;
		return {
			id: name.toLowerCase().replace(' ', '-'),
			name,
			department: (DEPARTMENTS[i % DEPARTMENTS.length] as Department).id,
			title: i % 3 === 0 ? 'Professor' : 'Lecturer'
		};
	}
);

const TOPICS = [
	'Library hours change',
	'Spring open house',
	'Research grant awarded',
	'Shuttle schedule update',
	'Alumni lecture series',
	'New lab opens',
	'Board approves budget',
	'Student award winners'
];

export const ARTICLES: Article[] = Array.from({ length: 40 }, (_, i) => ({
	slug: `story-${pad(i + 1)}`,
	title: `${TOPICS[i % TOPICS.length]} ${i + 1}`,
	published: `2026-${pad(1 + (i % 11))}-${pad(1 + (i % 27))}`
}));

const EVENT_TITLES = [
	'Open house',
	'Guest lecture',
	'Concert',
	'Career fair',
	'Film night',
	'Poster session'
];
const PLACES = ['Main Hall', 'Chapel', 'Science Annex', 'Library Atrium'];

export const EVENTS: Event[] = Array.from({ length: 30 }, (_, i) => ({
	id: `event-${pad(i + 1)}`,
	title: `${EVENT_TITLES[i % EVENT_TITLES.length]} ${i + 1}`,
	starts: `2026-12-${pad(1 + Math.floor(i / 2))}T${i % 2 === 0 ? '09' : '18'}:00`,
	place: PLACES[i % PLACES.length] as string
}));

export const PAGES: Topic[] = [
	{
		slug: 'mission',
		title: 'Mission',
		body: 'Larkspur College teaches small classes in the liberal arts.'
	},
	{ slug: 'history', title: 'History', body: 'The college opened in 1891 on a river bend.' },
	{ slug: 'governance', title: 'Governance', body: 'A board of twelve trustees sets policy.' },
	{
		slug: 'accreditation',
		title: 'Accreditation',
		body: 'The college holds regional accreditation.'
	},
	{
		slug: 'campus-safety',
		title: 'Campus Safety',
		body: 'Report an incident to the duty officer.'
	},
	{ slug: 'contact', title: 'Contact', body: 'Call the main office during business hours.' }
];

const newestFirst = (a: Article, b: Article) =>
	a.published < b.published ? 1 : a.published > b.published ? -1 : 0;
const soonestFirst = (a: Event, b: Event) =>
	a.starts < b.starts ? -1 : a.starts > b.starts ? 1 : 0;

const LATEST_NEWS = [...ARTICLES].sort(newestFirst).slice(0, HOME_ITEMS);
const upcomingOf = (events: ReadonlyMap<string, Event>) =>
	[...events.values()].sort(soonestFirst).slice(0, HOME_ITEMS);

/** a public dataset whose rows do not change, so its cursor stays at 1 */
function fixed<Row extends Plain>(name: string, rows: readonly Row[], key: (row: Row) => string) {
	return defineDataset<Row>(name, {
		scope: 'public',
		key,
		seed: () => rows,
		read: (ids) => rows.filter((row) => ids.includes(key(row))),
		changes: () => ({ cursor: 1, puts: [], deletes: [] }),
		horizon: () => 1,
		head: () => ({ cursor: 1 }),
		schema: `${name}-1`,
		maxRows: 1000,
		maxBytes: 1_000_000
	});
}

const NAV = `<nav><a href="/">Home</a> <a href="/news?page=1">News</a> <a href="/events?page=1">Events</a> <a href="/programs?page=1">Programs</a> <a href="/departments">Departments</a> <a href="/people">People</a></nav>`;
const FOOTER = `<footer><nav>${PAGES.map((page) => `<a href="/about/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a>`).join(' ')}</nav></footer>`;
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

type Shell = (title: string, body: string) => string;

/** the site's route declarations by pattern; the events routes read the live map so an update shows at once */
function declarationsFor(events: Map<string, Event>, shell: Shell) {
	const out: Record<string, RouteDeclaration> = {};
	const NEWS_LIST = shell(
		'News',
		`<h1>News</h1>{{#if query}}<p>{{query.total}} stories, page {{query.page}} of {{query.pages}}</p><ul>{{#each news}}<li><a href="/news/{{slug}}">{{title}}</a></li>{{/each}}</ul>{{else}}<p><a href="/news?page=1">Latest stories</a></p>{{/if}}`
	);
	const HOME = shell(
		'Larkspur College',
		'<h1>Larkspur College</h1><section><h2>Latest news</h2><ul>{{#each news}}<li><a href="/news/{{slug}}">{{title}}</a></li>{{/each}}</ul></section><section><h2>Next events</h2><ul>{{#each events}}<li><a href="/events/{{id}}">{{title}}</a>, {{starts}}</li>{{/each}}</ul></section>'
	);
	const EVENTS_LIST = shell(
		'Events',
		`<h1>Events</h1>{{#if query}}<p>{{query.total}} events, page {{query.page}} of {{query.pages}}</p><ul>{{#each events}}<li><a href="/events/{{id}}">{{title}}</a>, {{starts}}, {{place}}</li>{{/each}}</ul>{{else}}<p><a href="/events?page=1">Upcoming events</a></p>{{/if}}`
	);
	const PROGRAMS_LIST = shell(
		'Programs',
		`<h1>Programs</h1>{{#if query}}<p>{{query.total}} programs, page {{query.page}} of {{query.pages}}</p><ul>{{#each programs}}<li><a href="/programs/{{id}}">{{name}}</a> ({{level}})</li>{{/each}}</ul>{{else}}<p><a href="/programs?page=1">All programs</a></p>{{/if}}`
	);
	out['/'] = {
		strategy: 'template',
		template: { source: HOME },
		depends: () => ['news', 'events'],
		load: () => ({ news: LATEST_NEWS, events: upcomingOf(events) }),
		freshness: NEWS_FRESHNESS,
		scope: 'public'
	};
	out['/news'] = {
		strategy: 'template',
		template: { source: NEWS_LIST },
		depends: () => ['news'],
		load: () => ({}),
		freshness: NEWS_FRESHNESS,
		scope: 'public',
		query: { list: 'news', dataset: 'news', sort: ['-published'], pageSize: PAGE_SIZE }
	};
	out['/news/:slug'] = {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p>{{row.published}}</p><p><a href="/news?page=1">All news</a></p>'
			)
		},
		scope: 'public',
		family: { dataset: 'news', key: 'slug' },
		freshness: NEWS_FRESHNESS,
		load: (ctx) => ARTICLES.find((row) => row.slug === ctx.params['slug'])
	};
	out['/events'] = {
		strategy: 'template',
		template: { source: EVENTS_LIST },
		depends: () => ['events'],
		load: () => ({}),
		freshness: EVENTS_FRESHNESS,
		scope: 'public',
		query: { list: 'events', dataset: 'events', sort: ['starts'], pageSize: PAGE_SIZE }
	};
	out['/events/:id'] = {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p>{{row.starts}}, {{row.place}}</p><p><a href="/events?page=1">All events</a></p>'
			)
		},
		scope: 'public',
		family: { dataset: 'events', key: 'id' },
		freshness: EVENTS_FRESHNESS,
		load: (ctx) => events.get(ctx.params['id'] ?? '')
	};
	out['/departments'] = {
		strategy: 'template',
		template: {
			source: shell(
				'Departments',
				'<h1>Departments</h1><ul>{{#each departments}}<li><a href="/departments/{{id}}">{{name}}</a></li>{{/each}}</ul>'
			)
		},
		depends: () => ['departments'],
		load: () => ({ departments: DEPARTMENTS })
	};
	out['/departments/:id'] = {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p><a href="/departments">All departments</a> <a href="/programs?department={{row.id}}">Programs in {{row.name}}</a></p>'
			)
		},
		scope: 'public',
		family: { dataset: 'departments', key: 'id' },
		load: (ctx) => DEPARTMENTS.find((row) => row.id === ctx.params['id'])
	};
	out['/programs'] = {
		strategy: 'template',
		template: { source: PROGRAMS_LIST },
		depends: () => ['programs'],
		load: () => ({}),
		freshness: PROGRAMS_FRESHNESS,
		scope: 'public',
		query: {
			list: 'programs',
			dataset: 'programs',
			filter: { department: 'string', level: 'string' },
			sort: ['name'],
			pageSize: PAGE_SIZE
		}
	};
	out['/programs/:id'] = {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p>{{row.level}}</p><p><a href="/programs?page=1">All programs</a> <a href="/departments/{{row.department}}">Department</a></p>'
			)
		},
		scope: 'public',
		family: { dataset: 'programs', key: 'id' },
		freshness: PROGRAMS_FRESHNESS,
		load: (ctx) => PROGRAMS.find((row) => row.id === ctx.params['id'])
	};
	out['/people'] = {
		strategy: 'template',
		template: {
			source: shell(
				'People',
				'<h1>People</h1><ul>{{#each people}}<li><a href="/people/{{id}}">{{name}}</a>, {{title}}</li>{{/each}}</ul>'
			)
		},
		depends: () => ['people'],
		load: () => ({ people: PEOPLE })
	};
	out['/people/:id'] = {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p>{{row.title}}</p><p><a href="/people">All people</a> <a href="/departments/{{row.department}}">Department</a></p>'
			)
		},
		scope: 'public',
		family: { dataset: 'people', key: 'id' },
		load: (ctx) => PEOPLE.find((row) => row.id === ctx.params['id'])
	};
	out['/about/:slug'] = {
		strategy: 'template',
		template: {
			source: shell('{{row.title}}', '<h1>{{row.title}}</h1><p>{{row.body}}</p>')
		},
		freshness: ABOUT_FRESHNESS,
		load: (ctx) => ({ row: PAGES.find((row) => row.slug === ctx.params['slug']) ?? null })
	};
	out['/site.css'] = { strategy: 'static', depends: () => ['site'] };
	return out;
}

/** the list of matching rows for a query string, in the order the device would give it */
export function listed<Row extends object>(
	rows: readonly Row[],
	key: (row: Row) => string,
	params: URLSearchParams,
	filters: readonly (keyof Row & string)[],
	sorts: readonly (keyof Row & string)[]
): { items: Row[]; query: { total: number; page: number; pages: number } } | null {
	let matching = [...rows]
		.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
		.filter((row) =>
			filters.every((name) => !params.has(name) || String(row[name]) === params.get(name))
		);
	const sort = params.get('sort');
	if (sort !== null) {
		const field = sort.replace(/^-/, '') as keyof Row & string;
		if (!sorts.includes(field)) return null;
		const direction = sort.startsWith('-') ? -1 : 1;
		matching = matching.sort((a, b) => {
			const x = String(a[field]);
			const y = String(b[field]);
			return direction * (x < y ? -1 : x > y ? 1 : 0);
		});
	}
	const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
	const page = Number(params.get('page') ?? 1);
	if (!Number.isInteger(page) || page < 1 || page > pages) return null;
	const items = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	return { items, query: { total: matching.length, page, pages } };
}

const byId = <Row extends { id: string }>(rows: readonly Row[], id: string) =>
	rows.find((row) => row.id === id) ?? null;

/**
 * The JSON a page reads for a path under `/api`; null is a 404. The Nuxt example's `/api/**` route
 * and the `data` routes below both stand on this one function, so the origin and the held row
 * cannot disagree.
 */
export function apiBody(
	path: string,
	params: URLSearchParams,
	events: ReadonlyMap<string, Event>
): object | null {
	const [section = '', id] = path.split('/');
	switch (section) {
		case 'home':
			return { news: LATEST_NEWS, events: upcomingOf(events) };
		case 'news':
			if (id === undefined)
				return listed(ARTICLES, (row) => row.slug, params, [], ['published']);
			return ARTICLES.find((row) => row.slug === id) ?? null;
		case 'events':
			if (id === undefined) {
				return listed([...events.values()], (row) => row.id, params, [], ['starts']);
			}
			return events.get(id) ?? null;
		case 'departments':
			return id === undefined ? { items: DEPARTMENTS } : byId(DEPARTMENTS, id);
		case 'programs':
			if (id === undefined) {
				return listed(PROGRAMS, (row) => row.id, params, ['department', 'level'], ['name']);
			}
			return byId(PROGRAMS, id);
		case 'people':
			return id === undefined ? { items: PEOPLE } : byId(PEOPLE, id);
		case 'about':
			if (id === undefined) return { items: PAGES };
			return PAGES.find((row) => row.slug === id) ?? null;
		default:
			return null;
	}
}

// a list read holds no body of its own, so the default priors weigh its artifact against itself
const LIST_READS = { reuse: 0.8, futureViews: 6 };

/** the `data` routes over the JSON a framework app reads from `/api/news` and `/api/events` */
function apiDeclarations(): Record<string, RouteDeclaration> {
	return {
		'/api/news': {
			strategy: 'data',
			scope: 'public',
			depends: () => ['news'],
			load: () => ({}),
			freshness: NEWS_FRESHNESS,
			provision: LIST_READS,
			query: { list: 'items', dataset: 'news', sort: ['published'], pageSize: PAGE_SIZE }
		},
		'/api/news/:slug': {
			strategy: 'data',
			scope: 'public',
			family: { dataset: 'news', key: 'slug' },
			freshness: NEWS_FRESHNESS
		},
		'/api/events': {
			strategy: 'data',
			scope: 'public',
			depends: () => ['events'],
			load: () => ({}),
			freshness: EVENTS_FRESHNESS,
			provision: LIST_READS,
			query: { list: 'items', dataset: 'events', sort: ['starts'], pageSize: PAGE_SIZE }
		},
		'/api/events/:id': {
			strategy: 'data',
			scope: 'public',
			family: { dataset: 'events', key: 'id' },
			freshness: EVENTS_FRESHNESS
		}
	};
}

const html = (body: string) =>
	new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const reply = (body: string, status: number) => new Response(body, { status });

async function homepageBuild(
	spooled: boolean,
	docBytes: number,
	pages?: readonly PageLike[],
	api = false
) {
	const shell = shellOf(layoutOf(docBytes));
	const events = new Map(EVENTS.map((row) => [row.id, { ...row }]));
	let eventsCursor = 0;
	const eventLog: Array<{ cursor: number; key: string }> = [];

	const eventsDataset = defineDataset<Event>('events', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => [...events.values()],
		read: (ids) =>
			ids.flatMap((id) => {
				const row = events.get(id);
				return row ? [row] : [];
			}),
		changes: async (since) => {
			if (since > eventsCursor) return 'reset';
			const keys = new Set(
				eventLog.filter((entry) => entry.cursor > since).map((entry) => entry.key)
			);
			return {
				cursor: eventsCursor,
				puts: [...keys],
				deletes: [],
				proof: await setProof(events)
			};
		},
		horizon: () => 0,
		head: async () => ({ cursor: eventsCursor, proof: await setProof(events) }),
		schema: 'events-1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});

	const datasets = [
		fixed('departments', DEPARTMENTS, (row) => row.id),
		fixed('programs', PROGRAMS, (row) => row.id),
		fixed('people', PEOPLE, (row) => row.id),
		fixed('news', ARTICLES, (row) => row.slug),
		eventsDataset
	];
	const declared = declarationsFor(events, shell);
	// with a framework's pages the route list is the framework's table; the stylesheet is no page
	const { '/site.css': css, ...held } = declared;
	const found = pages ? routesFromPages(pages, held) : undefined;
	// the data routes are no pages, so they sit beside the helper's routes like the stylesheet
	const reads = Object.entries(api ? apiDeclarations() : {}).map(([pattern, declaration]) =>
		defineRoute(pattern, declaration)
	);
	const routes = found
		? [...found.routes, defineRoute('/site.css', css as RouteDeclaration), ...reads]
		: [
				...Object.entries(declared).map(([pattern, declaration]) =>
					defineRoute(pattern, declaration)
				),
				...reads
			];
	const store = memoryStore();
	const spool = spooled
		? createSpool({ routes, datasets, store, bundles: memoryBundleStore() })
		: undefined;
	await spool?.invalidate(['departments', 'events', 'news', 'people', 'programs']);
	await spool?.publish(ORIGIN);

	/** changes one event row, then republishes the pack; returns the new version */
	async function updateEvent(id: string, patch: Partial<Omit<Event, 'id'>>) {
		if (!spool) throw new Error('updateEvent needs the spool');
		const row = events.get(id);
		if (!row) throw new Error(`no event ${id}`);
		events.set(id, { ...row, ...patch });
		eventsCursor += 1;
		eventLog.push({ cursor: eventsCursor, key: id });
		await spool.invalidate(['events']);
		return spool.publish(ORIGIN);
	}

	const page = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/robots.txt') {
			return new Response('User-agent: *\nAllow: /', {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}
		if (api && url.pathname.startsWith('/api/')) {
			const body = apiBody(url.pathname.slice('/api/'.length), url.searchParams, events);
			return body === null ? reply('not found', 404) : Response.json(body);
		}
		const hit = matchRoute(routes, url.pathname);
		if (!hit) return reply('not found', 404);
		const { route, params } = hit;
		const plain = url.search === '';
		const template = (data: unknown) => html(interpretTemplate(route.template!, data));
		const eventList = [...events.values()];

		switch (route.pattern) {
			case '/':
				return template({ news: LATEST_NEWS, events: upcomingOf(events) });
			case '/news': {
				if (plain) return template({});
				const listing = listed(
					ARTICLES,
					(row) => row.slug,
					url.searchParams,
					[],
					['published']
				);
				return listing
					? template({ news: listing.items, query: listing.query })
					: reply('not found', 404);
			}
			case '/news/:slug': {
				const row = ARTICLES.find((entry) => entry.slug === params['slug']);
				return row ? template({ params, row }) : reply('not found', 404);
			}
			case '/events': {
				if (plain) return template({});
				const listing = listed(
					eventList,
					(row) => row.id,
					url.searchParams,
					[],
					['starts']
				);
				return listing
					? template({ events: listing.items, query: listing.query })
					: reply('not found', 404);
			}
			case '/events/:id': {
				const row = events.get(params['id'] ?? '');
				return row ? template({ params, row }) : reply('not found', 404);
			}
			case '/departments':
				return template({ departments: DEPARTMENTS });
			case '/departments/:id': {
				const row = DEPARTMENTS.find((entry) => entry.id === params['id']);
				return row ? template({ params, row }) : reply('not found', 404);
			}
			case '/programs': {
				if (plain) return template({});
				const listing = listed(
					PROGRAMS,
					(row) => row.id,
					url.searchParams,
					['department', 'level'],
					['name']
				);
				return listing
					? template({ programs: listing.items, query: listing.query })
					: reply('not found', 404);
			}
			case '/programs/:id': {
				const row = PROGRAMS.find((entry) => entry.id === params['id']);
				return row ? template({ params, row }) : reply('not found', 404);
			}
			case '/people':
				return template({ people: PEOPLE });
			case '/people/:id': {
				const row = PEOPLE.find((entry) => entry.id === params['id']);
				return row ? template({ params, row }) : reply('not found', 404);
			}
			case '/about/:slug': {
				const row = PAGES.find((entry) => entry.slug === params['slug']);
				return row ? template({ row }) : reply('not found', 404);
			}
			case '/site.css':
				return new Response(SITE_CSS, {
					headers: { 'content-type': 'text/css; charset=utf-8' }
				});
			default:
				return reply('not found', 404);
		}
	};

	return { spool, page, updateEvent, uncovered: found?.uncovered ?? [] };
}

type Built = Awaited<ReturnType<typeof homepageBuild>>;

/** the homepage with its spool and public pack; `spool: false` skips the spool, so `page` is the origin alone */
export function homepageSite(options: {
	spool: false;
	docBytes?: number;
}): Promise<Built & { spool: undefined }>;
export function homepageSite(options?: {
	spool?: true;
	docBytes?: number;
	/** a framework's registrations: the routes are then the ones it registered, declared here */
	pages?: readonly PageLike[];
	/** serve the JSON a framework app reads under `/api` and hold it as `data` routes */
	api?: boolean;
}): Promise<Built & { spool: Spool }>;
export function homepageSite(
	options: { spool?: boolean; docBytes?: number; pages?: readonly PageLike[]; api?: boolean } = {}
) {
	return homepageBuild(
		options.spool !== false,
		options.docBytes ?? 0,
		options.pages,
		options.api === true
	);
}
