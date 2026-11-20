import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { toNodeListener } from '../../src/node/listener.ts';
import {
	BUNDLE_DELTA_PREFIX,
	BUNDLE_PREFIX,
	interpretTemplate,
	PATHS
} from '../../src/protocol/index.ts';
import {
	createSpool,
	defineDataset,
	defineRoute,
	memoryBundleStore,
	memorySink,
	viewsOf,
	type Sink
} from '../../src/server/index.ts';
import { memoryStore } from '../../src/stores/index.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';
import { clickHref, settleOn } from './reader.ts';

/** the engines the rig can drive, by the name `@playwright/test` exports them under */
export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type Engine = (typeof ENGINES)[number];

/** the two arms: the courses site with no spool, and the same site under createSpool */
export const ARMS = ['baseline', 'spool'] as const;
export type Arm = (typeof ARMS)[number];

/**
 * The single-day reader models of `.remember/v1/review/model.mjs`, with the same view counts and
 * warm document navigations. The tab at the end is one document and then in-page views, the
 * single-visit case of `.remember/v1/review2/REVIEW_2.md`. The multi-day models are `DAY_SCENARIOS`,
 * run with `--days`.
 */
export const SCENARIOS = [
	{ name: 'One view, never returns', views: 1, warm: 0 },
	{ name: 'Two views, one visit', views: 2, warm: 0 },
	{ name: 'Five views, one visit', views: 5, warm: 0 },
	{ name: "Codex's mix: 1 + 100 in-page + 20 warm documents", views: 121, warm: 20 },
	{ name: 'One tab, 2,000 views', views: 2000, warm: 0 }
] as const;
export type Scenario = (typeof SCENARIOS)[number];

type Hit = {
	method: string;
	path: string;
	bytes: number;
	dest: string | null;
	mode: string | null;
	/** the status of the handler's response and whether the request was conditional; set by `counted` */
	status?: number;
	conditional?: boolean;
};
/** a hit tagged with the day and the view of a multi-day scenario that was running */
export type DayHit = Hit & { day: number; step: number };
type Handler = (request: Request) => Promise<Response>;

/** one page view of a scenario: a document `open` or an in-page `click` on a same-origin link */
export type Step = { via: 'open' | 'click'; index: number; dwell: boolean };

/** what a driver reports for one arm, so the runner counts the same way for every browser */
export type Driver = {
	/** true when the page shows the course's title; false after the wait times out */
	visit(path: string, title: string | undefined, via: 'open' | 'click'): Promise<boolean>;
	/** signs in as `as` before the first view, so the browser holds the session cookie */
	login?(as: string): Promise<void>;
	/** the text of the page's first heading, or null when it has none */
	text?(): Promise<string | null>;
	wait(ms: number): Promise<void>;
	controlled(): Promise<boolean>;
	/** the page's `Date.now()`, which the multi-day arms compare with the faked clock */
	now?(): Promise<number>;
	/** waits until the worker controls the page, once the page has the client or a registration; the milliseconds waited, or null when it has neither */
	engage?(timeoutMs: number): Promise<number | null>;
	/** what the page holds before a view starts; used by the trace only */
	state?(): Promise<PageState>;
	/** the records in the sealed key store, `spool-keys`; null when it cannot be read; used by the trace only */
	keys?(): Promise<number | null>;
	close(): Promise<void>;
};

/** the page's worker, pack and navigation state at the start of a view */
export type PageState = {
	controlled: boolean;
	navigateLoaded: boolean;
	swap: boolean;
	head: number | null;
	partial: boolean | null;
};

export type Launch = (input: {
	engine: Engine;
	origin: string;
	handler: Handler;
	profile: string;
}) => Promise<Driver>;

export type Serve = (handler: Handler) => Promise<{ origin: string; close(): Promise<void> }>;

/** the seams a test replaces: a browser, a server, and for the multi-day arms the clock */
export type Deps = {
	launch?: Launch;
	serve?: Serve;
	/** the environment the multi-day arms read the preload and the offset file from */
	env?: Record<string, string | undefined>;
	/** a real-time pause; the faked clock never drives it */
	sleep?: (ms: number) => Promise<void>;
	/** this process's wall clock */
	now?: () => number;
};

export type Options = {
	dryRun: boolean;
	engines: Engine[];
	scenarios: number[];
	out: string;
	force: boolean;
	work: string;
	count: number;
	dwellMs: number;
	settleMs: number;
	tailMs: number;
	/** how long a multi-day spool view waits for the worker to take control of the page before the next view starts; 0 does not wait */
	engageMs: number;
	bootstrap: 'first-view' | 'second-view';
	/** the pause before each in-page click, so a reader stays inside the history write budget */
	clickGapMs: number;
	/** whether the course page carries the `data-spool-swap` region that in-page views replace */
	swap: boolean;
	/** a JSON-lines file that receives one line per view and one for the tail */
	trace?: string;
	/** the reading's machine name; the platform label when unset */
	machine?: string;
	/** a lowercase word added to a multi-day reading's file name, so two runs on one date do not collide */
	experiment?: string;
	/** run `DAY_SCENARIOS` under the faked clock instead of `SCENARIOS`; `scenarios` then indexes them */
	days: boolean;
	/** the real time to wait after the offset file changes, so the preloaded library rereads it */
	clockWaitMs: number;
};

/** one arm of one scenario in one engine, as written to the reading's rows */
export type ArmRow = {
	engine: Engine;
	scenario: string;
	arm: Arm;
	views: number;
	requests: number;
	bytes: number;
	wrong: number;
	controlled: boolean;
	paths: Record<string, number>;
	/** origin requests each view made, in view order, including the wait that follows it */
	steps: number[];
	fatal?: string;
};

// #region the courses site, as examples/courses/shared/site.ts builds it

const TITLES = ['Intro to Drupal', 'Content Modeling', 'Theming'];

/** the title of course `index` (ids start at 101); the first three have fixed titles */
export const courseTitle = (index: number): string => TITLES[index] ?? `Course ${101 + index}`;

