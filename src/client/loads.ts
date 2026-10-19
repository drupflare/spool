/** the part of a `PerformanceResourceTiming` entry that counting needs */
export type ResourceEntry = { name: string };

/**
 * How many entries name a resource on another origin than `origin`, leaving out `ignore` (the
 * page runtime's own script, which a CDN may serve). It cannot tell a cache hit from a network
 * request, since a cross-origin entry without `Timing-Allow-Origin` reports no transfer size, so
 * the count is an upper bound on cross-origin network requests. An entry whose name is not a URL is skipped.
 */
export function crossOriginLoads(
	entries: readonly ResourceEntry[],
	origin: string,
	ignore: readonly string[] = []
): number {
	let count = 0;
	for (const { name } of entries) {
		if (ignore.includes(name)) continue;
		try {
			if (new URL(name).origin !== origin) count += 1;
		} catch {
			continue;
		}
	}
	return count;
}

/**
 * How many entries name a resource on each other origin, busiest first and cut to `limit`, again
 * leaving out `ignore`. Origins only: no path or query string is kept.
 */
export function crossOriginOrigins(
	entries: readonly ResourceEntry[],
	origin: string,
	ignore: readonly string[] = [],
	limit = 32
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const { name } of entries) {
		if (ignore.includes(name)) continue;
		try {
			const other = new URL(name).origin;
			if (other !== origin && other !== 'null')
				counts.set(other, (counts.get(other) ?? 0) + 1);
		} catch {
			continue;
		}
	}
	return Object.fromEntries(
		[...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit)
	);
}
