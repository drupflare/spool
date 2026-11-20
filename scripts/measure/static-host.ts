import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseFlags } from 'node:util';
import { entries, staticSite } from '../../examples/static/shared/site.ts';
import { fileStaticSink } from '../../src/node/listener.ts';
import { measurementPath } from '../../src/report/measurement.ts';
import { plan, SCENARIOS } from './demand.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';
import { clickHref, settleOn } from './reader.ts';

/** the engines this rig drives; WebKit registers no worker by default, so it is not run here */
export const ENGINES = ['chromium', 'firefox'] as const;
export type Engine = (typeof ENGINES)[number];

/**
 * The four arms. `publish` says what the operator does with the static tier: nothing, once, or
 * again at the start of every lease period with the stamp advanced.
 */
export type ArmSpec = {
	name: 'worker-only' | 'static-unstamped' | 'static-stamped' | 'no-spool';
	spool: boolean;
	publish: 'none' | 'once' | 'each-lease';
};

export const ARMS: readonly ArmSpec[] = [
	{ name: 'worker-only', spool: true, publish: 'none' },
	{ name: 'static-unstamped', spool: true, publish: 'once' },
	{ name: 'static-stamped', spool: true, publish: 'each-lease' },
	{ name: 'no-spool', spool: false, publish: 'none' }
];

