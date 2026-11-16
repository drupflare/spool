import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	compareText,
	evaluatePlan,
	evaluateQuery,
	TableIndex,
	type PlanAggregate,
	type PlanCondition,
	type PlanJoin,
	type PlanTable,
	type PlanTables,
	type QueryPlan,
	type QuerySchema
} from '../../src/protocol/index';

// a database is the independent oracle: it shares no code with the evaluator, which is the point
const schema: QuerySchema = {
	list: 'rows',
	filter: { department: 'string', level: 'number' },
	sort: ['name', 'level', 'id'],
	pageSize: 7
};

type Row = { id: number; name: string; department: string; level: number };

function lcg(seed: number) {
	let state = seed;
	return () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;
}

describe('evaluateQuery against SQLite', () => {
	it('returns the rows, order and counts the database does, over 400 random queries', () => {
		const next = lcg(20_261_026);
		const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
		const names = [
			'ada',
			'Ada',
			'bo',
			'Bo',
			'cy',
			'di',
			'Ed',
			'ed',
			'zed',
			'Zoe',
			'a b',
			'a-b',
			'10',
			'9'
		];
		const departments = ['math', 'cs', 'art', 'bio', 'law'];
		const rows: Row[] = Array.from({ length: 60 }, (_, id) => ({
			id,
			name: pick(names),
			department: pick(departments),
			level: Math.floor(next() * 5)
		}));
		const db = new DatabaseSync(':memory:');
		db.exec(
			'CREATE TABLE t (idx INTEGER PRIMARY KEY, id INTEGER, name TEXT, department TEXT, level REAL)'
		);
		const insert = db.prepare(
			'INSERT INTO t (idx, id, name, department, level) VALUES (?,?,?,?,?)'
		);
		rows.forEach((row, i) => insert.run(i, row.id, row.name, row.department, row.level));
		const data = { rows };

		for (let c = 0; c < 400; c++) {
			const search = new URLSearchParams();
			const where: string[] = [];
			const args: Array<string | number> = [];
			const departmentsAsked =
				next() < 0.5 ? [] : Array.from(new Set([pick(departments), pick(departments)]));
			for (const department of departmentsAsked) search.append('department', department);
			if (departmentsAsked.length > 0) {
				where.push(`department IN (${departmentsAsked.map(() => '?').join(',')})`);
				args.push(...departmentsAsked);
			}
			if (next() < 0.4) {
				const level = Math.floor(next() * 5);
				search.set('level', String(level));
				where.push('level = ?');
				args.push(level);
			}
			let order = 'idx ASC';
			if (next() < 0.7) {
				const field = pick(schema.sort as readonly string[]);
				const descending = next() < 0.5;
				search.set('sort', `${descending ? '-' : ''}${field}`);
				order = `${field} ${descending ? 'DESC' : 'ASC'}, idx ASC`;
			}
			const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
			const total = (
				db.prepare(`SELECT count(*) AS n FROM t ${filter}`).get(...args) as { n: number }
			).n;
			const pages = Math.max(1, Math.ceil(total / 7));
			const page = 1 + Math.floor(next() * pages);
			if (page > 1) search.set('page', String(page));
			const expected = (
				db
					.prepare(`SELECT id FROM t ${filter} ORDER BY ${order} LIMIT 7 OFFSET ?`)
					.all(...args, (page - 1) * 7) as Array<{ id: number }>
			).map((r) => r.id);

			const got = evaluateQuery(schema, data, search.toString());
			const label = `${c}: ${search.toString()}`;
			expect(got, label).not.toBeNull();
			expect(
				got?.items.map((r) => r['id']),
				label
			).toEqual(expected);
			expect(got?.total, label).toBe(total);
			expect(got?.pages, label).toBe(pages);
			expect(got?.page, label).toBe(page);
		}
		db.close();
	});

	it('differs from a database only where the comparison is by UTF-16 code unit', () => {
		// the evaluator orders strings by code unit and a database by bytes, so a character above U+FFFF
		// sorts before U+E000 to U+FFFF in one and after it in the other
		const rows = [
			{ id: 1, name: '\u{1F600}' },
			{ id: 2, name: 'Ａ' }
		];
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
		const insert = db.prepare('INSERT INTO t VALUES (?,?)');
		for (const row of rows) insert.run(row.id, row.name);
		const sql = (
			db.prepare('SELECT id FROM t ORDER BY name').all() as Array<{ id: number }>
		).map((r) => r.id);
		const mine = evaluateQuery(
			{ list: 'rows', sort: ['name'] },
			{ rows },
			'sort=name'
		)?.items.map((r) => r['id']);
		expect(sql).toEqual([2, 1]);
		expect(mine).toEqual([1, 2]);
		db.close();
	});
});

