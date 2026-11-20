import {
	ARTICLES,
	DEPARTMENTS,
	EVENTS,
	HOME_ITEMS,
	PAGE_SIZE,
	PAGES,
	PEOPLE,
	PROGRAMS
} from '../../shared/site.ts';

export type Listing<Row> = {
	items: Row[];
	query: { total: number; page: number; pages: number };
};

const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** one page of a list, with the same filters and sort the shared site's routes accept */
export function listing<Row extends object>(
	rows: readonly Row[],
	key: (row: Row) => string,
	params: URLSearchParams,
	filters: readonly (keyof Row & string)[],
	sorts: readonly (keyof Row & string)[]
): Listing<Row> | null {
	let matching = [...rows]
		.sort((a, b) => order(key(a), key(b)))
		.filter((row) =>
			filters.every((name) => !params.has(name) || String(row[name]) === params.get(name))
		);
	const sort = params.get('sort');
	if (sort !== null) {
		const field = sort.replace(/^-/, '') as keyof Row & string;
		if (!sorts.includes(field)) return null;
		const direction = sort.startsWith('-') ? -1 : 1;
		matching = matching.sort((a, b) => direction * order(String(a[field]), String(b[field])));
	}
	const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
	const page = Number(params.get('page') ?? 1);
	if (!Number.isInteger(page) || page < 1 || page > pages) return null;
	const items = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	return { items, query: { total: matching.length, page, pages } };
}

/** the query string of a page, as the URLSearchParams the listings read */
export async function paramsOf(
	search: Promise<Record<string, string | string[] | undefined>>
): Promise<URLSearchParams> {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(await search)) {
		if (typeof value === 'string') params.set(name, value);
	}
	return params;
}

export const newsList = (params: URLSearchParams) =>
	listing(ARTICLES, (row) => row.slug, params, [], ['published']);
export const eventsList = (params: URLSearchParams) =>
	listing(EVENTS, (row) => row.id, params, [], ['starts']);
export const programsList = (params: URLSearchParams) =>
	listing(PROGRAMS, (row) => row.id, params, ['department', 'level'], ['name']);

export const latestNews = () =>
	[...ARTICLES].sort((a, b) => order(b.published, a.published)).slice(0, HOME_ITEMS);
export const soonestEvents = () =>
	[...EVENTS].sort((a, b) => order(a.starts, b.starts)).slice(0, HOME_ITEMS);

export { ARTICLES, DEPARTMENTS, EVENTS, PAGES, PEOPLE, PROGRAMS };
