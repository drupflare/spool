import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import count from '../../examples/static/cloudflare-worker/count';
import { SCENARIOS } from '../../scripts/measure/demand';
import {
	ARMS,
	counterSequenceOk,
	draftOf,
	dryRunPlan,
	main,
	NEW_ENTRY,
	parseOptions,
	phasesOf,
	runStaticHost,
	tallyPhases,
	type Deps,
	type Driver,
	type Host,
	type Line,
	type Step
} from '../../scripts/measure/static-host';
import {
	measurementProblems,
	parseMeasurementText,
	serialiseMeasurement
} from '../../src/report/index';

const line = (over: Partial<Line> & Pick<Line, 'phase' | 'path'>): Line => ({
	epoch: 0,
	method: 'GET',
	status: 200,
	bytes: 0,
	worker: false,
	conditional: false,
	invocation: null,
	at: 0,
	...over
});

describe('the static-host rig options', () => {
	it('runs four arms in Chromium and Firefox, five lease periods of 90 s, from port 6550', () => {
		const options = parseOptions([]);
		expect(options.engines).toEqual(['chromium', 'firefox']);
		expect(options.arms).toEqual([
			'worker-only',
			'static-unstamped',
			'static-stamped',
			'no-spool'
		]);
		expect(options.lease).toBe(90);
		expect(options.periods).toBe(5);
		expect(options.port).toBe(6550);
		expect(options.dryRun).toBe(false);
	});

	it('refuses an unknown arm, engine or experiment, and a lease or port it cannot run', () => {
		expect(() => parseOptions(['--arms', 'toaster'])).toThrow('unknown arm toaster');
		expect(() => parseOptions(['--engines', 'opera'])).toThrow('unknown engine opera');
		expect(() => parseOptions(['--experiment', 'Short Lease'])).toThrow('--experiment');
		expect(() => parseOptions(['--lease', '0'])).toThrow('--lease');
		expect(() => parseOptions(['--lease', '1.5'])).toThrow('--lease');
		expect(() => parseOptions(['--port', '80'])).toThrow('--port');
	});

	it('reads the flags it is given', () => {
		const options = parseOptions([
			'--arms',
			'no-spool,worker-only',
			'--engines',
			'chromium',
			'--lease',
			'8',
			'--periods',
			'2',
			'--machine',
			'paisley-park',
			'--experiment',
			'short',
			'--force'
		]);
		expect(options.arms).toEqual(['no-spool', 'worker-only']);
		expect(options.lease).toBe(8);
		expect(options.periods).toBe(2);
		expect(options.machine).toBe('paisley-park');
		expect(options.experiment).toBe('short');
		expect(options.force).toBe(true);
	});
});

describe('the arms and phases', () => {
	it('names four arms: the Worker alone, files once, files with a stamp, and no spool', () => {
		expect(ARMS.map((arm) => [arm.name, arm.spool, arm.publish])).toEqual([
			['worker-only', true, 'none'],
			['static-unstamped', true, 'once'],
			['static-stamped', true, 'each-lease'],
			['no-spool', false, 'none']
		]);
	});

	it('lists the first view, views 2 and 3, 121 read views, the lease periods and the publish', () => {
		const phases = phasesOf({ lease: 90, periods: 5 });
		expect(phases.map((phase) => phase.id)).toEqual([
			'first-view',
			'view-2',
			'view-3',
			'read-121',
			'lease-1',
			'lease-2',
			'lease-3',
			'lease-4',
			'lease-5',
			'publish'
		]);
		expect(phases.map((phase) => phase.wait)).toEqual([0, 0, 0, 0, 91, 91, 91, 91, 91, 91]);
	});

	it('replays the demand reader mix in the read phase and opens one document in each lease phase', () => {
		const phases = phasesOf({ lease: 10, periods: 2 });
		const read = phases.find((phase) => phase.id === 'read-121')!.steps;
		const scenario = SCENARIOS[3];
		expect(read).toHaveLength(scenario.views);
		expect(read.filter((step) => step.via === 'click')).toHaveLength(100);
		expect(read.filter((step) => step.dwell)).toHaveLength(scenario.warm);
		expect(read[0]!.via).toBe('open');
		expect(read.every((step) => /^\/entries\/89\d\d$/.test(step.path))).toBe(true);
		expect(read.every((step) => typeof step.title === 'string')).toBe(true);
		for (const id of ['lease-1', 'lease-2']) {
			const steps = phases.find((phase) => phase.id === id)!.steps;
			expect(steps.map((step) => step.via)).toEqual(['open']);
		}
		expect(phases.find((phase) => phase.id === 'publish')!.steps).toEqual([
			{ via: 'open', path: '/', title: 'Newest Entries', dwell: false }
		]);
	});
});

