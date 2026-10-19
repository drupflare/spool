import { describe, expect, it } from 'vitest';
import {
	MANIFEST_SCHEMA,
	manifestRoutes,
	parseManifest,
	ProtocolError
} from '../../src/protocol/index';

const route = (extra: Record<string, unknown> = {}) => ({
	pattern: '/about',
	strategy: 'static',
	version: 'v1',
	...extra
});
const manifest = (...routes: unknown[]) => ({ schema: MANIFEST_SCHEMA, routes });

describe('parseManifest', () => {
	it('keeps what a valid manifest says', () => {
		const parsed = parseManifest(
			manifest(
				route({
					freshness: { maxStale: 60, mode: 'hard' },
					offline: 'refuse',
					sync: 'deferred'
				}),
				route({ pattern: '/docs/:slug', version: 'sha256-abc=' })
			)
		);
		expect(parsed.routes).toHaveLength(2);
		expect(parsed.routes[0]).toMatchObject({ offline: 'refuse', sync: 'deferred' });
	});

	it.each([
		['not an object', null],
		['a wrong schema', { schema: 2, routes: [] }],
		['routes that are not a list', { schema: 1, routes: {} }],
		['a route that is not an object', manifest(1)],
		['a pattern that is not a string', manifest(route({ pattern: 1 }))],
		['a pattern with no leading slash', manifest(route({ pattern: 'about' }))],
		['another strategy', manifest(route({ strategy: 'template' }))],
		['an empty version', manifest(route({ version: '' }))],
		['a long version', manifest(route({ version: 'x'.repeat(257) }))],
		['a version that is not a string', manifest(route({ version: 3 }))],
		['freshness that is not an object', manifest(route({ freshness: 3 }))],
		['a zero bound', manifest(route({ freshness: { maxStale: 0 } }))],
		['a bound that is not a number', manifest(route({ freshness: { maxStale: '1' } }))],
		['an unknown freshness mode', manifest(route({ freshness: { mode: 'x' } }))],
		['an unknown offline rule', manifest(route({ offline: 'x' }))],
		['an unknown sync rule', manifest(route({ sync: 'x' }))],
		['a pattern declared twice', manifest(route(), route())]
	])('refuses %s', (_name, value) => {
		expect(() => parseManifest(value)).toThrow(ProtocolError);
		try {
			parseManifest(value);
		} catch (error) {
			expect((error as ProtocolError).code).toBe('bad-manifest');
		}
	});
});

describe('manifestRoutes', () => {
	it('fills the defaults of a public route and carries the version', () => {
		const [out] = manifestRoutes(parseManifest(manifest(route())));
		expect(out).toEqual({
			pattern: '/about',
			strategy: 'static',
			scope: 'public',
			freshness: { maxStale: 900, mode: 'soft' },
			persist: true,
			offline: 'serve',
			sync: 'background',
			version: 'v1'
		});
	});

	it('lets a route override one freshness field', () => {
		const [out] = manifestRoutes(
			parseManifest(manifest(route({ freshness: { mode: 'hard' } })))
		);
		expect(out?.freshness).toEqual({ maxStale: 900, mode: 'hard' });
	});
});
