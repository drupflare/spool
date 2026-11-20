import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	classifyHit,
	clockMoved,
	DAY_SCENARIOS,
	dayPlan,
	daysDraftOf,
	draftOf,
	dryRunPlan,
	main,
	originPage,
	parseArgs,
	plan,
	requireClock,
	runDays,
	runDemand,
	SCENARIOS,
	shownState,
	tallyDays,
	viewRows,
	writeOffset,
	type DayHit,
	type DayScenario,
	type Deps,
	type Driver,
	type Options
} from '../../scripts/measure/demand';
import { interpretTemplate, viewToBeacon, type ViewEvent } from '../../src/protocol/index';
import {
	demandCounts,
	demandWorkerCounts,
	measurementProblems,
	multiplierOf,
	parseMeasurementText,
	serialiseMeasurement,
	type Measurement
} from '../../src/report/index';

const ORIGIN = 'https://site.test';

/** a browser stand-in: each visit is a fetch of the handler, read for its title; no page runs */
const stub: Deps = {
	serve: async () => ({ origin: ORIGIN, close: async () => undefined }),
	launch: async ({ handler }) => {
		const driver: Driver = {
			async visit(path, title) {
				const html = await (await handler(new Request(ORIGIN + path))).text();
				return /<h1>(.*?)<\/h1>/.exec(html)?.[1] === title;
			},
			wait: async () => undefined,
			controlled: async () => false,
			close: async () => undefined
		};
		return driver;
	}
};

const tiny = (over: Partial<Options> = {}): Options => ({
	...parseArgs([]),
	engines: ['chromium'],
	scenarios: [2],
	count: 12,
	dwellMs: 0,
	settleMs: 0,
	tailMs: 0,
	...over
});

let work: string;

beforeEach(async () => {
	work = await mkdtemp(join(tmpdir(), 'spool-demand-test-'));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the demand rig arguments', () => {
	it('takes every engine, scenario and the courses site by default', () => {
		const options = parseArgs([]);
		expect(options.engines).toEqual(['chromium', 'firefox', 'webkit']);
		expect(options.scenarios).toEqual([0, 1, 2, 3, 4]);
		expect(options.count).toBe(1000);
		expect(options.dryRun).toBe(false);
	});

	it('reads the flags it is given', () => {
		const options = parseArgs([
			'--dry-run',
			'--engines',
			'webkit',
			'--scenario',
			'2',
			'--courses',
			'20',
			'--force'
		]);
		expect(options).toMatchObject({
			dryRun: true,
			engines: ['webkit'],
			scenarios: [2],
			count: 20,
			force: true
		});
	});

	it('refuses an unknown flag, engine, scenario or a value that is not a whole number', () => {
		expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
		expect(() => parseArgs(['--engines', 'netscape'])).toThrow(/unknown engine/);
		expect(() => parseArgs(['--scenario', '9'])).toThrow(/unknown scenario/);
		expect(() => parseArgs(['--courses', '1.5'])).toThrow(/whole number/);
		expect(() => parseArgs(['--out'])).toThrow(/needs a value/);
	});

	it('selects a single-visit tab by index and refuses an index past the list', () => {
		expect(parseArgs(['--scenario', '4']).scenarios).toEqual([4]);
		expect(parseArgs(['--scenario', '0,4']).scenarios).toEqual([0, 4]);
		expect(() => parseArgs(['--scenario', '5'])).toThrow(/unknown scenario 5/);
	});

	it('reads the bootstrap gate, the swap region and the trace file, and refuses an unknown gate', () => {
		expect(parseArgs([]).bootstrap).toBe('second-view');
		expect(parseArgs([]).swap).toBe(true);
		expect(parseArgs(['--no-swap']).swap).toBe(false);
		expect(parseArgs([]).clickGapMs).toBe(150);
		expect(parseArgs(['--click-gap-ms', '0']).clickGapMs).toBe(0);
		expect(parseArgs([]).trace).toBeUndefined();
		expect(parseArgs(['--bootstrap', 'first-view', '--trace', '/t.jsonl'])).toMatchObject({
			bootstrap: 'first-view',
			trace: '/t.jsonl'
		});
		expect(() => parseArgs(['--bootstrap', 'third-view'])).toThrow(/unknown bootstrap/);
	});
});

describe('the reader plan', () => {
	it('visits the document, the in-page views, then the warm documents with a dwell', () => {
		const steps = plan(SCENARIOS[3], 1000);
		expect(steps).toHaveLength(121);
		expect(steps.filter((s) => s.via === 'click')).toHaveLength(100);
		expect(steps.filter((s) => s.dwell)).toHaveLength(20);
		expect(steps[0]).toEqual({ via: 'open', index: 0, dwell: false });
	});
});

