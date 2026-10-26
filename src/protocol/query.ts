import { shellHash } from './hash.js';

/** how a query parameter is read when it filters a field */
export type QueryFilterType = 'string' | 'number';

/**
 * The query strings a public route answers from the collection it holds. `list` names the key of the
 * loaded data that holds the whole collection, an array of flat objects. A parameter named in
 * `filter` keeps the items whose field of the same name equals it, and a repeated one matches any of
 * its values. `sort` lists the fields the `sort` parameter may name (`-name` sorts descending), and
 * `pageSize` turns on the 1-based `page` parameter.
 */
export type QuerySchema = {
	/** key of the loaded data that holds the collection */
	list: string;
	/** parameters that filter items, by field name, with how each is read */
	filter?: Record<string, QueryFilterType>;
	/** fields the sort parameter may name; a leading minus reverses the order */
	sort?: readonly string[];
	/** items per page; turns on the page parameter */
	pageSize?: number;
};

/** what a collection's `load` result carries so the worker can tell it holds every item the server sent */
export type DatasetProof = {
	/** number of items in the collection */
	count: number;
	/** hash of the collection's canonical JSON */
	digest: string;
};

/** the page of items a query selects, with the size of the filtered collection and the page count */
export type QueryResult = {
	/** the items on this page */
	items: Record<string, unknown>[];
	/** items matching the filters, before paging */
	total: number;
	/** the 1-based page returned */
	page: number;
	/** number of pages, at least 1 */
	pages: number;
};

/** what a template or renderer receives as `query` for a query URL */
export type QueryView = {
	/** items matching the filters, before paging */
	total: number;
	/** the 1-based page returned */
	page: number;
	/** number of pages, at least 1 */
	pages: number;
};

/** the refusal reason when the stored items no longer match their proof */
export const PROOF_MISMATCH = 'dataset proof does not match its items';

/** a flat object of a collection or the data around it */
export type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (value: Plain, key: string): unknown =>
	Object.hasOwn(value, key) ? value[key] : undefined;

function canonical(value: unknown): string | undefined {
	const convert = (value as { toJSON?: unknown } | null)?.toJSON;
	if (typeof value === 'object' && typeof convert === 'function') {
		return canonical(convert.call(value));
	}
	if (Array.isArray(value)) return `[${value.map((v) => canonical(v) ?? 'null').join(',')}]`;
	if (isPlain(value)) {
		const parts: string[] = [];
		for (const key of Object.keys(value).sort()) {
			const part = canonical(value[key]);
			if (part !== undefined) parts.push(`${JSON.stringify(key)}:${part}`);
		}
		return `{${parts.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** JSON with object keys sorted and no whitespace, so equal values give equal text on any engine */
export function canonicalJson(value: unknown): string {
	return canonical(value) ?? 'null';
}

/** the proof a query route's `load` result carries for its collection */
export async function datasetProof(items: readonly unknown[]): Promise<DatasetProof> {
	return { count: items.length, digest: await shellHash(canonicalJson(items)) };
}

/** whether `data` holds the collection at `schema.list` and a `proof` that matches it */
export async function verifyProof(schema: QuerySchema, data: unknown): Promise<boolean> {
	if (!isPlain(data)) return false;
	const items = own(data, schema.list);
	const proof = own(data, 'proof');
	if (!Array.isArray(items) || !isPlain(proof)) return false;
	if (proof['count'] !== items.length || typeof proof['digest'] !== 'string') return false;
	return (await shellHash(canonicalJson(items))) === proof['digest'];
}

const numberOf = (text: string): number | null =>
	text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null;

const rank = (value: unknown) =>
	typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;

/** numbers before strings before anything else; numbers by value, strings by code unit */
function compare(a: unknown, b: unknown): number {
	const [ra, rb] = [rank(a), rank(b)];
	if (ra !== rb) return ra - rb;
	if (ra === 2) return 0;
	return (a as number | string) < (b as number | string)
		? -1
		: (a as number | string) > (b as number | string)
			? 1
			: 0;
}

/**
 * Applies a query string to the collection in `data`: filters by equality, sorts stably (ties keep
 * the stored order), and pages. Returns `null` for anything the schema does not declare, so the
 * caller goes to the network: an unknown parameter, a number filter that is not a finite number, a
 * `sort` that is repeated or not a listed field, a `page` that is not a positive integer or lies
 * past the last, or an item that is not an object. An empty query string selects everything.
 */
export function evaluateQuery(
	schema: QuerySchema,
	data: unknown,
	search: string
): QueryResult | null {
	const list = isPlain(data) ? own(data, schema.list) : undefined;
	if (!Array.isArray(list) || !list.every(isPlain)) return null;
	const params = new URLSearchParams(search);
	const filter = schema.filter ?? {};
	for (const key of new Set(params.keys())) {
		if (key !== 'sort' && key !== 'page' && !Object.hasOwn(filter, key)) return null;
	}

	let items = list as Plain[];
	for (const [field, type] of Object.entries(filter)) {
		const wanted = params.getAll(field);
		if (wanted.length === 0) continue;
		if (type === 'number') {
			const numbers = wanted.map(numberOf);
			if (numbers.includes(null)) return null;
			items = items.filter((item) => {
				const value = own(item, field);
				return typeof value === 'number' && numbers.includes(value);
			});
		} else {
			items = items.filter((item) => {
				const value = own(item, field);
				const text =
					typeof value === 'string' ||
					typeof value === 'number' ||
					typeof value === 'boolean'
						? String(value)
						: undefined;
				return text !== undefined && wanted.includes(text);
			});
		}
	}

	const sorts = params.getAll('sort');
	if (sorts.length > 1) return null;
	items = [...items];
	if (sorts.length === 1) {
		const raw = sorts[0] as string;
		const listed = schema.sort ?? [];
		const descending = !listed.includes(raw) && raw.startsWith('-');
		const field = descending ? raw.slice(1) : raw;
		if (!listed.includes(field)) return null;
		items.sort((a, b) => {
			const order = compare(own(a, field), own(b, field));
			return descending ? -order : order;
		});
	}

	const pageParams = params.getAll('page');
	if (pageParams.length > 1) return null;
	let page = 1;
	if (pageParams.length === 1) {
		if (!/^[1-9]\d{0,14}$/.test(pageParams[0] as string)) return null;
		page = Number(pageParams[0]);
	}
	const total = items.length;
	const size = schema.pageSize;
	const pages = size === undefined ? 1 : Math.max(1, Math.ceil(total / size));
	if (page > pages) return null;
	return {
		items: size === undefined ? items : items.slice((page - 1) * size, page * size),
		total,
		page,
		pages
	};
}

/**
 * The data a template or renderer gets for a query URL: the stored data with `schema.list` replaced
 * by the page's items and a `query` key added. Refuses when the proof fails or the query is not one
 * the schema declares.
 */
export async function shapeQuery(
	schema: QuerySchema,
	data: unknown,
	search: string
): Promise<
	| {
			/** true when the query was answered from the stored collection */
			ok: true;
			/** the stored data with the page's items and the query view */
			data: Plain;
	  }
	| {
			/** false when the proof or the query was refused */
			ok: false;
			/** why the query was refused */
			reason: string;
	  }
> {
	if (!(await verifyProof(schema, data))) return { ok: false, reason: PROOF_MISMATCH };
	const result = evaluateQuery(schema, data, search);
	if (!result) return { ok: false, reason: 'query is not one the route declares' };
	const { items, total, page, pages } = result;
	const view: QueryView = { total, page, pages };
	return { ok: true, data: { ...(data as Plain), [schema.list]: items, query: view } };
}
