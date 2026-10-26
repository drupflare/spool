import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { evaluateQuery, type QuerySchema } from '../../src/protocol/index';

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
