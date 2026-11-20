import { escapeHtml, interpretTemplate } from '@drupflare/spool/protocol';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	type Spool,
	type StaticSink
} from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export type Entry = { id: string; title: string; area: string; date: string; body: string };

export const PAGE_SIZE = 10;
export const AREAS = ['api', 'cli', 'docs', 'perf'];

const KINDS = ['Added', 'Fixed', 'Changed', 'Removed'];
const SUBJECTS = [
	'cache lookups',
	'the sync command',
	'plugin loading',
	'search ranking',
	'image uploads',
	'the audit log'
];
const DAY_MS = 86_400_000;
const FIRST_DAY = Date.UTC(2025, 0, 6);
const SITE_URL = 'https://changelog.test/';
const LIST = '<ul>{{#each entries}}<li><a href="/entries/{{id}}">{{title}}</a></li>{{/each}}</ul>';
const NAV = '<nav><a href="/">Home</a> <a href="/areas">Areas</a></nav>';
const shell = (title: string, body: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body>${NAV}<main data-spool-swap>${body}</main></body></html>`;

/** ids count down as entries are added, so ascending key order lists the newest entry first */
export function entryId(seq: number): string {
	return String(9000 - seq).padStart(4, '0');
}

const pick = <T>(list: readonly T[], index: number): T => list[index % list.length] as T;
const dateOf = (index: number) =>
	new Date(FIRST_DAY + index * 7 * DAY_MS).toISOString().slice(0, 10);

/** the generated entries, oldest first, a week apart */
export function entries(count = 40): Entry[] {
	return Array.from({ length: count }, (_, index) => ({
		id: entryId(index + 1),
		title: `${pick(KINDS, index)} ${pick(SUBJECTS, index)} in 1.${index + 1}`,
		area: pick(AREAS, index),
		date: dateOf(index),
		body: `Release 1.${index + 1} of the library.`
	}));
}

/**
 * The changelog site: a dataset of entries, a list with an area filter and one page per entry. `page` is
 * the origin alone, so it is also the no-spool arm. `lease` is the stub's lease in seconds.
 */
export async function staticSite(options: { lease?: number } = {}) {
	const all = entries();
	const log: Array<{ cursor: number; key: string }> = [];
	let cursor = 1;
	let stamp = 0;
	const newestFirst = (): Entry[] => [...all].sort((a, b) => (a.id < b.id ? -1 : 1));

	const entryRows = defineDataset<Entry>('entries', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => newestFirst(),
		read: (ids) => all.filter((row) => ids.includes(row.id)),
		changes: (since) => ({
			cursor,
			puts: [...new Set(log.filter((item) => item.cursor > since).map((item) => item.key))],
			deletes: []
		}),
		horizon: () => 1,
		head: () => ({ cursor }),
		schema: 'entry-1',
		maxRows: 1000,
		maxBytes: 1_000_000
	});

	const homeRoute = defineRoute('/', {
		strategy: 'template',
		template: {
			source: shell(
				'Changelog',
				`<h1>{{#if query}}Page {{query.page}} of {{query.pages}}{{else}}Newest Entries{{/if}}</h1>${LIST}`
			)
		},
		depends: () => ['entries'],
		load: () => ({ entries: newestFirst().slice(0, PAGE_SIZE) }),
		query: { list: 'entries', dataset: 'entries', pageSize: PAGE_SIZE }
	});

	const entryRoute = defineRoute('/entries/:id', {
		strategy: 'template',
		template: {
			source: shell(
				'{{row.title}}',
				'<h1>{{row.title}}</h1><p>{{row.date}}</p><p>{{row.body}}</p><p><a href="/">All entries</a> <a href="/areas?area={{row.area}}">{{row.area}}</a></p>'
			)
		},
		family: { dataset: 'entries', key: 'id' },
		load: (ctx) => all.find((row) => row.id === ctx.params['id'])
	});

	const areaRoute = defineRoute('/areas', {
		strategy: 'template',
		template: {
			source: shell(
				'Areas',
				`<h1>{{#if query}}Entries in an Area{{else}}Areas{{/if}}</h1>{{#if query}}<p>{{query.total}} entries, page {{query.page}} of {{query.pages}}</p>${LIST}{{else}}<p>${AREAS.map((area) => `<a href="/areas?area=${encodeURIComponent(area)}">${escapeHtml(area)}</a>`).join(' ')}</p>{{/if}}`
			)
		},
		depends: () => ['entries'],
		load: () => ({}),
		query: {
			list: 'entries',
			dataset: 'entries',
			filter: { area: 'string' },
			pageSize: PAGE_SIZE
		}
	});

	const store = memoryStore();
	const spool = createSpool({
		routes: [homeRoute, entryRoute, areaRoute],
		datasets: [entryRows],
		store,
		bundles: memoryBundleStore(),
		// the stub is written before any page is answered, so the site policy is named here
		policy: {},
		stamp: () => stamp,
		freshness: { maxAge: options.lease ?? 86_400 }
	});

	const html = (body: string) =>
		new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

	const listing = (rows: Entry[], params: URLSearchParams) => {
		const page = Number(params.get('page') ?? 1);
		return {
			entries: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
			query: { total: rows.length, page, pages: Math.ceil(rows.length / PAGE_SIZE) }
		};
	};

	/** the origin answer; a query string it does not use is ignored */
	const page = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === '/') {
			const data =
				searchParams.size === 0
					? { entries: newestFirst().slice(0, PAGE_SIZE) }
					: listing(newestFirst(), searchParams);
			return html(interpretTemplate(homeRoute.template!, data));
		}
		if (pathname === '/areas') {
			if (searchParams.size === 0) return html(interpretTemplate(areaRoute.template!, {}));
			const area = searchParams.get('area');
			const rows = newestFirst().filter((row) => area === null || row.area === area);
			return html(interpretTemplate(areaRoute.template!, listing(rows, searchParams)));
		}
		const id = /^\/entries\/(\w+)$/.exec(pathname)?.[1];
		const row = id === undefined ? undefined : all.find((item) => item.id === id);
		if (row) return html(interpretTemplate(entryRoute.template!, { params: { id }, row }));
		return new Response('not found', { status: 404 });
	};

	/** adds an entry and builds the next pack; call `publish` to write it to the static tier */
	async function addEntry(
		fields: Omit<Entry, 'id'>
	): Promise<{ version: number; bytes: number }> {
		const entry: Entry = { ...fields, id: entryId(all.length + 1) };
		all.push(entry);
		cursor += 1;
		log.push({ cursor, key: entry.id });
		await spool.invalidate(['entries']);
		return spool.publish(new URL(SITE_URL));
	}

	/** advances the stamp, so the stub's bytes change, and writes the static tier to `sink` */
	function publish(sink: StaticSink): ReturnType<Spool['publishStatic']> {
		stamp += 1;
		return spool.publishStatic(sink);
	}

	await store.bump(['entries']);
	const { version } = await spool.publish(new URL(SITE_URL));

	return { spool, page, publish, addEntry, version, stamp: () => stamp };
}
