import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { TimedView } from '../../src/protocol/view';
import { zPeakWork, type PeakWork, type WorkSample } from '../../src/report/traffic';
import { isMain } from './lib';

const COLUMNS = ['start', 'seconds', 'route', 'requests', 'busy_ms'] as const;

/** an ISO 8601 time or epoch milliseconds, as epoch milliseconds */
function instant(text: string, line: number): number {
	const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
	if (!Number.isFinite(ms))
		throw new Error(`line ${line}: start is neither epoch milliseconds nor an ISO time`);
	return ms;
}

/**
 * An institution's server-work trace as `WorkSample` intervals. The CSV has one row per interval and
 * route: `start,seconds,route,requests,busy_ms`, where `busy_ms` is the handler time that route
 * used in the interval. Rows sharing a start and length form one interval.
 */
export function parseTrace(csv: string): WorkSample[] {
	const lines = csv.split('\n').filter((l) => l.trim() !== '');
	const header = (lines.shift() ?? '').split(',').map((c) => c.trim());
	if (COLUMNS.some((c, i) => header[i] !== c))
		throw new Error(`the header must be ${COLUMNS.join(',')}`);
	const intervals = new Map<string, WorkSample>();
	for (const [i, line] of lines.entries()) {
		const cells = line.split(',').map((c) => c.trim());
		if (cells.length !== COLUMNS.length)
			throw new Error(`line ${i + 2}: expected ${COLUMNS.length} columns`);
		const [start, seconds, route, requests, busy] = cells as [
			string,
			string,
			string,
			string,
			string
		];
		const sample: WorkSample = {
			start: instant(start, i + 2),
			seconds: Number(seconds),
			busyMs: {},
			requests: {}
		};
		const nums = [sample.seconds, Number(requests), Number(busy)];
		if (nums.some((n) => !Number.isFinite(n) || n < 0) || sample.seconds === 0) {
			throw new Error(
				`line ${i + 2}: seconds, requests and busy_ms must be non-negative numbers, seconds above zero`
			);
		}
		const key = `${sample.start}/${sample.seconds}`;
		const hit = intervals.get(key) ?? sample;
		hit.busyMs[route] = (hit.busyMs[route] ?? 0) + Number(busy);
		hit.requests[route] = (hit.requests[route] ?? 0) + Number(requests);
		intervals.set(key, hit);
	}
	return [...intervals.values()].sort((a, b) => a.start - b.start);
}

/** views from JSON lines, one `TimedView` per line */
export function parseViews(jsonl: string): TimedView[] {
	return jsonl
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => JSON.parse(l) as TimedView);
}

/** `Z_peak_work` over the busiest `share` of the trace's intervals */
export function peakWork(
	views: readonly TimedView[],
	samples: readonly WorkSample[],
	share = 0.1
): PeakWork {
	return zPeakWork(views, samples, { busiestShare: share });
}

export function parse(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			views: { type: 'string' },
			busiest: { type: 'string', default: '0.1' },
			out: { type: 'string' }
		}
	});
	return {
		trace: positionals[0],
		views: values.views,
		busiest: Number(values.busiest),
		out: values.out
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (!args.trace) {
		console.log(
			'usage: bun scripts/measure/traces.ts <trace.csv> [--views views.jsonl] [--busiest 0.1] [--out file.json]'
		);
	} else {
		const samples = parseTrace(readFileSync(args.trace, 'utf8'));
		const peak = args.views
			? peakWork(parseViews(readFileSync(args.views, 'utf8')), samples, args.busiest)
			: undefined;
		const text = `${JSON.stringify({ samples, peak }, null, '\t')}\n`;
		if (args.out) writeFileSync(args.out, text);
		else process.stdout.write(text);
	}
}