/** the origin page for a course or the list, with no spool */
export function originPage(count: number, swap: boolean, stored = false) {
	const region = swap ? ['<main data-spool-swap>', '</main>'] : ['', ''];
	const rows = Array.from({ length: count }, (_, i) => ({
		id: String(101 + i),
		title: courseTitle(i)
	}));
	const item = defineRoute('/courses/:id', {
		strategy: 'template',
		template: {
			source: `<!doctype html><html><head><title>{{row.title}}</title></head><body>${region[0]}<h1>{{row.title}}</h1>${region[1]}</body></html>`
		},
		...(stored
			? { depends: () => ['courses'] }
			: { family: { dataset: 'courses', key: 'id' } }),
		load: (ctx) => {
			const row = rows.find((course) => course.id === ctx.params['id']);
			return stored ? { row } : row;
		}
	});
	const page = (request: Request): Response => {
		const id = /^\/courses\/(\w+)$/.exec(new URL(request.url).pathname)?.[1];
		const row = rows.find((course) => course.id === id);
		if (!row) return new Response('not found', { status: 404 });
		return new Response(interpretTemplate(item.template!, { params: { id }, row }), {
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});
	};
	return { rows, item, page };
}

/** the handler for one arm: the origin page alone, or the same page behind `createSpool` */
async function buildSite(options: Options, spool: boolean, sink?: Sink): Promise<Handler> {
	const { count, bootstrap } = options;
	const { rows, item, page } = originPage(count, options.swap);
	if (!spool) return async (request) => page(request);
	const dataset = defineDataset<{ id: string; title: string }>('courses', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => rows,
		read: (ids) => rows.filter((row) => ids.includes(row.id)),
		changes: () => ({ cursor: 1, puts: [], deletes: [] }),
		horizon: () => 1,
		head: () => ({ cursor: 1 }),
		schema: 'course-1',
		maxRows: count,
		maxBytes: 10_000_000
	});
	const versions = memoryStore();
	await versions.bump(['courses']);
	const bundles = memoryBundleStore();
	const handle = createSpool({
		routes: [item],
		datasets: [dataset],
		store: versions,
		bundles,
		bootstrap,
		...(sink ? { sink } : {})
	});
	await handle.publish(new URL('https://site.test/'));
	return (request) => handle.handle(request, async (inner) => page(inner));
}

// #endregion

/** the course index a step visits; spread so the views are not the same few pages */
const visit = (i: number, count: number): number => (i * 37) % count;

/** the steps one scenario takes: a document, the in-page views, then the warm documents */
export function plan(scenario: Scenario, count: number): Step[] {
	const inPage = scenario.views - 1 - scenario.warm;
	const steps: Step[] = [{ via: 'open', index: 0, dwell: false }];
	for (let i = 1; i <= inPage; i++)
		steps.push({ via: 'click', index: visit(i, count), dwell: false });
	for (let j = 0; j < scenario.warm; j++) {
		steps.push({ via: 'open', index: visit(inPage + 1 + j, count), dwell: true });
	}
	return steps;
}

/** a request's key in the reading: the method and path, with course ids folded to `:id` */
export const pathKey = (method: string, path: string): string =>
	`${method} ${path.replace(/^\/courses\/\d+$/, '/courses/:id')}`;

function counted(
	handler: Handler,
	hits: Hit[],
	tag?: () => { day: number; step: number }
): Handler {
	return async (request) => {
		const response = await handler(request);
		const body = await response.clone().arrayBuffer();
		hits.push({
			method: request.method,
			path: new URL(request.url).pathname,
			bytes: body.byteLength,
			dest: request.headers.get('sec-fetch-dest'),
			mode: request.headers.get('sec-fetch-mode'),
			status: response.status,
			conditional: request.headers.has('if-none-match'),
			...tag?.()
		});
		return response;
	};
}

/** runs one arm of one scenario and counts every request that reaches the origin handler */
export async function runArm(
	input: { engine: Engine; arm: Arm; scenario: Scenario; options: Options },
	deps: Deps = {}
): Promise<ArmRow> {
	const { engine, arm, scenario, options } = input;
	const hits: Hit[] = [];
	const row: ArmRow = {
		engine,
		scenario: scenario.name,
		arm,
		views: scenario.views,
		requests: 0,
		bytes: 0,
		wrong: 0,
		controlled: false,
		paths: {},
		steps: []
	};
	const handler = counted(await buildSite(options, arm === 'spool'), hits);
	const server = await (deps.serve ?? nodeServe)(handler);
	const profile = await mkdtemp(join(options.work, `${engine}-${arm}-`));
	const trace = (line: object) =>
		options.trace
			? appendFile(
					options.trace,
					`${JSON.stringify({ engine, scenario: scenario.name, arm, ...line })}\n`
				)
			: undefined;
	const lineOf = (from: number) =>
		hits.slice(from).map((hit) => ({
			method: hit.method,
			path: hit.path,
			dest: hit.dest,
			mode: hit.mode,
			bytes: hit.bytes
		}));
	let driver: Driver | undefined;
	try {
		driver = await (deps.launch ?? playwrightLaunch)({
			engine,
			origin: server.origin,
			handler,
			profile
		});
		for (const [n, step] of plan(scenario, options.count).entries()) {
			if (step.via === 'click') await driver.wait(options.clickGapMs);
			const before = hits.length;
			if (step.dwell) await driver.wait(options.dwellMs);
			const state = n > 0 && arm === 'spool' ? await driver.state?.() : undefined;
			const ok = await driver.visit(
				`/courses/${101 + step.index}`,
				courseTitle(step.index),
				step.via
			);
			if (!ok) row.wrong++;
			if (n < 2) await driver.wait(options.settleMs);
			row.steps.push(hits.length - before);
			await trace({
				step: n,
				via: step.via,
				index: step.index,
				dwell: step.dwell,
				ok,
				before: state,
				requests: lineOf(before)
			});
		}
		const tailFrom = hits.length;
		await driver.wait(options.tailMs);
		await trace({ step: 'tail', requests: lineOf(tailFrom) });
		row.controlled = await driver.controlled();
	} catch (error) {
		row.fatal = String(error instanceof Error ? (error.stack ?? error.message) : error).split(
			'\n'
		)[0];
	} finally {
		await driver?.close().catch(() => undefined);
		await server.close();
	}
	row.requests = hits.length;
	for (const hit of hits) {
		const key = pathKey(hit.method, hit.path);
		row.paths[key] = (row.paths[key] ?? 0) + 1;
		row.bytes += hit.bytes;
	}
	return row;
}

