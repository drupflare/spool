import type { DatasetRow } from './dataset.js';
import { fillPattern } from './pattern.js';
import type { SerializedRoute } from './route.js';

/** the part of a route the index tables read; a route and a serialized route both carry it */
export type IndexRoute = Pick<SerializedRoute, 'pattern' | 'scope' | 'family' | 'query'>;

/** the family routes that index a row by its path, and the fields each dataset's queries read */
export type IndexPlan = {
	paths: Array<{ dataset: string; pattern: string; key: string }>;
	fields: Map<string, string[]>;
};

/** one index row: its table, its key, and its value, or `null` when the row leaves the index */
export type IndexRow = [table: string, key: string, row: DatasetRow | null];

/** whether a pattern has no param but `key`, so each row has one concrete path */
function oneParam(pattern: string, key: string): boolean {
	const parts = pattern.split('/');
	return (
		!parts.includes('**') && parts.every((part) => !part.startsWith(':') || part === `:${key}`)
	);
}

/** the index tables a route set asks for, read from its public routes */
export function indexPlan(routes: readonly IndexRoute[]): IndexPlan {
	const paths: IndexPlan['paths'] = [];
	const fields = new Map<string, Set<string>>();
	for (const route of routes) {
		if (route.scope !== 'public') continue;
		if (route.family && oneParam(route.pattern, route.family.key)) {
			paths.push({
				dataset: route.family.dataset,
				pattern: route.pattern,
				key: route.family.key
			});
		}
		const query = route.query;
		if (query?.dataset !== undefined && query.plan === undefined) {
			const names = fields.get(query.dataset) ?? new Set<string>();
			fields.set(query.dataset, names);
			for (const name of [...Object.keys(query.filter ?? {}), ...(query.sort ?? [])]) {
				names.add(name);
			}
		}
	}
	return { paths, fields: new Map([...fields].map(([dataset, names]) => [dataset, [...names]])) };
}

/**
 * The index rows of one row of `dataset`. With no `row` the key leaves the index: the same tables
 * come back with `null` values, since a path depends on the key alone.
 */
export function indexRowsOf(
	plan: IndexPlan,
	dataset: string,
	key: string,
	row?: DatasetRow
): IndexRow[] {
	const out: IndexRow[] = [];
	for (const path of plan.paths) {
		if (path.dataset !== dataset) continue;
		const at = fillPattern(path.pattern, { [path.key]: key });
		out.push([`path:${dataset}`, at, row === undefined ? null : { key }]);
	}
	const names = plan.fields.get(dataset);
	if (names !== undefined) {
		out.push([`query:${dataset}`, key, row === undefined ? null : projected(row, names)]);
	}
	return out;
}

/** the row cut to the named fields it holds */
function projected(row: DatasetRow, names: readonly string[]): DatasetRow {
	return Object.fromEntries(
		names.filter((name) => Object.hasOwn(row, name)).map((name) => [name, row[name]])
	);
}
