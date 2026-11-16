import { ProtocolError } from './errors.js';
import type { QueryResult, Shaped } from './query.js';
import { DATASET_NAME } from './query.js';

type Plain = Record<string, unknown>;

export type PlanOp = 'eq' | 'in' | 'gte' | 'lte' | 'prefix';

/** one condition of a plan; `param` is the URL parameter that supplies its value */
export type PlanCondition = {
	/** a base field, or `as.field` of a join */
	field: string;
	op: PlanOp;
	param: string;
	type: 'string' | 'number';
	/** prefix only: ASCII-only lowercasing on both sides, as SQLite's lower() does */
	fold?: 'ascii';
};

/** an equi-join from the base row; `on[1]` null matches the right dataset's key */
export type PlanJoin = {
	dataset: string;
	on: [string, string | null];
	type: 'inner' | 'left';
	/** the joined row's name in the output row */
	as: string;
	/** the right row's fields the plan may read */
	fields: string[];
};

export type PlanAggregate =
	| 'count'
	| { count: string }
	| { sum: string }
	| { min: string }
	| { max: string }
	| { avg: string };

/** a read-only query over held datasets, declared on a route and written in JSON */
export type QueryPlan = {
	/** base fields the plan may read; the output row carries exactly these */
	from: string[];
	join?: PlanJoin[];
	/** conditions, all ANDed; a condition whose parameter is absent is skipped */
	where?: PlanCondition[];
	group?: { by: string[]; aggregates: Record<string, PlanAggregate> };
	/** fields the `sort` parameter may name; a leading minus in the URL sorts descending */
	sort?: string[];
	pageSize: number;
	/** most result rows (groups or joined rows) the plan answers locally */
	limit: number;
};

/** the held rows of one dataset in ascending key order (code point order) */
export type PlanTable = {
	keys: readonly string[];
	rows: ReadonlyMap<string, Plain>;
	index?: TableIndex;
};

/** the base table and a way to reach each joined dataset; undefined when it is not held */
export type PlanTables = {
	base: PlanTable;
	joined(dataset: string): PlanTable | undefined;
};

/** the fewest rows a table holds before its fields are indexed; below it a scan is cheaper */
export const INDEX_MIN_ROWS = 200;

const PAGE = /^[1-9]\d{0,14}$/;
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const OPS = ['eq', 'in', 'gte', 'lte', 'prefix'];
const AGGREGATES = ['count', 'sum', 'min', 'max', 'avg'];
const PLAN_KEYS = ['from', 'join', 'where', 'group', 'sort', 'pageSize', 'limit'];

type Ref = { join: number; field: string };
type Entry = [unknown, string];
type Combo = { base: Plain; keys: Array<string | null>; joined: Array<Plain | null> };
type Active = { cond: PlanCondition; ref: Ref; values: Array<number | string> };

/** a plan read something SQLite would compare differently; the answer is the network's */
class NotLocal extends Error {}

const own = (row: Plain, field: string): unknown =>
	Object.hasOwn(row, field) ? (row[field] ?? null) : null;

const isObject = (value: unknown): value is Plain =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const typeRank = (value: unknown): number =>
	typeof value === 'number' ? 1 : typeof value === 'string' ? 2 : 0;

const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** a stored value the engine compares exactly as SQLite does; anything else makes a plan not local */
export function plainValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value === 'string') return !LONE_SURROGATE.test(value) && !value.includes('\0');
	return false;
}

/** UTF-8 byte order, which SQLite's BINARY collation uses; UTF-16 unit order differs above U+FFFF */
export function compareText(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x === y) continue;
		const surrogateX = x >= 0xd800 && x <= 0xdfff;
		const surrogateY = y >= 0xd800 && y <= 0xdfff;
		if (surrogateX !== surrogateY) return surrogateX ? 1 : -1;
		return x - y;
	}
	return a.length - b.length;
}