/** the reading's rows for every arm, engine and scenario in `options`; prints each row as it lands */
export async function runDemand(options: Options, deps: Deps = {}): Promise<ArmRow[]> {
	const rows: ArmRow[] = [];
	await mkdir(options.work, { recursive: true });
	for (const engine of options.engines) {
		for (const index of options.scenarios) {
			for (const arm of ARMS) {
				const row = await runArm(
					{ engine, arm, scenario: SCENARIOS[index]!, options },
					deps
				);
				console.log(JSON.stringify(row));
				rows.push(row);
			}
		}
	}
	return rows;
}

/** the reading as `measurements/demand/<date>.json` takes it, before the schema and path */
export function draftOf(rows: ArmRow[], options: Options, date: string): Draft {
	return {
		rig: 'demand',
		date,
		layer: 'L1',
		question:
			'Origin requests a reader model makes with and without spool, per engine, for single-day scenarios.',
		instrument:
			'Playwright persistent contexts; every request that reaches the origin handler is counted with its method, path and response bytes.',
		machine: localMachine(options.machine),
		software: {
			node: process.version,
			bun: process.versions.bun ?? 'not bun',
			playwright: createRequire(import.meta.url)('@playwright/test/package.json').version
		},
		method: {
			scenarios: options.scenarios.map((i) => SCENARIOS[i]!),
			arms: [...ARMS],
			engines: options.engines,
			courses: options.count,
			dwellMs: options.dwellMs,
			settleMs: options.settleMs,
			tailMs: options.tailMs,
			bootstrap: options.bootstrap,
			swap: options.swap,
			clickGapMs: options.clickGapMs
		},
		exclusions: [
			'a row with fatal set did not finish its arm and holds no count a reader may use',
			'a row with wrong above 0 has a page that did not show the course title; a reader drops it'
		],
		rows
	};
}

// #region the multi-day arms

/**
 * The multi-day reader models: `views[d]` document opens on day `d`, each day `gapH` hours after
 * the one before, so every day starts past the stub's 86,400 s lease. The browser is closed and
 * reopened on the same profile at each day, as a visitor who left would.
 */
export type DayEdit = { day: number; kind: 'course' | 'member'; text: string };

/**
 * `site: 'courses'` is the single-day site with a fixed dataset; `'live'` has a course dataset and a
 * principal `members` dataset that the server edits between days. `pages` is the path each view opens:
 * the course a step picks, course 101 every time, or the signed-in `/me`. An edit applies before its
 * day starts, and a revocation ends the session on the server after day `revokeAfterDay`.
 */
export type DayScenario = {
	name: string;
	views: readonly number[];
	gapH: number;
	site: 'courses' | 'live';
	pages: 'spread' | 'course' | 'me';
	login?: string;
	edits?: readonly DayEdit[];
	revokeAfterDay?: number;
	/** the one fixture change against the parent: a stored course page with depends, or a persistent principal page */
	variant?: 'stored' | 'persistent';
};

export const DAY_SCENARIOS = [
	{
		name: 'Daily reader: one document a day, 5 days',
		views: [1, 1, 1, 1, 1],
		gapH: 25,
		site: 'courses',
		pages: 'spread'
	},
	{
		name: 'Local-only reader across three leases',
		views: [3, 2, 2, 2],
		gapH: 25,
		site: 'courses',
		pages: 'spread'
	},
	{
		name: 'Public edit: a held course changes between days',
		views: [3, 2, 2, 2],
		gapH: 25,
		site: 'live',
		pages: 'course',
		edits: [{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }]
	},
	{
		name: 'Principal reader, session stays valid, session retention',
		views: [3, 1, 1, 1],
		gapH: 25,
		site: 'live',
		pages: 'me',
		login: 'ada'
	},
	{
		name: 'Principal reader, session ends on the server after day 2, session retention',
		views: [3, 1, 1, 1],
		gapH: 25,
		site: 'live',
		pages: 'me',
		login: 'ada',
		revokeAfterDay: 2
	},
	{
		name: 'Principal edit: the visitor row changes between days, session retention',
		views: [3, 1, 1, 1],
		gapH: 25,
		site: 'live',
		pages: 'me',
		login: 'ada',
		edits: [{ day: 2, kind: 'member', text: 'Ada Park, edited' }]
	},
	{
		name: 'Public edit, stored page route with depends: a held course changes between days',
		views: [3, 2, 2, 2],
		gapH: 25,
		site: 'live',
		pages: 'course',
		edits: [{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }],
		variant: 'stored'
	},
	{
		name: 'Principal reader, session stays valid, persistent retention and depends on members',
		views: [3, 1, 1, 1],
		gapH: 25,
		site: 'live',
		pages: 'me',
		login: 'ada',
		variant: 'persistent'
	},
	{
		name: 'Principal reader, session ends on the server after day 2, persistent retention and depends on members',
		views: [3, 1, 1, 1],
		gapH: 25,
		site: 'live',
		pages: 'me',
		login: 'ada',
		revokeAfterDay: 2,
		variant: 'persistent'
	}
] as const satisfies readonly DayScenario[];

/** one document open of a multi-day scenario: its day, its place in the day and the day's clock offset */
export type DayStep = {
	day: number;
	view: number;
	offsetH: number;
	index: number;
	path: string;
	dwell: boolean;
};

/** the opens of a multi-day scenario in order; the first of each day has no dwell */
export function dayPlan(scenario: DayScenario, count: number): DayStep[] {
	const steps: DayStep[] = [];
	let n = 0;
	scenario.views.forEach((views, day) => {
		for (let view = 0; view < views; view++) {
			const index = scenario.pages === 'course' ? 0 : visit(n, count);
			n++;
			steps.push({
				day,
				view,
				offsetH: day * scenario.gapH,
				index,
				path: scenario.pages === 'me' ? '/me' : `/courses/${101 + index}`,
				dwell: view > 0
			});
		}
	});
	return steps;
}

