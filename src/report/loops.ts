import type { Row } from './measurement.js';

/** seconds in each window of the avoidable-loops crawl */
export const LOOP_WINDOW_S = 20;

/** the window counts only when its page was in the state it was recorded in for this many seconds */
const VALID_SECONDS = 18;
/** a class holds when its condition holds on this many seconds of the window */
const NEEDED_SECONDS = 15;
const VISIBLE_FRAMES_PER_S = 20;
const HIDDEN_FRAMES_PER_S = 1;
const POLL_REQUESTS = 3;

/** the classes of the six primary loops, which `any` is the union of */
const PRIMARY = [
	'visible-frame-loop',
	'hidden-frame-loop',
	'hidden-timer-loop',
	'poll',
	'autoplay',
	'css-animation'
] as const;

/** the classes a page view can carry, in the order the table prints them */
export const LOOP_CLASSES = [...PRIMARY, 'any', 'hidden-timer-any'] as const;

export type LoopClass = (typeof LOOP_CLASSES)[number];

/** one second of a window: what the page did in it, as the crawl counted it */
export type LoopSecond = {
	visibility: string;
	raf: number;
	timers: { lt100: number; lt1s: number; gte1s: number };
	calls: { fetch: number; xhr: number; beacon: number; websocket: number; eventSource: number };
	requests: { same: Record<string, number>; cross: Record<string, number> };
	videoAdvancing: number;
	infiniteAnimations: number;
	/** the tab's state at the read: whether Chromium discarded its document, its readyState, and whether its URL changed since the window's first read */
	state?: { discarded: boolean; ready: string; moved: boolean };
};

export type LoopWindow = { seconds: LoopSecond[] };

/** a window that holds `state` for enough of its seconds to count; null otherwise */
function usable(win: LoopWindow | null, state: 'visible' | 'hidden'): LoopWindow | null {
	if (!win) return null;
	return win.seconds.filter((s) => s.visibility === state).length >= VALID_SECONDS ? win : null;
}

/** whether `test` holds for enough seconds of a usable window, null when the window is not usable */
function over(
	win: LoopWindow | null,
	test: (s: LoopSecond) => boolean,
	needed: number
): boolean | null {
	if (!win) return null;
	return win.seconds.filter(test).length >= needed;
}

/** the classes of one page, null for a page that did not load; a null class could not be measured */
export function loopClasses(page: Row): Record<LoopClass, boolean | null> | null {
	if (page.ok !== true) return null;
	const visible = usable(page.visible as LoopWindow | null, 'visible');
	const hidden = usable(page.hidden as LoopWindow | null, 'hidden');
	const requests = (s: LoopSecond) =>
		Object.values(s.requests.same).reduce((n, c) => n + c, 0) +
		Object.values(s.requests.cross).reduce((n, c) => n + c, 0);
	const classes = {
		'visible-frame-loop': over(visible, (s) => s.raf >= VISIBLE_FRAMES_PER_S, NEEDED_SECONDS),
		'hidden-frame-loop': over(hidden, (s) => s.raf >= HIDDEN_FRAMES_PER_S, NEEDED_SECONDS),
		'hidden-timer-loop': over(hidden, (s) => s.timers.gte1s >= 1, NEEDED_SECONDS),
		poll:
			visible === null
				? null
				: visible.seconds.reduce((n, s) => n + requests(s), 0) >= POLL_REQUESTS,
		autoplay: over(visible, (s) => s.videoAdvancing > 0, 1),
		'css-animation': over(visible, (s) => s.infiniteAnimations > 0, 1),
		'hidden-timer-any': over(
			hidden,
			(s) => s.timers.lt100 + s.timers.lt1s + s.timers.gte1s >= 1,
			NEEDED_SECONDS
		),
		any: null as boolean | null
	};
	const values = PRIMARY.map((c) => classes[c]);
	classes.any = values.includes(true) ? true : values.includes(null) ? null : false;
	return classes;
}

/** Wilson score interval for `k` of `n` at 95%, null when `n` is 0 */
export function wilson(k: number, n: number): { low: number; high: number } | null {
	if (n <= 0) return null;
	const z = 1.959964;
	const z2 = z * z;
	const p = k / n;
	const center = (p + z2 / (2 * n)) / (1 + z2 / n);
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
	return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export type LoopFigure = {
	/** pages where the class could be measured */
	n: number;
	count: number;
	share: number | null;
	low: number | null;
	high: number | null;
	/** sites with a measured page for the class, and sites with at least one page that has it */
	siteN: number;
	siteCount: number;
};

export type LoopFigures = {
	/** pages that loaded */
	pages: number;
	sites: number;
	classes: Record<LoopClass, LoopFigure>;
};

/** the share of loaded pages, and of sites, that carry each class; `slice` takes the page rows by position */
export function loopFigures(
	rows: readonly Row[],
	slice?: { from: number; to: number }
): LoopFigures {
	const pages = rows.filter((row) => row.kind === 'page').slice(slice?.from, slice?.to);
	const loaded = pages.flatMap((row) => {
		const classes = loopClasses(row);
		return classes === null ? [] : [{ site: String(row.site), classes }];
	});
	const out = {} as Record<LoopClass, LoopFigure>;
	for (const cls of LOOP_CLASSES) {
		const measured = loaded.filter((p) => p.classes[cls] !== null);
		const hits = measured.filter((p) => p.classes[cls] === true);
		const interval = wilson(hits.length, measured.length);
		out[cls] = {
			n: measured.length,
			count: hits.length,
			share: measured.length > 0 ? hits.length / measured.length : null,
			low: interval?.low ?? null,
			high: interval?.high ?? null,
			siteN: new Set(measured.map((p) => p.site)).size,
			siteCount: new Set(hits.map((p) => p.site)).size
		};
	}
	return { pages: loaded.length, sites: new Set(loaded.map((p) => p.site)).size, classes: out };
}

/** the figures of all the page rows, and of the first `floor(n / 2)` and the rest, in row order */
export function halves(rows: readonly Row[]): {
	all: LoopFigures;
	first: LoopFigures;
	second: LoopFigures;
} {
	const n = rows.filter((row) => row.kind === 'page').length;
	const cut = Math.floor(n / 2);
	return {
		all: loopFigures(rows),
		first: loopFigures(rows, { from: 0, to: cut }),
		second: loopFigures(rows, { from: cut, to: n })
	};
}
