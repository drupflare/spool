import type { Register } from './mode.js';

/** what the development report lists */
export type DevReport = {
	/** routes registered, with the spool pattern each one was registered under */
	registered: Array<{ pattern: string; register: Register; maxAge?: number }>;
	/** pages left to the network, with the reason */
	network: Array<{ path: string; reason: string }>;
	/**
	 * GET paths a page made that no family covered. Absent where the framework gives the report no
	 * requests to read (a build adapter, a config that never serves), so no count is printed.
	 */
	uncovered?: string[];
};

/** the text the development server prints for a report; one line per route or request */
export function formatDevReport(report: DevReport): string {
	const uncovered = report.uncovered;
	const lines = [
		`spool: ${report.registered.length} registered, ${report.network.length} left to the network${uncovered === undefined ? '' : `, ${uncovered.length} uncovered GET`}`
	];
	for (const route of report.registered) {
		const age = route.maxAge === undefined ? '' : `  maxAge ${route.maxAge}s`;
		lines.push(`  registered  ${route.pattern}  ${route.register}${age}`);
	}
	for (const page of report.network) {
		lines.push(`  network     ${page.path}  ${page.reason}`);
	}
	for (const path of uncovered ?? []) {
		lines.push(`  uncovered   GET ${path}`);
	}
	return lines.join('\n');
}