/** NULL first, then numbers, then text; the order SQLite sorts a column with no affinity by */
function compareValues(a: unknown, b: unknown): number {
	const ra = typeRank(a);
	const rb = typeRank(b);
	if (ra !== rb) return ra - rb;
	if (ra === 0) return 0;
	if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
	return compareText(a as string, b as string);
}

function compareTuples(a: unknown[], b: unknown[]): number {
	for (let i = 0; i < a.length; i++) {
		const order = compareValues(a[i], b[i]);
		if (order !== 0) return order;
	}
	return 0;
}

const sameValue = (a: unknown, b: unknown): boolean =>
	typeRank(a) !== 0 && typeRank(a) === typeRank(b) && a === b;

const sortKeys = (keys: string[]): string[] => keys.sort(compareText);

/** the first index whose entry satisfies `pred`, for a predicate that is false then true over the list */
function lowerBound(list: readonly Entry[], pred: (entry: Entry) => boolean): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (pred(list[mid] as Entry)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * Lazy per-field indexes over one table. Each index is built on first use and is only an
 * optimisation: a plan gives the same answer with or without one.
 */
export class TableIndex {
	readonly #keys: readonly string[];
	readonly #rows: ReadonlyMap<string, Plain>;
	readonly #clean = new Map<string, boolean>();
	readonly #equal = new Map<string, Map<string, string[]>>();
	readonly #sorted = new Map<string, Entry[]>();
	#built = 0;
	#entries = 0;

	constructor(keys: readonly string[], rows: ReadonlyMap<string, Plain>) {
		this.#keys = keys;
		this.#rows = rows;
	}

	/** how many field indexes have been built */
	get built(): number {
		return this.#built;
	}

	/** how many entries the built indexes hold, across every field */
	get entries(): number {
		return this.#entries;
	}

	/** whether every row's `field` holds a value {@link plainValue} accepts */
	clean(field: string): boolean {
		let ok = this.#clean.get(field);
		if (ok === undefined) {
			ok = this.#keys.every((key) => plainValue(own(this.#rows.get(key) as Plain, field)));
			this.#clean.set(field, ok);
		}
		return ok;
	}

	/** the keys whose `field` equals one of `values`, ascending */
	equal(field: string, values: readonly (number | string)[]): string[] {
		const map = this.#equalMap(field);
		const single =
			values.length === 1 ? map.get(`${typeRank(values[0])}${String(values[0])}`) : undefined;
		if (single) return [...single];
		const found = new Set<string>();
		for (const value of values) {
			for (const key of map.get(`${typeRank(value)}${String(value)}`) ?? []) found.add(key);
		}
		return sortKeys([...found]);
	}

	/** the keys whose `field` is at least or at most `value`, within the value's type, ascending */
	range(field: string, op: 'gte' | 'lte', value: number | string): string[] {
		const list = this.#sortedFor(`r\0${field}`, field, (v) =>
			typeRank(v) === 0 ? undefined : v
		);
		const rank = typeRank(value);
		const blockStart = lowerBound(list, (e) => typeRank(e[0]) >= rank);
		const blockEnd = lowerBound(list, (e) => typeRank(e[0]) > rank);
		const [from, to] =
			op === 'gte'
				? [lowerBound(list, (e) => compareValues(e[0], value) >= 0), blockEnd]
				: [blockStart, lowerBound(list, (e) => compareValues(e[0], value) > 0)];
		return sortKeys(list.slice(Math.max(from, blockStart), to).map((e) => e[1]));
	}

	/** the keys whose `field` starts with `text`, ascending */
	prefix(field: string, fold: 'ascii' | undefined, text: string): string[] {
		const list = this.#sortedFor(`p\0${fold ?? ''}\0${field}`, field, (v) =>
			typeof v === 'string' ? (fold === 'ascii' ? asciiLower(v) : v) : undefined
		);
		const wanted = fold === 'ascii' ? asciiLower(text) : text;
		const keys: string[] = [];
		for (
			let i = lowerBound(list, (e) => compareValues(e[0], wanted) >= 0);
			i < list.length;
			i++
		) {
			const [value, key] = list[i] as Entry;
			if (!(value as string).startsWith(wanted)) break;
			keys.push(key);
		}
		return sortKeys(keys);
	}

	#equalMap(field: string): Map<string, string[]> {
		let map = this.#equal.get(field);
		if (!map) {
			map = new Map();
			for (const key of this.#keys) {
				const value = own(this.#rows.get(key) as Plain, field);
				if (typeRank(value) === 0) continue;
				const tag = `${typeRank(value)}${String(value)}`;
				const list = map.get(tag);
				if (list) list.push(key);
				else map.set(tag, [key]);
				this.#entries += 1;
			}
			this.#equal.set(field, map);
			this.#built += 1;
		}
		return map;
	}

	#sortedFor(id: string, field: string, pick: (value: unknown) => unknown): Entry[] {
		let list = this.#sorted.get(id);
		if (!list) {
			list = [];
			for (const key of this.#keys) {
				const value = pick(own(this.#rows.get(key) as Plain, field));
				if (value !== undefined) list.push([value, key]);
			}
			list.sort((a, b) => compareValues(a[0], b[0]) || compareText(a[1], b[1]));
			this.#sorted.set(id, list);
			this.#built += 1;
			this.#entries += list.length;
		}
		return list;
	}
}