/** what a request is for; `drain` is a sync or dataset request sent in a view that made no document request */
export type HitType =
	| 'document'
	| 'login'
	| 'stub'
	| 'asset'
	| 'pack'
	| 'delta'
	| 'sync'
	| 'dataset'
	| 'drain'
	| 'artifact'
	| 'write'
	| 'beacon'
	| 'other';

/** the type of a request, from its path; `stepHasDocument` says whether its view fetched a document */
export function classifyHit(hit: Hit, stepHasDocument: boolean): HitType {
	const { path } = hit;
	if (/^\/courses\/\d+$/.test(path) || path === '/me') return 'document';
	if (path === '/login') return 'login';
	if (path === PATHS.worker) return 'stub';
	if (path.startsWith(BUNDLE_DELTA_PREFIX)) return 'delta';
	if (path.startsWith(BUNDLE_PREFIX)) return 'pack';
	if (path === PATHS.write) return 'write';
	if (path === PATHS.sync || path === PATHS.dataset) {
		if (!stepHasDocument) return 'drain';
		return path === PATHS.sync ? 'sync' : 'dataset';
	}
	if (path === PATHS.artifact) return 'artifact';
	if (path === PATHS.beacon) return 'beacon';
	if (/^\/\.spool\/[^/]+\/.+\.js$/.test(path)) return 'asset';
	return 'other';
}

/** one day of one arm: origin requests, the ones that need server logic, bytes, and each type */
export type DayTally = {
	day: number;
	requests: number;
	/** every request but the stub and the scripts, which a static tier can serve without a Worker */
	dynamic: number;
	bytes: number;
	byType: Partial<Record<HitType, { requests: number; bytes: number }>>;
};

/** the per-day tally of a hit log for days `0` to `days - 1`, with a zero row for a day with no hit */
export function tallyDays(hits: readonly DayHit[], days: number): DayTally[] {
	const documents = new Set(
		hits
			.filter((hit) => classifyHit(hit, false) === 'document')
			.map((h) => `${h.day}:${h.step}`)
	);
	const tallies: DayTally[] = Array.from({ length: days }, (_, day) => ({
		day,
		requests: 0,
		dynamic: 0,
		bytes: 0,
		byType: {}
	}));
	for (const hit of hits) {
		const tally = tallies[hit.day];
		if (!tally) continue;
		const type = classifyHit(hit, documents.has(`${hit.day}:${hit.step}`));
		const slot = (tally.byType[type] ??= { requests: 0, bytes: 0 });
		slot.requests++;
		slot.bytes += hit.bytes;
		tally.requests++;
		tally.bytes += hit.bytes;
		if (type !== 'stub' && type !== 'asset') tally.dynamic++;
	}
	return tallies;
}

const MS_PER_HOUR = 3_600_000;

/** whether a clock read at `nowMs` moved `offsetH` hours past the read at `startMs`, within `slackMs` */
export function clockMoved(
	startMs: number,
	nowMs: number,
	offsetH: number,
	slackMs = MS_PER_HOUR
): boolean {
	return Math.abs(nowMs - startMs - offsetH * MS_PER_HOUR) <= slackMs;
}

/** writes `+<hours>h` to a libfaketime offset file; the file must sit inside the work folder */
export async function writeOffset(file: string, work: string, hours: number): Promise<void> {
	const from = relative(resolve(work), resolve(file));
	if (from === '' || from.startsWith('..') || isAbsolute(from)) {
		throw new Error(
			`${file} is outside the work folder ${work}; refusing to write the clock there`
		);
	}
	await writeFile(file, hours === 0 ? '+0' : `+${hours}h`);
}

/** the offset file the multi-day arms write, or an error that says how to run them in the container */
export function requireClock(env: Record<string, string | undefined>): string {
	const how =
		'run the multi-day arms in the Linux container: WORK_TREE=<synced snapshot> OUT_DIR=<empty folder> bash .remember/v1/lanes/md-run.sh (it sets LD_PRELOAD, FAKETIME_TIMESTAMP_FILE, FAKETIME_NO_CACHE, DONT_FAKE_MONOTONIC and REAL_EPOCH_MS)';
	const file = env['FAKETIME_TIMESTAMP_FILE'];
	if (!file) throw new Error(`FAKETIME_TIMESTAMP_FILE is not set; ${how}`);
	const preload = env['LD_PRELOAD'];
	if (!preload) throw new Error(`LD_PRELOAD is not set; ${how}`);
	if (!preload.includes('faketime')) {
		throw new Error(`LD_PRELOAD does not name libfaketime (${preload}); ${how}`);
	}
	return file;
}

/** the live site with the hooks the multi-day runner uses between days */
type LiveSite = {
	handler: Handler;
	/** changes the course or the signed-in member's row on the server and tells spool */
	edit(edit: DayEdit): Promise<void>;
	/** ends the session on the server: the identity stops resolving and the live hub revokes */
	revoke(): Promise<void>;
};

type Member = { id: string; name: string };

/**
 * The courses site with a principal side, as `examples/dashboard/shared/site.ts` builds it (a principal
 * `members` dataset, a principal `/me` template, `identity` from a cookie, a `/login` that sets the
 * partition), cut to what the multi-day arms read and with datasets whose `changes` answer from a log
 * so a row can change. The dashboard itself imports the package by name, which needs `dist/`, and
 * gives the rig no hook to change a row or end a session.
 */
