import type { WorkSample } from '../report/traffic.js';

/** the origin's work per interval, kept in memory; `samples()` is what `Z_peak_work` reads */
export type WorkSeries = {
	/** adds one request that took `busyMs` on `route`; `at` is epoch milliseconds, now when omitted */
	record(route: string, busyMs: number, at?: number): void;
	/** every kept interval, oldest first, the open one included */
	samples(): WorkSample[];
	clear(): void;
};

/** what {@link workSeries} takes */
export type WorkSeriesOptions = {
	/** length of one interval; default 60 */
	intervalSeconds?: number;
	/** most intervals kept before the oldest is dropped; default 1440, a day at 60 s */
	keep?: number;
	now?: () => number;
};

/**
 * Buckets requests by time. Each isolate or process keeps its own series, so an app that runs
 * more than one reads `samples()` from each and concatenates them.
 */
export function workSeries(options: WorkSeriesOptions = {}): WorkSeries {
	const seconds = options.intervalSeconds ?? 60;
	const keep = options.keep ?? 1440;
	const now = options.now ?? Date.now;
	const buckets = new Map<number, WorkSample>();
	return {
		record(route, busyMs, at = now()) {
			const start = Math.floor(at / (seconds * 1000)) * seconds * 1000;
			let sample = buckets.get(start);
			if (!sample) {
				sample = { start, seconds, busyMs: {}, requests: {} };
				buckets.set(start, sample);
				if (buckets.size > keep) {
					const oldest = Math.min(...buckets.keys());
					buckets.delete(oldest);
				}
			}
			sample.busyMs[route] = (sample.busyMs[route] ?? 0) + busyMs;
			sample.requests[route] = (sample.requests[route] ?? 0) + 1;
		},
		samples: () =>
			[...buckets.values()]
				.sort((a, b) => a.start - b.start)
				.map((s) => ({ ...s, busyMs: { ...s.busyMs }, requests: { ...s.requests } })),
		clear: () => buckets.clear()
	};
}