/** the value a plan reads for a field of a table, under the same rule with or without an index */
function cleanIn(table: PlanTable, field: string): boolean {
	if (table.index) return table.index.clean(field);
	return table.keys.every((key) => plainValue(own(table.rows.get(key) as Plain, field)));
}

/** the field's reference: a base field (join -1) or a joined row's field */
function resolve(plan: QueryPlan, ref: string): Ref | undefined {
	if (plan.from.includes(ref)) return { join: -1, field: ref };
	const dot = ref.indexOf('.');
	if (dot < 0) return undefined;
	const as = ref.slice(0, dot);
	const field = ref.slice(dot + 1);
	const join = (plan.join ?? []).findIndex((j) => j.as === as);
	if (join < 0 || !(plan.join?.[join]?.fields ?? []).includes(field)) return undefined;
	return { join, field };
}

function read(combo: Combo, ref: Ref): unknown {
	if (ref.join < 0) return own(combo.base, ref.field);
	const right = combo.joined[ref.join];
	return right ? own(right, ref.field) : null;
}

function compileValues(cond: PlanCondition, raw: string[]): Array<number | string> | null {
	if (cond.op !== 'in' && raw.length !== 1) return null;
	const out: Array<number | string> = [];
	for (const text of raw) {
		if (cond.type === 'number') {
			if (!NUMBER_TEXT.test(text)) return null;
			const n = Number(text);
			if (!Number.isFinite(n)) return null;
			out.push(n);
		} else {
			if (text.includes('\0')) return null;
			out.push(text);
		}
	}
	return out;
}

function matchesCondition(active: Active, value: unknown): boolean {
	const { cond, values } = active;
	if (cond.op === 'eq' || cond.op === 'in') return values.some((v) => sameValue(value, v));
	if (cond.op === 'gte' || cond.op === 'lte') {
		const first = values[0];
		if (typeRank(value) === 0 || typeRank(value) !== typeRank(first)) return false;
		const order = compareValues(value, first);
		return cond.op === 'gte' ? order >= 0 : order <= 0;
	}
	if (typeof value !== 'string') return false;
	const wanted = values[0] as string;
	return cond.fold === 'ascii'
		? asciiLower(value).startsWith(asciiLower(wanted))
		: value.startsWith(wanted);
}

/** the keys of a joined table that a base row matches, ascending */
function matches(join: PlanJoin, table: PlanTable, base: Plain): string[] {
	const value = own(base, join.on[0]);
	if (join.on[1] === null) {
		return typeof value === 'string' && table.rows.has(value) ? [value] : [];
	}
	if (typeRank(value) === 0) return [];
	const field = join.on[1];
	if (table.index && table.keys.length >= INDEX_MIN_ROWS) {
		return table.index.equal(field, [value as number | string]);
	}
	return table.keys.filter((key) => sameValue(own(table.rows.get(key) as Plain, field), value));
}