async function buildLiveSite(
	options: Options,
	spooled: boolean,
	sink?: Sink,
	scenario: Partial<DayScenario> = {}
): Promise<LiveSite> {
	const { count, bootstrap } = options;
	const {
		rows,
		item,
		page: coursePage
	} = originPage(count, options.swap, scenario.variant === 'stored');
	const courseLog: string[] = [];
	const members: Member[] = [{ id: 'ada', name: 'Ada Park' }];
	const memberLog: string[] = [];
	let revoked = false;
	const courses = defineDataset<{ id: string; title: string }>('courses', {
		scope: 'public',
		key: (row) => row.id,
		seed: () => rows,
		read: (ids) => rows.filter((row) => ids.includes(row.id)),
		changes: (since) => ({
			cursor: courseLog.length,
			puts: [...new Set(courseLog.slice(since))],
			deletes: []
		}),
		horizon: () => 0,
		head: () => ({ cursor: courseLog.length }),
		schema: 'course-1',
		maxRows: count,
		maxBytes: 10_000_000
	});
	const mine = (principal: string | undefined) =>
		members.filter((member) => member.id === principal);
	const memberSet = defineDataset<Member>(
		'members',
		{
			scope: 'principal',
			maxStaleMs: 600_000,
			key: (row) => row.id,
			seed: (ctx) => mine(ctx.principal?.principal),
			read: (ids, ctx) =>
				mine(ctx.principal?.principal).filter((row) => ids.includes(row.id)),
			fields: () => ['id', 'name'],
			changes: (since) => ({
				cursor: memberLog.length,
				puts: [...new Set(memberLog.slice(since))],
				deletes: []
			}),
			horizon: () => 0,
			head: () => ({ cursor: memberLog.length }),
			schema: 'member-1',
			maxRows: 10,
			maxBytes: 10_000
		},
		{ principalDatasets: true }
	);
	const region = options.swap ? ['<main data-spool-swap>', '</main>'] : ['', ''];
	const meRoute = defineRoute('/me', {
		strategy: 'template',
		auth: 'principal',
		family: { dataset: 'members', key: 'viewer.id' },
		...(scenario.pages === 'me' && scenario.variant !== 'persistent'
			? { retention: 'session' as const }
			: {}),
		...(scenario.variant === 'persistent' ? { depends: () => ['members'] } : {}),
		template: {
			source: `<!doctype html><html><head><title>Me</title></head><body>${region[0]}<h1>{{row.name}}</h1>${region[1]}</body></html>`
		}
	});
	const principalOf = (request: Request): string | null => {
		const user = /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null;
		return !revoked && members.some((member) => member.id === user) ? user : null;
	};
	const versions = memoryStore();
	await versions.bump(['courses']);
	const spool = spooled
		? createSpool({
				routes: [item, meRoute],
				datasets: [courses, memberSet],
				principalDatasets: true,
				store: versions,
				bundles: memoryBundleStore(),
				bootstrap,
				identity: {
					secret: 'a long random value kept on the server',
					resolve: (request) => {
						const principal = principalOf(request);
						return principal === null ? null : { principal };
					}
				},
				logout: ['/logout'],
				...(sink ? { sink } : {})
			})
		: undefined;
	await spool?.publish(new URL('https://site.test/'));
	const origin = async (request: Request): Promise<Response> => {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === '/login' && request.method === 'POST') {
			const as = searchParams.get('as') ?? '';
			if (!members.some((member) => member.id === as)) {
				return new Response('unknown user', { status: 400 });
			}
			return new Response('Signed in', {
				headers: {
					'set-cookie': `user=${as}; Path=/; Max-Age=31536000`,
					...(spool ? { 'spool-partition': await spool.partition(as) } : {})
				}
			});
		}
		if (pathname === '/me') {
			const user = principalOf(request);
			const row = members.find((member) => member.id === user);
			if (!row) return new Response('sign in', { status: 401 });
			return new Response(interpretTemplate(meRoute.template!, { row }), {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			});
		}
		return coursePage(request);
	};
	return {
		handler: spool
			? (request) => spool.handle(request, async (inner) => origin(inner))
			: async (request) => origin(request),
		async edit(edit) {
			if (edit.kind === 'course') {
				const row = rows[0]!;
				row.title = edit.text;
				courseLog.push(row.id);
				await spool?.invalidate(['courses']);
			} else {
				const row = members[0]!;
				row.name = edit.text;
				memberLog.push(row.id);
				await spool?.invalidate(['members']);
			}
			// publish after invalidate, so the stub the next visit fetches carries the new cursor's pack
			await spool?.publish(new URL('https://site.test/'));
		},
		async revoke() {
			revoked = true;
			await spool?.revoke('ada');
		}
	};
}

/** what a view showed: the text before an edit, the text after it, or anything else (a sign-in page, no heading) */
export function shownState(
	text: string | null,
	before: string,
	after: string
): 'old' | 'new' | 'other' {
	if (text === before) return 'old';
	return text === after ? 'new' : 'other';
}

/** what the worker reported for one view: how it was answered and how long its inputs went unchecked */
export type ViewRow = {
	at: number;
	route: string;
	tier: string;
	reason: string;
	staleSec: number | null;
	swAgeMs: number;
	gapMs: number | null;
};

/** the `spool.view` events among `events` as rows, in the order the server received them */
export function viewRows(events: Parameters<typeof viewsOf>[0]): ViewRow[] {
	return viewsOf(events).map(({ at, route, tier, reason, staleSec, swAgeMs, gapMs }) => ({
		at,
		route,
		tier,
		reason,
		staleSec,
		swAgeMs,
		gapMs
	}));
}

/** one arm of one multi-day scenario in one engine, as written to the reading's rows */
export type DayRow = {
	engine: Engine;
	scenario: string;
	arm: Arm;
	views: number;
	requests: number;
	bytes: number;
	wrong: number;
	controlled: boolean;
	paths: Record<string, number>;
	/** one tally per day that started; a day whose clock check failed is absent */
	days: DayTally[];
	/** the node and page clocks at the start of each day, in epoch milliseconds */
	clock: Array<{ day: number; offsetH: number; nodeMs: number; pageMs: number | null }>;
	/** the first heading each view showed, which is what the visitor read; null when the page had none */
	shown?: Array<{ day: number; step: number; text: string | null }>;
	/** how long each spool view waited for the worker to take control; null where the page had no client yet or the wait was off */
	engaged?: Array<{ day: number; step: number; waitedMs: number | null }>;
	/** the `spool.view` events the server received, in order; a view flushes with a later request, so the last views of a run are absent. Spool arms only */
	workerViews?: ViewRow[];
	fatal?: string;
};