describe('the per-phase tally', () => {
	const lines: Line[] = [
		line({ phase: 'first-view', path: '/', worker: true, invocation: 1, bytes: 6000 }),
		line({ phase: 'first-view', path: '/.spool/1.0.0/client.js', bytes: 90000 }),
		line({ phase: 'first-view', path: '/.spool/bundle/1', bytes: 1800 }),
		line({ phase: 'lease-1', path: '/spool-sw.js', status: 304, conditional: true }),
		line({ phase: 'lease-1', path: '/spool-sw.js', bytes: 140000 }),
		line({
			phase: 'lease-1',
			path: '/.spool/sync',
			worker: true,
			invocation: 2,
			bytes: 50
		}),
		line({
			phase: 'lease-1',
			path: '/entries/8999',
			worker: true,
			invocation: 3,
			status: 404,
			bytes: 9
		})
	];
	const reads = [
		{ phase: 'first-view', before: 0, after: 1 },
		{ phase: 'lease-1', before: 1, after: 3 }
	];

	it('counts invocations from the counter and requests by who answered, status and bytes', () => {
		const [first, lease] = tallyPhases(['first-view', 'lease-1', 'view-2'], lines, reads);
		expect(first).toMatchObject({
			phase: 'first-view',
			requests: 3,
			worker_invocations: 1,
			worker_responses: 1,
			asset_requests: 2,
			asset_200: 2,
			asset_304: 0,
			asset_other: 0,
			worker_200: 1,
			worker_304: 0,
			worker_other: 0,
			worker_bytes: 6000,
			asset_bytes: 91800,
			counter_agrees: true
		});
		expect(first!.by_kind).toEqual({
			document: { worker: 1, assets: 0 },
			runtime: { worker: 0, assets: 1 },
			pack: { worker: 0, assets: 1 }
		});
		expect(lease).toMatchObject({
			requests: 4,
			worker_invocations: 2,
			worker_responses: 2,
			asset_requests: 2,
			asset_200: 1,
			asset_304: 1,
			worker_200: 1,
			worker_other: 1,
			worker_bytes: 59,
			asset_bytes: 140000,
			counter_agrees: true
		});
		expect(lease!.by_kind['stub']).toEqual({ worker: 0, assets: 2 });
		expect(lease!.by_kind['spool']).toEqual({ worker: 1, assets: 0 });
	});

	it('reports a phase that has no counter read with a null count, and flags a disagreement', () => {
		const tallies = tallyPhases(['first-view', 'lease-1', 'view-2'], lines, [
			{ phase: 'first-view', before: 0, after: 2 }
		]);
		expect(tallies[0]).toMatchObject({ worker_invocations: 2, counter_agrees: false });
		expect(tallies[1]).toMatchObject({ worker_invocations: null, counter_agrees: false });
		expect(tallies[2]).toMatchObject({ requests: 0, worker_invocations: null });
	});

	it('accepts a marked sequence 1 to N in each epoch and refuses a repeat', () => {
		const marked = (epoch: number, invocation: number) =>
			line({ phase: 'x', path: '/', epoch, worker: true, invocation });
		expect(counterSequenceOk([marked(0, 2), marked(0, 1), marked(1, 1)])).toBe(true);
		expect(counterSequenceOk([marked(0, 1), marked(0, 1)])).toBe(false);
		expect(counterSequenceOk([marked(0, 1), marked(0, 3)])).toBe(false);
		expect(counterSequenceOk([line({ phase: 'x', path: '/a.js' })])).toBe(true);
	});
});