function expand(
	joins: PlanJoin[],
	targets: PlanTable[],
	combo: Combo,
	depth: number,
	out: Combo[]
): void {
	if (depth === joins.length) {
		out.push(combo);
		return;
	}
	const join = joins[depth] as PlanJoin;
	const table = targets[depth] as PlanTable;
	const found = matches(join, table, combo.base);
	if (found.length === 0) {
		if (join.type === 'left') {
			expand(
				joins,
				targets,
				{ ...combo, keys: [...combo.keys, null], joined: [...combo.joined, null] },
				depth + 1,
				out
			);
		}
		return;
	}
	for (const key of found) {
		const right = table.rows.get(key) as Plain;
		expand(
			joins,
			targets,
			{ base: combo.base, keys: [...combo.keys, key], joined: [...combo.joined, right] },
			depth + 1,
			out
		);
	}
}

function aggregate(plan: QueryPlan, agg: PlanAggregate, members: Combo[]): unknown {
	if (agg === 'count') return members.length;
	const [kind, field] = Object.entries(agg)[0] as [string, string];
	const ref = resolve(plan, field) as Ref;
	const values = members.map((m) => read(m, ref)).filter((v) => v !== null);
	if (kind === 'count') return values.length;
	if (kind === 'min' || kind === 'max') {
		if (values.length === 0) return null;
		return values.reduce((best, v) => {
			const order = compareValues(v, best);
			return kind === 'min' ? (order < 0 ? v : best) : order > 0 ? v : best;
		});
	}
	if (values.length === 0) return null;
	let sum = 0;
	for (const v of values) {
		if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new NotLocal();
		sum += v;
		if (!Number.isSafeInteger(sum)) throw new NotLocal();
	}
	return kind === 'sum' ? sum : sum / values.length;
}

type Item = { row: Plain; sort: unknown[]; tie: unknown[] };

function projectRow(plan: QueryPlan, combo: Combo): Plain {
	const fields = plan.from.map((field) => [field, own(combo.base, field)]);
	const joined = (plan.join ?? []).map((join, i) => {
		const right = combo.joined[i];
		const values = join.fields.map((field) => [field, right ? own(right, field) : null]);
		return [join.as, Object.fromEntries(values)];
	});
	return Object.fromEntries([...fields, ...joined]);
}

function groupItems(
	plan: QueryPlan,
	group: NonNullable<QueryPlan['group']>,
	kept: Combo[],
	sorts: string[]
): Item[] {
	const byRefs = group.by.map((field) => resolve(plan, field) as Ref);
	const groups = new Map<string, { by: unknown[]; members: Combo[] }>();
	if (group.by.length === 0) groups.set('[]', { by: [], members: [] });
	for (const combo of kept) {
		const by = byRefs.map((ref) => read(combo, ref));
		const tag = JSON.stringify(
			by.map((v) => (v === null ? '0' : `${typeRank(v)}${String(v)}`))
		);
		const found = groups.get(tag) ?? { by, members: [] };
		found.members.push(combo);
		groups.set(tag, found);
	}
	const aggregates = Object.entries(group.aggregates);
	return [...groups.values()].map(({ by, members }) => {
		const row = Object.fromEntries([
			...group.by.map((field, i) => [field, by[i] ?? null]),
			...aggregates.map(([name, agg]) => [name, aggregate(plan, agg, members)])
		]);
		return { row, sort: sorts.map((name) => row[name]), tie: by };
	});
}