// #region query plans: the oracle translates each plan into SQL and runs it on node:sqlite

type PlanBase = { c?: unknown; n?: unknown; x?: unknown };
type PlanRight = { f?: unknown; g?: unknown };

const PLAN_TABLE = 'jt';
const PLAN_STRINGS = [
	'ada',
	'Ada',
	'ABC',
	'abc',
	'ab',
	'Ab',
	'bo',
	'Bo',
	'',
	'a b',
	'a-b',
	'é',
	'Zoe',
	'\u{1F600}',
	'�',
	'Ｂ',
	'￿',
	'10'
];
const PLAN_INTS = [2147483647, 2147483648, 2147483646, -5, 0, 3, 7, 1, 2147483649];
const PLAN_PREFIXES = ['a', 'A', '', 'ad', '\u{1F600}', 'B', 'b', 'ab'];

/** a base table and a right table, each with missing fields, nulls and mixed types */
function planFixture(next: () => number, count: number) {
	const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
	const mixed = (values: readonly unknown[]): unknown => {
		const r = next();
		return r < 0.12 ? undefined : r < 0.22 ? null : pick(values);
	};
	const base = new Map<string, PlanBase>();
	const keys = ['', '\u{1F600}', '�', 'A', 'a'];
	const mixedX = [...PLAN_STRINGS.slice(0, 6), ...PLAN_INTS];
	for (let i = 0; i < count; i++) {
		const row: PlanBase = {};
		const c = mixed(PLAN_STRINGS);
		const n = mixed(PLAN_INTS);
		const x = mixed(mixedX);
		if (c !== undefined) row.c = c;
		if (n !== undefined) row.n = n;
		if (x !== undefined) row.x = x;
		base.set(`${pick(keys)}${i}`, row);
	}
	const right = new Map<string, PlanRight>();
	for (const key of new Set(PLAN_STRINGS)) {
		if (next() < 0.6) right.set(key, { f: mixed(mixedX), g: mixed(PLAN_INTS) });
	}
	for (let i = 0; i < count; i++) {
		right.set(`z${i}`, { f: mixed(mixedX), g: mixed(PLAN_INTS) });
	}
	return { base, right };
}

function planTables(
	base: Map<string, PlanBase>,
	right: Map<string, PlanRight>,
	indexed: boolean
): PlanTables {
	const table = (rows: Map<string, Record<string, unknown>>): PlanTable => {
		const keys = [...rows.keys()].sort(compareText);
		return { keys, rows, ...(indexed ? { index: new TableIndex(keys, rows) } : {}) };
	};
	const baseTable = table(base);
	const rightTable = table(right);
	return { base: baseTable, joined: (name) => (name === PLAN_TABLE ? rightTable : undefined) };
}

