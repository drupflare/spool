import {
	defineRoute,
	type Freshness,
	type Route,
	type RouteContext
} from '../../src/protocol/index';

/** the data behind the campus fixture; change a field, then invalidate the tag it feeds */
export type CampusData = {
	site: string;
	courses: Record<string, string>;
	teachers: Record<string, string>;
	taught: Record<string, string[]>;
};

const NAV = '<nav>{{#each menu}}<a>{{this}}</a>{{/each}}</nav>';
const page = (body: string) => `<html><head></head><body>${body}${NAV}</body></html>`;

/**
 * Three routes over shared data: a course page, a teacher page and the department page. Every page
 * shows the `menu` projection, which reads `site:name` and every course; teacher and department
 * pages share the `roster:<teacher>` projections.
 */
export function campus(
	options: { sync?: 'background' | 'deferred'; freshness?: Partial<Freshness> } = {}
): {
	db: CampusData;
	routes: Route[];
	/** the network render of a path, written out by hand rather than derived from the routes */
	html(path: string): string | undefined;
} {
	const db: CampusData = {
		site: 'Spool U',
		courses: { '101': 'Intro', '102': 'Advanced' },
		teachers: { ada: 'Ada', bo: 'Bo' },
		taught: { ada: ['101'], bo: ['102'] }
	};
	const menu = (ctx: RouteContext) =>
		ctx.projection('menu', [
			ctx.record('site:name', db.site),
			...Object.keys(db.courses)
				.sort()
				.map((id) => ctx.record(`course:${id}`, db.courses[id]))
		]);
	const roster = (ctx: RouteContext, teacher: string) =>
		ctx.projection(
			`roster:${teacher}`,
			(db.taught[teacher] ?? []).map((id) => ctx.record(`course:${id}`, db.courses[id]))
		);

	const routes = [
		defineRoute('/c/:id', {
			strategy: 'template',
			sync: options.sync,
			freshness: options.freshness,
			template: { source: page('<h1>{{title}}</h1>') },
			load: (ctx) => ({
				title: ctx.record(
					`course:${ctx.params['id']}`,
					db.courses[ctx.params['id'] as string]
				),
				menu: menu(ctx)
			})
		}),
		defineRoute('/t/:id', {
			strategy: 'template',
			sync: options.sync,
			freshness: options.freshness,
			template: {
				source: page('<h1>{{name}}</h1><ul>{{#each roster}}<li>{{this}}</li>{{/each}}</ul>')
			},
			load: (ctx) => ({
				name: ctx.record(
					`teacher:${ctx.params['id']}`,
					db.teachers[ctx.params['id'] as string]
				),
				roster: roster(ctx, ctx.params['id'] as string),
				menu: menu(ctx)
			})
		}),
		defineRoute('/d', {
			strategy: 'template',
			sync: options.sync,
			freshness: options.freshness,
			template: {
				source: page(
					'<h1>{{site}}</h1><ul>{{#each ada}}<li>{{this}}</li>{{/each}}{{#each bo}}<li>{{this}}</li>{{/each}}</ul>'
				)
			},
			load: (ctx) => ({
				site: ctx.record('site:name', db.site),
				ada: roster(ctx, 'ada'),
				bo: roster(ctx, 'bo'),
				menu: menu(ctx)
			})
		}),
		defineRoute('/about', {
			strategy: 'template',
			template: { source: '<html><head></head><body><h1>{{title}}</h1></body></html>' },
			sync: options.sync,
			freshness: options.freshness,
			load: () => ({ title: 'About' })
		})
	];

	const nav = () =>
		`<nav>${[
			db.site,
			...Object.keys(db.courses)
				.sort()
				.map((id) => db.courses[id])
		]
			.map((t) => `<a>${t}</a>`)
			.join('')}</nav>`;
	const list = (teacher: string) =>
		(db.taught[teacher] ?? []).map((id) => `<li>${db.courses[id]}</li>`).join('');
	const wrap = (body: string) => `<html><head></head><body>${body}${nav()}</body></html>`;

	return {
		db,
		routes,
		html(path) {
			const [, kind, id = ''] = path.split('/');
			if (kind === 'c' && db.courses[id] !== undefined) {
				return wrap(`<h1>${db.courses[id]}</h1>`);
			}
			if (kind === 't' && db.teachers[id] !== undefined) {
				return wrap(`<h1>${db.teachers[id]}</h1><ul>${list(id)}</ul>`);
			}
			if (path === '/d')
				return wrap(`<h1>${db.site}</h1><ul>${list('ada')}${list('bo')}</ul>`);
			if (path === '/about') return '<html><head></head><body><h1>About</h1></body></html>';
			return undefined;
		}
	};
}