function run(plan: QueryPlan, search: string, tables: PlanTables): QueryResult | null {
	const params = new URLSearchParams(search);
	const conditions = plan.where ?? [];
	const joins = plan.join ?? [];
	for (const key of new Set(params.keys())) {
		if (key !== 'sort' && key !== 'page' && !conditions.some((c) => c.param === key))
			return null;
	}
	const active: Active[] = [];
	for (const cond of conditions) {
		const raw = params.getAll(cond.param);
		if (raw.length === 0) continue;
		const values = compileValues(cond, raw);
		if (!values) return null;
		active.push({ cond, ref: resolve(plan, cond.field) as Ref, values });
	}
	const sortParams = params.getAll('sort');
	if (sortParams.length > 1) return null;
	const sorts: Array<{ name: string; desc: boolean }> = [];
	if (sortParams.length === 1) {
		const raw = sortParams[0] as string;
		const desc = raw.startsWith('-');
		const name = desc ? raw.slice(1) : raw;
		if (!(plan.sort ?? []).includes(name)) return null;
		sorts.push({ name, desc });
	}
	const pageParams = params.getAll('page');
	if (pageParams.length > 1) return null;
	let page = 1;
	if (pageParams.length === 1) {
		if (!PAGE.test(pageParams[0] as string)) return null;
		page = Number(pageParams[0]);
	}

	const base = tables.base;
	const targets: PlanTable[] = [];
	for (const join of joins) {
		const table = tables.joined(join.dataset);
		if (!table) return null;
		targets.push(table);
	}
	for (const field of plan.from) if (!cleanIn(base, field)) return null;
	for (let i = 0; i < joins.length; i++) {
		const join = joins[i] as PlanJoin;
		const fields = join.on[1] === null ? join.fields : [...join.fields, join.on[1]];
		for (const field of fields) if (!cleanIn(targets[i] as PlanTable, field)) return null;
	}

	let keys: readonly string[] = base.keys;
	const first = active.find((a) => a.ref.join < 0);
	if (first && base.index && base.keys.length >= INDEX_MIN_ROWS) {
		const { cond, ref, values } = first;
		keys =
			cond.op === 'gte' || cond.op === 'lte'
				? base.index.range(ref.field, cond.op, values[0] as number | string)
				: cond.op === 'prefix'
					? base.index.prefix(ref.field, cond.fold, values[0] as string)
					: base.index.equal(ref.field, values);
	}

	const combos: Combo[] = [];
	for (const key of keys) {
		const row = base.rows.get(key) as Plain;
		expand(joins, targets, { base: row, keys: [key], joined: [] }, 0, combos);
	}
	const kept = combos.filter((c) => active.every((a) => matchesCondition(a, read(c, a.ref))));

	const group = plan.group;
	const sortNames = sorts.map((s) => s.name);
	let items: Item[];
	if (group) {
		items = groupItems(plan, group, kept, sortNames);
	} else {
		if (kept.length > plan.limit) return null;
		const sortRefs = sortNames.map((name) => resolve(plan, name) as Ref);
		items = kept.map((combo) => ({
			row: projectRow(plan, combo),
			sort: sortRefs.map((ref) => read(combo, ref)),
			tie: combo.keys
		}));
	}
	if (items.length > plan.limit) return null;
	items.sort((a, b) => {
		for (let i = 0; i < sorts.length; i++) {
			const order = compareValues(a.sort[i], b.sort[i]);
			if (order !== 0) return sorts[i]?.desc ? -order : order;
		}
		return compareTuples(a.tie, b.tie);
	});

	const total = items.length;
	const size = plan.pageSize;
	const pages = Math.max(1, Math.ceil(total / size));
	if (page > pages) return null;
	return {
		items: items.slice((page - 1) * size, page * size).map((item) => item.row),
		total,
		page,
		pages
	};
}

/**
 * Answers a query string from held tables under `plan`, or returns null when the answer is not
 * local: an unknown or repeated parameter, a value the plan refuses, a float or text in a sum, a
 * table that is not held, a boolean or nested value in a declared field, or more result rows than
 * `limit`. Equal to the SQL the plan describes, row for row.
 */
export function evaluatePlan(
	plan: QueryPlan,
	search: string,
	tables: PlanTables
): QueryResult | null {
	try {
		return run(plan, search, tables);
	} catch (error) {
		if (error instanceof NotLocal) return null;
		throw error;
	}
}