describe('the single-visit tabs', () => {
	it('keeps the four single-day models and adds one single-visit tab after them', () => {
		expect(SCENARIOS.map((s) => [s.name, s.views, s.warm])).toEqual([
			['One view, never returns', 1, 0],
			['Two views, one visit', 2, 0],
			['Five views, one visit', 5, 0],
			["Codex's mix: 1 + 100 in-page + 20 warm documents", 121, 20],
			['One tab, 2,000 views', 2000, 0]
		]);
	});

	it('plans a tab as one document and then in-page views, with no warm document', () => {
		const steps = plan(SCENARIOS[4], 1000);
		expect(steps).toHaveLength(2000);
		expect(steps.filter((s) => s.via === 'open')).toHaveLength(1);
		expect(steps.filter((s) => s.via === 'click')).toHaveLength(1999);
		expect(steps.filter((s) => s.dwell)).toHaveLength(0);
	});

	it('divides the baseline by the spool count, and by the worker count without boot and stub', () => {
		const boot = 'GET /.spool/1.0.0/boot/1.js';
		const stub = 'GET /spool-sw.js';
		const reading = {
			rows: [['One tab, 2,000 views', 2000]].flatMap(([scenario, views]) => [
				{
					engine: 'chromium',
					scenario,
					arm: 'baseline',
					views,
					requests: views,
					bytes: 0,
					wrong: 0,
					paths: { 'GET /courses/:id': views }
				},
				{
					engine: 'chromium',
					scenario,
					arm: 'spool',
					views,
					requests: 5,
					bytes: 0,
					wrong: 0,
					paths: { 'GET /courses/:id': 3, [boot]: 1, [stub]: 1 }
				}
			])
		} as unknown as Measurement;
		const counts = demandCounts(reading).map((c) => [
			c.views,
			c.baseline,
			c.spool,
			multiplierOf(c.baseline, c.spool)
		]);
		expect(counts).toEqual([[2000, 2000, 5, 400]]);
		expect(demandWorkerCounts(reading).map((c) => [c.views, c.spool])).toEqual([[2000, 3]]);
	});
});

describe('the dry run', () => {
	it('prints the plan and touches no browser or server', async () => {
		const seams: Deps = {
			launch: async () => {
				throw new Error('launch must not run on a dry run');
			},
			serve: async () => {
				throw new Error('serve must not run on a dry run');
			}
		};
		const lines: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)));
		const code = await main(['--dry-run', '--out', work, '--work', work], seams);
		expect(code).toBe(0);
		const printed = JSON.parse(lines.join('\n'));
		expect(printed.engines).toEqual(['chromium', 'firefox', 'webkit']);
		expect(printed.fileExists).toBe(false);
		expect(printed.file).toMatch(/demand\/\d{4}-\d{2}-\d{2}\.json$/);
		expect(printed.scenarios.map((s: { steps: number }) => s.steps)).toEqual([
			1, 2, 5, 121, 2000
		]);
	});

	it('names the file a run would write under the output folder', () => {
		const dry = dryRunPlan(tiny({ out: '/out' }), '2026-11-18');
		expect(dry.file).toBe('/out/demand/2026-11-18.json');
	});
});

