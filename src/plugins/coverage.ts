import { PATHS } from '../protocol/config.js';
import type { SerializedRoute } from '../protocol/route.js';
import { coverageReport } from '../sw/coverage.js';

/** one line of the development report for a GET that no data family covers */
export function uncoveredLine(path: string): string {
	return `spool: uncovered GET ${path}`;
}

/**
 * Watches the requests a development server receives and calls `print` once for each fetch or XHR
 * GET that no data family in `families` covers. A navigation, a script, a stylesheet and an image
 * are not page reads, so only `Sec-Fetch-Dest: empty` counts. The server sees its own origin only:
 * a request to another origin never reaches it, so a cross-origin read is not reported here.
 */
export function devCoverage(
	families: readonly SerializedRoute[],
	print: (line: string) => void
): (request: { method: string; url: string; fetchDest: string | null }) => void {
	const seen = new Set<string>();
	return ({ method, url, fetchDest }) => {
		if (method !== 'GET' || fetchDest !== 'empty') return;
		const parsed = new URL(url);
		if (parsed.pathname === PATHS.worker || parsed.pathname.startsWith('/.spool')) return;
		const [uncovered] = coverageReport([{ method, url }], families, parsed.origin);
		if (uncovered === undefined || seen.has(uncovered)) return;
		seen.add(uncovered);
		print(uncoveredLine(`${parsed.pathname}${parsed.search}`));
	};
}
