import {
	compileTemplate,
	defineWrite,
	escapeHtml,
	interpretTemplate,
	type Plain,
	type Resource
} from '@drupflare/spool/protocol';
import {
	createSpool,
	defineDataset,
	defineResource,
	defineRoute,
	memoryBundleStore,
	routesFromPages,
	type PageLike,
	type Spool
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Member = { id: string; name: string; projects: string[] };
export type Project = { id: string; name: string; open: number; done: number; overdue: number };
export type Task = {
	id: string;
	project: string;
	title: string;
	status: string;
	assignee: string;
	due: string;
	priority: string;
};

export const PROJECTS = [
	{ id: 'site', name: 'Website refresh' },
	{ id: 'app', name: 'Campus app' }
];

export const MEMBERS: Member[] = [
	{ id: 'ada', name: 'Ada Park', projects: ['site', 'app'] },
	{ id: 'bo', name: 'Bo Lin', projects: ['site'] },
	{ id: 'cy', name: 'Cy Ortiz', projects: ['app'] }
];

// overdue counts against today, so the due dates sit far in the past and the future
export const TASKS: Task[] = [
	{
		id: 't1',
		project: 'site',
		title: 'Draft homepage copy',
		status: 'todo',
		assignee: 'ada',
		due: '2001-01-10',
		priority: 'high'
	},
	{
		id: 't2',
		project: 'site',
		title: 'Pick hero image',
		status: 'doing',
		assignee: 'bo',
		due: '2999-11-25',
		priority: 'normal'
	},
	{
		id: 't3',
		project: 'site',
		title: 'Launch checklist',
		status: 'done',
		assignee: 'ada',
		due: '2001-11-01',
		priority: 'normal'
	},
	{
		id: 't4',
		project: 'app',
		title: 'Sign-in screen',
		status: 'todo',
		assignee: 'cy',
		due: '2999-12-01',
		priority: 'normal'
	},
	{
		id: 't5',
		project: 'app',
		title: 'Course import',
		status: 'done',
		assignee: 'cy',
		due: '2001-11-15',
		priority: 'low'
	}
];

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];
const MEMBER_MAX_STALE_MS = 600_000;
const SECRET = 'a long random value kept on the server';

const memberOf = (id: string | null): Member | undefined =>
	MEMBERS.find((member) => member.id === id);
const membersOf = (principal: string | undefined): Member[] =>
	MEMBERS.filter((member) => member.id === principal);
const projectsOf = (principal: string | null): string[] => memberOf(principal)?.projects ?? [];

function principalOf(request: Request): string | null {
	const user = /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
	return memberOf(user) === undefined ? null : user;
}

const NAV =
	'<nav><a href="/">Board</a> <a href="/login">Sign in</a> <a href="/logout">Sign out</a></nav>';
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

const reply = (body: string, status: number) => new Response(body, { status });
const html = (body: string) =>
	new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const isText = (value: unknown, max: number): boolean =>
	typeof value === 'string' && value.trim() !== '' && value.length <= max;

function valid(task: Task): boolean {
	return (
		isText(task.title, 200) &&
		isText(task.project, 50) &&
		isText(task.assignee, 50) &&
		/^\d{4}-\d{2}-\d{2}$/.test(String(task.due)) &&
		STATUSES.includes(task.status) &&
		PRIORITIES.includes(task.priority) &&
		memberOf(task.assignee) !== undefined
	);
}

async function json(request: Request): Promise<Partial<Task> | null> {
	const body: unknown = await request.json().catch(() => null);
	return typeof body === 'object' && body !== null && !Array.isArray(body)
		? (body as Partial<Task>)
		: null;
}

/** the counters of a project, from its tasks; open is every task not done */
function countersOf(project: { id: string; name: string }, tasks: readonly Task[]): Project {
	const mine = tasks.filter((task) => task.project === project.id);
	const open = mine.filter((task) => task.status !== 'done');
	const now = new Date().toISOString().slice(0, 10);
	return {
		id: project.id,
		name: project.name,
		open: open.length,
		done: mine.length - open.length,
		overdue: open.filter((task) => task.due < now).length
	};
}

