import { interpretTemplate } from '@drupflare/spool/protocol';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	type Spool
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Course = { id: string; title: string };

const titles = ['Intro to Drupal', 'Content Modeling', 'Theming'];

/** the course rows; ids start at 101, and the first three have fixed titles */
export function courses(count = 3): Course[] {
	return Array.from({ length: count }, (_, i) => ({
		id: String(101 + i),
		title: titles[i] ?? `Course ${101 + i}`
	}));
}

const NAV = '<nav><a href="/">Home</a> <a href="/courses">Courses</a></nav>';
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

type Linked = Course & { prev: string; next: string };

async function courseBuild(count: number, spooled: boolean, docBytes: number) {
	const shell = shellOf(layoutOf(docBytes));
	const rows = courses(count);
	// neighbours live in the row, so a held item page can link to them
	const linked: Linked[] = rows.map((row, i) => ({
		...row,
		prev: rows[i - 1]?.id ?? '',
		next: rows[i + 1]?.id ?? ''
	}));

	const dataset = defineDataset<Linked>('courses', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => linked,
		read: (ids) => linked.filter((row) => ids.includes(row.id)),
		changes: () => ({ cursor: 1, puts: [], deletes: [] }),
		horizon: () => 1,
		head: () => ({ cursor: 1 }),
		schema: 'course-1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});

	const list = defineRoute('/courses', {
		strategy: 'template',
		template: {
			source: shell(
				'Courses',
				'<ul>{{#each courses}}<li><a href="/courses/{{id}}">{{title}}</a></li>{{/each}}</ul>'
			)
		},
		depends: () => ['courses'],
		load: () => ({ courses: linked })
	});

	const item = defineRoute('/courses/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p><a href="/courses">All courses</a></p>{{#if row.prev}}<p><a href="/courses/{{row.prev}}">Previous course</a></p>{{/if}}{{#if row.next}}<p><a href="/courses/{{row.next}}">Next course</a></p>{{/if}}'
			)
		},
		family: { dataset: 'courses', key: 'id' },
		load: (ctx) => linked.find((row) => row.id === ctx.params['id'])
	});

	const routes = [list, item];

	const versions = memoryStore();
	await versions.bump(['courses']);
	const bundles = memoryBundleStore();
	const spool = spooled
		? createSpool({ routes, datasets: [dataset], store: versions, bundles })
		: undefined;
	// the pack must sit at the store's cursor, or a page finds no pack for its ring
	await spool?.publish(new URL('https://site.test/'));

	const html = (body: string) =>
		new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

	const page = (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const id = /^\/courses\/(\w+)$/.exec(pathname)?.[1];
		if (id !== undefined) {
			const row = linked.find((course) => course.id === id);
			if (!row) return new Response('not found', { status: 404 });
			return html(interpretTemplate(item.template!, { params: { id }, row }));
		}
		if (pathname === '/courses') {
			return html(interpretTemplate(list.template!, { courses: linked }));
		}
		if (pathname === '/') {
			return html(
				shell(
					'Courses',
					'<h1>Courses</h1><p><a href="/courses">Browse the course list</a></p>'
				)
			);
		}
		if (pathname === '/ping') {
			return new Response('pong', { headers: { 'content-type': 'text/plain' } });
		}
		return new Response('not found', { status: 404 });
	};

	return { spool, page };
}

type Built = Awaited<ReturnType<typeof courseBuild>>;

/** the courses site with its spool; `spool: false` skips the spool, so `page` is the origin alone */
export function courseSpool(
	count: number,
	options: { spool: false; docBytes?: number }
): Promise<Built & { spool: undefined }>;
export function courseSpool(
	count?: number,
	options?: { spool?: true; docBytes?: number }
): Promise<Built & { spool: Spool }>;
export function courseSpool(count = 3, options: { spool?: boolean; docBytes?: number } = {}) {
	return courseBuild(count, options.spool !== false, options.docBytes ?? 0);
}
