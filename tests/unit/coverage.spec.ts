import { describe, expect, it } from 'vitest';
import { devCoverage, uncoveredLine } from '../../src/plugins/coverage';
import { defineRoute, serializeRoute, type SerializedRoute } from '../../src/protocol/index';
import { coverageReport } from '../../src/sw/coverage';

const API = 'https://api.test';
const PAGE = 'https://site.test';
const family = (pattern: string, extra: Record<string, unknown> = {}): SerializedRoute =>
	serializeRoute(
		defineRoute(pattern, {
			strategy: 'data',
			family: { dataset: 'courses', key: 'id' },
			...extra
		} as Parameters<typeof defineRoute>[1])
	);

describe('devCoverage', () => {
	const families = [family('/api/courses/:id')];
	const watch = () => {
		const lines: string[] = [];
		const observe = devCoverage(families, (line) => lines.push(line));
		const get = (path: string, fetchDest: string | null = 'empty', method = 'GET') =>
			observe({ method, url: `${PAGE}${path}`, fetchDest });
		return { lines, get };
	};

	it('prints each uncovered fetch GET once, with its query', () => {
		const { lines, get } = watch();
		get('/api/courses/c1');
		get('/api/teachers?sort=name');
		get('/api/teachers?sort=name');
		get('/api/rooms');
		expect(lines).toEqual([
			uncoveredLine('/api/teachers?sort=name'),
			uncoveredLine('/api/rooms')
		]);
	});

	it('ignores a navigation, a script, a write and spool own paths', () => {
		const { lines, get } = watch();
		get('/about', 'document');
		get('/app.js', 'script');
		get('/api/x', null);
		get('/api/teachers', 'empty', 'POST');
		get('/.spool/sync?from=0');
		get('/spool-sw.js');
		expect(lines).toEqual([]);
	});

	it('formats the line the dev server prints', () => {
		expect(uncoveredLine('/x')).toBe('spool: uncovered GET /x');
	});
});

describe('coverageReport', () => {
	const families = [
		family('/v2/courses/:id', { origin: API }),
		serializeRoute(
			defineRoute('/v2/courses', {
				strategy: 'data',
				origin: API,
				query: { list: 'courses', dataset: 'courses', filter: { title: 'string' } },
				load: () => ({})
			})
		)
	];

	it('lists the GETs no family covers, in first-seen order, and ignores writes', () => {
		const report = coverageReport(
			[
				{ method: 'GET', url: `${API}/v2/courses/c1` },
				{ method: 'GET', url: `${API}/v2/teachers` },
				{ method: 'POST', url: `${API}/v2/courses` },
				{ method: 'GET', url: `${API}/v2/courses/c2` },
				{ method: 'GET', url: `${API}/v2/teachers` }
			],
			families,
			PAGE
		);
		expect(report).toEqual([`${API}/v2/teachers`]);
	});

	it('covers a same-origin family only on the page origin', () => {
		const own = [family('/api/courses/:id')];
		const report = coverageReport(
			[
				{ method: 'GET', url: `${PAGE}/api/courses/c1` },
				{ method: 'GET', url: `${API}/api/courses/c1` }
			],
			own,
			PAGE
		);
		expect(report).toEqual([`${API}/api/courses/c1`]);
	});

	it('covers a query only with the parameters the family takes', () => {
		const report = coverageReport(
			[
				{ method: 'GET', url: `${API}/v2/courses?title=Algebra` },
				{ method: 'GET', url: `${API}/v2/courses?page=2&sort=title` },
				{ method: 'GET', url: `${API}/v2/courses?title=Algebra&color=red` }
			],
			families,
			PAGE
		);
		expect(report).toEqual([`${API}/v2/courses?title=Algebra&color=red`]);
	});

	it('covers nothing for a data route that is neither a family nor cross-origin', () => {
		const plain = [
			serializeRoute(defineRoute('/api/plain/:id', { strategy: 'data', load: () => ({}) }))
		];
		expect(
			coverageReport([{ method: 'GET', url: `${PAGE}/api/plain/c1` }], plain, PAGE)
		).toEqual([`${PAGE}/api/plain/c1`]);
	});
});