/** the same two tables as SQL; a missing field is NULL, and no column has a declared type */
function planDatabase(base: Map<string, PlanBase>, right: Map<string, PlanRight>): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE base (k TEXT, c, n, x)');
	db.exec(`CREATE TABLE ${PLAN_TABLE} (k TEXT, f, g)`);
	const nul = (v: unknown) => (v ?? null) as string | number | null;
	const insertBase = db.prepare('INSERT INTO base VALUES (?,?,?,?)');
	for (const [k, r] of base) insertBase.run(k, nul(r.c), nul(r.n), nul(r.x));
	const insertRight = db.prepare(`INSERT INTO ${PLAN_TABLE} VALUES (?,?,?)`);
	for (const [k, r] of right) insertRight.run(k, nul(r.f), nul(r.g));
	db.exec(`CREATE INDEX base_c ON base (c); CREATE INDEX ${PLAN_TABLE}_f ON ${PLAN_TABLE} (f)`);
	db.exec(`CREATE INDEX ${PLAN_TABLE}_g ON ${PLAN_TABLE} (g)`);
	return db;
}

const AGG_SQL: Record<string, string> = {
	count: 'COUNT',
	sum: 'SUM',
	min: 'MIN',
	max: 'MAX',
	avg: 'AVG'
};

/** the rows a plan and query string answer, as SQL gives them, in the order the plan sorts them */
function sqlRows(db: DatabaseSync, plan: QueryPlan, text: string): Array<Record<string, unknown>> {
	const params = new URLSearchParams(text);
	const joins: PlanJoin[] = plan.join ?? [];
	const aliasOf = (ref: string): string => {
		if (plan.from.includes(ref)) return `b.${ref}`;
		const i = joins.findIndex((j) => ref.startsWith(`${j.as}.`));
		return `j${i}.${ref.slice((joins[i] as PlanJoin).as.length + 1)}`;
	};
	const from = joins
		.map((j, i) => {
			const kind = j.type === 'left' ? 'LEFT JOIN' : 'JOIN';
			const on = j.on[1] === null ? `j${i}.k` : `j${i}.${j.on[1]}`;
			return `${kind} ${PLAN_TABLE} j${i} ON ${on} = b.${j.on[0]}`;
		})
		.join(' ');
	const where: string[] = [];
	const args: Array<string | number> = [];
	for (const cond of plan.where ?? []) {
		const raw = params.getAll(cond.param);
		if (raw.length === 0) continue;
		const e = aliasOf(cond.field);
		const conv = (v: string) => (cond.type === 'number' ? Number(v) : v);
		if (cond.op === 'eq') {
			where.push(`${e} = ?`);
			args.push(conv(raw[0] as string));
		} else if (cond.op === 'in') {
			where.push(`${e} IN (${raw.map(() => '?').join(',')})`);
			args.push(...raw.map(conv));
		} else if (cond.op === 'gte' || cond.op === 'lte') {
			const guard =
				cond.type === 'number'
					? `typeof(${e}) IN ('integer','real')`
					: `typeof(${e}) = 'text'`;
			where.push(`(${guard} AND ${e} ${cond.op === 'gte' ? '>=' : '<='} ?)`);
			args.push(conv(raw[0] as string));
		} else {
			const fold = cond.fold === 'ascii';
			const lhs = fold ? `lower(${e})` : e;
			where.push(
				`(typeof(${e}) = 'text' AND substr(${lhs}, 1, length(?)) = ${fold ? 'lower(?)' : '?'})`
			);
			args.push(raw[0] as string, raw[0] as string);
		}
	}
	const sortName = params.getAll('sort')[0];
	const desc = sortName?.startsWith('-') ?? false;
	const sortField = sortName === undefined ? undefined : desc ? sortName.slice(1) : sortName;
	const group = plan.group;
	let select: string;
	let groupBy = '';
	const order: string[] = [];
	if (!group) {
		const cols = plan.from.map((f) => `b.${f} AS c_${f}`);
		joins.forEach((j, i) =>
			cols.push(`j${i}.k AS jk${i}`, ...j.fields.map((f) => `j${i}.${f} AS j${i}_${f}`))
		);
		select = `SELECT b.k AS bk, ${cols.join(', ')}`;
		if (sortField !== undefined) order.push(`${aliasOf(sortField)} ${desc ? 'DESC' : 'ASC'}`);
		order.push('bk', ...joins.map((_, i) => `jk${i}`));
	} else {
		const cols = group.by.map((f) => `b.${f} AS g_${f}`);
		for (const [name, agg] of Object.entries(group.aggregates)) {
			cols.push(`${aggSql(agg, aliasOf)} AS a_${name}`);
		}
		select = `SELECT ${cols.join(', ')}`;
		if (group.by.length > 0) groupBy = `GROUP BY ${group.by.map((f) => `b.${f}`).join(', ')}`;
		if (sortField !== undefined) {
			const key = group.by.includes(sortField) ? `b.${sortField}` : `a_${sortField}`;
			order.push(`${key} ${desc ? 'DESC' : 'ASC'}`);
		}
		order.push(...group.by.map((f) => `b.${f}`));
	}
	const sql = [
		select,
		`FROM base b ${from}`,
		where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
		groupBy,
		order.length > 0 ? `ORDER BY ${order.join(', ')}` : ''
	]
		.filter((part) => part !== '')
		.join(' ');
	const raw = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
	return raw.map((r) => {
		if (group) {
			const row: Record<string, unknown> = {};
			for (const f of group.by) row[f] = r[`g_${f}`] ?? null;
			for (const name of Object.keys(group.aggregates)) row[name] = r[`a_${name}`] ?? null;
			return row;
		}
		const row: Record<string, unknown> = {};
		for (const f of plan.from) row[f] = r[`c_${f}`] ?? null;
		joins.forEach((j, i) => {
			row[j.as] = Object.fromEntries(j.fields.map((f) => [f, r[`j${i}_${f}`] ?? null]));
		});
		return row;
	});
}

