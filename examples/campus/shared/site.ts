import { escapeHtml, interpretTemplate, type Plain } from '@drupflare/spool/protocol';
import {
	buildBundle,
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	type Spool
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Course = { id: string; title: string; department: string };
export type Person = { id: string; name: string };
export type Article = { slug: string; year: string; title: string };
export type Profile = {
	id: string;
	name: string;
	courses: string[];
	classmates: Array<{ id: string; name: string }>;
};

export const COURSES: Course[] = [
	{ id: '101', title: 'Intro to Drupal', department: 'web' },
	{ id: '102', title: 'Content Modeling', department: 'web' },
	{ id: '103', title: 'Theming', department: 'web' },
	{ id: '201', title: 'Statistics', department: 'math' },
	{ id: '202', title: 'Linear Algebra', department: 'math' }
];

export const PEOPLE: Person[] = [
	{ id: 'ada', name: 'Ada Park' },
	{ id: 'bo', name: 'Bo Lin' },
	{ id: 'cy', name: 'Cy Ortiz' },
	{ id: 'dee', name: 'Dee Shah' }
];

export const ARTICLES: Article[] = [
	{ slug: 'pack-release', year: '2026', title: 'Pack release' },
	{ slug: 'ring-budget', year: '2026', title: 'The ring budget' }
];

export const NEWS_FRESHNESS = { maxStale: 3600, mode: 'soft' } as const;

export const PAGE_SIZE = 2;
const PROFILE_MAX_STALE_MS = 600_000;
const SECRET = 'a long random value kept on the server';

/** the course each person is in; a signed-in person sees the people who share one */
const ENROLMENTS: Record<string, string[]> = {
	ada: ['101', '102'],
	bo: ['103'],
	cy: ['101'],
	dee: ['103']
};

const TEAMS = new Map([
	['web', ['ada', 'bo']],
	['math', ['cy', 'dee']]
]);

const nameOf = (id: string): string => PEOPLE.find((person) => person.id === id)?.name ?? '';

function principalOf(request: Request): string | null {
	const user = /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1];
	return user !== undefined && Object.hasOwn(ENROLMENTS, user) ? user : null;
}

function profileOf(id: string): Profile {
	return { id, name: nameOf(id), courses: ENROLMENTS[id] ?? [], classmates: classmatesOf(id) };
}

/** the other people who share a course with `id` */
function classmatesOf(id: string): Array<{ id: string; name: string }> {
	const mine = ENROLMENTS[id] ?? [];
	return Object.keys(ENROLMENTS)
		.sort()
		.filter((other) => other !== id && (ENROLMENTS[other] ?? []).some((c) => mine.includes(c)))
		.map((other) => ({ id: other, name: nameOf(other) }));
}

/** the profiles a principal may see: their own and those of people who share a course */
function profilesOf(principal: string | null | undefined): Profile[] {
	if (!principal || !Object.hasOwn(ENROLMENTS, principal)) return [];
	const mine = ENROLMENTS[principal] ?? [];
	return Object.keys(ENROLMENTS)
		.sort()
		.filter((id) => (ENROLMENTS[id] ?? []).some((course) => mine.includes(course)))
		.map(profileOf);
}

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

const courses = fixed('courses', COURSES, (row) => row.id);
const people = fixed('people', PEOPLE, (row) => row.id);
const news = fixed('news', ARTICLES, (row) => row.slug);

const profiles = defineDataset<Profile>(
	'profiles',
	{
		scope: 'principal',
		maxStaleMs: PROFILE_MAX_STALE_MS,
		key: (row) => row.id,
		seed: (ctx) => profilesOf(ctx.principal?.principal),
		read: (ids, ctx) =>
			profilesOf(ctx.principal?.principal).filter((row) => ids.includes(row.id)),
		changes: () => ({ cursor: 1, puts: [], deletes: [] }),
		horizon: () => 1,
		head: () => ({ cursor: 1 }),
		schema: 'profile-1',
		maxRows: 100,
		maxBytes: 100_000
	},
	{ principalDatasets: true }
);

