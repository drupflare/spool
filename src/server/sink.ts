import type { BeaconEvent } from '../protocol/beacon.js';
import {
	loadsFromBeacon,
	viewFromBeacon,
	viewsWithLoads,
	type TimedView
} from '../protocol/view.js';

/** where flushed beacon events go: Analytics Engine, a log, a queue */
export interface Sink {
	write(events: readonly BeaconEvent[]): void | Promise<void>;
}

/** a sink that keeps events in `events`, for tests */
export function memorySink(): Sink & { events: BeaconEvent[] } {
	const events: BeaconEvent[] = [];
	return {
		events,
		write(batch) {
			events.push(...batch);
		}
	};
}

/**
 * The `spool.view` events among `events`, validated, with cross-origin counts joined from the
 * loads reports among them; anything else is skipped. A page reports when it is hidden, which can
 * be a later flush than its view, so pass the whole stream and not one batch.
 */
export function viewsOf(events: readonly BeaconEvent[]): TimedView[] {
	return viewsWithLoads(events);
}

/**
 * A sink that writes one JSON line per event through `write`, such as `console.log` or a stream's
 * `write`. A view becomes a flat object (`event`, `at` and the view's fields) and a loads report one
 * (`event`, `view`, `count`, `at`) so a log query can read them; any other request is written as it
 * was held.
 */
export function jsonLinesSink(write: (line: string) => void): Sink {
	return {
		write(batch) {
			for (const event of batch) {
				const view = viewFromBeacon(event);
				const loads = loadsFromBeacon(event);
				if (view) write(JSON.stringify({ event: 'spool.view', ...view }));
				else if (loads) write(JSON.stringify({ event: 'spool.loads', ...loads }));
				else write(JSON.stringify(event));
			}
		}
	};
}

/** the part of an Analytics Engine binding the sink calls */
export interface AnalyticsEngineLike {
	writeDataPoint(point: {
		indexes?: string[];
		blobs?: Array<string | null>;
		doubles?: number[];
	}): void;
}

/** longest slice of a body one data point carries, in UTF-8 bytes; a longer body is split across points */
export const MAX_BEACON_BLOB = 4096;

const encoder = new TextEncoder();

/**
 * Cuts `text` into slices of at most `limit` UTF-8 bytes, never inside a code point. Text with no
 * bytes still gives one empty slice, so every event leaves one data point at least.
 */
export function splitBytes(text: string, limit: number = MAX_BEACON_BLOB): string[] {
	const parts: string[] = [];
	let current = '';
	let size = 0;
	for (const char of text) {
		const n = encoder.encode(char).length;
		if (size + n > limit) {
			parts.push(current);
			current = '';
			size = 0;
		}
		current += char;
		size += n;
	}
	parts.push(current);
	return parts;
}

/**
 * A sink for a Workers Analytics Engine dataset, one data point per event.
 *
 * | | views | other requests |
 * | --- | --- | --- |
 * | index1 | route pattern | path |
 * | blob1 | `view` | `beacon` |
 * | blob2 to blob9 | tier, reason, engine, scope, strategy, route, id, from | content type, body slice, vendor |
 * | double1 to double6 | at, staleSec, swAgeMs, gapMs, mismatch, crossOriginLoads | at, slice number from 0, slice count |
 *
 * `staleSec`, `gapMs` and `crossOriginLoads` are -1 when unknown; `mismatch` is -1 when nothing was
 * compared, 0 for a match and 1 for a mismatch. A page's loads report is a row with `blob1` of
 * `loads`, the view id as `blob2` and `at` and the count as `double1` and `double2`. Analytics
 * Engine caps an index at 96 bytes and a row at 16 KB, so a body longer than {@link MAX_BEACON_BLOB}
 * bytes is written as several points, one per slice, with the same index, content type, vendor and
 * `at`; join the slices by those and `double2` (the slice number) to rebuild it. Nothing is cut off.
 */
export function analyticsEngineSink(dataset: AnalyticsEngineLike): Sink {
	return {
		write(batch) {
			for (const event of batch) {
				const view = viewFromBeacon(event);
				const loads = loadsFromBeacon(event);
				if (loads) {
					dataset.writeDataPoint({
						indexes: [event.path],
						blobs: ['loads', loads.view],
						doubles: [loads.at, loads.count]
					});
				} else if (view) {
					dataset.writeDataPoint({
						indexes: [view.route.slice(0, 96)],
						blobs: [
							'view',
							view.tier,
							view.reason,
							view.engine,
							view.scope,
							view.strategy,
							view.route,
							view.id,
							view.from ?? null
						],
						doubles: [
							view.at,
							view.staleSec ?? -1,
							view.swAgeMs,
							view.gapMs ?? -1,
							view.mismatch === null ? -1 : Number(view.mismatch),
							view.crossOriginLoads ?? -1
						]
					});
				} else {
					const slices = splitBytes(event.body);
					slices.forEach((slice, n) => {
						dataset.writeDataPoint({
							indexes: [event.path.slice(0, 96)],
							blobs: ['beacon', event.contentType, slice, event.vendor ?? null],
							doubles: [event.at, n, slices.length]
						});
					});
				}
			}
		}
	};
}