/** the page data for a plan route: the stored data with the rows under `list` and a `query` view */
export function shapePlan(
	list: string,
	plan: QueryPlan,
	data: unknown,
	search: string,
	tables: PlanTables | undefined
): Shaped {
	if (!tables) return { ok: false, reason: 'plan needs its datasets' };
	const result = evaluatePlan(plan, search, tables);
	if (!result) return { ok: false, reason: 'query is not one the route declares' };
	const { items, total, page, pages } = result;
	return {
		ok: true,
		data: { ...(isObject(data) ? data : {}), [list]: items, query: { total, page, pages } }
	};
}

function fail(pattern: string, message: string): never {
	throw new ProtocolError('bad-route', `${pattern}: ${message}`);
}

const isName = (value: unknown): value is string =>
	typeof value === 'string' && value !== '' && !value.includes('.');

function names(pattern: string, value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.every(isName) || new Set(value).size !== value.length) {
		fail(pattern, `query.plan.${what} must be a list of distinct field names`);
	}
	return [...(value as string[])];
}

function checkAggregate(pattern: string, plan: QueryPlan, spec: unknown): PlanAggregate {
	if (spec === 'count') return 'count';
	if (!isObject(spec))
		fail(pattern, 'query.plan.group.aggregates must be "count" or one aggregate object');
	const kinds = Object.keys(spec);
	const kind = kinds[0] as string;
	const field = spec[kind];
	if (kinds.length !== 1 || !AGGREGATES.includes(kind)) {
		fail(pattern, `unknown aggregate ${JSON.stringify(spec)}`);
	}
	if (typeof field !== 'string' || !resolve(plan, field)) {
		fail(pattern, `aggregate field ${JSON.stringify(field)} is not readable`);
	}
	return { [kind]: field } as PlanAggregate;
}