/** runs one arm of one multi-day scenario and counts every request that reaches the origin handler */
export async function runDayArm(
	input: { engine: Engine; arm: Arm; scenario: DayScenario; options: Options; file: string },
	deps: Deps = {}
): Promise<DayRow> {
	const { engine, arm, scenario, options, file } = input;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const now = deps.now ?? Date.now;
	const steps = dayPlan(scenario, options.count);
	const hits: DayHit[] = [];
	const at = { day: 0, step: 0 };
	const row: DayRow = {
		engine,
		scenario: scenario.name,
		arm,
		views: steps.length,
		requests: 0,
		bytes: 0,
		wrong: 0,
		controlled: false,
		paths: {},
		days: [],
		clock: [],
		shown: [],
		engaged: []
	};
	const sink = arm === 'spool' ? memorySink() : undefined;
	const site: Partial<LiveSite> & { handler: Handler } =
		scenario.site === 'live'
			? await buildLiveSite(options, arm === 'spool', sink, scenario)
			: { handler: await buildSite(options, arm === 'spool', sink) };
	const handler = counted(site.handler, hits, () => ({ ...at }));
	const server = await (deps.serve ?? nodeServe)(handler);
	const profile = await mkdtemp(join(options.work, `${engine}-${arm}-days-`));
	const trace = (line: object) =>
		options.trace
			? appendFile(
					options.trace,
					`${JSON.stringify({ engine, scenario: scenario.name, arm, ...line })}\n`
				)
			: undefined;
	const lineOf = (from: number) =>
		hits.slice(from).map(({ method, path, dest, mode, bytes, status, conditional }) => ({
			method,
			path,
			dest,
			mode,
			bytes,
			status,
			conditional
		}));
	let driver: Driver | undefined;
	let started = 0;
	try {
		await writeOffset(file, options.work, 0);
		await sleep(options.clockWaitMs);
		const start = now();
		for (const step of steps) {
			if (step.view === 0) {
				await driver?.close().catch(() => undefined);
				driver = undefined;
				if (step.day > 0) {
					if (scenario.revokeAfterDay === step.day - 1) await site.revoke?.();
					for (const edit of scenario.edits ?? []) {
						if (edit.day === step.day) await site.edit?.(edit);
					}
					await writeOffset(file, options.work, step.offsetH);
					await sleep(options.clockWaitMs);
				}
				const nodeMs = now();
				if (!clockMoved(start, nodeMs, step.offsetH)) {
					throw new Error(
						`the node clock did not move ${step.offsetH} h after the offset file changed; this runtime does not honour the preloaded clock`
					);
				}
				driver = await (deps.launch ?? playwrightLaunch)({
					engine,
					origin: server.origin,
					handler,
					profile
				});
				const pageMs = (await driver.now?.()) ?? null;
				row.clock.push({ day: step.day, offsetH: step.offsetH, nodeMs, pageMs });
				if (pageMs !== null && !clockMoved(start, pageMs, step.offsetH)) {
					await sleep(options.clockWaitMs);
					const again = (await driver.now?.()) ?? null;
					const offset = (ms: number | null) =>
						ms === null ? 'n/a' : ((ms - start) / MS_PER_HOUR).toFixed(2);
					throw new Error(
						`the page clock did not move ${step.offsetH} h with the node clock; the browser does not honour the preloaded clock (page offset ${offset(pageMs)} h, read again after ${options.clockWaitMs} ms: ${offset(again)} h)`
					);
				}
				started = step.day + 1;
				at.day = step.day;
				at.step = 0;
				if (step.day === 0 && scenario.login) await driver.login?.(scenario.login);
			}
			at.day = step.day;
			at.step = step.view;
			const before = hits.length;
			if (step.dwell) await driver!.wait(options.dwellMs);
			const title = scenario.site === 'courses' ? courseTitle(step.index) : undefined;
			const ok = await driver!.visit(step.path, title, 'open');
			if (!ok) row.wrong++;
			await driver!.wait(options.settleMs);
			const waited =
				arm === 'spool' && options.engageMs > 0
					? ((await driver!.engage?.(options.engageMs).catch(() => null)) ?? null)
					: null;
			row.engaged!.push({ day: step.day, step: step.view, waitedMs: waited });
			row.shown!.push({
				day: step.day,
				step: step.view,
				text: (await driver!.text?.().catch(() => null)) ?? null
			});
			const after =
				arm === 'spool' && options.trace
					? await driver!.state?.().catch(() => undefined)
					: undefined;
			const keys =
				arm === 'spool' && options.trace
					? await driver!.keys?.().catch(() => null)
					: undefined;
			await trace({
				day: step.day,
				step: step.view,
				ok,
				waited,
				after,
				keys,
				requests: lineOf(before)
			});
			if (step.view === scenario.views[step.day]! - 1) {
				const tailFrom = hits.length;
				await driver!.wait(options.tailMs);
				await trace({ day: step.day, step: 'tail', requests: lineOf(tailFrom) });
				row.controlled = await driver!.controlled();
			}
		}
	} catch (error) {
		row.fatal = String(error instanceof Error ? (error.stack ?? error.message) : error).split(
			'\n'
		)[0];
	} finally {
		await driver?.close().catch(() => undefined);
		await server.close();
		await writeOffset(file, options.work, 0).catch(() => undefined);
	}
	row.days = tallyDays(hits, started);
	if (sink) row.workerViews = viewRows(sink.events);
	row.requests = hits.length;
	for (const hit of hits) {
		const key = pathKey(hit.method, hit.path);
		row.paths[key] = (row.paths[key] ?? 0) + 1;
		row.bytes += hit.bytes;
	}
	return row;
}

/** the reading's rows for every arm, engine and multi-day scenario in `options`; prints each row */
export async function runDays(options: Options, deps: Deps = {}): Promise<DayRow[]> {
	const file = requireClock(deps.env ?? process.env);
	const rows: DayRow[] = [];
	await mkdir(options.work, { recursive: true });
	for (const engine of options.engines) {
		for (const index of options.scenarios) {
			for (const arm of ARMS) {
				const row = await runDayArm(
					{ engine, arm, scenario: DAY_SCENARIOS[index]!, options, file },
					deps
				);
				console.log(JSON.stringify(row));
				rows.push(row);
			}
		}
	}
	return rows;
}

