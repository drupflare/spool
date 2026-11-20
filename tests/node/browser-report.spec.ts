import { describe, expect, it } from 'vitest';
import { reportProblems, unexplainedSkips, type Report } from '../../scripts/browser-report';

const stats = { expected: 3, unexpected: 0, skipped: 2, flaky: 0 };

const report = (
	tests: Array<{ status: string; annotations?: Array<{ type: string; description?: string }> }>
): Report => ({
	stats,
	suites: [
		{
			suites: [{ specs: tests.map((t, i) => ({ title: `case ${i}`, tests: [t] })) }]
		}
	]
});

describe('the browser report check', () => {
	it('accepts a skip that names its reason and rejects one that does not', () => {
		const r = report([
			{
				status: 'skipped',
				annotations: [{ type: 'skip', description: 'WebKit bug 332455' }]
			},
			{ status: 'skipped', annotations: [{ type: 'skip' }] },
			{ status: 'skipped' },
			{ status: 'expected' }
		]);
		expect(unexplainedSkips(r)).toEqual(['case 1', 'case 2']);
		expect(reportProblems(r)).toEqual([
			'skipped with no reason: case 1',
			'skipped with no reason: case 2'
		]);
	});

	it('reports nothing for explained skips only', () => {
		const r = report([
			{ status: 'skipped', annotations: [{ type: 'skip', description: 'reason' }] },
			{ status: 'expected' }
		]);
		expect(reportProblems(r)).toEqual([]);
	});

	it('fails a report where no test ran', () => {
		expect(
			reportProblems({
				stats: { expected: 0, unexpected: 0, skipped: 4, flaky: 0 },
				suites: []
			})
		).toEqual(['no browser test ran at all']);
	});
});