/** a host and a driver that answer from a script: no browser, no wrangler */
function fakes() {
	const calls: string[] = [];
	let phase = '';
	// a publish reloads the Worker: its own count restarts, the host's total goes on
	let raw = 0;
	let carried = 0;
	const lines: Line[] = [];
	let epoch = 0;
	const host: Host = {
		origin: 'http://127.0.0.1:1',
		lines,
		phase: (id) => void (phase = id),
		total: async () => carried + raw,
		async publish(change) {
			calls.push(`publish ${phase} stamp=${change.stamp} row=${change.row}`);
			carried += raw;
			raw = 0;
			epoch += 1;
		},
		stop: async () => void calls.push('stop')
	};
	const driver: Driver = {
		async visit(step: Step) {
			raw += 1;
			lines.push(
				line({ phase, path: step.path, epoch, worker: true, invocation: raw, bytes: 10 })
			);
			return true;
		},
		wait: async (ms) => void (ms >= 1000 && calls.push(`wait ${phase} ${ms}`)),
		idle: async () => undefined,
		sawEntry: async () => true,
		controlled: async () => true,
		close: async () => void calls.push('close')
	};
	const deps: Deps = {
		host: async ({ arm }) => {
			calls.push(`host ${arm.name}`);
			return host;
		},
		launch: async () => driver,
		now: () => 1_700_000_000_000
	};
	return { calls, deps, lines };
}

describe('a run', () => {
	const tiny = (arms: string, extra: string[] = []) =>
		parseOptions([
			'--arms',
			arms,
			'--engines',
			'chromium',
			'--lease',
			'2',
			'--periods',
			'2',
			'--settle-ms',
			'0',
			'--dwell-ms',
			'0',
			'--click-gap-ms',
			'0',
			...extra
		]);

	it('writes one row per phase and one per arm, and publishes where the arm says to', async () => {
		const { calls, deps } = fakes();
		const rows = await runStaticHost(tiny('static-stamped'), deps);
		const phases = rows.filter((row) => row['kind'] === 'phase');
		expect(phases.map((row) => row['phase'])).toEqual([
			'first-view',
			'view-2',
			'view-3',
			'read-121',
			'lease-1',
			'lease-2',
			'publish'
		]);
		expect(phases.map((row) => row['views'])).toEqual([1, 1, 1, 121, 1, 1, 1]);
		expect(phases.every((row) => row['worker_invocations'] === row['views'])).toBe(true);
		expect(phases.at(-1)!['shows_new_entry']).toBe(true);
		const arm = rows.find((row) => row['kind'] === 'arm')!;
		expect(arm).toMatchObject({
			engine: 'chromium',
			arm: 'static-stamped',
			lease_period_worker_invocations: [1, 1],
			counter_sequence_ok: true
		});
		expect(calls.filter((call) => call.startsWith('publish'))).toEqual([
			'publish lease-1 stamp=true row=false',
			'publish lease-2 stamp=true row=false',
			'publish publish stamp=true row=true'
		]);
		expect(calls).toContain('wait lease-1 3000');
		expect(calls.at(-1)).toBe('stop');
	});

	it('republishes once without a stamp for the unstamped arm and never for the Worker alone', async () => {
		const unstamped = fakes();
		await runStaticHost(tiny('static-unstamped'), unstamped.deps);
		expect(unstamped.calls.filter((call) => call.startsWith('publish'))).toEqual([
			'publish publish stamp=false row=true'
		]);
		const worker = fakes();
		await runStaticHost(tiny('worker-only,no-spool'), worker.deps);
		expect(worker.calls.filter((call) => call.startsWith('publish'))).toEqual([
			'publish publish stamp=false row=true',
			'publish publish stamp=false row=true'
		]);
	});

	it('keeps a row for an arm that failed, with the failure, and stops the host', async () => {
		const { calls, deps } = fakes();
		const launch = deps.launch!;
		let visits = 0;
		deps.launch = async (input) => {
			const driver = await launch(input);
			const visit = driver.visit.bind(driver);
			driver.visit = async (step) => {
				visits += 1;
				if (visits === 3) throw new Error('page crashed');
				return visit(step);
			};
			return driver;
		};
		const rows = await runStaticHost(tiny('no-spool'), deps);
		expect(rows.filter((row) => row['kind'] === 'phase')).toHaveLength(2);
		expect(rows.find((row) => row['kind'] === 'arm')).toMatchObject({
			fatal: 'page crashed'
		});
		expect(calls).toContain('stop');
		expect(calls).toContain('close');
	});

	it('builds a reading that validates and survives a write and a read', async () => {
		const { deps } = fakes();
		const options = tiny('no-spool');
		const rows = await runStaticHost(options, deps);
		const draft = draftOf(rows, options, '2026-11-20', {});
		expect(measurementProblems({ schema: 1, ...draft })).toEqual([]);
		expect(draft.rig).toBe('static-host');
		const back = parseMeasurementText(serialiseMeasurement(draft));
		expect(back.rows).toHaveLength(rows.length);
		expect(back.method).toMatchObject({ lease_seconds: 2, lease_periods: 2 });
		expect(back.exclusions.join(' ')).toContain('not the production meter');
	});
});