/** the multi-day reading as `measurements/demand/<date>-days.json` takes it */
export function daysDraftOf(
	rows: DayRow[],
	options: Options,
	date: string,
	env: Record<string, string | undefined> = process.env
): Draft {
	return {
		rig: 'demand',
		date,
		layer: 'L1',
		question:
			'Origin requests, Worker-invocation equivalents and bytes per device per day, with and without spool, for visitors who return after one lease or more, per engine.',
		instrument:
			'Playwright persistent contexts reopened on one profile each day; the wall clock of the server and the browser moved together by libfaketime reading an offset file; every request that reaches the origin handler is counted with its method, path, response bytes, day and view.',
		machine: {
			...localMachine(options.machine),
			...(env['RIG_CONTAINER'] ? { container: env['RIG_CONTAINER'] } : {}),
			...(env['RIG_LOAD_AVG'] ? { loadAverageAtStart: env['RIG_LOAD_AVG'] } : {})
		},
		software: {
			node: process.version,
			bun: process.versions.bun ?? 'not bun',
			playwright: createRequire(import.meta.url)('@playwright/test/package.json').version,
			faketime: `libfaketime preloaded from ${env['LD_PRELOAD'] ?? 'unset'}, version not read`
		},
		method: {
			scenarios: options.scenarios.map((i) => DAY_SCENARIOS[i]!),
			arms: [...ARMS],
			engines: options.engines,
			courses: options.count,
			dwellMs: options.dwellMs,
			settleMs: options.settleMs,
			tailMs: options.tailMs,
			engageMs: options.engageMs,
			clockWaitMs: options.clockWaitMs,
			bootstrap: options.bootstrap,
			swap: options.swap,
			leaseSeconds: 86_400,
			noCache: env['FAKETIME_NO_CACHE'] ?? 'unset',
			dontFakeMonotonic: env['DONT_FAKE_MONOTONIC'] ?? 'unset',
			realEpochMs: env['REAL_EPOCH_MS'] ?? 'unset'
		},
		exclusions: [
			'the monotonic clock is not faked; waits and timers run in real time, so a lease is crossed by the wall clock only',
			'a row with fatal set did not finish its arm; its days hold the counts of the days that started',
			'a row with wrong above 0 has a page that did not show the course title; a reader drops it',
			'dynamic counts every request but the stub and the scripts; it is the invocation count only when a static tier serves those (L2 over the hit log)',
			'the dataset never changes, so a sync carries no patch; the bytes of a sync that carries a change are not in this reading',
			'a Firefox row that failed to start under the preloaded library is the result for that engine'
		],
		rows
	};
}

// #endregion

const USAGE = `usage: bun scripts/measure/demand.ts [--dry-run] [--engines chromium,firefox,webkit]
  [--scenario <index>[,<index>]] [--out <dir>] [--work <dir>] [--force]
  [--courses <n>] [--dwell-ms <n>] [--settle-ms <n>] [--tail-ms <n>] [--engage-ms <n>]
  [--bootstrap first-view|second-view] [--no-swap] [--click-gap-ms <n>] [--trace <file>]
  [--machine <name>] [--days] [--clock-wait-ms <n>]
scenarios: ${SCENARIOS.map((s, i) => `${i} ${s.name}`).join('; ')}
with --days: ${DAY_SCENARIOS.map((s, i) => `${i} ${s.name}`).join('; ')}`;

/** the rig's flags, with the defaults the plan prints; throws on an unknown flag or value */
export function parseArgs(argv: string[]): Options {
	const options: Options = {
		dryRun: false,
		engines: [...ENGINES],
		scenarios: SCENARIOS.map((_, i) => i),
		out: MEASUREMENTS_DIR,
		force: false,
		work: join(tmpdir(), 'spool-demand'),
		count: 1000,
		dwellMs: 1500,
		settleMs: 1500,
		tailMs: 1500,
		engageMs: 15000,
		bootstrap: 'second-view',
		swap: true,
		clickGapMs: 150,
		days: false,
		clockWaitMs: 2500
	};
	let chosen: number[] | undefined;
	const value = (flag: string, i: number): string => {
		const next = argv[i + 1];
		if (next === undefined) throw new Error(`${flag} needs a value\n${USAGE}`);
		return next;
	};
	const int = (flag: string, i: number): number => {
		const n = Number(value(flag, i));
		if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		switch (flag) {
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--force':
				options.force = true;
				break;
			case '--engines': {
				const names = value(flag, i).split(',');
				for (const name of names) {
					if (!(ENGINES as readonly string[]).includes(name))
						throw new Error(`unknown engine ${name}`);
				}
				options.engines = names as Engine[];
				i++;
				break;
			}
			case '--scenario': {
				chosen = value(flag, i).split(',').map(Number);
				i++;
				break;
			}
			case '--days':
				options.days = true;
				break;
			case '--clock-wait-ms':
				options.clockWaitMs = int(flag, i);
				i++;
				break;
			case '--out':
				options.out = value(flag, i);
				i++;
				break;
			case '--work':
				options.work = value(flag, i);
				i++;
				break;
			case '--courses':
				options.count = int(flag, i);
				i++;
				break;
			case '--dwell-ms':
				options.dwellMs = int(flag, i);
				i++;
				break;
			case '--settle-ms':
				options.settleMs = int(flag, i);
				i++;
				break;
			case '--tail-ms':
				options.tailMs = int(flag, i);
				i++;
				break;
			case '--engage-ms':
				options.engageMs = int(flag, i);
				i++;
				break;
			case '--bootstrap': {
				const gate = value(flag, i);
				if (gate !== 'first-view' && gate !== 'second-view')
					throw new Error(`unknown bootstrap ${gate}`);
				options.bootstrap = gate;
				i++;
				break;
			}
			case '--trace':
				options.trace = value(flag, i);
				i++;
				break;
			case '--machine':
				options.machine = value(flag, i);
				i++;
				break;
			case '--experiment': {
				const word = value(flag, i);
				if (!/^[a-z][a-z-]*$/.test(word)) {
					throw new Error('--experiment must be lowercase words joined by dashes');
				}
				options.experiment = word;
				i++;
				break;
			}
			case '--no-swap':
				options.swap = false;
				break;
			case '--click-gap-ms':
				options.clickGapMs = int(flag, i);
				i++;
				break;
			default:
				throw new Error(`unknown flag ${flag}\n${USAGE}`);
		}
	}
	const known: readonly unknown[] = options.days ? DAY_SCENARIOS : SCENARIOS;
	for (const index of chosen ?? []) {
		if (!Number.isInteger(index) || !known[index]) throw new Error(`unknown scenario ${index}`);
	}
	options.scenarios = chosen ?? known.map((_, i) => i);
	return options;
}