/** a public dataset whose rows change; `changes` answers from a log of puts and removes */
function table<Row extends Plain & { id: string }>(name: string, rows: readonly Row[]) {
	const current = new Map(rows.map((row) => [row.id, row]));
	const log: Array<{ key: string; deleted: boolean }> = [];
	const dataset = defineDataset<Row>(name, {
		scope: 'public',
		key: (row) => row.id,
		seed: () => [...current.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
		read: (ids) => ids.flatMap((id) => (current.has(id) ? [current.get(id) as Row] : [])),
		changes: (since) => {
			const latest = new Map<string, boolean>();
			for (const entry of log.slice(since)) latest.set(entry.key, entry.deleted);
			const puts = [...latest].filter(([, gone]) => !gone).map(([key]) => key);
			const deletes = [...latest]
				.filter(([, gone]) => gone)
				.map(([key]) => ({ key, cursor: log.length }));
			return { cursor: log.length, puts, deletes };
		},
		horizon: () => 0,
		head: () => ({ cursor: log.length }),
		schema: `${name}-1`,
		maxRows: 1000,
		maxBytes: 1_000_000
	});
	return {
		dataset,
		rows: () => [...current.values()],
		get: (id: string) => current.get(id),
		put(row: Row) {
			current.set(row.id, row);
			log.push({ key: row.id, deleted: false });
		},
		remove(id: string) {
			current.delete(id);
			log.push({ key: id, deleted: true });
		}
	};
}

async function dashboardBuild(spooled: boolean, docBytes: number, pages?: readonly PageLike[]) {
	const shell = shellOf(layoutOf(docBytes));
	// the board pages are origin pages unless a framework registers them: a family route would add
	// a path row per task to the pack
	const taskSource = shell(
		'{{row.title}}',
		'<h1>{{row.title}}</h1><p>{{row.status}}, {{row.priority}}, due {{row.due}}</p><p><a href="/board/projects/{{row.project}}">Project</a> <a href="/">Board</a></p>'
	);
	const projectSource = shell(
		'{{row.name}}',
		'<h1>{{row.name}}</h1><p>{{row.open}} open, {{row.done}} done, {{row.overdue}} overdue</p><p><a href="/">Board</a></p>'
	);
	const boardSource = shell(
		'Board',
		'<h1>Board</h1><ul>{{#each tasks}}<li><a href="/board/tasks/{{id}}">{{title}}</a>, {{status}}, <a href="/board/projects/{{project}}">{{projectName}}</a></li>{{/each}}</ul><p>{{#each projects}}<a href="/board/projects/{{id}}">{{name}}</a> {{/each}}</p>'
	);
	const boardTemplate = compileTemplate({ source: boardSource });
	const taskTemplate = compileTemplate({ source: taskSource });
	const projectTemplate = compileTemplate({ source: projectSource });

	const tasks = table<Task>('tasks', TASKS);
	const projects = table<Project>(
		'projects',
		PROJECTS.map((project) => countersOf(project, TASKS))
	);
	const members = defineDataset<Member>(
		'members',
		{
			scope: 'principal',
			maxStaleMs: MEMBER_MAX_STALE_MS,
			key: (row) => row.id,
			seed: (ctx) => membersOf(ctx.principal?.principal),
			read: (ids, ctx) =>
				membersOf(ctx.principal?.principal).filter((row) => ids.includes(row.id)),
			fields: (viewer, row) =>
				viewer?.principal === row.id ? ['id', 'name', 'projects'] : ['id', 'name'],
			changes: () => ({ cursor: 1, puts: [], deletes: [] }),
			horizon: () => 1,
			head: () => ({ cursor: 1 }),
			schema: 'member-1',
			maxRows: 10,
			maxBytes: 10_000
		},
		{ principalDatasets: true }
	);

	let seq = TASKS.length;

	const base = defineResource('/tasks', { dataset: 'tasks', key: 'id' });
	const families = ['/tasks', '/tasks/:id'];
	const statusWrites = [
		defineWrite('/tasks/:id', {
			method: 'PATCH',
			dataset: 'tasks',
			key: 'id',
			apply: { set: { status: { body: 'status' } } },
			updates: families
		}),
		defineWrite('/tasks/:id/complete', {
			method: 'POST',
			dataset: 'tasks',
			key: 'id',
			apply: { set: { status: 'done' } },
			updates: families
		})
	];
	const resource: Resource = {
		...base,
		writes: [
			...base.writes.filter(
				(write) =>
					!(write.method === 'PATCH' && write.pattern === '/tasks/:id') &&
					!(write.method === 'POST' && write.pattern === '/tasks/:id/:action')
			),
			...statusWrites
		]
	};

	const projectRoute = defineRoute('/projects/:id', {
		strategy: 'data',
		family: { dataset: 'projects', key: 'id' }
	});

	const meRoute = defineRoute('/me', {
		strategy: 'template',
		auth: 'principal',
		family: { dataset: 'members', key: 'viewer.id' },
		template: {
			source: shell(
				'Me',
				'<h1>{{row.name}}</h1><p>{{#each row.projects}}<a href="/board/projects/{{this}}">{{this}}</a> {{/each}}</p>'
			)
		}
	});

	/** the board page is a function of the public tasks and the project names, so a template holds it */
	const boardData = () => ({
		tasks: tasks.rows().map((task) => ({
			...task,
			projectName:
				PROJECTS.find((project) => project.id === task.project)?.name ?? task.project
		})),
		projects: PROJECTS
	});

	// the board pages a framework registers; only the framework knows which pages exist
	const found = pages
		? routesFromPages(pages, {
				'/': {
					strategy: 'template',
					template: { source: boardSource },
					scope: 'public',
					depends: () => ['tasks', 'projects'],
					load: boardData
				},
				'/board/tasks/:id': {
					strategy: 'template',
					template: { source: taskSource },
					scope: 'public',
					family: { dataset: 'tasks', key: 'id' },
					load: (ctx) => tasks.get(ctx.params['id'] ?? '')
				},
				'/board/projects/:id': {
					strategy: 'template',
					template: { source: projectSource },
					scope: 'public',
					family: { dataset: 'projects', key: 'id' },
					load: (ctx) => projects.get(ctx.params['id'] ?? '')
				}
			})
		: undefined;

	/** recounts each project and puts the counter row only when its values changed */
	function refresh(ids: string[]): void {
		for (const id of new Set(ids)) {
			const before = projects.get(id);
			if (!before) continue;
			const after = countersOf(before, tasks.rows());
			if (JSON.stringify(after) !== JSON.stringify(before)) projects.put(after);
		}
	}

	function save(before: Task, next: Task, mine: string[]): Response {
		if (!mine.includes(next.project)) return reply('not a member', 403);
		if (!valid(next)) return reply('bad task', 400);
		tasks.put(next);
		refresh([before.project, next.project]);
		return Response.json(next);
	}

	async function change(request: Request, principal: string | null): Promise<Response> {
		if (principal === null) return reply('sign in', 401);
		const mine = projectsOf(principal);
		const [id, action] = new URL(request.url).pathname.split('/').slice(2);

		if (id === undefined) {
			if (request.method !== 'POST') return reply('not allowed', 405);
			const fields = await json(request);
			if (fields === null) return reply('bad body', 400);
			const task = {
				status: 'todo',
				priority: 'normal',
				assignee: principal,
				...fields,
				id: `t${seq + 1}`
			} as Task;
			if (!mine.includes(task.project)) return reply('not a member', 403);
			if (!valid(task)) return reply('bad task', 400);
			seq += 1;
			tasks.put(task);
			refresh([task.project]);
			return Response.json(task, { status: 201 });
		}

		const current = tasks.get(id);
		if (current === undefined) return reply('not found', 404);
		if (!mine.includes(current.project)) return reply('not a member', 403);

		if (request.method === 'DELETE' && action === undefined) {
			tasks.remove(id);
			refresh([current.project]);
			return new Response(null, { status: 204 });
		}
		if (request.method === 'POST' && action === 'complete') {
			return save(current, { ...current, status: 'done' }, mine);
		}
		if (request.method === 'PATCH' && action === undefined) {
			const fields = await json(request);
			if (fields === null) return reply('bad body', 400);
			return save(current, { ...current, ...fields, id }, mine);
		}
		return reply('not allowed', 405);
	}

	const spool = spooled
		? createSpool({
				routes: [projectRoute, meRoute, ...(found?.routes ?? [])],
				resources: [resource],
				datasets: [tasks.dataset, projects.dataset, members],
				principalDatasets: true,
				store: memoryStore(),
				bundles: memoryBundleStore(),
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
	await spool?.invalidate(['tasks', 'projects']);
	const built = await spool?.publish(new URL('https://site.test/'));

	const page = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		const principal = principalOf(request);

		if (pathname === '/login' && request.method === 'POST') {
			const as = searchParams.get('as') ?? '';
			if (memberOf(as) === undefined) return reply('unknown user', 400);
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
			if (principal === null) {
				const forms = MEMBERS.map(
					(member) =>
						`<form method="post" action="/login?as=${encodeURIComponent(member.id)}"><button>${escapeHtml(member.name)}</button></form>`
				);
				return html(shell('Sign in', `<h1>Sign in</h1>${forms.join('')}`));
			}
			return html(
				shell(
					'Signed in',
					`<h1>${escapeHtml(memberOf(principal)?.name ?? '')}</h1><p><a href="/me">Your projects</a></p>`
				)
			);
		}
		if (pathname === '/') return html(interpretTemplate(boardTemplate, boardData()));
		const taskId = /^\/board\/tasks\/(\w+)$/.exec(pathname)?.[1];
		if (taskId !== undefined) {
			const row = tasks.get(taskId);
			return row
				? html(interpretTemplate(taskTemplate, { params: { id: taskId }, row }))
				: reply('not found', 404);
		}
		const projectId = /^\/board\/projects\/(\w+)$/.exec(pathname)?.[1];
		if (projectId !== undefined) {
			const row = projects.get(projectId);
			return row
				? html(interpretTemplate(projectTemplate, { params: { id: projectId }, row }))
				: reply('not found', 404);
		}
		if (pathname === '/healthz') return new Response('ok');
		if (pathname === '/me') {
			if (principal === null) return reply('sign in', 401);
			return html(
				interpretTemplate(meRoute.template!, {
					row: memberOf(principal) as Member
				})
			);
		}
		if (pathname === '/tasks' || pathname.startsWith('/tasks/')) {
			if (request.method !== 'GET') return change(request, principal);
			const [id] = pathname.split('/').slice(2);
			if (id === undefined) {
				// the shape the held collection answers with: its rows by key, and the query counts
				const rows = tasks.rows().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				return Response.json({
					tasks: rows,
					query: { total: rows.length, page: 1, pages: 1 }
				});
			}
			const row = tasks.get(id);
			return row ? Response.json(row) : reply('not found', 404);
		}
		const project = /^\/projects\/(\w+)$/.exec(pathname)?.[1];
		if (project !== undefined) {
			const row = projects.get(project);
			return row ? Response.json(row) : reply('not found', 404);
		}
		return reply('not found', 404);
	};

	return { spool, page, resource, built, uncovered: found?.uncovered ?? [] };
}

type Built = Awaited<ReturnType<typeof dashboardBuild>>;

/** the board with its spool and pack; `spool: false` skips the spool, so `page` is the origin alone */
export function dashboardSite(options: {
	spool: false;
	docBytes?: number;
}): Promise<Built & { spool: undefined }>;
export function dashboardSite(options?: {
	spool?: true;
	docBytes?: number;
	/** a framework's registrations: the board pages it registered get a family route each */
	pages?: readonly PageLike[];
}): Promise<Built & { spool: Spool; built: NonNullable<Built['built']> }>;
export function dashboardSite(
	options: { spool?: boolean; docBytes?: number; pages?: readonly PageLike[] } = {}
) {
	return dashboardBuild(options.spool !== false, options.docBytes ?? 0, options.pages);
}