function aggSql(agg: PlanAggregate, aliasOf: (ref: string) => string): string {
	if (agg === 'count') return 'COUNT(*)';
	const [kind, field] = Object.entries(agg)[0] as [string, string];
	return `${AGG_SQL[kind]}(${aliasOf(field)})`;
}

/** a random plan and the query string that asks it, drawn from the same generator for every test */
function randomPlan(next: () => number): { plan: QueryPlan; search: URLSearchParams } {
	const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
	const chance = (p: number) => next() < p;
	const from = ['c', 'n', 'x'];
	const onChoices: Array<[string, string | null]> = [
		['c', null],
		['c', 'f'],
		['n', 'g'],
		['x', 'f']
	];
	const joins: PlanJoin[] = [];
	const joinCount = pick([0, 0, 1, 1, 2]);
	for (let i = 0; i < joinCount; i++) {
		joins.push({
			dataset: PLAN_TABLE,
			on: pick(onChoices),
			type: pick(['inner', 'left'] as const),
			as: i === 0 ? 'j' : 'm',
			fields: ['f', 'g']
		});
	}
	const refs = [...from, ...joins.flatMap((j) => j.fields.map((f) => `${j.as}.${f}`))];
	type Template = Omit<PlanCondition, 'param'>;
	const templates: Template[] = [
		{ field: 'c', op: 'eq', type: 'string' },
		{ field: 'x', op: 'eq', type: 'number' },
		{ field: 'x', op: 'eq', type: 'string' },
		{ field: 'c', op: 'in', type: 'string' },
		{ field: 'n', op: 'in', type: 'number' },
		{ field: 'n', op: 'gte', type: 'number' },
		{ field: 'n', op: 'lte', type: 'number' },
		{ field: 'x', op: 'gte', type: 'string' },
		{ field: 'x', op: 'lte', type: 'number' },
		{ field: 'c', op: 'prefix', type: 'string' },
		{ field: 'c', op: 'prefix', type: 'string', fold: 'ascii' }
	];
	const first = joins[0];
	if (first) {
		templates.push(
			{ field: `${first.as}.g`, op: 'eq', type: 'number' },
			{ field: `${first.as}.f`, op: 'prefix', type: 'string', fold: 'ascii' },
			{ field: `${first.as}.f`, op: 'gte', type: 'string' }
		);
	}
	const search = new URLSearchParams();
	const where: PlanCondition[] = [];
	const conditionCount = pick([0, 1, 1, 2, 3]);
	for (let i = 0; i < conditionCount; i++) {
		const cond: PlanCondition = { ...pick(templates), param: `p${i}` };
		where.push(cond);
		if (!chance(0.85)) continue;
		const value = (): string =>
			cond.type === 'number'
				? String(pick(PLAN_INTS))
				: cond.op === 'prefix'
					? pick(PLAN_PREFIXES)
					: pick(PLAN_STRINGS);
		if (cond.op === 'in') {
			for (let v = 0; v <= Math.floor(next() * 2); v++) search.append(cond.param, value());
		} else {
			search.set(cond.param, value());
		}
	}
	let group: QueryPlan['group'];
	if (chance(0.5)) {
		const by = ['c', 'n', 'x'].filter(() => chance(0.4)).slice(0, 2);
		const pool: Array<[string, PlanAggregate]> = [
			['cnt', 'count'],
			['sn', { sum: 'n' }],
			['av', { avg: 'n' }],
			['mn', { min: 'x' }],
			['mx', { max: 'x' }],
			['cx', { count: 'x' }]
		];
		if (first) pool.push(['mf', { min: `${first.as}.f` }], ['sg', { sum: `${first.as}.g` }]);
		const aggregates: Record<string, PlanAggregate> = {};
		for (const [name, agg] of pool) if (chance(0.4)) aggregates[name] = agg;
		if (Object.keys(aggregates).length === 0) aggregates['cnt'] = 'count';
		group = { by, aggregates };
	}
	const sortable = group ? [...group.by, ...Object.keys(group.aggregates)] : refs;
	const sortList = sortable.filter(() => chance(0.5));
	const pageSize = 1 + Math.floor(next() * 6);
	const limit = chance(0.75) ? 1000 : Math.max(pageSize, 1 + Math.floor(next() * 40));
	const plan: QueryPlan = { from, pageSize, limit };
	if (joins.length > 0) plan.join = joins;
	if (where.length > 0) plan.where = where;
	if (group) plan.group = group;
	if (sortList.length > 0) {
		plan.sort = sortList;
		if (chance(0.7)) search.set('sort', `${chance(0.5) ? '-' : ''}${pick(sortList)}`);
	}
	return { plan, search };
}