describe('the arms', () => {
	it('counts every request the origin handler sees, with the same count for each arm of the stub', async () => {
		const rows = await runDemand(tiny(), stub);
		expect(rows.map((r) => [r.arm, r.requests, r.wrong])).toEqual([
			['baseline', 5, 0],
			['spool', 5, 0]
		]);
		expect(rows[0]!.paths).toEqual({ 'GET /courses/:id': 5 });
	});

	it('writes one trace line per view and one for the tail, with the requests each made', async () => {
		const trace = join(work, 'trace.jsonl');
		await runDemand(tiny({ scenarios: [1], trace }), stub);
		const lines = (await readFile(trace, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(lines.map((l) => [l.arm, l.step, l.requests.length])).toEqual([
			['baseline', 0, 1],
			['baseline', 1, 1],
			['baseline', 'tail', 0],
			['spool', 0, 1],
			['spool', 1, 1],
			['spool', 'tail', 0]
		]);
	});

	it('keeps a row for an arm that failed and names the failure', async () => {
		const failing: Deps = {
			...stub,
			launch: async () => {
				throw new Error('no browser here');
			}
		};
		const rows = await runDemand(tiny({ scenarios: [1] }), failing);
		expect(rows[0]!.fatal).toMatch(/no browser here/);
		expect(rows[0]!.requests).toBe(0);
	});
});

const PRELOAD = '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1';

/** the hours a libfaketime offset file holds, such as `+25h` */
const hoursIn = (file: string): number => Number(readFileSync(file, 'utf8').replace(/[+h]/g, ''));

/** stand-ins for a preloaded process: the offset file moves the node clock and the page clock together */
const clocked = (file: string, page = true): Deps => ({
	...stub,
	env: { LD_PRELOAD: PRELOAD, FAKETIME_TIMESTAMP_FILE: file },
	sleep: async () => undefined,
	now: () => 1_800_000_000_000 + hoursIn(file) * 3_600_000,
	launch: async (input) => {
		const driver = await stub.launch!(input);
		return {
			...driver,
			now: async () => 1_800_000_000_000 + (page ? hoursIn(file) : 0) * 3_600_000
		};
	}
});

const daysOptions = (over: Partial<Options> = {}): Options =>
	tiny({ days: true, scenarios: [1], ...over });

describe('the multi-day scenarios', () => {
	it('lists nine scenarios: the six from before, then three variants of their parents', () => {
		expect(DAY_SCENARIOS.map((s) => [s.name, s.views, s.gapH, s.site, s.pages])).toEqual([
			['Daily reader: one document a day, 5 days', [1, 1, 1, 1, 1], 25, 'courses', 'spread'],
			['Local-only reader across three leases', [3, 2, 2, 2], 25, 'courses', 'spread'],
			['Public edit: a held course changes between days', [3, 2, 2, 2], 25, 'live', 'course'],
			[
				'Principal reader, session stays valid, session retention',
				[3, 1, 1, 1],
				25,
				'live',
				'me'
			],
			[
				'Principal reader, session ends on the server after day 2, session retention',
				[3, 1, 1, 1],
				25,
				'live',
				'me'
			],
			[
				'Principal edit: the visitor row changes between days, session retention',
				[3, 1, 1, 1],
				25,
				'live',
				'me'
			],
			[
				'Public edit, stored page route with depends: a held course changes between days',
				[3, 2, 2, 2],
				25,
				'live',
				'course'
			],
			[
				'Principal reader, session stays valid, persistent retention and depends on members',
				[3, 1, 1, 1],
				25,
				'live',
				'me'
			],
			[
				'Principal reader, session ends on the server after day 2, persistent retention and depends on members',
				[3, 1, 1, 1],
				25,
				'live',
				'me'
			]
		]);
	});

	it('keeps the data of all nine scenarios; only their titles and routes changed', () => {
		expect(DAY_SCENARIOS.map(({ name: _name, ...data }) => data)).toEqual([
			{ views: [1, 1, 1, 1, 1], gapH: 25, site: 'courses', pages: 'spread' },
			{ views: [3, 2, 2, 2], gapH: 25, site: 'courses', pages: 'spread' },
			{
				views: [3, 2, 2, 2],
				gapH: 25,
				site: 'live',
				pages: 'course',
				edits: [{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }]
			},
			{ views: [3, 1, 1, 1], gapH: 25, site: 'live', pages: 'me', login: 'ada' },
			{
				views: [3, 1, 1, 1],
				gapH: 25,
				site: 'live',
				pages: 'me',
				login: 'ada',
				revokeAfterDay: 2
			},
			{
				views: [3, 1, 1, 1],
				gapH: 25,
				site: 'live',
				pages: 'me',
				login: 'ada',
				edits: [{ day: 2, kind: 'member', text: 'Ada Park, edited' }]
			},
			{
				views: [3, 2, 2, 2],
				gapH: 25,
				site: 'live',
				pages: 'course',
				edits: [{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }],
				variant: 'stored'
			},
			{
				views: [3, 1, 1, 1],
				gapH: 25,
				site: 'live',
				pages: 'me',
				login: 'ada',
				variant: 'persistent'
			},
			{
				views: [3, 1, 1, 1],
				gapH: 25,
				site: 'live',
				pages: 'me',
				login: 'ada',
				revokeAfterDay: 2,
				variant: 'persistent'
			}
		]);
	});

	it('gives the new scenarios their login, edits and revocation as data', () => {
		const scenarios: readonly DayScenario[] = DAY_SCENARIOS;
		expect(scenarios.slice(2, 6).map((s) => [s.login, s.edits, s.revokeAfterDay])).toEqual([
			[undefined, [{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }], undefined],
			['ada', undefined, undefined],
			['ada', undefined, 2],
			['ada', [{ day: 2, kind: 'member', text: 'Ada Park, edited' }], undefined]
		]);
	});

	it('visits one fixed course, or the principal page, on every view of the new scenarios', () => {
		expect(dayPlan(DAY_SCENARIOS[2], 1000).map((s) => s.path)).toEqual(
			Array(9).fill('/courses/101')
		);
		expect(dayPlan(DAY_SCENARIOS[3], 1000).map((s) => [s.day, s.offsetH, s.path])).toEqual([
			[0, 0, '/me'],
			[0, 0, '/me'],
			[0, 0, '/me'],
			[1, 25, '/me'],
			[2, 50, '/me'],
			[3, 75, '/me']
		]);
		expect(dayPlan(DAY_SCENARIOS[0], 1000)[1]!.path).toBe('/courses/138');
	});

	it('gives each variant its parent data, with only its name and variant changed', () => {
		const scenarios: readonly DayScenario[] = DAY_SCENARIOS;
		const bare = ({ name: _name, variant: _variant, ...rest }: DayScenario) => rest;
		expect(scenarios.slice(0, 6).map((s) => s.variant)).toEqual(Array(6).fill(undefined));
		expect(scenarios.slice(6).map((s) => s.variant)).toEqual([
			'stored',
			'persistent',
			'persistent'
		]);
		expect(bare(scenarios[6]!)).toEqual(bare(scenarios[2]!));
		expect(bare(scenarios[7]!)).toEqual(bare(scenarios[3]!));
		expect(bare(scenarios[8]!)).toEqual(bare(scenarios[4]!));
		expect(scenarios[6]!.name).toMatch(/stored page route with depends/);
		expect(scenarios[7]!.name).toMatch(/persistent retention/);
		expect(scenarios[8]!.name).toMatch(/persistent retention/);
	});

	type Handler = (request: Request) => Promise<Response>;

	/**
	 * what `read` finds at each view of a scenario, in order: the baseline arm's views, then the spool
	 * arm's. `get` sends a request with the cookie the scenario's login left, as a signed-in visitor does.
	 */
	const atEachView = async <T>(
		index: number,
		read: (get: (path: string) => Promise<Response>) => Promise<T>
	): Promise<T[]> => {
		const seen: T[] = [];
		// kept across the browser launches of the days: a visitor's cookie outlives a closed browser
		let cookie = '';
		await runDays(daysOptions({ work, scenarios: [index] }), {
			...clocked(join(work, 'offset')),
			launch: async ({ handler }: { handler: Handler }) => {
				return {
					async login(as) {
						const response = await handler(
							new Request(`${ORIGIN}/login?as=${as}`, { method: 'POST' })
						);
						cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
					},
					async visit() {
						seen.push(
							await read((path) =>
								handler(
									new Request(ORIGIN + path, {
										headers: cookie ? { cookie } : undefined
									})
								)
							)
						);
						return true;
					},
					wait: async () => undefined,
					controlled: async () => false,
					close: async () => undefined
				};
			}
		});
		return seen;
	};

	/** the worker config a `/spool-sw.js` response carries on its first line, or null for a response without one */
	const stubConfig = async (
		get: (path: string) => Promise<Response>
	): Promise<Record<string, unknown> | null> => {
		const line = (await (await get('/spool-sw.js')).text()).split('\n')[0] ?? '';
		const prefix = 'self.__SPOOL_CONFIG__=';
		return line.startsWith(prefix) ? JSON.parse(line.slice(prefix.length, -1)) : null;
	};

	/** the `deps` of the `Spool-Artifact` header a response carries, or `no artifact` when it has none */
	const depsOf = (response: Response): string =>
		/deps=([^;]*)/.exec(response.headers.get('spool-artifact') ?? '')?.[1] ?? 'no artifact';

	it('serves the course page of scenario 6 from a stored route with the courses tag, and scenario 2 from a family route', async () => {
		const courseRoute = (get: (path: string) => Promise<Response>) =>
			stubConfig(get).then(
				(config) =>
					(
						config?.['routes'] as
							Array<{ pattern: string; family?: unknown }> | undefined
					)?.find((route) => route.pattern === '/courses/:id') ?? null
			);
		const parentFamily = await atEachView(
			2,
			async (get) => (await courseRoute(get))?.family ?? null
		);
		const variantFamily = await atEachView(
			6,
			async (get) => (await courseRoute(get))?.family ?? null
		);
		const parentDeps = await atEachView(2, async (get) => depsOf(await get('/courses/101')));
		const variantDeps = await atEachView(6, async (get) => depsOf(await get('/courses/101')));
		expect(parentFamily.slice(9)).toEqual(Array(9).fill({ dataset: 'courses', key: 'id' }));
		expect(variantFamily.slice(9)).toEqual(Array(9).fill(null));
		expect(parentDeps.slice(9)).toEqual(Array(9).fill(''));
		expect(variantDeps.slice(9)).toEqual(Array(9).fill('courses'));
	});

	it('names the members tag on the principal page of a persistent variant only', async () => {
		const variant = await atEachView(7, async (get) => depsOf(await get('/me')));
		const session = await atEachView(3, async (get) => depsOf(await get('/me')));
		expect(variant.slice(6)).toEqual(Array(6).fill('members'));
		expect(session.slice(6)).toEqual(Array(6).fill(''));
	});

	it('waits for the worker to control the page after each spool view, and for no other arm', async () => {
		const run = async (engageMs: number) => {
			const asked: number[] = [];
			const rows = await runDays(daysOptions({ work, scenarios: [1], engageMs }), {
				...clocked(join(work, 'offset')),
				launch: async (input) => {
					const driver = await clocked(join(work, 'offset')).launch!(input);
					return {
						...driver,
						engage: async (limit) => {
							asked.push(limit);
							return 7;
						}
					};
				}
			});
			return { asked, rows };
		};
		const waiting = await run(4000);
		expect(waiting.asked).toEqual(Array(9).fill(4000));
		const [baseline, spool] = waiting.rows;
		expect(baseline!.engaged!.map((e) => e.waitedMs)).toEqual(Array(9).fill(null));
		expect(spool!.engaged!.map((e) => e.waitedMs)).toEqual(Array(9).fill(7));
		expect(spool!.engaged!.map((e) => [e.day, e.step])).toEqual(
			DAY_SCENARIOS[1]!.views.flatMap((count, day) =>
				Array.from({ length: count }, (_, step) => [day, step])
			)
		);
		const off = await run(0);
		expect(off.asked).toEqual([]);
	});

	it('declares session retention on the principal page of scenarios 3 to 5 and persistent on 7 and 8', async () => {
		const meRetention = async (index: number) =>
			(
				await atEachView(
					index,
					async (get) =>
						(
							(await stubConfig(get))?.['routes'] as
								Array<{ pattern: string; retention?: string }> | undefined
						)?.find((route) => route.pattern === '/me')?.retention ?? null
				)
			).slice(6);
		expect(await meRetention(3)).toEqual(Array(6).fill('session'));
		expect(await meRetention(4)).toEqual(Array(6).fill('session'));
		expect(await meRetention(5)).toEqual(Array(6).fill('session'));
		expect(await meRetention(7)).toEqual(Array(6).fill('persistent'));
		expect(await meRetention(8)).toEqual(Array(6).fill('persistent'));
	});

	it('gives the members dataset the fixture bound in scenarios 7 and 8', async () => {
		const bounds = async (index: number) =>
			(
				await atEachView(
					index,
					async (get) => (await stubConfig(get))?.['principalDatasets'] ?? null
				)
			).slice(6);
		expect(await bounds(7)).toEqual(Array(6).fill([{ name: 'members', maxStaleMs: 600_000 }]));
		expect(await bounds(8)).toEqual(Array(6).fill([{ name: 'members', maxStaleMs: 600_000 }]));
	});

	it('serves a stub that carries the new pack once the edit step publishes it', async () => {
		const digests = await atEachView(2, async (get) => {
			const pack = (await stubConfig(get))?.['pack'] as { digest?: string } | undefined;
			return pack?.digest ?? null;
		});
		const spool = digests.slice(9);
		expect(typeof spool[0]).toBe('string');
		expect(spool.slice(0, 5)).toEqual(Array(5).fill(spool[0]));
		expect(typeof spool[5]).toBe('string');
		expect(spool[5]).not.toBe(spool[0]);
		expect(spool.slice(5)).toEqual(Array(4).fill(spool[5]));
	});

	it('loads the stored course route as { row }, so its template renders the title from the held data', () => {
		const ctx = { params: { id: '101' } } as never;
		const stored = originPage(3, true, true).item;
		const family = originPage(3, true, false).item;
		expect(stored.load(ctx)).toEqual({ row: { id: '101', title: 'Intro to Drupal' } });
		expect(interpretTemplate(stored.template!, stored.load(ctx))).toContain(
			'<h1>Intro to Drupal</h1>'
		);
		expect(family.load(ctx)).toEqual({ id: '101', title: 'Intro to Drupal' });
	});

	it('schedules every view as a document open, with the clock offset of its day', () => {
		const steps = dayPlan(DAY_SCENARIOS[1], 1000);
		expect(steps).toHaveLength(9);
		expect(steps.map((s) => [s.day, s.offsetH, s.dwell])).toEqual([
			[0, 0, false],
			[0, 0, true],
			[0, 0, true],
			[1, 25, false],
			[1, 25, true],
			[2, 50, false],
			[2, 50, true],
			[3, 75, false],
			[3, 75, true]
		]);
		expect(new Set(steps.map((s) => s.index)).size).toBeGreaterThan(5);
		expect(dayPlan(DAY_SCENARIOS[0], 1000).map((s) => s.offsetH)).toEqual([0, 25, 50, 75, 100]);
	});
});

describe('the per-day tally', () => {
	const hit = (
		day: number,
		step: number,
		path: string,
		bytes: number,
		method = 'GET'
	): DayHit => ({
		day,
		step,
		method,
		path,
		bytes,
		dest: null,
		mode: null
	});
	const log: DayHit[] = [
		hit(0, 0, '/courses/101', 1000),
		hit(0, 0, '/.spool/1.0.0/client.js', 300),
		hit(0, 0, '/spool-sw.js', 200),
		hit(0, 1, '/courses/138', 500),
		hit(0, 1, '/.spool/bundle/1', 4000),
		hit(1, 0, '/spool-sw.js', 200),
		hit(1, 1, '/.spool/sync', 50),
		hit(1, 1, '/.spool/beacon', 10, 'POST'),
		hit(2, 0, '/courses/5', 700),
		hit(2, 0, '/.spool/sync', 60)
	];

	it('counts requests, dynamic requests, bytes and each type for every day', () => {
		expect(tallyDays(log, 4)).toEqual([
			{
				day: 0,
				requests: 5,
				dynamic: 3,
				bytes: 6000,
				byType: {
					document: { requests: 2, bytes: 1500 },
					asset: { requests: 1, bytes: 300 },
					stub: { requests: 1, bytes: 200 },
					pack: { requests: 1, bytes: 4000 }
				}
			},
			{
				day: 1,
				requests: 3,
				dynamic: 2,
				bytes: 260,
				byType: {
					stub: { requests: 1, bytes: 200 },
					drain: { requests: 1, bytes: 50 },
					beacon: { requests: 1, bytes: 10 }
				}
			},
			{
				day: 2,
				requests: 2,
				dynamic: 2,
				bytes: 760,
				byType: {
					document: { requests: 1, bytes: 700 },
					sync: { requests: 1, bytes: 60 }
				}
			},
			{ day: 3, requests: 0, dynamic: 0, bytes: 0, byType: {} }
		]);
	});

	it('calls a sync a drain only when its step made no document request', () => {
		expect(classifyHit(log[6]!, false)).toBe('drain');
		expect(classifyHit(log[9]!, true)).toBe('sync');
		expect(classifyHit(hit(0, 0, '/.spool/dataset', 1), false)).toBe('drain');
		expect(classifyHit(hit(0, 0, '/.spool/artifact', 1), false)).toBe('artifact');
		expect(classifyHit(hit(0, 0, '/favicon.ico', 1), false)).toBe('other');
		expect(classifyHit(hit(0, 0, '/.spool/1.0.0/boot/1.js', 1), false)).toBe('asset');
	});

	it('names the principal page, the login, the dataset sync and the delta', () => {
		expect(classifyHit(hit(0, 0, '/me', 1), false)).toBe('document');
		expect(classifyHit(hit(0, 0, '/login', 1, 'POST'), false)).toBe('login');
		expect(classifyHit(hit(0, 0, '/.spool/dataset', 1), true)).toBe('dataset');
		expect(classifyHit(hit(0, 0, '/.spool/bundle/delta/1/2', 1), true)).toBe('delta');
		expect(classifyHit(hit(0, 0, '/.spool/bundle/2', 1), true)).toBe('pack');
		expect(classifyHit(hit(0, 0, '/.spool/write', 1, 'POST'), true)).toBe('write');
	});

	it('tallies an edit day by type from a fixed log: a dataset sync and a document, then a drain', () => {
		const edit = [
			hit(2, 0, '/spool-sw.js', 200),
			hit(2, 0, '/.spool/sync', 40),
			hit(2, 0, '/.spool/dataset', 90),
			hit(2, 1, '/me', 300),
			hit(3, 0, '/.spool/dataset', 20),
			hit(3, 1, '/.spool/bundle/delta/1/2', 70)
		];
		const days = tallyDays(edit, 4);
		expect(days[2]).toEqual({
			day: 2,
			requests: 4,
			dynamic: 3,
			bytes: 630,
			byType: {
				stub: { requests: 1, bytes: 200 },
				drain: { requests: 2, bytes: 130 },
				document: { requests: 1, bytes: 300 }
			}
		});
		expect(days[3]!.byType).toEqual({
			drain: { requests: 1, bytes: 20 },
			delta: { requests: 1, bytes: 70 }
		});
	});

	it('says whether a view showed the text before the edit, after it, or something else', () => {
		expect(shownState('Intro', 'Intro', 'Intro, revised')).toBe('old');
		expect(shownState('Intro, revised', 'Intro', 'Intro, revised')).toBe('new');
		expect(shownState(null, 'Intro', 'Intro, revised')).toBe('other');
		expect(shownState('Sign in', 'Intro', 'Intro, revised')).toBe('other');
	});
});

/** a stand-in with a cookie jar that outlives a relaunch: login, visits that carry the cookie, and the h1 */
const liveStub = (file: string): Deps => {
	let cookie = '';
	return {
		...clocked(file),
		launch: async ({ handler }) => {
			let last = '';
			const get = (path: string, method = 'GET') =>
				handler(
					new Request(ORIGIN + path, { method, headers: cookie ? { cookie } : undefined })
				);
			return {
				async visit(path) {
					last = await (await get(path)).text();
					return true;
				},
				wait: async () => undefined,
				controlled: async () => false,
				close: async () => undefined,
				now: async () => 1_800_000_000_000 + hoursIn(file) * 3_600_000,
				async login(as) {
					const response = await get(`/login?as=${as}`, 'POST');
					cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
				},
				text: async () => /<h1>(.*?)<\/h1>/.exec(last)?.[1] ?? null
			};
		}
	};
};

describe('the principal and edit scenarios', () => {
	const run = (index: number) =>
		runDays(daysOptions({ work, scenarios: [index] }), liveStub(join(work, 'offset')));
	const perDay = (row: Awaited<ReturnType<typeof run>>[number]) =>
		row.days.map((d) => d.requests);
	const texts = (row: Awaited<ReturnType<typeof run>>[number]) => row.shown?.map((s) => s.text);

	it('counts the login on day 0 and one page request on each later day for a valid session', async () => {
		const rows = await run(3);
		for (const row of rows) {
			expect(row.fatal).toBeUndefined();
			expect(perDay(row)).toEqual([4, 1, 1, 1]);
			expect(texts(row)).toEqual(Array(6).fill('Ada Park'));
		}
		expect(rows[0]!.days[0]!.byType['login']).toEqual({ requests: 1, bytes: 9 });
	});

	it('shows no principal page on the day after the session ends on the server', async () => {
		const rows = await run(4);
		for (const row of rows) {
			expect(perDay(row)).toEqual([4, 1, 1, 1]);
			expect(texts(row)).toEqual([
				'Ada Park',
				'Ada Park',
				'Ada Park',
				'Ada Park',
				'Ada Park',
				null
			]);
		}
	});

	it('shows the edited course from the edit day on, and the edited principal row the same way', async () => {
		const course = await run(2);
		for (const row of course) {
			expect(perDay(row)).toEqual([3, 2, 2, 2]);
			expect(texts(row)).toEqual([
				...Array(5).fill('Intro to Drupal'),
				...Array(4).fill('Intro to Drupal, revised')
			]);
		}
		const member = await run(5);
		for (const row of member) {
			expect(texts(row)).toEqual([
				'Ada Park',
				'Ada Park',
				'Ada Park',
				'Ada Park',
				'Ada Park, edited',
				'Ada Park, edited'
			]);
		}
	});

	it('gives every spool row a worker view list, even when no beacon arrived', async () => {
		const rows = await run(3);
		expect(rows.map((r) => [r.arm, r.workerViews])).toEqual([
			['baseline', undefined],
			['spool', []]
		]);
	});
});

describe('the worker views a spool arm reports', () => {
	const view = (id: string, reason: ViewEvent['reason'], staleSec: number | null): ViewEvent => ({
		id,
		tier: reason === 'fresh' ? 'local' : 'local-revalidate',
		reason,
		staleSec,
		engine: 'chromium',
		scope: 'public',
		strategy: 'template',
		route: '/courses/:id',
		mismatch: null,
		swAgeMs: 1200,
		gapMs: null,
		crossOriginLoads: null
	});

	it('lists the reason, tier and age of each view the server received, in order', () => {
		const events = [
			viewToBeacon(view('a', 'fresh', 3), 1000),
			{ path: '/other', body: '', contentType: 'text/plain', at: 1001 },
			viewToBeacon(view('b', 'soft-sync', 90_000), 2000)
		];
		expect(viewRows(events)).toEqual([
			{
				at: 1000,
				route: '/courses/:id',
				tier: 'local',
				reason: 'fresh',
				staleSec: 3,
				swAgeMs: 1200,
				gapMs: null
			},
			{
				at: 2000,
				route: '/courses/:id',
				tier: 'local-revalidate',
				reason: 'soft-sync',
				staleSec: 90_000,
				swAgeMs: 1200,
				gapMs: null
			}
		]);
	});

	it('gives a spool row an empty list when no beacon arrived and a baseline row none', async () => {
		const rows = await runDays(
			daysOptions({ work, scenarios: [0] }),
			clocked(join(work, 'offset'))
		);
		expect(rows.map((r) => [r.arm, r.workerViews])).toEqual([
			['baseline', undefined],
			['spool', []]
		]);
	});
});

describe('the faked clock', () => {
	it('writes a libfaketime offset inside the work folder and refuses a path outside it', async () => {
		const file = join(work, 'offset');
		await writeOffset(file, work, 25);
		expect(readFileSync(file, 'utf8')).toBe('+25h');
		await writeOffset(file, work, 0);
		expect(readFileSync(file, 'utf8')).toBe('+0');
		await expect(writeOffset(join(tmpdir(), 'offset-elsewhere'), work, 1)).rejects.toThrow(
			/outside the work folder/
		);
		await expect(writeOffset(join(work, '..', 'offset'), work, 1)).rejects.toThrow(
			/outside the work folder/
		);
	});

	it('refuses to run without the preload and the offset file, and prints the container command', () => {
		expect(() => requireClock({})).toThrow(/FAKETIME_TIMESTAMP_FILE/);
		expect(() => requireClock({ FAKETIME_TIMESTAMP_FILE: '/w/offset' })).toThrow(/LD_PRELOAD/);
		expect(() =>
			requireClock({ LD_PRELOAD: '/lib/other.so', FAKETIME_TIMESTAMP_FILE: '/w/o' })
		).toThrow(/libfaketime/);
		expect(() => requireClock({})).toThrow(/md-run\.sh/);
		expect(requireClock({ LD_PRELOAD: PRELOAD, FAKETIME_TIMESTAMP_FILE: '/w/offset' })).toBe(
			'/w/offset'
		);
	});

	it('accepts a clock that moved by the offset within an hour and refuses one that did not', () => {
		const start = 1_800_000_000_000;
		expect(clockMoved(start, start + 25 * 3_600_000 + 5_000, 25)).toBe(true);
		expect(clockMoved(start, start + 5_000, 25)).toBe(false);
		expect(clockMoved(start, start + 27 * 3_600_000, 25)).toBe(false);
	});
});

describe('the multi-day arms', () => {
	it('reads --days and indexes --scenario into the multi-day list', () => {
		expect(parseArgs([]).days).toBe(false);
		const options = parseArgs(['--days']);
		expect(options.days).toBe(true);
		expect(options.scenarios).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(parseArgs(['--scenario', '1', '--days']).scenarios).toEqual([1]);
		expect(parseArgs(['--scenario', '6,7,8', '--days']).scenarios).toEqual([6, 7, 8]);
		expect(() => parseArgs(['--days', '--scenario', '9'])).toThrow(/unknown scenario 9/);
		expect(parseArgs(['--experiment', 'principal-edit']).experiment).toBe('principal-edit');
		expect(() => parseArgs(['--experiment', 'Bad Name'])).toThrow(/experiment/);
		expect(parseArgs(['--clock-wait-ms', '10']).clockWaitMs).toBe(10);
	});

	it('prints engines, scenarios, days and the file a multi-day run would write', async () => {
		const lines: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)));
		const code = await main(['--dry-run', '--days', '--out', work, '--work', work], {
			launch: async () => {
				throw new Error('launch must not run on a dry run');
			}
		});
		expect(code).toBe(0);
		const printed = JSON.parse(lines.join('\n'));
		expect(printed.engines).toEqual(['chromium', 'firefox', 'webkit']);
		expect(
			printed.scenarios.map((s: { steps: number; days: number }) => [s.days, s.steps])
		).toEqual([
			[5, 5],
			[4, 9],
			[4, 9],
			[4, 6],
			[4, 6],
			[4, 6],
			[4, 9],
			[4, 6],
			[4, 6]
		]);
		expect(printed.scenarios.map((s: { variant: string | null }) => s.variant)).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
			'stored',
			'persistent',
			'persistent'
		]);
		expect(printed.scenarios[4]).toMatchObject({
			site: 'live',
			login: 'ada',
			revokeAfterDay: 2
		});
		expect(printed.scenarios[2].edits).toEqual([
			{ day: 2, kind: 'course', text: 'Intro to Drupal, revised' }
		]);
		expect(printed.file).toMatch(/demand\/\d{4}-\d{2}-\d{2}-days\.json$/);
		expect(printed.fileExists).toBe(false);
	});

	it('adds the experiment word to the multi-day file name', () => {
		const dry = dryRunPlan(
			daysOptions({ out: '/out', experiment: 'principal-edit' }),
			'2026-11-20'
		);
		expect(dry.file).toBe('/out/demand/2026-11-20-days-principal-edit.json');
	});

	it('refuses the multi-day arms without the clock and runs no browser', async () => {
		const deps: Deps = {
			env: {},
			launch: async () => {
				throw new Error('launch must not run');
			}
		};
		await expect(main(['--days', '--out', work, '--work', work], deps)).rejects.toThrow(
			/FAKETIME_TIMESTAMP_FILE/
		);
	});

	it('tallies every day of both arms, leaves the clock at +0 and counts the same views in each', async () => {
		const file = join(work, 'offset');
		const rows = await runDays(daysOptions({ work }), clocked(file));
		expect(rows.map((r) => [r.arm, r.days.length, r.requests, r.wrong, r.fatal])).toEqual([
			['baseline', 4, 9, 0, undefined],
			['spool', 4, 9, 0, undefined]
		]);
		expect(rows[0]!.days.map((d) => d.requests)).toEqual([3, 2, 2, 2]);
		expect(rows[0]!.days.map((d) => d.byType['document']?.requests)).toEqual([3, 2, 2, 2]);
		expect(rows[0]!.clock.map((c) => c.offsetH)).toEqual([0, 25, 50, 75]);
		expect(hoursIn(file)).toBe(0);
	});

	it('keeps a row that names a clock the runtime did not move, and counts nothing from it', async () => {
		const file = join(work, 'offset');
		const rows = await runDays(daysOptions({ work }), clocked(file, false));
		expect(rows[0]!.fatal).toMatch(/clock/);
		expect(rows[0]!.days.map((d) => d.requests)).toEqual([3]);
	});

	it('reads the page clock a second time when it did not move, and names both offsets', async () => {
		const file = join(work, 'offset');
		const rows = await runDays(daysOptions({ work }), clocked(file, false));
		expect(rows[0]!.fatal).toMatch(/page offset 0\.00 h, read again after \d+ ms: 0\.00 h\)$/);
		expect(rows[0]!.clock.map((c) => [c.day, c.offsetH])).toEqual([
			[0, 0],
			[1, 25]
		]);
	});

	it('writes one trace line per view and one per day for the tail, with the requests each made', async () => {
		const trace = join(work, 'trace.jsonl');
		await runDays(daysOptions({ work, trace }), clocked(join(work, 'offset')));
		const lines = (await readFile(trace, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(26);
		expect(lines.slice(0, 13).map((l) => [l.arm, l.day, l.step, l.requests.length])).toEqual([
			['baseline', 0, 0, 1],
			['baseline', 0, 1, 1],
			['baseline', 0, 2, 1],
			['baseline', 0, 'tail', 0],
			['baseline', 1, 0, 1],
			['baseline', 1, 1, 1],
			['baseline', 1, 'tail', 0],
			['baseline', 2, 0, 1],
			['baseline', 2, 1, 1],
			['baseline', 2, 'tail', 0],
			['baseline', 3, 0, 1],
			['baseline', 3, 1, 1],
			['baseline', 3, 'tail', 0]
		]);
		expect(lines[0]!.requests[0]).toMatchObject({
			path: '/courses/101',
			status: 200,
			conditional: false
		});
		expect(lines[13]!.arm).toBe('spool');
	});

	it('writes a multi-day reading that the schema-1 reader accepts', async () => {
		const file = join(work, 'offset');
		const options = daysOptions({ work });
		const rows = await runDays(options, clocked(file));
		const draft = daysDraftOf(rows, options, '2026-11-19');
		expect(measurementProblems({ schema: 1, ...draft })).toEqual([]);
		expect(() =>
			parseMeasurementText(serialiseMeasurement(draft), 'demand days')
		).not.toThrow();
		expect(draft.exclusions.join(' ')).toMatch(/monotonic clock is not faked/);
		expect(draft.software['faketime']).toMatch(/libfaketime/);
	});

	it('puts the sealed key count in the trace lines of a spool arm, when the driver reports one', async () => {
		const trace = join(work, 'trace.jsonl');
		const deps: Deps = {
			...clocked(join(work, 'offset')),
			launch: async (input) => ({ ...(await stub.launch!(input)), keys: async () => 2 })
		};
		await runDays(daysOptions({ work, trace, scenarios: [1] }), deps);
		const lines = (await readFile(trace, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(
			lines.filter((l) => l.arm === 'spool' && l.step !== 'tail').map((l) => l.keys)
		).toEqual(Array(9).fill(2));
		expect(lines.filter((l) => l.arm === 'baseline').every((l) => l.keys === undefined)).toBe(
			true
		);
	});

	it('records the container and the box load average in the machine block', async () => {
		const options = daysOptions({ work });
		const env = { RIG_CONTAINER: 'spool-v1-browser:1', RIG_LOAD_AVG: '0.52 0.40 0.31' };
		const draft = daysDraftOf([], options, '2026-11-19', env);
		expect(draft.machine).toMatchObject({
			container: 'spool-v1-browser:1',
			loadAverageAtStart: '0.52 0.40 0.31'
		});
		expect(draft.method['realEpochMs']).toBe('unset');
	});
});

describe('the reading', () => {
	it('validates through the schema-1 reader', async () => {
		const rows = await runDemand(tiny(), stub);
		const text = serialiseMeasurement(draftOf(rows, tiny(), '2026-11-18'));
		expect(() => parseMeasurementText(text, 'demand')).not.toThrow();
	});

	it('names the machine it is given', async () => {
		expect(parseArgs(['--machine', 'paisley-park']).machine).toBe('paisley-park');
		const rows = await runDemand(tiny(), stub);
		const draft = draftOf(rows, tiny({ machine: 'paisley-park' }), '2026-11-18');
		expect(draft.machine['name']).toBe('paisley-park');
	});
});
