import { ProtocolError } from '../protocol/errors.js';
import { defineRoute, type Route, type RouteDeclaration } from '../protocol/route.js';
import type { Register } from './mode.js';

export type { Register, Registration } from './mode.js';

/** the fields of a framework registration the helper reads; every `pages.ts` registration has them */
export type PageLike = {
	/** the framework's own path, such as `/articles/[id]` */
	path: string;
	/** the spool pattern; absent when the framework path does not convert */
	pattern?: string;
	register: Register;
	reason: string;
};

/** a registered page no declaration covers, so no route exists for it and the network answers */
export type UncoveredPage = { path: string; pattern: string; register: Register; reason: string };

/**
 * Turns a framework's registrations into routes. `declarations` maps a spool pattern to what only
 * the operator knows: the template or renderer, the family's dataset, the scope, `freshness`,
 * `depends`. The helper adds no default of its own, so each declaration is the `defineRoute`
 * declaration for its pattern.
 *
 * It checks both directions. A declaration whose pattern the framework did not register throws
 * `bad-route` and names the pattern, which catches a typo and a page that was renamed or deleted.
 * A registered pattern with no declaration gets no route (the network answers it) and comes back in
 * `uncovered`, so print it. A declaration that reads a dataset (`family` or `query.dataset`) must set
 * `scope` or `auth` itself: the helper never takes the default `public` for a dataset it did not
 * see. A registration whose path did not convert has no pattern and cannot be declared. A pattern
 * the framework lists twice gets one route. Routes come back in registration order, and the first
 * one that matches a path answers it.
 */
export function routesFromPages(
	pages: readonly PageLike[],
	declarations: Readonly<Record<string, RouteDeclaration>>
): { routes: Route[]; uncovered: UncoveredPage[] } {
	const registered = new Map<string, PageLike & { pattern: string }>();
	for (const page of pages) {
		if (page.pattern !== undefined && !registered.has(page.pattern)) {
			registered.set(page.pattern, { ...page, pattern: page.pattern });
		}
	}
	const unknown = Object.keys(declarations).filter((pattern) => !registered.has(pattern));
	if (unknown.length > 0) {
		throw new ProtocolError(
			'bad-route',
			`${unknown.join(', ')}: the framework registered no such route (registered: ${[...registered.keys()].join(', ') || 'none'})`
		);
	}
	const routes: Route[] = [];
	const uncovered: UncoveredPage[] = [];
	for (const [pattern, page] of registered) {
		const declaration = declarations[pattern];
		if (declaration === undefined) {
			uncovered.push({
				path: page.path,
				pattern,
				register: page.register,
				reason: page.reason
			});
			continue;
		}
		const reads =
			(declaration as { family?: unknown }).family !== undefined ||
			(declaration as { query?: { dataset?: unknown } }).query?.dataset !== undefined;
		const declared =
			(declaration as { scope?: unknown }).scope !== undefined ||
			(declaration as { auth?: unknown }).auth !== undefined;
		if (reads && !declared) {
			throw new ProtocolError(
				'bad-route',
				`${pattern}: a route that reads a dataset must declare its scope: set scope to 'public' or 'principal'`
			);
		}
		routes.push(defineRoute(pattern, declaration));
	}
	return { routes, uncovered };
}