describe('query plans against SQLite', () => {
	it('returns the rows, order, paging and refusals the database gives, over 300 random plans', () => {
		const next = lcg(20_261_115);
		const { base, right } = planFixture(next, 240);
		const db = planDatabase(base, right);
		const tables = planTables(base, right, true);
		let answered = 0;
		for (let c = 0; c < 300; c++) {
			const { plan, search } = randomPlan(next);
			const all = sqlRows(db, plan, search.toString());
			const pages = Math.max(1, Math.ceil(all.length / plan.pageSize));
			const page = next() < 0.1 ? pages + 1 : 1 + Math.floor(next() * pages);
			if (page > 1) search.set('page', String(page));
			const text = search.toString();
			const label = `${c}: ${text}`;
			const got = evaluatePlan(plan, text, tables);
			if (page > pages || all.length > plan.limit) {
				expect(got, label).toBeNull();
				continue;
			}
			const start = (page - 1) * plan.pageSize;
			expect(got, label).toEqual({
				items: all.slice(start, start + plan.pageSize),
				total: all.length,
				page,
				pages
			});
			answered += 1;
		}
		expect(answered).toBeGreaterThan(150);
		db.close();
	});

	it('gives the same answer with an index as with a scan, over 120 random plans', () => {
		const next = lcg(7_331);
		const { base, right } = planFixture(next, 240);
		const indexed = planTables(base, right, true);
		const scanned = planTables(base, right, false);
		for (let c = 0; c < 120; c++) {
			const { plan, search } = randomPlan(next);
			const text = search.toString();
			expect(evaluatePlan(plan, text, indexed), `${c}: ${text}`).toEqual(
				evaluatePlan(plan, text, scanned)
			);
		}
		expect(indexed.base.index?.built).toBeGreaterThan(0);
		expect(indexed.joined(PLAN_TABLE)?.index?.built).toBeGreaterThan(0);
	});

	it('holds one index entry per row for each field it builds, 10,000 entries over 5,000 rows', () => {
		const keys = Array.from({ length: 5000 }, (_, i) => `k${String(i).padStart(5, '0')}`);
		const rows = new Map(keys.map((k, i) => [k, { c: `v${i % 7}`, n: i }]));
		const index = new TableIndex(keys, rows);
		expect(index.equal('c', ['v3']).length).toBe(714);
		expect(index.range('n', 'gte', 2500).length).toBe(2500);
		expect(index.built).toBe(2);
		expect(index.entries).toBe(10_000);
	});
});

