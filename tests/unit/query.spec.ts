import { describe, expect, it } from 'vitest';
import {
	canonicalJson,
	datasetProof,
	defineRoute,
	evaluateQuery,
	injectClientTag,
	PROOF_MISMATCH,
	shapeQuery,
	verifyProof,
	type Artifact,
	type QuerySchema
} from '../../src/protocol/index';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { renderLocal } from '../../src/sw/render';

const base64url = (hex: string) =>
	btoa(String.fromCharCode(...hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

const people = [
	{ name: 'Ada', department: 'math', age: 36 },
	{ name: 'Bo', department: 'cs', age: 25 },
	{ name: 'Cy', department: 'math', age: 25 },
	{ name: 'Di', department: 'art', age: 41 },
	{ name: 'Ed', department: 'math', age: 30 }
];
const schema: QuerySchema = {
	list: 'people',
	filter: { department: 'string', age: 'number' },
	sort: ['name', 'age'],
	pageSize: 2
};
const data = { people, proof: { count: 5, digest: 'unused' } };
const names = (search: string, over: Partial<QuerySchema> = {}, source: unknown = data) =>
	evaluateQuery({ ...schema, ...over }, source, search)?.items.map((p) => p['name']);
const summary = (search: string, over: Partial<QuerySchema> = {}) => {
	const result = evaluateQuery({ ...schema, ...over }, data, search);
	return result && { total: result.total, page: result.page, pages: result.pages };
};

describe('canonicalJson', () => {
	it('sorts keys at every depth, keeps array order and writes no whitespace', () => {
		expect(canonicalJson({ b: [{ z: 1, y: 2 }, 3], a: 'x' })).toBe(
			'{"a":"x","b":[{"y":2,"z":1},3]}'
		);
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});

	it('orders keys by code unit, not by locale', () => {
		expect(canonicalJson({ b: 1, a: 2, B: 3, é: 4 })).toBe('{"B":3,"a":2,"b":1,"é":4}');
	});

	it('writes the scalars JSON does, and drops or nulls what JSON drops or nulls', () => {
		expect(canonicalJson(null)).toBe('null');
		expect(canonicalJson('a"b')).toBe('"a\\"b"');
		expect(canonicalJson(1.5)).toBe('1.5');
		expect(canonicalJson(true)).toBe('true');
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalJson([undefined, () => 1])).toBe('[null,null]');
		expect(canonicalJson(undefined)).toBe('null');
		expect(canonicalJson(Number.NaN)).toBe('null');
	});

	it('follows toJSON, so a value and its JSON round trip give the same text', () => {
		const row = { at: new Date(0), n: 1 };
		expect(canonicalJson(row)).toBe('{"at":"1970-01-01T00:00:00.000Z","n":1}');
		expect(canonicalJson(JSON.parse(JSON.stringify(row)))).toBe(canonicalJson(row));
		expect(canonicalJson({ toJSON: 'not a function', a: 1 })).toBe(
			'{"a":1,"toJSON":"not a function"}'
		);
	});
});

describe('datasetProof', () => {
	it('counts the items and hashes their canonical JSON with SHA-256', async () => {
		expect(await datasetProof([])).toEqual({
			count: 0,
			digest: base64url('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945')
		});
		expect(await datasetProof([{ b: 'x', a: 1 }])).toEqual({
			count: 1,
			digest: base64url('a103829f0f464d4252e13d7b7911f6abd24978a09a93fdd84e37c32cde9345c2')
		});
	});

	it('changes with one value, one item or the order of the items, and not with key order', async () => {
		const one = await datasetProof([{ a: 1 }, { a: 2 }]);
		expect((await datasetProof([{ a: 1 }, { a: 3 }])).digest).not.toBe(one.digest);
		expect((await datasetProof([{ a: 1 }])).digest).not.toBe(one.digest);
		expect((await datasetProof([{ a: 2 }, { a: 1 }])).digest).not.toBe(one.digest);
		expect(await datasetProof([{ a: 1, b: 1 }])).toEqual(await datasetProof([{ b: 1, a: 1 }]));
	});
});

describe('verifyProof', () => {
	it('accepts a collection with its own proof, also after a JSON round trip', async () => {
		const good = { people, proof: await datasetProof(people) };
		expect(await verifyProof(schema, good)).toBe(true);
		expect(await verifyProof(schema, JSON.parse(JSON.stringify(good)))).toBe(true);
	});

	it('refuses a missing or malformed proof, a wrong count, a wrong digest and a missing list', async () => {
		const proof = await datasetProof(people);
		const bad: unknown[] = [
			{ people },
			{ people, proof: 'x' },
			{ people, proof: [] },
			{ people, proof: { count: 4, digest: proof.digest } },
			{ people, proof: { count: '5', digest: proof.digest } },
			{ people, proof: { count: 5, digest: 'abc' } },
			{ people, proof: { count: 5, digest: 7 } },
			{ people: people.slice(1), proof },
			{ people: [{ ...people[0], age: 37 }, ...people.slice(1)], proof },
			{ people: 'none', proof },
			{ proof },
			null,
			[],
			'text'
		];
		for (const value of bad) expect(await verifyProof(schema, value)).toBe(false);
	});
});

describe('evaluateQuery', () => {
	it('selects everything on one page when the query string is empty, with or without the ?', () => {
		expect(names('')).toEqual(['Ada', 'Bo']);
		expect(names('?')).toEqual(['Ada', 'Bo']);
		expect(summary('')).toEqual({ total: 5, page: 1, pages: 3 });
		expect(names('', { pageSize: undefined })).toEqual(['Ada', 'Bo', 'Cy', 'Di', 'Ed']);
		expect(summary('', { pageSize: undefined })).toEqual({ total: 5, page: 1, pages: 1 });
	});

	it('filters a string field by equality, and a repeated parameter matches any of its values', () => {
		expect(names('?department=math')).toEqual(['Ada', 'Cy']);
		expect(summary('?department=math')).toEqual({ total: 3, page: 1, pages: 2 });
		expect(names('?department=math&page=2')).toEqual(['Ed']);
		expect(names('?department=math&department=art', { pageSize: 10 })).toEqual([
			'Ada',
			'Cy',
			'Di',
			'Ed'
		]);
		expect(names('?department=m%61th&department=cs', { pageSize: 10 })).toEqual([
			'Ada',
			'Bo',
			'Cy',
			'Ed'
		]);
	});

	it('filters a number field as a number and combines fields with and', () => {
		expect(names('?age=25&age=30', { pageSize: 10 })).toEqual(['Bo', 'Cy', 'Ed']);
		expect(names('?department=math&age=25')).toEqual(['Cy']);
		expect(names('?age=25.0')).toEqual(['Bo', 'Cy']);
		expect(names('?age=0x19')).toEqual(['Bo', 'Cy']);
		expect(names('?age=26')).toEqual([]);
	});

	it('returns an empty first page for a filter that matches nothing, and refuses page 2 of it', () => {
		expect(evaluateQuery(schema, data, '?department=none')).toEqual({
			items: [],
			total: 0,
			page: 1,
			pages: 1
		});
		expect(evaluateQuery(schema, data, '?department=none&page=2')).toBeNull();
	});

	it('sorts ascending and descending, and ties keep the stored order either way', () => {
		expect(names('?sort=name', { pageSize: 10 })).toEqual(['Ada', 'Bo', 'Cy', 'Di', 'Ed']);
		expect(names('?sort=-name', { pageSize: 10 })).toEqual(['Ed', 'Di', 'Cy', 'Bo', 'Ada']);
		expect(names('?sort=age', { pageSize: 10 })).toEqual(['Bo', 'Cy', 'Ed', 'Ada', 'Di']);
		expect(names('?sort=-age', { pageSize: 10 })).toEqual(['Di', 'Ada', 'Ed', 'Bo', 'Cy']);
	});

	it('sorts before it pages, and filters before it sorts', () => {
		expect(names('?sort=name&page=2')).toEqual(['Cy', 'Di']);
		expect(names('?sort=-age&page=3')).toEqual(['Cy']);
		expect(names('?department=math&sort=-name')).toEqual(['Ed', 'Cy']);
		expect(summary('?department=math&sort=-name&page=2')).toEqual({
			total: 3,
			page: 2,
			pages: 2
		});
	});

	it('compares numbers by value and strings by code unit, with numbers first, then strings, then the rest', () => {
		const rows = (key: string, values: unknown[]) => ({
			list: values.map((value, id) => ({ id, [key]: value }))
		});
		const order = (key: string, values: unknown[], search: string) =>
			evaluateQuery({ list: 'list', sort: [key] }, rows(key, values), search)?.items.map(
				(item) => item[key]
			);
		expect(order('n', [10, 9, 100], '?sort=n')).toEqual([9, 10, 100]);
		expect(order('s', ['b', 'B', 'a'], '?sort=s')).toEqual(['B', 'a', 'b']);
		expect(order('v', ['x', 2, null, 1, 'a'], '?sort=v')).toEqual([1, 2, 'a', 'x', null]);
		expect(order('v', ['x', 2, null, 1, 'a'], '?sort=-v')).toEqual([null, 'x', 'a', 2, 1]);
	});

	it('compares a string filter as text for strings, numbers and booleans, and a number filter by type', () => {
		const mixed = {
			list: [
				{ id: 5, tag: 'five' },
				{ id: '5', tag: 'text' },
				{ id: true, tag: 'yes' },
				{ id: null, tag: 'none' },
				{ tag: 'missing' }
			]
		};
		const tags = (type: 'string' | 'number', search: string) =>
			evaluateQuery({ list: 'list', filter: { id: type } }, mixed, search)?.items.map(
				(item) => item['tag']
			);
		expect(tags('string', '?id=5')).toEqual(['five', 'text']);
		expect(tags('string', '?id=true')).toEqual(['yes']);
		expect(tags('string', '?id=null')).toEqual([]);
		expect(tags('number', '?id=5')).toEqual(['five']);
	});

	it('is one page of everything when pageSize is absent, and page 1 is the only page', () => {
		const open = { ...schema, pageSize: undefined };
		expect(evaluateQuery(open, data, '?page=1')?.pages).toBe(1);
		expect(evaluateQuery(open, data, '?page=2')).toBeNull();
	});

	it('does not reorder or change the stored collection', () => {
		const before = JSON.stringify(data);
		evaluateQuery(schema, data, '?sort=-age&department=math');
		expect(JSON.stringify(data)).toBe(before);
	});

	it.each([
		['an unknown parameter', '?colour=red'],
		['an unknown parameter beside a valid one', '?department=math&colour=red'],
		['a parameter named like an inherited property', '?constructor=1'],
		['a number filter with text', '?age=old'],
		['an empty number filter', '?age='],
		['a blank number filter', '?age=%20'],
		['an infinite number filter', '?age=Infinity'],
		['one bad value among good number values', '?age=25&age=x'],
		['a sort that is not listed', '?sort=department'],
		['a descending sort that is not listed', '?sort=-department'],
		['an empty sort', '?sort='],
		['a bare minus sort', '?sort=-'],
		['a double minus sort', '?sort=--name'],
		['a sort given twice', '?sort=name&sort=age'],
		['a sort given twice with the same value', '?sort=name&sort=name'],
		['page 0', '?page=0'],
		['a negative page', '?page=-1'],
		['a fractional page', '?page=1.5'],
		['a page with text', '?page=two'],
		['an empty page', '?page='],
		['a page with a leading zero', '?page=01'],
		['a page given twice', '?page=1&page=2'],
		['a page past the last', '?page=4'],
		['a page past the last of a filtered result', '?department=cs&page=2']
	])('answers null for %s', (_name, search) => {
		expect(evaluateQuery(schema, data, search)).toBeNull();
	});

	it.each([
		['data that is not an object', 'text'],
		['data that is an array', []],
		['no list', { proof: 1 }],
		['a list that is not an array', { people: 'none' }],
		['a primitive item', { people: [{ name: 'a' }, 7] }],
		['a null item', { people: [null] }],
		['an array item', { people: [[1]] }]
	])('answers null for %s, even for the empty query', (_name, source) => {
		expect(evaluateQuery(schema, source, '')).toBeNull();
	});

	it('does not read a list the data merely inherits', () => {
		expect(evaluateQuery({ list: 'toString' }, {}, '')).toBeNull();
	});
});

describe('shapeQuery', () => {
	it('replaces the list with the page and adds the page numbers, keeping the other keys', async () => {
		const proven = { people, note: 'kept', proof: await datasetProof(people) };
		const shaped = await shapeQuery(schema, proven, '?department=math&page=2');
		expect(shaped).toEqual({
			ok: true,
			data: {
				people: [people[4]],
				note: 'kept',
				proof: proven.proof,
				query: { total: 3, page: 2, pages: 2 }
			}
		});
	});

	it('refuses a collection that fails its proof before it reads the query', async () => {
		const shaped = await shapeQuery(schema, data, '?department=math');
		expect(shaped).toEqual({ ok: false, reason: PROOF_MISMATCH });
		expect(await shapeQuery(schema, data, '?colour=red')).toEqual({
			ok: false,
			reason: PROOF_MISMATCH
		});
	});

	it('refuses a query the schema does not declare', async () => {
		const proven = { people, proof: await datasetProof(people) };
		expect(await shapeQuery(schema, proven, '?colour=red')).toEqual({
			ok: false,
			reason: 'query is not one the route declares'
		});
	});
});

describe('evaluateQuery against an independent oracle', () => {
	let seed = 20_261_025;
	const next = () => {
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return seed / 2 ** 32;
	};
	const below = (n: number) => Math.floor(next() * n);
	const pick = <T>(list: readonly T[]): T => list[below(list.length)] as T;

	const NAMES = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'];
	const DEPARTMENTS = ['math', 'cs', 'art', 'bio'];
	type Row = { name: string; department: string; age: number };
	type Query = {
		department?: string[];
		age?: number[];
		sort?: { field: 'name' | 'age'; descending: boolean };
		page?: number;
	};

	const oracle = (rows: Row[], query: Query, pageSize: number | undefined) => {
		const kept = rows
			.map((row, index) => ({ row, index }))
			.filter(
				({ row }) =>
					(query.department === undefined || query.department.includes(row.department)) &&
					(query.age === undefined || query.age.includes(row.age))
			);
		if (query.sort) {
			const { field, descending } = query.sort;
			kept.sort((a, b) => {
				const x = a.row[field];
				const y = b.row[field];
				const order = x < y ? -1 : x > y ? 1 : 0;
				return (descending ? -order : order) || a.index - b.index;
			});
		}
		const items = kept.map(({ row }) => row);
		const pages = pageSize === undefined ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
		const page = query.page ?? 1;
		const start = pageSize === undefined ? 0 : (page - 1) * pageSize;
		return {
			items: pageSize === undefined ? items : items.slice(start, start + pageSize),
			total: items.length,
			page,
			pages
		};
	};

	const randomRows = (): Row[] =>
		Array.from({ length: below(26) }, () => ({
			name: pick(NAMES),
			department: pick(DEPARTMENTS),
			age: 20 + below(6)
		}));

	const randomQuery = (rows: Row[], pageSize: number | undefined): Query => {
		const query: Query = {};
		if (below(2)) {
			query.department = Array.from({ length: 1 + below(2) }, () =>
				pick([...DEPARTMENTS, 'none'])
			);
		}
		if (below(2)) query.age = Array.from({ length: 1 + below(2) }, () => 18 + below(10));
		if (below(2))
			query.sort = { field: pick(['name', 'age'] as const), descending: below(2) === 1 };
		if (below(2)) {
			const pages = oracle(rows, query, pageSize).pages;
			query.page = 1 + below(pages);
		}
		return query;
	};

	const searchOf = (query: Query) => {
		const params: Array<[string, string]> = [];
		for (const value of query.department ?? []) params.push(['department', value]);
		for (const value of query.age ?? []) params.push(['age', String(value)]);
		if (query.sort) {
			params.push(['sort', `${query.sort.descending ? '-' : ''}${query.sort.field}`]);
		}
		if (query.page !== undefined) params.push(['page', String(query.page)]);
		for (let i = params.length - 1; i > 0; i--) {
			const j = below(i + 1);
			[params[i], params[j]] = [params[j] as [string, string], params[i] as [string, string]];
		}
		return `?${new URLSearchParams(params)}`;
	};

	const template = {
		source: '<html><head></head><body><p>{{query.total}}/{{query.page}}/{{query.pages}}</p><ul>{{#each people}}<li>{{name}} {{department}} {{age}}</li>{{/each}}</ul></body></html>'
	};
	const html = (result: ReturnType<typeof oracle>) =>
		`<html><head></head><body><p>${result.total}/${result.page}/${result.pages}</p><ul>${result.items
			.map((row) => `<li>${row.name} ${row.department} ${row.age}</li>`)
			.join('')}</ul></body></html>`;

	it('returns what plain filter, sort and slice return for 300 random collections and queries', async () => {
		let matched = 0;
		for (let run = 0; run < 300; run++) {
			const rows = randomRows();
			const pageSize = below(3) === 0 ? undefined : 1 + below(6);
			const spec: QuerySchema = {
				list: 'people',
				filter: { department: 'string', age: 'number' },
				sort: ['name', 'age'],
				...(pageSize === undefined ? {} : { pageSize })
			};
			const query = randomQuery(rows, pageSize);
			const search = searchOf(query);
			const expected = oracle(rows, query, pageSize);
			const source = { people: rows, proof: await datasetProof(rows) };
			expect(evaluateQuery(spec, source, search), `${run}: ${search}`).toEqual(expected);

			const route = defineRoute('/people', {
				strategy: 'template',
				template,
				load: () => source,
				query: spec
			});
			const config = createSpool({ routes: [route], store: memoryStore() }).config;
			const stored: Artifact = {
				protocol: 1,
				id: '/people',
				scope: 'public',
				strategy: 'template',
				deps: [],
				vector: 0,
				body: { data: JSON.parse(JSON.stringify(source)) }
			};
			const rendered = await renderLocal(
				config,
				config.routes[0] as never,
				stored,
				{},
				search
			);
			expect(rendered, `${run}: ${search}`).toEqual({
				ok: true,
				html: injectClientTag(html(expected), config.clientTag)
			});
			if (expected.items.length > 0) matched += 1;
		}
		expect(matched).toBeGreaterThan(100);
	});
});