describe('the dry run', () => {
	const logs: string[] = [];
	afterEach(() => vi.restoreAllMocks());

	it('prints the arms, phases, lease and the file it would write, and starts nothing', async () => {
		vi.spyOn(console, 'log').mockImplementation((text: string) => void logs.push(text));
		const out = await mkdtemp(join(tmpdir(), 'static-host-'));
		const never: Deps = {
			host: async () => {
				throw new Error('a dry run opened a host');
			},
			launch: async () => {
				throw new Error('a dry run launched a browser');
			}
		};
		const code = await main(['--dry-run', '--out', out, '--lease', '30'], never);
		expect(code).toBe(0);
		const plan = JSON.parse(logs.at(-1)!);
		expect(plan.arms.map((arm: { name: string }) => arm.name)).toEqual(
			ARMS.map((arm) => arm.name)
		);
		expect(plan.phases.map((phase: { id: string }) => phase.id)).toHaveLength(10);
		expect(plan.lease_seconds).toBe(30);
		expect(plan.file).toMatch(/static-host\/\d{4}-\d{2}-\d{2}\.json$/);
		expect(plan.file_exists).toBe(false);
		expect(dryRunPlan(parseOptions(['--experiment', 'short']), '2026-11-20').file).toMatch(
			/static-host\/2026-11-20-short\.json$/
		);
	});

	it('refuses an unknown arm before it starts anything', async () => {
		await expect(main(['--dry-run', '--arms', 'toaster'], {})).rejects.toThrow('unknown arm');
	});
});

describe('the counting Worker entry', () => {
	it('counts each invocation, marks the response with the count and leaves the control paths uncounted', async () => {
		const get = (path: string) => count.fetch(new Request(`https://changelog.test${path}`), {});
		const start = (await (await get('/__count')).json()) as {
			invocations: number;
			isolate: string;
		};
		expect(start.invocations).toBe(0);
		expect(start.isolate).toMatch(/^[0-9a-f-]{36}$/);
		const first = await get('/entries/8999');
		expect(first.headers.get('x-worker-invoked')).toBe('1');
		expect((await get('/entries/8998')).headers.get('x-worker-invoked')).toBe('2');
		// the isolate id names a loaded copy: it holds while the count moves, so a new id means a reload
		expect(await (await get('/__count')).json()).toEqual({
			invocations: 2,
			isolate: start.isolate
		});
	});

	it('adds a row through /__add so the Worker serves the new entry', async () => {
		const request = (path: string, init?: RequestInit) =>
			count.fetch(new Request(`https://changelog.test${path}`, init), {});
		expect((await request('/entries/8959')).status).toBe(404);
		const added = await request('/__add', {
			method: 'POST',
			body: JSON.stringify(NEW_ENTRY)
		});
		expect(await added.json()).toEqual({ added: true });
		const page = await request('/entries/8959');
		expect(page.status).toBe(200);
		expect(await page.text()).toContain(NEW_ENTRY.title);
	});

	it('serves the origin page with no spool markup when MODE is none', async () => {
		const response = await count.fetch(new Request('https://changelog.test/entries/8999'), {
			MODE: 'none'
		});
		expect(response.headers.get('spool-protocol')).toBeNull();
		expect(response.headers.get('x-worker-invoked')).not.toBeNull();
	});
});