/** the row the publish phase adds, in the Worker and in the files */
export const NEW_ENTRY = {
	title: 'Added the export command in 2.0',
	area: 'cli',
	date: '2026-01-05',
	body: 'Release 2.0 of the library.'
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WORKER_DIR = join(ROOT, 'examples', 'static', 'cloudflare-worker');

export type Options = {
	dryRun: boolean;
	engines: Engine[];
	arms: ArmSpec['name'][];
	/** the stub lease in seconds; a scenario parameter, the library default is 86,400 */
	lease: number;
	/** how many lease periods follow the read phase */
	periods: number;
	dwellMs: number;
	settleMs: number;
	clickGapMs: number;
	/** the counting proxy's port; wrangler takes the next two */
	port: number;
	out: string;
	work: string;
	force: boolean;
	machine?: string;
	experiment?: string;
};

/** the command line as options; throws on a value the rig cannot run */
export function parseOptions(argv: readonly string[]): Options {
	const { values } = parseFlags({
		args: [...argv],
		options: {
			'dry-run': { type: 'boolean', default: false },
			force: { type: 'boolean', default: false },
			engines: { type: 'string', default: ENGINES.join(',') },
			arms: { type: 'string', default: ARMS.map((arm) => arm.name).join(',') },
			lease: { type: 'string', default: '90' },
			periods: { type: 'string', default: '5' },
			'dwell-ms': { type: 'string', default: '1500' },
			'settle-ms': { type: 'string', default: '1500' },
			'click-gap-ms': { type: 'string', default: '150' },
			port: { type: 'string', default: '6550' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			work: { type: 'string', default: join(tmpdir(), 'spool-static-host') },
			machine: { type: 'string' },
			experiment: { type: 'string' }
		},
		strict: true
	});
	const whole = (flag: string, text: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
		const n = Number(text);
		if (!Number.isInteger(n) || n < min || n > max) {
			throw new Error(`--${flag} must be a whole number from ${min} to ${max}, got ${text}`);
		}
		return n;
	};
	const engines = (values.engines ?? '').split(',');
	for (const name of engines) {
		if (!(ENGINES as readonly string[]).includes(name))
			throw new Error(`unknown engine ${name}`);
	}
	const arms = (values.arms ?? '').split(',');
	for (const name of arms) {
		if (!ARMS.some((arm) => arm.name === name)) throw new Error(`unknown arm ${name}`);
	}
	if (values.experiment !== undefined && !/^[a-z][a-z-]*$/.test(values.experiment)) {
		throw new Error('--experiment must be lowercase words joined by dashes');
	}
	return {
		dryRun: values['dry-run'] ?? false,
		engines: engines as Engine[],
		arms: arms as ArmSpec['name'][],
		lease: whole('lease', values.lease ?? '', 1),
		periods: whole('periods', values.periods ?? '', 1),
		dwellMs: whole('dwell-ms', values['dwell-ms'] ?? '', 0),
		settleMs: whole('settle-ms', values['settle-ms'] ?? '', 0),
		clickGapMs: whole('click-gap-ms', values['click-gap-ms'] ?? '', 0),
		port: whole('port', values.port ?? '', 1024, 65533),
		out: values.out ?? MEASUREMENTS_DIR,
		work: values.work ?? join(tmpdir(), 'spool-static-host'),
		force: values.force ?? false,
		machine: values.machine,
		experiment: values.experiment
	};
}

// #region phases

/** one page view: a typed document open or an in-page click on a same-origin link */
export type Step = { via: 'open' | 'click'; path: string; title?: string; dwell: boolean };

/** one phase: an optional wait of `wait` seconds, then its views */
export type PhaseSpec = {
	id: string;
	kind: 'views' | 'lease' | 'publish';
	wait: number;
	steps: Step[];
};

/**
 * The phases every arm runs. The read phase replays the single-day demand reader's mix over the
 * changelog's 40 entries; each lease phase waits past the lease and opens one entry.
 */
export function phasesOf(options: Pick<Options, 'lease' | 'periods'>): PhaseSpec[] {
	const all = entries();
	const entry = (index: number) => ({
		path: `/entries/${all[index]!.id}`,
		title: all[index]!.title
	});
	const open = (index: number): Step => ({ via: 'open', ...entry(index), dwell: false });
	const wait = options.lease + 1;
	const read = plan(SCENARIOS[3], all.length).map((step): Step => ({
		via: step.via,
		...entry(step.index),
		dwell: step.dwell
	}));
	return [
		{ id: 'first-view', kind: 'views', wait: 0, steps: [open(0)] },
		{ id: 'view-2', kind: 'views', wait: 0, steps: [open(1)] },
		{ id: 'view-3', kind: 'views', wait: 0, steps: [open(2)] },
		{ id: 'read-121', kind: 'views', wait: 0, steps: read },
		...Array.from({ length: options.periods }, (_, k): PhaseSpec => ({
			id: `lease-${k + 1}`,
			kind: 'lease',
			wait,
			steps: [open((k * 7 + 3) % all.length)]
		})),
		{
			id: 'publish',
			kind: 'publish',
			wait,
			steps: [{ via: 'open', path: '/', title: 'Newest Entries', dwell: false }]
		}
	];
}

// #endregion

// #region tally

/** one request the counting proxy passed: who answered it and with what */
export type Line = {
	phase: string;
	/** which Worker isolate was running; a reload after an assets change starts a new one */
	epoch: number;
	method: string;
	path: string;
	status: number;
	bytes: number;
	/** true when the response carried the Worker's mark; false when the assets answered */
	worker: boolean;
	conditional: boolean;
	/** the Worker's own running count in its mark */
	invocation: number | null;
	at: number;
};

/** the counting Worker's total at the start and end of one phase */
export type CounterRead = { phase: string; before: number; after: number };

export type PhaseTally = {
	phase: string;
	requests: number;
	/** the counter's difference over the phase; null when the phase has no read */
	worker_invocations: number | null;
	worker_responses: number;
	asset_requests: number;
	asset_200: number;
	asset_304: number;
	asset_other: number;
	worker_200: number;
	worker_304: number;
	worker_other: number;
	worker_bytes: number;
	asset_bytes: number;
	by_kind: Record<string, { worker: number; assets: number }>;
	counter_agrees: boolean;
};

/** what a request is for, from its path */
export function kindOf(path: string): string {
	const { pathname } = new URL(path, 'http://host');
	if (pathname === '/spool-sw.js') return 'stub';
	if (/^\/\.spool\/[^/]+\/boot\//.test(pathname)) return 'boot';
	if (/^\/\.spool\/[^/]+\/.+\.js$/.test(pathname)) return 'runtime';
	if (pathname.startsWith('/.spool/bundle/')) return 'pack';
	if (pathname.startsWith('/.spool/')) return 'spool';
	return 'document';
}

/** the per-phase counts of a request log and the counter reads, in the order of `ids` */
export function tallyPhases(
	ids: readonly string[],
	lines: readonly Line[],
	reads: readonly CounterRead[]
): PhaseTally[] {
	return ids.map((phase) => {
		const read = reads.find((item) => item.phase === phase);
		const tally: PhaseTally = {
			phase,
			requests: 0,
			worker_invocations: read ? read.after - read.before : null,
			worker_responses: 0,
			asset_requests: 0,
			asset_200: 0,
			asset_304: 0,
			asset_other: 0,
			worker_200: 0,
			worker_304: 0,
			worker_other: 0,
			worker_bytes: 0,
			asset_bytes: 0,
			by_kind: {},
			counter_agrees: false
		};
		for (const item of lines) {
			if (item.phase !== phase) continue;
			tally.requests += 1;
			const slot = (tally.by_kind[kindOf(item.path)] ??= { worker: 0, assets: 0 });
			if (item.worker) {
				slot.worker += 1;
				tally.worker_responses += 1;
				tally.worker_bytes += item.bytes;
				if (item.status === 200) tally.worker_200 += 1;
				else if (item.status === 304) tally.worker_304 += 1;
				else tally.worker_other += 1;
			} else {
				slot.assets += 1;
				tally.asset_requests += 1;
				tally.asset_bytes += item.bytes;
				if (item.status === 200) tally.asset_200 += 1;
				else if (item.status === 304) tally.asset_304 += 1;
				else tally.asset_other += 1;
			}
		}
		tally.counter_agrees = tally.worker_invocations === tally.worker_responses;
		return tally;
	});
}

/** whether the marks in each epoch are exactly 1 to N once each, so no isolate counted twice or skipped */
export function counterSequenceOk(lines: readonly Line[]): boolean {
	const byEpoch = new Map<number, number[]>();
	for (const item of lines) {
		if (!item.worker || item.invocation === null) continue;
		byEpoch.set(item.epoch, [...(byEpoch.get(item.epoch) ?? []), item.invocation]);
	}
	return [...byEpoch.values()].every((marks) =>
		marks.sort((a, b) => a - b).every((mark, i) => mark === i + 1)
	);
}

// #endregion

// #region runner

type Row = Record<string, unknown>;

/** the site behind a counting proxy: a request log, the Worker's own counter and the operator's actions */
export type Host = {
	/** where the browser goes */
	origin: string;
	lines: Line[];
	/** tags the requests that follow with a phase */
	phase(id: string): void;
	/** the Worker's invocations so far, continuous across reloads */
	total(): Promise<number>;
	/** changes the files and the Worker, as an operator's publish does */
	publish(change: { stamp: boolean; row: boolean }): Promise<void>;
	stop(): Promise<void>;
};

export type Driver = {
	/** true when the page reached the step's path and showed its title */
	visit(step: Step): Promise<boolean>;
	wait(ms: number): Promise<void>;
	idle(): Promise<void>;
	/** whether the page shows the row the publish phase adds */
	sawEntry(): Promise<boolean>;
	controlled(): Promise<boolean>;
	close(): Promise<void>;
};

/** the seams a test replaces: the host, the browser and the clock */
export type Deps = {
	host?: (input: {
		arm: ArmSpec;
		engine: Engine;
		options: Options;
		index: number;
	}) => Promise<Host>;
	launch?: (input: { engine: Engine; origin: string }) => Promise<Driver>;
	versions?: (engines: readonly Engine[]) => Promise<Record<string, string>>;
	now?: () => number;
};

const first = (error: unknown) =>
	String(error instanceof Error ? error.message : error).split('\n')[0];

/** every phase of one arm in one engine, as phase rows and one arm row */
async function runArm(
	input: { arm: ArmSpec; engine: Engine; options: Options; index: number },
	deps: Deps
): Promise<Row[]> {
	const { arm, engine, options } = input;
	const now = deps.now ?? Date.now;
	const phases = phasesOf(options);
	const host = await (deps.host ?? openHost)(input);
	const reads: CounterRead[] = [];
	const done: PhaseSpec[] = [];
	const extra = new Map<string, Row>();
	let driver: Driver | undefined;
	let wrong = 0;
	let controlled = false;
	let fatal: string | undefined;
	try {
		driver = await (deps.launch ?? playwrightLaunch)({ engine, origin: host.origin });
		let before = await host.total();
		for (const phase of phases) {
			host.phase(phase.id);
			const started = now();
			const stamp = arm.publish === 'each-lease';
			if (phase.kind === 'lease' && stamp) await host.publish({ stamp, row: false });
			if (phase.kind === 'publish') await host.publish({ stamp, row: true });
			if (phase.wait > 0) await driver.wait(phase.wait * 1000);
			for (const step of phase.steps) {
				if (step.dwell) await driver.wait(options.dwellMs);
				if (step.via === 'click') await driver.wait(options.clickGapMs);
				if (!(await driver.visit(step))) wrong += 1;
			}
			await driver.idle();
			await driver.wait(options.settleMs);
			const after = await host.total();
			reads.push({ phase: phase.id, before, after });
			before = after;
			done.push(phase);
			extra.set(phase.id, {
				views: phase.steps.length,
				started_at: started,
				ended_at: now(),
				...(phase.kind === 'publish' ? { shows_new_entry: await driver.sawEntry() } : {})
			});
		}
		controlled = await driver.controlled();
	} catch (error) {
		fatal = first(error);
	} finally {
		await driver?.close().catch(() => undefined);
		await host.stop();
	}
	const tallies = tallyPhases(
		done.map((phase) => phase.id),
		host.lines,
		reads
	);
	const rows: Row[] = tallies.map((tally) => ({
		kind: 'phase',
		engine,
		arm: arm.name,
		...tally,
		...extra.get(tally.phase),
		stub_requests_at: host.lines
			.filter((item) => item.phase === tally.phase && kindOf(item.path) === 'stub')
			.map((item) => item.at)
	}));
	rows.push({
		kind: 'arm',
		engine,
		arm: arm.name,
		controlled,
		wrong,
		lease_period_worker_invocations: tallies
			.filter((tally) => tally.phase.startsWith('lease-'))
			.map((tally) => tally.worker_invocations),
		counter_total: reads.at(-1)?.after ?? null,
		worker_responses_total: host.lines.filter((item) => item.worker).length,
		counter_sequence_ok: counterSequenceOk(host.lines),
		...(fatal ? { fatal } : {})
	});
	return rows;
}

/** the rows of every chosen arm in every chosen engine; prints each row as it lands */
export async function runStaticHost(options: Options, deps: Deps = {}): Promise<Row[]> {
	const rows: Row[] = [];
	let index = 0;
	for (const engine of options.engines) {
		for (const name of options.arms) {
			const arm = ARMS.find((item) => item.name === name)!;
			for (const row of await runArm({ arm, engine, options, index }, deps)) {
				console.log(JSON.stringify(row));
				rows.push(row);
			}
			index += 1;
		}
	}
	return rows;
}

// #endregion

// #region the real host and browser

/** one arm's Worker under `wrangler dev --local`, its assets folder, and the counting proxy in front */
async function openHost(input: {
	arm: ArmSpec;
	engine: Engine;
	options: Options;
	index: number;
}): Promise<Host> {
	const { arm, engine, options } = input;
	mkdirSync(options.work, { recursive: true });
	const dir = mkdtempSync(join(options.work, `${engine}-${arm.name}-`));
	const assets = join(dir, 'public');
	mkdirSync(assets);
	const site = await staticSite({ lease: options.lease });
	const sink = fileStaticSink(assets);
	if (arm.publish === 'each-lease') await site.publish(sink);
	else if (arm.publish === 'once') await site.spool.publishStatic(sink);
	const port = options.port;
	const target = `http://127.0.0.1:${port + 1}`;
	let output = '';
	const child: ChildProcess = spawn(
		join(ROOT, 'node_modules', '.bin', 'wrangler'),
		[
			'dev',
			'-c',
			'wrangler.count.jsonc',
			'--local',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port + 1),
			'--inspector-port',
			String(port + 2),
			'--assets',
			assets,
			'--var',
			`MODE:${arm.spool ? 'spool' : 'none'}`,
			'--var',
			`LEASE:${options.lease}`
		],
		{
			cwd: WORKER_DIR,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
			detached: true
		}
	);
	child.stdout?.on('data', (chunk) => (output += chunk));
	child.stderr?.on('data', (chunk) => (output += chunk));
	const read = async (): Promise<{ invocations: number; isolate: string }> =>
		(await fetch(`${target}/__count`)).json() as Promise<{
			invocations: number;
			isolate: string;
		}>;
	const raw = async (): Promise<number> => (await read()).invocations;
	const stopChild = () => {
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				// already gone
			}
		}
	};
	for (let tries = 0; ; tries += 1) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${output.slice(-400)}`);
		if (tries >= 240) {
			stopChild();
			throw new Error(`wrangler dev did not answer on ${port + 1}: ${output.slice(-400)}`);
		}
		if (
			await raw().then(
				() => true,
				() => false
			)
		)
			break;
		await new Promise((done) => setTimeout(done, 500));
	}
	const lines: Line[] = [];
	let phase = '';
	let epoch = 0;
	let carried = 0;
	const proxy = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers)) {
			if (
				typeof value === 'string' &&
				!['host', 'connection', 'accept-encoding'].includes(key)
			) {
				headers.set(key, value);
			}
		}
		const body = Buffer.concat(chunks);
		const upstream = await fetch(target + (req.url ?? '/'), {
			method: req.method,
			headers,
			body: body.length > 0 ? body : undefined,
			redirect: 'manual'
		});
		const sent = new Uint8Array(await upstream.arrayBuffer());
		const mark = upstream.headers.get('x-worker-invoked');
		lines.push({
			phase,
			epoch,
			method: req.method ?? 'GET',
			path: req.url ?? '/',
			status: upstream.status,
			bytes: sent.length,
			worker: mark !== null,
			conditional: 'if-none-match' in req.headers || 'if-modified-since' in req.headers,
			invocation: mark === null ? null : Number(mark),
			at: Date.now()
		});
		const out: Record<string, string> = {};
		upstream.headers.forEach((value, key) => {
			if (
				!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(
					key
				)
			) {
				out[key] = value;
			}
		});
		res.writeHead(upstream.status, out);
		res.end(sent);
	});
	await new Promise<void>((done) => proxy.listen(port, '127.0.0.1', done));
	return {
		origin: `http://127.0.0.1:${port}`,
		lines,
		phase: (id) => void (phase = id),
		total: async () => carried + (await raw()),
		async publish(change) {
			const before = await read();
			const files = arm.publish !== 'none';
			if (files) {
				if (change.row) await site.addEntry(NEW_ENTRY);
				await (change.stamp ? site.publish(sink) : site.spool.publishStatic(sink));
				// any change to the assets folder reloads the Worker, which empties its counter and its rows
				let tries = 0;
				let after = before;
				while (after.isolate === before.isolate) {
					tries += 1;
					if (tries > 60)
						throw new Error('wrangler dev did not reload after the assets changed');
					await new Promise((done) => setTimeout(done, 500));
					after = await read().catch(() => before);
				}
				epoch += 1;
				carried += before.invocations - after.invocations;
			}
			if (change.row) {
				await fetch(`${target}/__add`, { method: 'POST', body: JSON.stringify(NEW_ENTRY) });
			}
		},
		async stop() {
			proxy.closeAllConnections();
			await new Promise((done) => proxy.close(done));
			stopChild();
			if (output.includes('ERROR')) console.error(output);
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** a persistent Playwright context on a fresh profile, driven the way the demand rig drives one */
async function playwrightLaunch(input: { engine: Engine; origin: string }): Promise<Driver> {
	const playwright = await import('@playwright/test');
	const profile = mkdtempSync(join(tmpdir(), 'spool-static-host-profile-'));
	const context = await playwright[input.engine].launchPersistentContext(profile, {
		headless: true,
		timeout: 60000
	});
	const page = context.pages()[0] ?? (await context.newPage());
	return {
		async visit(step) {
			if (step.via === 'open') await page.goto(input.origin + step.path);
			else await clickHref(page, step.path);
			return settleOn(page, step.path, step.title);
		},
		wait: (ms) => page.waitForTimeout(ms),
		idle: () => page.waitForLoadState('networkidle').catch(() => undefined),
		sawEntry: () =>
			page.evaluate((text) => document.body.innerText.includes(text), NEW_ENTRY.title),
		controlled: () => page.evaluate(() => navigator.serviceWorker.controller !== null),
		async close() {
			await context.close();
			rmSync(profile, { recursive: true, force: true });
		}
	};
}

async function browserVersions(engines: readonly Engine[]): Promise<Record<string, string>> {
	const playwright = await import('@playwright/test');
	const versions: Record<string, string> = {};
	for (const name of engines) {
		const browser = await playwright[name].launch();
		versions[name] = browser.version();
		await browser.close();
	}
	return versions;
}

// #endregion

const versionOf = (path: string): string => {
	try {
		return JSON.parse(readFileSync(join(ROOT, path), 'utf8')).version as string;
	} catch {
		return 'not read';
	}
};

/** the reading as `measurements/static-host/<date>[-experiment].json` takes it */
export function draftOf(
	rows: Row[],
	options: Options,
	date: string,
	env: Record<string, string | undefined> = process.env,
	browsers: Record<string, string> = {}
): Draft {
	return {
		rig: 'static-host',
		date,
		layer: 'L1',
		question:
			'Worker invocations, asset requests and bytes per client for a visitor on a Worker with an assets folder, with the stub, runtime and packs served by the Worker, by files without a stamp, by files with a stamp, and with no spool.',
		instrument:
			"wrangler dev --local (workerd) running a counting Worker over an assets folder; a counting proxy in front that logs each response and which side answered; the Worker's own invocation counter read at phase boundaries; Playwright persistent contexts",
		machine: {
			...localMachine(options.machine),
			...(env['RIG_CONTAINER'] ? { container: env['RIG_CONTAINER'] } : {}),
			...(env['RIG_LOAD_AVG'] ? { load_average_at_start: env['RIG_LOAD_AVG'] } : {})
		},
		software: {
			node: process.version,
			bun: process.versions.bun ?? 'not bun',
			spool: versionOf('package.json'),
			playwright: createRequire(import.meta.url)('@playwright/test/package.json').version,
			wrangler: versionOf('node_modules/wrangler/package.json'),
			workerd: versionOf('node_modules/workerd/package.json'),
			...browsers
		},
		method: {
			arms: options.arms.map((name) => ARMS.find((arm) => arm.name === name)),
			engines: options.engines,
			lease_seconds: options.lease,
			lease_periods: options.periods,
			phases: phasesOf(options).map((phase) => ({
				id: phase.id,
				kind: phase.kind,
				wait_seconds: phase.wait,
				views: phase.steps.length
			})),
			reader: `${SCENARIOS[3].name} replayed by the demand rig's plan over the changelog's 40 entries, after views 1 to 3`,
			dwell_ms: options.dwellMs,
			settle_ms: options.settleMs,
			click_gap_ms: options.clickGapMs,
			host: 'examples/static/cloudflare-worker/count.ts under wrangler dev --local',
			proxy_port: options.port,
			bytes: 'response body bytes before compression; the proxy removes accept-encoding',
			counter:
				'the Worker counts each invocation except /__count and /__add; the rig reads it at phase boundaries; a change to the assets folder reloads the Worker and resets it, so the rig adds the last read before each republish',
			stamp: 'static-unstamped publishes with the stamp fixed at 0 (staticSite always passes a stamp); static-stamped advances it before each lease period and for the publish phase'
		},
		exclusions: [
			'local workerd is not the production meter: it shows which side answered a request, not what a deployed Worker or Cloudflare bills',
			'the lease is a scenario parameter chosen so the reading can cross lease periods without a faked clock; the library default is 86,400 s',
			'one machine and one run per engine and arm; no spread is reported',
			'the stamp republish cadence is the operator choice the static-stamped arm models; the library does not enforce it',
			'a row with fatal set did not finish its arm; its phases hold the counts of the phases that ran',
			'a phase row with counter_agrees false has a counter difference that differs from the marked responses in the log, usually a request that crossed a phase boundary; the counter is the figure of record',
			'an arm row with counter_sequence_ok false has a marked sequence that is not 1 to N in some Worker epoch; its counts are not usable',
			'a row with wrong above 0 has a view whose page did not reach its path or title',
			'WebKit is not run: it registers no worker by default'
		],
		rows
	};
}

/** the plan `--dry-run` prints: every default resolved, the file it would write, and no browser or Worker */
export function dryRunPlan(options: Options, date: string) {
	const file = join(
		options.out,
		measurementPath({ rig: 'static-host', date }, options.experiment)
	);
	return {
		engines: options.engines,
		arms: options.arms.map((name) => ARMS.find((arm) => arm.name === name)),
		phases: phasesOf(options).map((phase) => ({
			id: phase.id,
			kind: phase.kind,
			wait: phase.wait,
			steps: phase.steps.length
		})),
		lease_seconds: options.lease,
		lease_periods: options.periods,
		dwell_ms: options.dwellMs,
		settle_ms: options.settleMs,
		click_gap_ms: options.clickGapMs,
		ports: { proxy: options.port, wrangler: options.port + 1, inspector: options.port + 2 },
		work: options.work,
		file,
		file_exists: existsSync(file)
	};
}

/** the CLI: `--dry-run` prints the plan, otherwise every arm runs and the reading is written */
export async function main(argv: string[], deps: Deps = {}): Promise<number> {
	const options = parseOptions(argv);
	const date = utcDate();
	const intended = dryRunPlan(options, date);
	if (options.dryRun) {
		console.log(JSON.stringify(intended, null, '\t'));
		return 0;
	}
	if (intended.file_exists && !options.force) {
		throw new Error(`${intended.file} exists; pass --force to replace it`);
	}
	const rows = await runStaticHost(options, deps);
	const browsers = await (deps.versions ?? browserVersions)(options.engines);
	const path = writeMeasurement(
		options.out,
		draftOf(rows, options, date, process.env, browsers),
		{ experiment: options.experiment, overwrite: options.force }
	);
	console.log(`wrote ${path}`);
	return rows.some((row) => row['fatal'] !== undefined) ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