/** the validated copy of a plan; throws `bad-route` for a plan the engine could not answer exactly */
export function checkPlan(pattern: string, value: unknown): QueryPlan {
	if (!isObject(value)) fail(pattern, 'query.plan must be an object');
	for (const key of Object.keys(value)) {
		if (!PLAN_KEYS.includes(key)) fail(pattern, `unknown query.plan option "${key}"`);
	}
	const from = names(pattern, value['from'], 'from');
	const joins: PlanJoin[] = [];
	const plan: QueryPlan = { from, join: joins, pageSize: 1, limit: 1 };

	if (value['join'] !== undefined) {
		if (!Array.isArray(value['join'])) fail(pattern, 'query.plan.join must be a list');
		for (const raw of value['join']) {
			if (!isObject(raw)) fail(pattern, 'query.plan.join entries must be objects');
			for (const key of Object.keys(raw)) {
				if (!['dataset', 'on', 'type', 'as', 'fields'].includes(key)) {
					fail(pattern, `unknown query.plan.join option "${key}"`);
				}
			}
			const { dataset, on, type, as } = raw;
			if (typeof dataset !== 'string' || !DATASET_NAME.test(dataset)) {
				fail(pattern, 'query.plan.join.dataset must be a dataset name');
			}
			const [onBase, onRight] = Array.isArray(on) ? on : [];
			if (
				typeof onBase !== 'string' ||
				!from.includes(onBase) ||
				!(onRight === null || isName(onRight))
			) {
				fail(pattern, 'query.plan.join.on must be [base field, right field or null]');
			}
			if (type !== 'inner' && type !== 'left') {
				fail(pattern, 'query.plan.join.type must be "inner" or "left"');
			}
			if (!isName(as) || from.includes(as) || joins.some((j) => j.as === as)) {
				fail(pattern, 'query.plan.join.as must be a new name');
			}
			joins.push({
				dataset,
				on: [onBase, onRight as string | null],
				type,
				as,
				fields: names(pattern, raw['fields'], 'join.fields')
			});
		}
	}

	const where: PlanCondition[] = [];
	const params = new Set<string>();
	if (value['where'] !== undefined) {
		if (!Array.isArray(value['where'])) fail(pattern, 'query.plan.where must be a list');
		for (const raw of value['where']) {
			if (!isObject(raw)) fail(pattern, 'query.plan.where entries must be objects');
			for (const key of Object.keys(raw)) {
				if (!['field', 'op', 'param', 'type', 'fold'].includes(key)) {
					fail(pattern, `unknown query.plan.where option "${key}"`);
				}
			}
			const { field, op, param, type, fold } = raw;
			if (typeof field !== 'string' || !resolve(plan, field)) {
				fail(pattern, `query.plan.where.field ${JSON.stringify(field)} is not readable`);
			}
			if (typeof op !== 'string' || !OPS.includes(op)) {
				fail(pattern, `unknown query.plan.where operator ${JSON.stringify(op)}`);
			}
			if (typeof param !== 'string' || param === '' || param === 'sort' || param === 'page') {
				fail(pattern, 'query.plan.where.param must be a parameter name');
			}
			if (params.has(param)) fail(pattern, `query.plan.where.param "${param}" is used twice`);
			if (type !== 'string' && type !== 'number') {
				fail(pattern, 'query.plan.where.type must be "string" or "number"');
			}
			if (op === 'prefix' && type !== 'string') fail(pattern, 'prefix takes a string');
			if (fold !== undefined && !(op === 'prefix' && fold === 'ascii')) {
				fail(pattern, 'query.plan.where.fold is "ascii" on prefix only');
			}
			params.add(param);
			where.push({
				field,
				op: op as PlanOp,
				param,
				type,
				...(fold === undefined ? {} : { fold: 'ascii' as const })
			});
		}
	}

	let group: QueryPlan['group'];
	if (value['group'] !== undefined) {
		const raw = value['group'];
		if (!isObject(raw)) fail(pattern, 'query.plan.group must be an object');
		for (const key of Object.keys(raw)) {
			if (!['by', 'aggregates'].includes(key))
				fail(pattern, `unknown query.plan.group option "${key}"`);
		}
		const by = raw['by'] === undefined ? [] : names(pattern, raw['by'], 'group.by');
		if (!by.every((field) => from.includes(field))) {
			fail(pattern, 'query.plan.group.by names base fields only');
		}
		if (!isObject(raw['aggregates']))
			fail(pattern, 'query.plan.group.aggregates must be an object');
		const aggregates: Record<string, PlanAggregate> = {};
		for (const [name, spec] of Object.entries(raw['aggregates'])) {
			if (!isName(name) || by.includes(name)) {
				fail(pattern, `query.plan.group.aggregates cannot name "${name}"`);
			}
			aggregates[name] = checkAggregate(pattern, plan, spec);
		}
		group = { by, aggregates };
	}

	let sort: string[] | undefined;
	if (value['sort'] !== undefined) {
		if (!Array.isArray(value['sort'])) fail(pattern, 'query.plan.sort must be a list of names');
		sort = [];
		for (const name of value['sort']) {
			if (
				typeof name !== 'string' ||
				name === '' ||
				name.startsWith('-') ||
				sort.includes(name)
			) {
				fail(pattern, `query.plan.sort cannot name ${JSON.stringify(name)}`);
			}
			const known = group
				? group.by.includes(name) || Object.hasOwn(group.aggregates, name)
				: resolve(plan, name) !== undefined;
			if (!known)
				fail(
					pattern,
					`query.plan.sort names ${JSON.stringify(name)}, which is not readable`
				);
			sort.push(name);
		}
	}

	const { pageSize, limit } = value;
	if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1) {
		fail(pattern, 'query.plan.pageSize must be a positive integer');
	}
	if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < pageSize) {
		fail(pattern, 'query.plan.limit must be an integer at least pageSize');
	}

	const out: QueryPlan = { from, pageSize, limit };
	if (joins.length > 0) out.join = joins;
	if (where.length > 0) out.where = where;
	if (group) out.group = group;
	if (sort) out.sort = sort;
	return out;
}