const NAV =
	'<nav><a href="/">Home</a> <a href="/courses">Courses</a> <a href="/catalogue">Catalogue</a> <a href="/people">People</a> <a href="/news">News</a> <a href="/login">Sign in</a> <a href="/logout">Sign out</a></nav>';
const shellOf = (layout: string) => (title: string, body: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body>${NAV}<main data-spool-swap>${body}</main>${layout}</body></html>`;

/** filler letters for the padding hook; a multiplicative hash keeps them near random for gzip */
const filler = (length: number): string =>
	Array.from({ length }, (_, i) =>
		String.fromCharCode(97 + ((Math.imul(i, 2654435761) >>> 24) % 26))
	).join('');

/** a hidden block of `bytes` bytes in the page layout; none when 0, which is the default */
const layoutOf = (bytes: number): string =>
	bytes === 0 ? '' : `<div hidden>${filler(bytes - 18)}</div>`;

const teamRoute = defineRoute('/teams/:team', {
	strategy: 'projection',
	depends: (ctx) => [`team:${ctx.params['team'] ?? ''}`],
	load: (ctx) => ({
		team: ctx.params['team'],
		names: (TEAMS.get(ctx.params['team'] ?? '') ?? []).map(nameOf)
	}),
	provision: { reuse: 0.8, futureViews: 6 }
});

const courseJsonRoute = defineRoute('/api/courses/:id', {
	strategy: 'data',
	family: { dataset: 'courses', key: 'id' },
	load: (ctx) => COURSES.find((row) => row.id === ctx.params['id']),
	provision: { reuse: 0.8, futureViews: 6 }
});

const cssRoute = defineRoute('/site.css', { strategy: 'static', depends: () => ['site'] });

const html = (body: string) =>
	new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const reply = (body: string, status: number) => new Response(body, { status });

const byTitle = (a: Course, b: Course) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);

async function campusBuild(spooled: boolean, docBytes: number) {
	const shell = shellOf(layoutOf(docBytes));
	const CATALOGUE_SOURCE = shell(
		'Catalogue',
		'<h1>Catalogue</h1>{{#if query}}<p>{{query.total}} courses, page {{query.page}} of {{query.pages}}</p><ul>{{#each courses}}<li><a href="/courses/{{id}}">{{title}}</a></li>{{/each}}</ul>{{else}}<p>Add a department to the address.</p><p><a href="/catalogue?department=web">Web courses</a> <a href="/catalogue?department=math">Math courses</a></p><p><a href="/teams/web">Web team</a> <a href="/teams/math">Math team</a></p>{{/if}}'
	);

	const coursesRoute = defineRoute('/courses', {
		strategy: 'template',
		template: {
			source: shell(
				'Courses',
				'<ul>{{#each courses}}<li><a href="/courses/{{id}}">{{title}}</a></li>{{/each}}</ul>'
			)
		},
		depends: () => ['courses'],
		load: () => ({ courses: COURSES })
	});

	const courseRoute = defineRoute('/courses/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p><a href="/courses">All courses</a> <a href="/catalogue?department={{row.department}}">More {{row.department}} courses</a></p>'
			)
		},
		family: { dataset: 'courses', key: 'id' },
		load: (ctx) => COURSES.find((row) => row.id === ctx.params['id'])
	});

	const catalogueRoute = defineRoute('/catalogue', {
		strategy: 'template',
		template: { source: CATALOGUE_SOURCE },
		depends: () => ['courses'],
		load: () => ({}),
		query: {
			list: 'courses',
			dataset: 'courses',
			filter: { department: 'string' },
			sort: ['title'],
			pageSize: PAGE_SIZE
		}
	});

	const personRoute = defineRoute('/people/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p><a href="/people">All people</a></p>'
			)
		},
		family: { dataset: 'people', key: 'id' },
		load: (ctx) => PEOPLE.find((row) => row.id === ctx.params['id'])
	});

	const articleRoute = defineRoute('/news/:year/:slug', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p><a href="/news">All news</a></p>'
			)
		},
		family: { dataset: 'news', key: 'slug' },
		freshness: NEWS_FRESHNESS,
		load: (ctx) =>
			ARTICLES.find(
				(row) => row.slug === ctx.params['slug'] && row.year === ctx.params['year']
			)
	});

	const accountRoute = defineRoute('/account', {
		strategy: 'template',
		scope: 'principal',
		retention: 'persistent',
		template: {
			source: shell(
				'Account',
				'<h1>{{me.name}}</h1><p>{{#each me.courses}}<span>{{this}}</span>{{/each}}</p><p>{{#each me.classmates}}<a href="/classmates/{{id}}">{{name}}</a> {{/each}}</p>'
			)
		},
		depends: (ctx) => [`account:${ctx.identity?.principal ?? ''}`],
		load: (ctx) => ({ me: ctx.row('profiles', ctx.identity?.principal ?? '') })
	});

	const classmateRoute = defineRoute('/classmates/:id', {
		strategy: 'template',
		scope: 'principal',
		retention: 'persistent',
		template: {
			source: shell(
				'{{row.name}}',
				'<h1>{{row.name}}</h1><p>{{#each row.courses}}<span>{{this}}</span>{{/each}}</p><p><a href="/account">Your account</a></p>'
			)
		},
		depends: (ctx) => [`classmates:${ctx.identity?.principal ?? ''}`],
		load: (ctx) => {
			const id = ctx.params['id'] ?? '';
			const visible = profilesOf(ctx.identity?.principal).some((row) => row.id === id);
			return { row: visible ? ctx.row('profiles', id) : null };
		}
	});

	const routes = [
		coursesRoute,
		courseRoute,
		catalogueRoute,
		personRoute,
		articleRoute,
		teamRoute,
		courseJsonRoute,
		cssRoute,
		accountRoute,
		classmateRoute
	];

	const datasets = [courses, people, news, profiles];
	const store = memoryStore();
	await store.bump(['courses', 'people', 'news']);
	const bundles = memoryBundleStore();
	if (spooled) {
		await buildBundle({
			store: bundles,
			datasets,
			routes,
			version: await store.cursor(),
			url: new URL('https://site.test/')
		});
	}

	const spool = spooled
		? createSpool({
				routes,
				datasets,
				principalDatasets: true,
				store,
				bundles,
				identity: {
					secret: SECRET,
					resolve: (request) => {
						const principal = principalOf(request);
						return principal === null ? null : { principal };
					}
				},
				logout: ['/logout']
			})
		: undefined;

	const page = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		const me = principalOf(request);

		if (pathname === '/login' && request.method === 'POST') {
			const as = searchParams.get('as') ?? '';
			if (!Object.hasOwn(ENROLMENTS, as)) return reply('unknown user', 400);
			return new Response('Signed in', {
				headers: {
					'set-cookie': `user=${as}; Path=/`,
					...(spool ? { 'spool-partition': await spool.partition(as) } : {})
				}
			});
		}
		if (pathname === '/logout') {
			return new Response(shell('Signed out', '<h1>Signed out</h1>'), {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'set-cookie': 'user=; Max-Age=0; Path=/',
					'spool-clear': '*'
				}
			});
		}
		if (pathname === '/login' && request.method === 'GET') {
			if (me !== null) {
				return html(
					shell(
						'Signed in',
						`<h1>${escapeHtml(nameOf(me))}</h1><p><a href="/account">Your account</a></p>`
					)
				);
			}
			const forms = Object.keys(ENROLMENTS)
				.sort()
				.map(
					(id) =>
						`<form method="post" action="/login?as=${encodeURIComponent(id)}"><button>${escapeHtml(nameOf(id))}</button></form>`
				);
			return html(shell('Sign in', `<h1>Sign in</h1>${forms.join('')}`));
		}
		if (pathname === '/') {
			return html(
				shell(
					'Campus',
					'<h1>Campus</h1><p><a href="/courses">Courses</a>, <a href="/catalogue">catalogue</a>, <a href="/people">people</a> and <a href="/news">news</a></p>'
				)
			);
		}
		if (pathname === '/people') {
			const items = PEOPLE.map(
				(person) =>
					`<li><a href="/people/${encodeURIComponent(person.id)}">${escapeHtml(person.name)}</a></li>`
			);
			return html(shell('People', `<h1>People</h1><ul>${items.join('')}</ul>`));
		}
		if (pathname === '/news') {
			const items = ARTICLES.map(
				(article) =>
					`<li><a href="/news/${encodeURIComponent(article.year)}/${encodeURIComponent(article.slug)}">${escapeHtml(article.title)}</a></li>`
			);
			return html(shell('News', `<h1>News</h1><ul>${items.join('')}</ul>`));
		}
		if (pathname === '/account') {
			if (me === null) return reply('sign in', 401);
			return html(interpretTemplate(accountRoute.template!, { me: profileOf(me) }));
		}
		const classmate = /^\/classmates\/(\w+)$/.exec(pathname)?.[1];
		if (classmate !== undefined) {
			if (me === null) return reply('sign in', 401);
			const row = profilesOf(me).find((profile) => profile.id === classmate);
			return row
				? html(interpretTemplate(classmateRoute.template!, { row }))
				: reply('not found', 404);
		}

		if (pathname === '/courses') {
			return html(interpretTemplate(coursesRoute.template!, { courses: COURSES }));
		}
		if (pathname === '/catalogue') {
			if (searchParams.size === 0)
				return html(interpretTemplate(catalogueRoute.template!, {}));
			const department = searchParams.get('department');
			const rows = COURSES.filter(
				(course) => department === null || course.department === department
			);
			if (searchParams.get('sort') === 'title') rows.sort(byTitle);
			const current = Number(searchParams.get('page') ?? 1);
			const items = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
			const query = {
				total: rows.length,
				page: current,
				pages: Math.ceil(rows.length / PAGE_SIZE)
			};
			return html(interpretTemplate(catalogueRoute.template!, { courses: items, query }));
		}
		const id = /^\/courses\/(\w+)$/.exec(pathname)?.[1];
		if (id !== undefined) {
			const row = COURSES.find((course) => course.id === id);
			return row
				? html(interpretTemplate(courseRoute.template!, { params: { id }, row }))
				: reply('not found', 404);
		}
		const person = /^\/people\/(\w+)$/.exec(pathname)?.[1];
		if (person !== undefined) {
			const row = PEOPLE.find((entry) => entry.id === person);
			return row
				? html(interpretTemplate(personRoute.template!, { params: { id: person }, row }))
				: reply('not found', 404);
		}
		const article = /^\/news\/(\d{4})\/([\w-]+)$/.exec(pathname);
		if (article) {
			const year = article[1] ?? '';
			const slug = article[2] ?? '';
			const row = ARTICLES.find((entry) => entry.year === year && entry.slug === slug);
			return row
				? html(interpretTemplate(articleRoute.template!, { params: { year, slug }, row }))
				: reply('not found', 404);
		}
		const team = /^\/teams\/(\w+)$/.exec(pathname)?.[1];
		if (team !== undefined) {
			const items = (TEAMS.get(team) ?? []).map(
				(member) => `<li>${escapeHtml(nameOf(member))}</li>`
			);
			return html(shell('Team', `<ul>${items.join('')}</ul>`));
		}
		const json = /^\/api\/courses\/(\w+)$/.exec(pathname)?.[1];
		if (json !== undefined) {
			const row = COURSES.find((course) => course.id === json);
			return row ? Response.json(row) : reply('not found', 404);
		}
		if (pathname === '/site.css') {
			return new Response('body{margin:0}', {
				headers: { 'content-type': 'text/css; charset=utf-8' }
			});
		}
		return reply('not found', 404);
	};

	return { spool, page };
}

type Built = Awaited<ReturnType<typeof campusBuild>>;

/** the campus site with its spool and public pack; `spool: false` skips the spool, so `page` is the origin alone */
export function campusSite(options: {
	spool: false;
	docBytes?: number;
}): Promise<Built & { spool: undefined }>;
export function campusSite(options?: {
	spool?: true;
	docBytes?: number;
}): Promise<Built & { spool: Spool }>;
export function campusSite(options: { spool?: boolean; docBytes?: number } = {}) {
	return campusBuild(options.spool !== false, options.docBytes ?? 0);
}
