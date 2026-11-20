import { reportProblems, type Report } from './browser-report';

const file = Bun.file(process.argv[2] ?? 'playwright-report/results.json');
if (!(await file.exists())) {
	console.error('::error::no browser report was written, so nothing proves the suite ran');
	process.exit(1);
}
const report = (await file.json()) as Report;
const { expected, unexpected, skipped, flaky } = report.stats;
console.log(`expected=${expected} unexpected=${unexpected} skipped=${skipped} flaky=${flaky}`);
const problems = reportProblems(report);
for (const problem of problems) console.error(`::error::${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