/** the plan `--dry-run` prints: every default resolved, the file it would write, and no browser */
export function dryRunPlan(options: Options, date: string) {
	const suffix = options.days ? `-days${options.experiment ? `-${options.experiment}` : ''}` : '';
	const file = join(options.out, 'demand', `${date}${suffix}.json`);
	return {
		engines: options.engines,
		arms: [...ARMS],
		days: options.days,
		clockWaitMs: options.clockWaitMs,
		scenarios: options.scenarios.map((i) =>
			options.days
				? {
						index: i,
						name: DAY_SCENARIOS[i]!.name,
						site: DAY_SCENARIOS[i]!.site,
						login: (DAY_SCENARIOS[i] as DayScenario).login ?? null,
						variant: (DAY_SCENARIOS[i] as DayScenario).variant ?? null,
						edits: (DAY_SCENARIOS[i] as DayScenario).edits ?? [],
						revokeAfterDay: (DAY_SCENARIOS[i] as DayScenario).revokeAfterDay ?? null,
						days: DAY_SCENARIOS[i]!.views.length,
						offsetsH: dayPlan(DAY_SCENARIOS[i]!, options.count)
							.filter((s) => s.view === 0)
							.map((s) => s.offsetH),
						steps: dayPlan(DAY_SCENARIOS[i]!, options.count).length
					}
				: {
						index: i,
						...SCENARIOS[i]!,
						steps: plan(SCENARIOS[i]!, options.count).length
					}
		),
		courses: options.count,
		dwellMs: options.dwellMs,
		settleMs: options.settleMs,
		tailMs: options.tailMs,
		engageMs: options.engageMs,
		bootstrap: options.bootstrap,
		swap: options.swap,
		clickGapMs: options.clickGapMs,
		trace: options.trace ?? null,
		work: options.work,
		file,
		fileExists: existsSync(file)
	};
}

/** the first Playwright driver: a persistent context per arm, a document `goto` or an anchor click */
async function playwrightLaunch({
	engine,
	origin,
	profile
}: Parameters<Launch>[0]): Promise<Driver> {
	const playwright = await import('@playwright/test');
	const browser = {
		chromium: playwright.chromium,
		firefox: playwright.firefox,
		webkit: playwright.webkit
	}[engine];
	const context = await browser.launchPersistentContext(profile, {
		headless: true,
		timeout: 60000
	});
	const page = await context.newPage();
	return {
		async visit(path, title, via) {
			if (via === 'open') await page.goto(origin + path);
			else await clickHref(page, path);
			return settleOn(page, path, title);
		},
		wait: (ms) => page.waitForTimeout(ms),
		controlled: () => page.evaluate(() => navigator.serviceWorker.controller !== null),
		engage: (limit) =>
			page.evaluate(async (ms) => {
				const registered = (await navigator.serviceWorker.getRegistration()) !== undefined;
				if (!registered && !('spool' in window)) return null;
				const start = performance.now();
				while (!navigator.serviceWorker.controller && performance.now() - start < ms) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				return Math.round(performance.now() - start);
			}, limit),
		now: () => page.evaluate(() => Date.now()),
		async login(as) {
			await context.request.post(`${origin}/login?as=${encodeURIComponent(as)}`);
		},
		text: () => page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? null),
		state: () =>
			page.evaluate(
				() =>
					new Promise<PageState>((resolve) => {
						const none: PageState = {
							controlled: navigator.serviceWorker.controller !== null,
							navigateLoaded: 'spoolNavigate' in window,
							swap:
								document.querySelector('[data-spool-swap]') !== null ||
								document.querySelector('main') !== null,
							head: null,
							partial: null
						};
						try {
							const open = indexedDB.open('spool-bundle');
							open.onerror = () => resolve(none);
							open.onsuccess = () => {
								const db = open.result;
								try {
									const get = db
										.transaction('head')
										.objectStore('head')
										.get('active');
									get.onerror = () => resolve(none);
									get.onsuccess = () => {
										db.close();
										const head = get.result as
											{ version: number; partial?: boolean } | undefined;
										resolve({
											...none,
											head: head?.version ?? null,
											partial: head ? head.partial === true : null
										});
									};
								} catch {
									db.close();
									resolve(none);
								}
							};
						} catch {
							resolve(none);
						}
					})
			),
		keys: () =>
			page.evaluate(
				() =>
					new Promise<number | null>((resolve) => {
						// opening a missing database would create it empty, so check it exists first
						indexedDB
							.databases()
							.then((dbs) => {
								if (!dbs.some((db) => db.name === 'spool-keys')) return resolve(0);
								const open = indexedDB.open('spool-keys');
								open.onerror = () => resolve(null);
								open.onsuccess = () => {
									const db = open.result;
									try {
										const count = db
											.transaction('keys')
											.objectStore('keys')
											.count();
										count.onsuccess = () => {
											db.close();
											resolve(count.result);
										};
										count.onerror = () => {
											db.close();
											resolve(null);
										};
									} catch {
										db.close();
										resolve(null);
									}
								};
							})
							.catch(() => resolve(null));
					})
			),
		close: () => context.close()
	};
}

/** the default server: a node HTTP listener on loopback, on a free port */
async function nodeServe(handler: Handler): Promise<{ origin: string; close(): Promise<void> }> {
	const server: Server = createServer(toNodeListener(handler));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	};
}

/** the CLI: `--dry-run` prints the plan, otherwise every arm runs and the reading is written */
export async function main(argv: string[], deps: Deps = {}): Promise<number> {
	const options = parseArgs(argv);
	const date = utcDate();
	if (options.dryRun) {
		console.log(JSON.stringify(dryRunPlan(options, date), null, '\t'));
		return 0;
	}
	const rows = options.days ? await runDays(options, deps) : await runDemand(options, deps);
	const draft = options.days
		? daysDraftOf(rows as DayRow[], options, date, deps.env)
		: draftOf(rows as ArmRow[], options, date);
	const path = writeMeasurement(options.out, draft, {
		overwrite: options.force,
		experiment: options.days
			? `days${options.experiment ? `-${options.experiment}` : ''}`
			: undefined
	});
	console.log(`wrote ${path}`);
	return rows.some((row) => row.fatal !== undefined) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
