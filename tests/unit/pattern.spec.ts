import { describe, expect, it } from 'vitest';
import {
	checkPattern,
	fillPattern,
	matchPattern,
	matchRoute,
	ProtocolError
} from '../../src/protocol/index';

describe('matchPattern', () => {
	it('captures named segments', () => {
		expect(matchPattern('/node/:id', '/node/42')).toEqual({ id: '42' });
		expect(matchPattern('/a/:b/c/:d', '/a/x/c/y')).toEqual({ b: 'x', d: 'y' });
	});

	it('matches literal paths with no params', () => {
		expect(matchPattern('/about', '/about')).toEqual({});
		expect(matchPattern('/', '/')).toEqual({});
	});

	it('ignores one trailing slash on either side', () => {
		expect(matchPattern('/node/:id', '/node/42/')).toEqual({ id: '42' });
		expect(matchPattern('/node/:id/', '/node/42')).toEqual({ id: '42' });
	});

	it('refuses a different length, a different literal and an empty capture', () => {
		expect(matchPattern('/node/:id', '/node')).toBeNull();
		expect(matchPattern('/node/:id', '/node/1/2')).toBeNull();
		expect(matchPattern('/node/:id', '/page/1')).toBeNull();
		expect(matchPattern('/node/:id', '/node//')).toBeNull();
		expect(matchPattern('/a/:b/c', '/a//c')).toBeNull();
	});

	it('lets a final ** take any number of segments, none included', () => {
		expect(matchPattern('/**', '/')).toEqual({});
		expect(matchPattern('/**', '/a/b/c')).toEqual({});
		expect(matchPattern('/docs/:id/**', '/docs/7')).toEqual({ id: '7' });
		expect(matchPattern('/docs/:id/**', '/docs/7/x/y/')).toEqual({ id: '7' });
		expect(matchPattern('/docs/**', '/other/x')).toBeNull();
		expect(matchPattern('/docs/:id/**', '/docs')).toBeNull();
	});

	it('decodes percent escapes and refuses a malformed one', () => {
		expect(matchPattern('/tag/:name', '/tag/a%20b')).toEqual({ name: 'a b' });
		expect(matchPattern('/tag/:name', '/tag/%E0%A4%A')).toBeNull();
	});
});

describe('fillPattern', () => {
	it('is the inverse of matchPattern', () => {
		const params = { b: 'a b', d: 'x/y' };
		const path = fillPattern('/a/:b/c/:d', params);
		expect(path).toBe('/a/a%20b/c/x%2Fy');
		expect(matchPattern('/a/:b/c/:d', path)).toEqual(params);
	});

	it('names the missing parameter', () => {
		expect(() => fillPattern('/a/:b', {})).toThrow(/missing parameter "b"/);
	});

	it('has no path to fill for a **', () => {
		expect(() => fillPattern('/a/**', {})).toThrow(/no single path/);
	});
});

describe('checkPattern', () => {
	it.each([
		['no/leading/slash', /must start with/],
		['/a//b', /empty segment/],
		['/a/:', /bad parameter name/],
		['/a/:1x', /bad parameter name/],
		['/a/:b/:b', /duplicate parameter/],
		['/**/a', /"\*\*" must be the last segment/]
	])('rejects %s', (pattern, message) => {
		expect(() => checkPattern(pattern)).toThrow(message);
		try {
			checkPattern(pattern);
		} catch (error) {
			expect(error).toBeInstanceOf(ProtocolError);
			expect((error as ProtocolError).code).toBe('bad-pattern');
		}
	});

	it('accepts the root and a plain pattern', () => {
		expect(() => checkPattern('/')).not.toThrow();
		expect(() => checkPattern('/a/:b_1/c')).not.toThrow();
		expect(() => checkPattern('/**')).not.toThrow();
		expect(() => checkPattern('/a/:b/**')).not.toThrow();
	});
});

describe('matchRoute', () => {
	const routes = [{ pattern: '/node/:id' }, { pattern: '/node/new' }];

	it('returns the first route that fits, with its params', () => {
		expect(matchRoute(routes, '/node/new')).toEqual({
			route: routes[0],
			params: { id: 'new' }
		});
	});

	it('returns null when nothing fits', () => {
		expect(matchRoute(routes, '/other')).toBeNull();
	});
});
