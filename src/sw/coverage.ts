import { matchPattern } from '../protocol/pattern.js';
import type { SerializedRoute } from '../protocol/route.js';

/** the GETs a page made that no data family answers, as absolute URLs in first-seen order */
export function coverageReport(
	requests: readonly { method: string; url: string }[],
	families: readonly SerializedRoute[],
	origin: string
): string[] {
	const uncovered = new Set<string>();
	for (const { method, url } of requests) {
		if (method !== 'GET') continue;
		const parsed = new URL(url);
		if (!families.some((route) => covers(route, parsed, origin))) uncovered.add(url);
	}
	return [...uncovered];
}

/**
 * A data family covers a GET of its origin (the page's own when it names none) whose path fits its
 * pattern. A query string is covered only by the parameters the family's query takes, the rule
 * `evaluateQuery` applies when the worker reads.
 */
function covers(route: SerializedRoute, url: URL, origin: string): boolean {
	if (route.strategy !== 'data') return false;
	if (route.family === undefined && route.origin === undefined) return false;
	if ((route.origin ?? origin) !== url.origin) return false;
	if (matchPattern(route.pattern, url.pathname) === null) return false;
	if (url.search === '') return true;
	if (route.query === undefined) return false;
	const filter = route.query.filter ?? {};
	return [...url.searchParams.keys()].every(
		(key) => key === 'sort' || key === 'page' || Object.hasOwn(filter, key)
	);
}