describe('query plans refuse what SQLite would answer differently', () => {
	const plan: QueryPlan = {
		from: ['c', 'n'],
		group: { by: ['c'], aggregates: { s: { sum: 'n' }, k: 'count' } },
		pageSize: 10,
		limit: 10
	};
	const tablesOf = (rows: Array<Record<string, unknown>>, joined?: Map<string, PlanTable>) => {
		const map = new Map(rows.map((row, i) => [`k${i}`, row]));
		const keys = [...map.keys()].sort(compareText);
		const base: PlanTable = { keys, rows: map };
		return {
			base,
			joined: (name: string) => (name === PLAN_TABLE ? joined?.get(name) : undefined)
		};
	};

	it('refuses a float that a sum reads, and answers when the float is outside the sum', () => {
		const floatSummed = tablesOf([{ c: 'a', n: 1.5 }]);
		expect(evaluatePlan(plan, '', floatSummed)).toBeNull();
		const counted: QueryPlan = { ...plan, group: { by: ['c'], aggregates: { k: 'count' } } };
		expect(evaluatePlan(counted, '', tablesOf([{ c: 'a', n: 1.5 }]))).not.toBeNull();
		const onlyB: QueryPlan = {
			...plan,
			where: [{ field: 'c', op: 'eq', param: 'c', type: 'string' }]
		};
		const mixed = tablesOf([
			{ c: 'a', n: 1.5 },
			{ c: 'b', n: 2 }
		]);
		expect(evaluatePlan(onlyB, 'c=b', mixed)?.items).toEqual([{ c: 'b', s: 2, k: 1 }]);
	});

	it('refuses a boolean or a nested value in a declared field, and ignores an undeclared one', () => {
		const flagged = { from: ['c', 'n'], pageSize: 10, limit: 10 } as QueryPlan;
		expect(evaluatePlan(flagged, '', tablesOf([{ c: 'a', n: true }]))).toBeNull();
		expect(evaluatePlan(flagged, '', tablesOf([{ c: 'a', n: { deep: 1 } }]))).toBeNull();
		expect(evaluatePlan(flagged, '', tablesOf([{ c: 'a', n: 1, extra: true }]))).not.toBeNull();
	});

	it('refuses a lone surrogate and a NUL in a declared text field', () => {
		const flagged = { from: ['c'], pageSize: 10, limit: 10 } as QueryPlan;
		expect(evaluatePlan(flagged, '', tablesOf([{ c: '\uD800' }]))).toBeNull();
		expect(evaluatePlan(flagged, '', tablesOf([{ c: 'a\0b' }]))).toBeNull();
		expect(evaluatePlan(flagged, '', tablesOf([{ c: '\u{1F600}' }]))).not.toBeNull();
	});

	it('refuses a sum past the safe integer range', () => {
		const big = tablesOf([
			{ c: 'a', n: Number.MAX_SAFE_INTEGER },
			{ c: 'a', n: Number.MAX_SAFE_INTEGER }
		]);
		expect(evaluatePlan(plan, '', big)).toBeNull();
	});

	it('refuses a join to a table that is not held', () => {
		const joined: QueryPlan = {
			from: ['c'],
			join: [{ dataset: PLAN_TABLE, on: ['c', null], type: 'inner', as: 'j', fields: ['f'] }],
			pageSize: 10,
			limit: 10
		};
		expect(evaluatePlan(joined, '', tablesOf([{ c: 'a' }]))).toBeNull();
	});

	it('answers an average of integers as SQLite does, and an empty sum as null', () => {
		const values = [2147483647, 2147483646, 1];
		const db = new DatabaseSync(':memory:');
		db.exec('CREATE TABLE t (c, n)');
		const insert = db.prepare('INSERT INTO t VALUES (?,?)');
		for (const n of values) insert.run('a', n);
		insert.run('b', null);
		const sqlAvg = (
			db.prepare('SELECT AVG(n) AS v FROM t WHERE c = ?').get('a') as { v: number }
		).v;
		const avg: QueryPlan = {
			from: ['c', 'n'],
			where: [{ field: 'c', op: 'eq', param: 'c', type: 'string' }],
			group: { by: ['c'], aggregates: { v: { avg: 'n' }, s: { sum: 'n' } } },
			pageSize: 10,
			limit: 10
		};
		const rows = tablesOf([...values.map((n) => ({ c: 'a', n })), { c: 'b' }]);
		expect(evaluatePlan(avg, 'c=a', rows)?.items).toEqual([
			{ c: 'a', v: sqlAvg, s: 4294967294 }
		]);
		expect(evaluatePlan(avg, 'c=b', rows)?.items).toEqual([{ c: 'b', v: null, s: null }]);
		db.close();
	});

	it('matches a prefix with ASCII-only case folding, as lower() does', () => {
		const folded: QueryPlan = {
			from: ['c'],
			where: [{ field: 'c', op: 'prefix', param: 'p', type: 'string', fold: 'ascii' }],
			pageSize: 10,
			limit: 10
		};
		const rows = tablesOf([{ c: 'ABC' }, { c: 'É' }, { c: 'abd' }]);
		const got = evaluatePlan(folded, 'p=ab', rows);
		expect(got?.items.map((r) => r['c'])).toEqual(['ABC', 'abd']);
		expect(evaluatePlan(folded, 'p=%C3%A9', rows)?.items).toEqual([]);
	});

	it('never matches a number with a text, and skips a condition whose parameter is absent', () => {
		const eq: QueryPlan = {
			from: ['c', 'n'],
			where: [
				{ field: 'n', op: 'eq', param: 'n', type: 'string' },
				{ field: 'n', op: 'gte', param: 'g', type: 'number' }
			],
			pageSize: 10,
			limit: 10
		};
		const rows = tablesOf([
			{ c: 'a', n: 5 },
			{ c: 'b', n: '5' }
		]);
		expect(evaluatePlan(eq, 'n=5', rows)?.items.map((r) => r['c'])).toEqual(['b']);
		expect(evaluatePlan(eq, '', rows)?.items.map((r) => r['c'])).toEqual(['a', 'b']);
		expect(evaluatePlan(eq, 'g=4', rows)?.items.map((r) => r['c'])).toEqual(['a']);
	});

	it('refuses a parameter the plan does not declare, a repeated sort and a page past the last', () => {
		const rows = tablesOf([{ c: 'a', n: 1 }]);
		const listed: QueryPlan = { from: ['c'], sort: ['c'], pageSize: 10, limit: 10 };
		expect(evaluatePlan(listed, 'x=1', rows)).toBeNull();
		expect(evaluatePlan(listed, 'sort=c&sort=c', rows)).toBeNull();
		expect(evaluatePlan(listed, 'sort=n', rows)).toBeNull();
		expect(evaluatePlan(listed, 'page=2', rows)).toBeNull();
		expect(evaluatePlan(listed, 'sort=-c', rows)?.items).toEqual([{ c: 'a' }]);
	});
});

// #endregion
