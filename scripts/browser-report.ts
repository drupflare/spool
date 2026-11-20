type Annotation = { type: string; description?: string };
type Test = { status?: string; annotations?: Annotation[] };
type Spec = { title: string; tests?: Test[] };
type Suite = { title?: string; specs?: Spec[]; suites?: Suite[] };

export type Report = {
	stats: { expected: number; unexpected: number; skipped: number; flaky: number };
	suites?: Suite[];
};

/** the titles of skipped tests that carry no reason, in report order */
export function unexplainedSkips(report: Report): string[] {
	const found: string[] = [];
	const walk = (suite: Suite) => {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				if (test.status !== 'skipped') continue;
				const reason = (test.annotations ?? []).some(
					(a) => a.type === 'skip' && (a.description ?? '').trim() !== ''
				);
				if (!reason) found.push(spec.title);
			}
		}
		for (const child of suite.suites ?? []) walk(child);
	};
	for (const suite of report.suites ?? []) walk(suite);
	return found;
}

/** the problems that make the browser job fail, empty when the report is acceptable */
export function reportProblems(report: Report): string[] {
	const { expected, unexpected, flaky } = report.stats;
	if (expected + unexpected + flaky === 0) return ['no browser test ran at all'];
	return unexplainedSkips(report).map((title) => `skipped with no reason: ${title}`);
}
