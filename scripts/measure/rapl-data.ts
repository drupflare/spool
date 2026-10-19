import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** a seeded generator (mulberry32) so a rebuilt database holds the same rows */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** synthetic enrollment data, seeded; no real student records. 60 departments, 24 terms, `scale` x 1.8M enrollments */
export function buildEnrollment(dir: string, scale = 1): string {
	const path = join(dir, 'enroll.sqlite');
	if (existsSync(path)) return path;
	const r = rng(20261019);
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE departments(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE terms(id INTEGER PRIMARY KEY, label TEXT, seq INTEGER);
CREATE TABLE courses(id INTEGER PRIMARY KEY, dept_id INTEGER, level INTEGER, credits INTEGER);
CREATE TABLE instructors(id INTEGER PRIMARY KEY, dept_id INTEGER);
CREATE TABLE sections(id INTEGER PRIMARY KEY, course_id INTEGER, term_id INTEGER, instructor_id INTEGER, capacity INTEGER);
CREATE TABLE students(id INTEGER PRIMARY KEY, major_dept_id INTEGER, cohort_term_id INTEGER);
CREATE TABLE enrollments(student_id INTEGER, section_id INTEGER, grade_points REAL, status TEXT);`);
	const D = 60;
	const T = 24;
	const C = 6000 * scale;
	const I = 1500;
	const S = 60000 * scale;
	const ST = 120000 * scale;
	const E = 1_800_000 * scale;
	const pick = (n: number) => 1 + Math.floor(r() * n);
	db.exec('BEGIN');
	let p = db.prepare('INSERT INTO departments VALUES(?,?)');
	for (let i = 1; i <= D; i++) p.run(i, `Department ${i}`);
	p = db.prepare('INSERT INTO terms VALUES(?,?,?)');
	for (let i = 1; i <= T; i++) {
		p.run(
			i,
			`${2019 + Math.floor((i - 1) / 3)} ${['Spring', 'Summer', 'Fall'][(i - 1) % 3]}`,
			i
		);
	}
	p = db.prepare('INSERT INTO courses VALUES(?,?,?,?)');
	for (let i = 1; i <= C; i++) p.run(i, 1 + Math.floor(r() * r() * D), pick(4), pick(4));
	p = db.prepare('INSERT INTO instructors VALUES(?,?)');
	for (let i = 1; i <= I; i++) p.run(i, pick(D));
	p = db.prepare('INSERT INTO sections VALUES(?,?,?,?,?)');
	for (let i = 1; i <= S; i++) p.run(i, pick(C), pick(T), pick(I), 20 + Math.floor(r() * 180));
	p = db.prepare('INSERT INTO students VALUES(?,?,?)');
	for (let i = 1; i <= ST; i++) p.run(i, pick(D), pick(T - 3));
	db.exec('COMMIT');
	db.exec('BEGIN');
	p = db.prepare('INSERT INTO enrollments VALUES(?,?,?,?)');
	const status = ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'W', 'D'];
	for (let i = 0; i < E; i++) {
		const s = status[Math.floor(r() * status.length)] as string;
		const g = s === 'A' ? Math.round(r() * r() * 16 + (1 - r()) * 16 * 0.55) / 4 : null;
		p.run(pick(ST), pick(S), g, s);
	}
	db.exec('COMMIT');
	db.exec(`CREATE INDEX ix_e_sec ON enrollments(section_id); CREATE INDEX ix_e_stu ON enrollments(student_id);
CREATE INDEX ix_s_course ON sections(course_id); CREATE INDEX ix_s_term ON sections(term_id); CREATE INDEX ix_c_dept ON courses(dept_id);
CREATE INDEX ix_st_dept ON students(major_dept_id); ANALYZE;`);
	db.close();
	return path;
}

/** a synthetic CMS: 5,000 nodes with tags, a menu, blocks and 20,000 comments */
export function buildCms(dir: string): string {
	const path = join(dir, 'cms.sqlite');
	if (existsSync(path)) return path;
	const r = rng(77);
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE nodes(id INTEGER PRIMARY KEY, title TEXT, body TEXT, uid INTEGER, created INTEGER, type TEXT);
CREATE TABLE terms(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE node_terms(node_id INTEGER, term_id INTEGER);
CREATE TABLE menu(id INTEGER PRIMARY KEY, parent INTEGER, title TEXT, path TEXT, weight INTEGER);
CREATE TABLE blocks(id INTEGER PRIMARY KEY, region TEXT, title TEXT, body TEXT, weight INTEGER);
CREATE TABLE comments(id INTEGER PRIMARY KEY, node_id INTEGER, uid INTEGER, body TEXT, created INTEGER);`);
	const word = () =>
		r()
			.toString(36)
			.slice(2, 5 + Math.floor(r() * 7));
	const text = (n: number) => Array.from({ length: n }, word).join(' ');
	const pick = (n: number) => 1 + Math.floor(r() * n);
	db.exec('BEGIN');
	for (let i = 1; i <= 200; i++) db.prepare('INSERT INTO users VALUES(?,?)').run(i, text(2));
	for (let i = 1; i <= 400; i++) db.prepare('INSERT INTO terms VALUES(?,?)').run(i, text(1));
	for (let i = 1; i <= 5000; i++) {
		db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?)').run(
			i,
			text(6),
			text(150),
			pick(200),
			1.6e9 + i * 1000,
			i % 3 ? 'article' : 'page'
		);
		for (let k = 0; k < 3; k++)
			db.prepare('INSERT INTO node_terms VALUES(?,?)').run(i, pick(400));
	}
	for (let i = 1; i <= 80; i++) {
		db.prepare('INSERT INTO menu VALUES(?,?,?,?,?)').run(
			i,
			i % 10 === 1 ? 0 : pick(8),
			text(2),
			`/node/${i}`,
			Math.floor(r() * 20)
		);
	}
	for (let i = 1; i <= 24; i++) {
		db.prepare('INSERT INTO blocks VALUES(?,?,?,?,?)').run(
			i,
			['header', 'sidebar', 'footer', 'content_top'][i % 4] as string,
			text(3),
			text(40),
			i
		);
	}
	for (let i = 1; i <= 20000; i++) {
		db.prepare('INSERT INTO comments VALUES(?,?,?,?,?)').run(
			i,
			pick(5000),
			pick(200),
			text(30),
			1.6e9 + i
		);
	}
	db.exec('COMMIT');
	db.exec(
		'CREATE INDEX ix_nt ON node_terms(node_id); CREATE INDEX ix_nt2 ON node_terms(term_id); CREATE INDEX ix_cm ON comments(node_id); CREATE INDEX ix_nc ON nodes(created); ANALYZE;'
	);
	db.close();
	return path;
}

/** both databases under `dir`, created when missing */
export function buildAll(dir: string, scale = 1): string[] {
	mkdirSync(dir, { recursive: true });
	return [buildEnrollment(dir, scale), buildCms(dir)];
}
