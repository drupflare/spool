import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
	MEASUREMENTS_DIR,
	counterDelta,
	integrateWatts,
	isMain,
	otherCpuMs,
	parseNvidiaCsv,
	parseUsageUsec,
	rotate,
	shuffle,
	utcDate,
	writeMeasurement,
	type Draft,
	type PowerSample
} from './lib.ts';
import { buildAll } from './rapl-data.ts';

/** the experiments, which are also the file suffixes under `measurements/rapl/` */
export const EXPERIMENTS = [
	'views',
	'compute-server',
	'compute-browser',
	'projection',
	'inference',
	'power-state'
] as const;

export type Experiment = (typeof EXPERIMENTS)[number];

type Raw = Record<string, any>;

const HERE = dirname(fileURLToPath(import.meta.url));

/** the computer the readings were taken on; `--machine-json` merges over it */
export const PAISLEY: Record<string, string | number> = {
	name: 'paisley-park',
	cpu: 'AMD Ryzen 9 9900X',
	os: 'Ubuntu 24.04',
	governor: 'powersave',
	cpuidle: 'acpi_idle, menu',
	pstate: 'amd-pstate-epp, EPP performance'
};

const CONTAINER =
	'container mcr.microsoft.com/playwright:v1.62.1-noble, --cpus 8 --memory 6g, Node 24.18.1, node:sqlite 3.53.1';
const INSTRUMENT =
	'RAPL package-0 energy counter (intel-rapl sysfs, read-only bind into the container)';
const EXCLUSIONS = ['windows where other containers used more than 100 ms of CPU per second'];
const DATA =
	'synthetic: enroll.sqlite (60 departments, 24 terms, 6,000 courses, 60,000 sections, 120,000 students, 1.8M enrollments, seeded) and cms.sqlite (5,000 nodes)';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** what a run was asked to do, with the container's paths as defaults */
export type Config = {
	experiment: Experiment;
	rounds: number;
	idleS: number;
	navs: number;
	rapl: string;
	cgroup: string;
	raw: string;
	mirror: string;
	data: string;
	governor: string;
	windowS: number;
	settleS: number;
	nreq: number;
	set: 'sweep' | 'timer';
	model: string;
	ollama: string;
};

const DEFAULT_ROUNDS: Record<Experiment, number> = {
	views: 8,
	'compute-server': 8,
	'compute-browser': 8,
	projection: 8,
	inference: 5,
	'power-state': 4
};

export function parse(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			rounds: { type: 'string' },
			'idle-s': { type: 'string', default: '30' },
			navs: { type: 'string', default: '300' },
			rapl: { type: 'string', default: '/rapl/intel-rapl:0' },
			cgroup: { type: 'string', default: '/host-cgroup/system.slice' },
			raw: { type: 'string' },
			mirror: { type: 'string', default: '/rig/mirror' },
			data: { type: 'string', default: '/rig/data' },
			governor: { type: 'string', default: 'powersave' },
			'window-s': { type: 'string', default: '20' },
			'settle-s': { type: 'string', default: '4' },
			nreq: { type: 'string', default: '24' },
			set: { type: 'string', default: 'sweep' },
			model: { type: 'string', default: 'llama3.1:8b' },
			ollama: { type: 'string', default: 'http://host.docker.internal:11434' },
			gpu: { type: 'string' },
			'machine-json': { type: 'string' },
			'timer-raw': { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			date: { type: 'string' },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	const [command, experiment] = positionals;
	if (command !== undefined && !['run', 'publish', 'mirror', 'data'].includes(command)) {
		throw new Error(`unknown command ${command}; use run, publish, mirror or data`);
	}
	if (command === 'run' || command === 'publish') {
		if (!EXPERIMENTS.includes(experiment as Experiment)) {
			throw new Error(`experiment must be one of ${EXPERIMENTS.join(', ')}`);
		}
	}
	const exp = experiment as Experiment;
	const config: Config = {
		experiment: exp,
		rounds: Number(values.rounds ?? DEFAULT_ROUNDS[exp] ?? 8),
		idleS: Number(values['idle-s']),
		navs: Number(values.navs),
		rapl: values.rapl as string,
		cgroup: values.cgroup as string,
		raw: (values.raw ?? `out/${exp}.jsonl`) as string,
		mirror: values.mirror as string,
		data: values.data as string,
		governor: values.governor as string,
		windowS: Number(values['window-s']),
		settleS: Number(values['settle-s']),
		nreq: Number(values.nreq),
		set: values.set === 'timer' ? 'timer' : 'sweep',
		model: values.model as string,
		ollama: values.ollama as string
	};
	return {
		command,
		positionals,
		config,
		gpu: values.gpu,
		timerRaw: values['timer-raw'],
		machineJson: values['machine-json'],
		out: values.out as string,
		date: values.date,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

// #region measurement

/** reads the package counter, the host's load and the other containers' CPU */
export class Meter {
	readonly raplDir: string;
	readonly cgroupDir: string;
	readonly range: number;
	readonly self: string;

	constructor(raplDir: string, cgroupDir: string) {
		this.raplDir = raplDir;
		this.cgroupDir = cgroupDir;
		this.range = Number(readFileSync(join(raplDir, 'max_energy_range_uj'), 'utf8'));
		this.self = readFileSync('/etc/hostname', 'utf8').trim();
	}

	uj(sub = ''): number {
		return Number(readFileSync(join(this.raplDir, sub, 'energy_uj'), 'utf8'));
	}

	load(): number {
		return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
	}

	snap(): Record<string, number> {
		const out: Record<string, number> = {};
		try {
			for (const d of readdirSync(this.cgroupDir).filter((x) => x.startsWith('docker-'))) {
				out[d.slice(7, 19)] = parseUsageUsec(
					readFileSync(join(this.cgroupDir, d, 'cpu.stat'), 'utf8')
				);
			}
		} catch {
			return out;
		}
		return out;
	}

	/** runs `fn` between two reads and returns the energy, the time and the neighbours' CPU */
	async window<T>(fn: () => Promise<T>, withCore = false) {
		const s0 = this.snap();
		const p0 = this.uj();
		const c0 = withCore ? this.uj('intel-rapl:0:0') : 0;
		const e0 = Date.now();
		const t0 = process.hrtime.bigint();
		const l0 = this.load();
		const result = await fn();
		const p1 = this.uj();
		const c1 = withCore ? this.uj('intel-rapl:0:0') : 0;
		const t1 = process.hrtime.bigint();
		const e1 = Date.now();
		const others = otherCpuMs(s0, this.snap(), this.self);
		return {
			result,
			elapsedMs: Number(t1 - t0) / 1e6,
			pkgJ: counterDelta(p0, p1, this.range) / 1e6,
			coreJ: withCore ? counterDelta(c0, c1, this.range) / 1e6 : undefined,
			load0: l0,
			load1: this.load(),
			epochStartMs: e0,
			epochEndMs: e1,
			others
		};
	}
}

const emit = (config: Config, row: Raw) => {
	appendFileSync(config.raw, `${JSON.stringify(row)}\n`);
	console.log(JSON.stringify(row).slice(0, 160));
};

function startOrigin(env: Record<string, string>): ChildProcess {
	return spawn('node', [join(HERE, 'rapl-origin.ts')], {
		stdio: 'inherit',
		env: { ...process.env, ...env }
	});
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

/** one keep-alive GET; resolves the status, body size and ETag */
function get(port: number, path: string, headers: Record<string, string> = {}, keep = true) {
	return new Promise<{ status: number; bytes: number; etag?: string; body: string }>(
		(resolve, reject) => {
			const req = http.request(
				{ host: '127.0.0.1', port, path, agent: keep ? agent : undefined, headers },
				(res) => {
					let bytes = 0;
					let body = '';
					res.on('data', (c: Buffer) => {
						bytes += c.length;
						if (bytes < 200_000) body += c;
					});
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							bytes,
							etag: res.headers.etag as string | undefined,
							body
						})
					);
				}
			);
			req.on('error', reject);
			req.end();
		}
	);
}

const stats = async (port: number) => JSON.parse((await get(port, '/__stats')).body) as Raw;

async function idleWindow(
	meter: Meter,
	config: Config,
	round: number,
	arm = 'idle',
	extra: Raw = {}
) {
	await sleep(2000);
	const w = await meter.window(() => sleep(config.idleS * 1000));
	emit(config, {
		arm,
		round,
		n: 0,
		elapsedMs: w.elapsedMs,
		pkgJ: w.pkgJ,
		load0: w.load0,
		load1: w.load1,
		otherCpuMs: w.others,
		...extra
	});
}

// #endregion

// #region experiments

type Page = import('playwright').Page;

async function launch() {
	const { chromium } = await import('playwright');
	return chromium.launch({ channel: 'chromium' });
}

/** e4: network with optimized headers, the service worker, network with the shipping headers, idle */
async function runViews(config: Config, meter: Meter) {
	const pages = (
		JSON.parse(readFileSync(join(config.mirror, 'manifest.json'), 'utf8')) as {
			pages: string[];
		}
	).pages;
	const origin = startOrigin({ MODE: 'views', MIRROR: config.mirror, RTT_MS: '40' });
	await sleep(2500);
	const statsOf = async () => JSON.parse((await get(8939, '/', {}, false)).body) as Raw;
	const arms = ['network', 'spool', 'shipping', 'idle'];
	for (let round = 0; round < config.rounds; round++) {
		for (const arm of rotate(arms, round)) {
			if (arm === 'idle') {
				await sleep(2000);
				const o0 = await statsOf();
				const w = await meter.window(() => sleep(config.idleS * 1000), true);
				const o1 = await statsOf();
				emit(config, viewsRow(arm, round, 0, w, o0, o1, 8931));
				continue;
			}
			const base = arm === 'shipping' ? 'http://127.0.0.1:8932' : 'http://127.0.0.1:8931';
			const browser = await launch();
			const page = await (await browser.newContext()).newPage();
			await page.goto(base + pages[0]);
			if (arm === 'spool') {
				await page.evaluate(() =>
					navigator.serviceWorker.register('/spool-sw.js', { updateViaCache: 'all' })
				);
				await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
					timeout: 30_000
				});
				await page.reload();
			}
			for (let i = 0; i < pages.length * 2; i++)
				await page.goto(base + (pages[i % pages.length] as string));
			await page.waitForTimeout(2000);
			const o0 = await statsOf();
			const w = await meter.window(async () => {
				for (let i = 0; i < config.navs; i++) {
					await page.goto(base + (pages[i % pages.length] as string));
					await page.waitForLoadState('load');
				}
				if (arm === 'spool') {
					await page.evaluate(() =>
						navigator.serviceWorker.controller?.postMessage('flush')
					);
					await page.waitForTimeout(300);
				}
			}, true);
			const o1 = await statsOf();
			emit(
				config,
				viewsRow(arm, round, config.navs, w, o0, o1, arm === 'shipping' ? 8932 : 8931)
			);
			await browser.close();
		}
	}
	origin.kill();
}

function viewsRow(
	arm: string,
	round: number,
	navs: number,
	w: Awaited<ReturnType<Meter['window']>>,
	o0: Raw,
	o1: Raw,
	port: number
): Raw {
	const paths: Record<string, number> = {};
	for (const [k, v] of Object.entries(o1.paths[port] as Record<string, number>)) {
		const d = v - ((o0.paths[port] as Record<string, number>)[k] ?? 0);
		if (d > 0) paths[k] = d;
	}
	return {
		arm,
		round,
		navs,
		elapsedMs: w.elapsedMs,
		pkgJ: w.pkgJ,
		coreJ: w.coreJ,
		load0: w.load0,
		load1: w.load1,
		originHits: { opt: o1.hits[8931] - o0.hits[8931], ship: o1.hits[8932] - o0.hits[8932] },
		originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
		originPaths: paths,
		otherContainersCpuMs: w.others
	};
}

const SERVER_ARMS: Array<[string, string | null, string | null, boolean, number]> = [
	['null', null, null, false, 400_000],
	['cms-recompute-200', 'cms', 'r', false, 20_000],
	['cms-recompute-304', 'cms', 'r', true, 20_000],
	['cms-cache-200', 'cms', 'c', false, 400_000],
	['cms-cache-304', 'cms', 'c', true, 400_000],
	['ana-recompute-200', 'ana', 'r', false, 30],
	['ana-recompute-304', 'ana', 'r', true, 30],
	['ana-cache-200', 'ana', 'c', false, 400_000],
	['ana-cache-304', 'ana', 'c', true, 400_000]
];

/** Q1a and Q1b: closed loop, concurrency 1, a Node client against the origin, no emulated latency */
async function runComputeServer(config: Config, meter: Meter) {
	const port = 8941;
	const origin = startOrigin({
		PORT: String(port),
		RTT_MS: '0',
		BENCH_TERMS: '3',
		MIRROR: config.mirror,
		DATA: config.data
	});
	await sleep(2000);
	const names = [...SERVER_ARMS.map((a) => a[0]), 'idle'];
	for (let round = 0; round < config.rounds; round++) {
		for (const name of rotate(names, round, 2)) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			const [, kind, mode, conditional, n] = SERVER_ARMS.find(
				(a) => a[0] === name
			) as (typeof SERVER_ARMS)[number];
			const etags: Record<string, string> = {};
			const path = (i: number) => (kind ? `/${mode}/${kind}/${(i % 4) + 1}` : '/__null');
			const headers = (p: string) => ({
				'accept-encoding': 'gzip',
				...(conditional && etags[p] ? { 'if-none-match': etags[p] as string } : {})
			});
			for (let i = 0; i < 8; i++) {
				const p = path(i);
				const r = await get(port, p, headers(p));
				if (r.etag) etags[p] = r.etag;
			}
			await sleep(1500);
			const o0 = await stats(port);
			const c0 = process.cpuUsage();
			const counts: Record<number, number> = {};
			let bytes = 0;
			const w = await meter.window(async () => {
				for (let i = 0; i < n; i++) {
					const p = path(i);
					const r = await get(port, p, headers(p));
					bytes += r.bytes;
					counts[r.status] = (counts[r.status] ?? 0) + 1;
				}
			});
			const c1 = process.cpuUsage();
			const o1 = await stats(port);
			emit(config, {
				arm: name,
				round,
				n,
				status: counts,
				bytesPerOp: bytes / n,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				serverCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
				clientCpuMs: (c1.user + c1.system - c0.user - c0.system) / 1000,
				otherCpuMs: w.others
			});
		}
	}
	origin.kill();
}

const BROWSER_ARMS: Record<
	'compute-browser' | 'projection',
	Array<[string, string, string, number]>
> = {
	'compute-browser': [
		['cms-recompute', 'r', 'cms', 300],
		['cms-cache', 'c', 'cms', 300],
		['cms-spool', 's', 'cms', 300],
		['ana-recompute', 'r', 'ana', 40],
		['ana-cache', 'c', 'ana', 300],
		['ana-spool', 's', 'ana', 300]
	],
	projection: [
		['proj-srv-recompute', 'r', 'ps', 100],
		['proj-srv-cache', 'c', 'ps', 300],
		['proj-cli-network', 'c', 'pk', 300],
		['proj-cli-spool', 's', 'pk', 300],
		['cms-spool', 's', 'cms', 300]
	]
};

/** Q1d and Q1e: Chromium with 40 ms of emulated latency against the same origin */
async function runComputeBrowser(config: Config, meter: Meter) {
	const port = 8941;
	const origin = startOrigin({
		PORT: String(port),
		RTT_MS: '40',
		BENCH_TERMS: '3',
		MIRROR: config.mirror,
		DATA: config.data
	});
	await sleep(2500);
	const arms = BROWSER_ARMS[config.experiment as 'compute-browser' | 'projection'];
	const names = [...arms.map((a) => a[0]), 'idle'];
	const base = `http://127.0.0.1:${port}`;
	for (let round = 0; round < config.rounds; round++) {
		for (const name of rotate(names, round, 3)) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			const [, mode, kind, n] = arms.find((a) => a[0] === name) as (typeof arms)[number];
			const pages = [1, 2, 3, 4].map((i) => `/${mode}/${kind}/${i}`);
			const browser = await launch();
			const page: Page = await (await browser.newContext()).newPage();
			await page.goto(base + pages[0]);
			if (mode === 's') {
				await page.evaluate(
					(u) => navigator.serviceWorker.register(u, { updateViaCache: 'all' }),
					kind === 'pk' ? '/spool-sw-proj.js' : '/spool-sw.js'
				);
				await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
					timeout: 30_000
				});
				await page.reload();
			}
			for (let i = 0; i < 8; i++) await page.goto(base + (pages[i % 4] as string));
			await page.waitForTimeout(2000);
			const o0 = await stats(port);
			const w = await meter.window(async () => {
				for (let i = 0; i < n; i++) {
					await page.goto(base + (pages[i % 4] as string));
					await page.waitForLoadState('load');
				}
				if (mode === 's') {
					await page.evaluate(() =>
						navigator.serviceWorker.controller?.postMessage('flush')
					);
					await page.waitForTimeout(300);
				}
			});
			const o1 = await stats(port);
			emit(config, {
				arm: name,
				round,
				n,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				originReqs: o1.reqs - o0.reqs,
				originRecompute: o1.recompute - o0.recompute,
				originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
				otherCpuMs: w.others
			});
			await browser.close();
		}
	}
	origin.kill();
}

/** Q1c: a local model behind the origin; the GPU is sampled on the host, see `publish --gpu` */
async function runInference(config: Config, meter: Meter) {
	const port = 8941;
	const unload = () =>
		fetch(`${config.ollama}/api/generate`, {
			method: 'POST',
			body: JSON.stringify({ model: config.model, keep_alive: 0 })
		}).then((r) => r.json());
	const loaded = async () =>
		(
			(await (await fetch(`${config.ollama}/api/ps`)).json()) as {
				models?: Array<{ name: string }>;
			}
		).models ?? [];
	if ((await loaded()).length > 0)
		throw new Error('ollama already has a model loaded; unload it and rerun');
	const origin = startOrigin({
		PORT: String(port),
		RTT_MS: '0',
		BENCH_TERMS: '3',
		MIRROR: config.mirror,
		DATA: config.data,
		MODEL: config.model,
		OLLAMA: config.ollama
	});
	await sleep(2500);
	const window_ = async (arm: string, round: number, fn: () => Promise<Raw | void>) => {
		const o0 = await stats(port);
		const w = await meter.window(async () => (await fn()) ?? {});
		const o1 = await stats(port);
		const others = { ...w.others };
		emit(config, {
			arm,
			round,
			epochStartMs: w.epochStartMs,
			epochEndMs: w.epochEndMs,
			elapsedMs: w.elapsedMs,
			pkgJ: w.pkgJ,
			load0: w.load0,
			load1: w.load1,
			serverCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
			aiCalls: o1.ai.calls - o0.ai.calls,
			aiOutTokens: o1.ai.out - o0.ai.out,
			aiPromptTokens: o1.ai.inp - o0.ai.inp,
			loadedModels: (await loaded()).map((m) => m.name),
			otherCpuMs: others,
			...w.result
		});
	};
	for (let round = 0; round < config.rounds; round++) {
		await unload();
		await sleep(3000);
		await window_('idle-unloaded', round, () => sleep(config.idleS * 1000));
		for (let i = 1; i <= 4; i++) await get(port, `/r/ai/${i}`);
		await sleep(2000);
		await window_('idle-loaded', round, () => sleep(config.idleS * 1000));
		await window_('ai-recompute', round, async () => {
			const latMs: number[] = [];
			for (let i = 0; i < config.nreq; i++) {
				const a = Date.now();
				const r = await get(port, `/r/ai/${(i % 4) + 1}`);
				latMs.push(Date.now() - a);
				if (r.status !== 200) throw new Error(`status ${r.status}`);
			}
			return { latMs };
		});
		for (let i = 1; i <= 4; i++) await get(port, `/c/ai/${i}`);
		await window_('ai-cache', round, async () => {
			for (let i = 0; i < CACHE_WINDOW_REQUESTS; i++) await get(port, `/c/ai/${(i % 4) + 1}`);
		});
		await unload();
	}
	origin.kill();
}

const CACHE_WINDOW_REQUESTS = 300_000;

const STATES = [0, 1, 2, 3];

/** a condition of the power-state sweep */
export type Condition = { name: string; route: string; rate: number; mode: string; freq?: boolean };

/** idle twice, then each route at each rate, steady and bursty; the `timer` set is the generator-only control */
export function conditions(set: 'sweep' | 'timer'): Condition[] {
	const list: Condition[] = [
		{ name: 'idle', route: 'none', rate: 0, mode: 'none' },
		{ name: 'idle-nofreq', route: 'none', rate: 0, mode: 'none', freq: false }
	];
	if (set === 'timer') {
		for (const rate of [50, 200, 1000]) {
			list.push(
				{ name: `timer-steady-${rate}`, route: 'timer', rate, mode: 'steady' },
				{ name: `null-steady-${rate}`, route: 'null', rate, mode: 'steady' }
			);
		}
		list.push({ name: 'timer-bursty-1000', route: 'timer', rate: 1000, mode: 'bursty' });
		return list;
	}
	for (const mode of ['steady', 'bursty']) {
		for (const rate of [5, 20, 50, 100, 200, 500, 1000])
			list.push({ name: `cms-${mode}-${rate}`, route: 'cms', rate, mode });
		for (const rate of [0.4, 2])
			list.push({ name: `ana-${mode}-${rate}`, route: 'ana', rate, mode });
		for (const rate of [50, 1000])
			list.push({ name: `null-${mode}-${rate}`, route: 'null', rate, mode });
	}
	return list;
}

/** Q2: open-loop request rates; package watts, C-state time, wakeups, busy fraction and frequency per window */
async function runPowerState(config: Config, meter: Meter) {
	const port = 8941;
	const periodS = 5;
	const freqEveryMs = 2000;
	const rd = (p: string) => readFileSync(p, 'utf8').trim();
	const ncpu = readdirSync('/sys/devices/system/cpu').filter((x) => /^cpu\d+$/.test(x)).length;
	const cpuidle = () => {
		const t = [0, 0, 0, 0];
		const u = [0, 0, 0, 0];
		for (let c = 0; c < ncpu; c++) {
			for (const s of STATES) {
				t[s] =
					(t[s] as number) +
					Number(rd(`/sys/devices/system/cpu/cpu${c}/cpuidle/state${s}/time`));
				u[s] =
					(u[s] as number) +
					Number(rd(`/sys/devices/system/cpu/cpu${c}/cpuidle/state${s}/usage`));
			}
		}
		return { t, u };
	};
	const procstat = () => {
		const f = (rd('/proc/stat').split('\n')[0] as string)
			.split(/\s+/)
			.slice(1)
			.map(Number) as number[];
		return {
			busy:
				(f[0] as number) +
				(f[1] as number) +
				(f[2] as number) +
				(f[5] as number) +
				(f[6] as number),
			idle: (f[3] as number) + (f[4] as number)
		};
	};
	const freqs = () => {
		let sum = 0;
		let max = 0;
		for (let c = 0; c < ncpu; c++) {
			const f = Number(rd(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`));
			sum += f;
			if (f > max) max = f;
		}
		return { mean: sum / ncpu, max };
	};
	const origin = startOrigin({
		PORT: String(port),
		RTT_MS: '0',
		BENCH_TERMS: '3',
		MIRROR: config.mirror,
		DATA: config.data
	});
	await sleep(2500);
	const pool = new http.Agent({ keepAlive: true, maxSockets: 16 });
	let done = 0;
	const fire = (path: string) => {
		if (path === '/__timer') {
			done++;
			return;
		}
		const req = http.request(
			{ host: '127.0.0.1', port, path, agent: pool, headers: { 'accept-encoding': 'gzip' } },
			(res) => {
				res.resume();
				res.on('end', () => done++);
			}
		);
		req.on('error', () => undefined);
		req.end();
	};
	const generate = (route: string, rate: number, mode: string) => {
		let stopped = false;
		let n = 0;
		const url = () =>
			route === 'null'
				? '/__null'
				: route === 'timer'
					? '/__timer'
					: `/r/${route}/${(n++ % 4) + 1}`;
		void (async () => {
			const t0 = performance.now();
			if (mode === 'steady') {
				const gap = 1000 / rate;
				for (let i = 1; !stopped; i++) {
					fire(url());
					const wait = t0 + i * gap - performance.now();
					if (wait > 0) await sleep(wait);
				}
			} else {
				const per = Math.max(1, Math.round(rate * periodS));
				for (let k = 1; !stopped; k++) {
					for (let i = 0; i < per; i++) fire(url());
					const wait = t0 + k * periodS * 1000 - performance.now();
					if (wait > 0) await sleep(wait);
				}
			}
		})();
		return () => {
			stopped = true;
		};
	};
	const conds = conditions(config.set);
	for (let round = 0; round < config.rounds; round++) {
		const order = shuffle(conds.slice(2), 1000 + round);
		const half = Math.floor(order.length / 2);
		const seq = [
			conds[0] as Condition,
			...order.slice(0, half),
			conds[1] as Condition,
			...order.slice(half),
			conds[0] as Condition
		];
		for (const [at, c] of seq.entries()) {
			const stop = c.rate > 0 ? generate(c.route, c.rate, c.mode) : () => undefined;
			await sleep(config.settleS * 1000);
			const d0 = done;
			const o0 = await stats(port);
			const ci0 = cpuidle();
			const ps0 = procstat();
			const fs: Array<{ mean: number; max: number }> = [];
			let sampling = c.freq !== false;
			const tick = (async () => {
				while (sampling) {
					fs.push(freqs());
					await sleep(freqEveryMs);
				}
			})();
			const w = await meter.window(() => sleep(config.windowS * 1000));
			const ci1 = cpuidle();
			const ps1 = procstat();
			const d1 = done;
			sampling = false;
			await tick;
			const o1 = await stats(port);
			stop();
			await sleep(1500);
			const el = w.elapsedMs / 1000;
			const busy = ps1.busy - ps0.busy;
			emit(config, {
				cond: c.name,
				route: c.route,
				rate: c.rate,
				mode: c.mode,
				round,
				order: at,
				elapsedS: el,
				pkgJ: w.pkgJ,
				pkgW: w.pkgJ / el,
				reqs: d1 - d0,
				serverCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
				load0: w.load0,
				load1: w.load1,
				residency: STATES.map(
					(s) => ((ci1.t[s] as number) - (ci0.t[s] as number)) / 1e6 / (ncpu * el)
				),
				wakeups: STATES.map((s) => ((ci1.u[s] as number) - (ci0.u[s] as number)) / el),
				busyFrac: busy / (busy + (ps1.idle - ps0.idle)),
				freqMeanKHz: fs.length ? fs.reduce((a, b) => a + b.mean, 0) / fs.length : null,
				freqMaxKHz: fs.length ? Math.max(...fs.map((x) => x.max)) : null,
				freqSamples: fs.length,
				otherCpuMs: w.others
			});
		}
	}
	origin.kill();
}

/** snapshots an origin's home page, up to five linked pages and every same-origin response they load into `dir` */
export async function snapshotMirror(origin: string, dir: string) {
	const { chromium } = await import('playwright');
	const { createHash } = await import('node:crypto');
	const { mkdirSync } = await import('node:fs');
	mkdirSync(join(dir, 'files'), { recursive: true });
	const files: Record<string, { file: string; type: string; bytes: number }> = {};
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on('response', async (res) => {
		const url = new URL(res.url());
		if (url.origin !== origin || res.status() !== 200) return;
		const key = url.pathname + url.search;
		if (files[key]) return;
		try {
			const body = await res.body();
			const file = createHash('sha1').update(key).digest('hex');
			writeFileSync(join(dir, 'files', file), body);
			files[key] = {
				file,
				type: res.headers()['content-type'] ?? 'application/octet-stream',
				bytes: body.length
			};
		} catch {
			return;
		}
	});
	await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
	const links = await page.evaluate(
		(o) => [
			...new Set(
				[...document.querySelectorAll('a[href]')]
					.map((a) => (a as HTMLAnchorElement).href.split('#')[0] as string)
					.filter(
						(h) => h.startsWith(o) && !h.includes('/user/') && !/\.(pdf|xml)$/.test(h)
					)
			)
		],
		origin
	);
	const pages = ['/'];
	for (const link of links) {
		if (pages.length >= 6) break;
		const path = new URL(link).pathname;
		if (pages.includes(path)) continue;
		const res = await page.goto(link, { waitUntil: 'networkidle' }).catch(() => null);
		if (
			res &&
			res.status() === 200 &&
			(res.headers()['content-type'] ?? '').includes('text/html')
		)
			pages.push(path);
	}
	await browser.close();
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({ origin, taken: new Date().toISOString(), pages, files }, null, 1)
	);
	return { pages, files: Object.keys(files).length };
}

// #endregion

// #region publishing

/** drops container ids: the sum of the other containers' CPU, and the ollama container's apart when named */
export function stripRow(row: Raw, ollama?: string): Raw {
	const out = { ...row };
	for (const key of ['otherCpuMs', 'otherContainersCpuMs']) {
		const value = out[key];
		if (value === undefined || typeof value === 'number') continue;
		const others = { ...(value as Record<string, number>) };
		if (ollama !== undefined) {
			out.ollamaCpuMs = round3(others[ollama] ?? 0);
			delete others[ollama];
		}
		out[key] = round3(Object.values(others).reduce((sum, v) => sum + v, 0));
	}
	return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** inference rows with the window's GPU energy added from the sampled power trace and the window bounds removed */
export function inferenceRows(raw: Raw[], samples: readonly PowerSample[], ollama?: string): Raw[] {
	return raw.map((row) => {
		const { epochStartMs, epochEndMs, ...rest } = row;
		const gpu = integrateWatts(samples, epochStartMs, epochEndMs);
		if (!gpu)
			throw new Error(`no GPU samples inside the ${row.arm} window of round ${row.round}`);
		return {
			...stripRow(rest, ollama),
			gpuSamples: gpu.samples,
			gpuSpanS: round3(gpu.spanS),
			gpuJ: round3(gpu.joules)
		};
	});
}

const readJsonl = (path: string): Raw[] =>
	readFileSync(path, 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Raw);

const RIG_ARMS = {
	'compute-browser': { r: 'recompute', c: 'server cache', s: 'service worker' },
	projection: { r: 'recompute', c: 'server cache', s: 'service worker' }
} as const;

/**
 * The schema-1 file for a finished run: container ids stripped, GPU energy integrated for the
 * inference run, and the method written down from what the run recorded in its meta file.
 */
export function publishDraft(
	experiment: Experiment,
	raw: Raw[],
	meta: Raw,
	options: {
		date?: string;
		machine?: Record<string, string | number>;
		gpu?: readonly PowerSample[];
		ollama?: string;
	} = {}
): Draft {
	const machine = { ...PAISLEY, ...options.machine };
	const date = options.date ?? utcDate();
	const base = {
		rig: 'rapl' as const,
		date,
		layer: 'L1' as const,
		instrument: INSTRUMENT,
		exclusions: EXCLUSIONS
	};
	if (experiment === 'views') {
		return {
			...base,
			question:
				'package joules per navigation: optimized HTTP caching, spool, and the demo shipping headers',
			instrument:
				'RAPL package-0 and core energy counters (intel-rapl sysfs, read-only bind into the container)',
			machine,
			software: {
				browser:
					'Chromium (new headless), container mcr.microsoft.com/playwright:v1.62.1-noble, --cpus 8 --memory 6g'
			},
			method: {
				pages: meta.pages,
				'navigations per window': meta.navs,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				'arm order': 'rotated per round',
				'emulated rtt ms': 40,
				origin: 'Node static mirror of demo.drupflare.com in the same container',
				'energy counter range uJ': meta.range
			},
			exclusions: [],
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'compute-server') {
		return {
			...base,
			question:
				'package joules per server request: recompute against an in-process cache, for a CMS render and an analytics page',
			machine,
			software: {
				origin: 'Node http server and a keep-alive Node client in one container',
				container: CONTAINER
			},
			method: {
				arms: SERVER_ARMS.map((a) => a[0]),
				'operations per window': Object.fromEntries(SERVER_ARMS.map((a) => [a[0], a[4]])),
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				concurrency: 1,
				'arm order': 'rotated per round',
				'emulated rtt ms': 0,
				data: DATA,
				'cms render':
					'12 queries, a string template and gzip over the mirror HTML (about 27 KB)',
				'analytics page':
					'4 department queries and a university-wide scan of the last 3 terms (about 393 ms of CPU)'
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'compute-browser' || experiment === 'projection') {
		const arms = BROWSER_ARMS[experiment];
		const names = RIG_ARMS[experiment];
		return {
			...base,
			question:
				experiment === 'projection'
					? 'package joules per Chromium navigation: server-computed result, cached result and a result computed in the page from stored records'
					: 'package joules per Chromium navigation: recompute, optimized server cache and a service-worker render, for a CMS page and an analytics page',
			machine,
			software: { browser: 'Chromium (new headless)', container: CONTAINER },
			method: {
				arms: Object.fromEntries(
					arms.map(([name, mode, kind, n]) => [
						name,
						{
							mode: names[mode as 'r' | 'c' | 's'],
							page: kind,
							'navigations per window': n
						}
					])
				),
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				'arm order': 'rotated per round',
				'emulated rtt ms': 40,
				data: DATA,
				origin:
					'Node server in the same container; pages are the demo.drupflare.com mirror HTML plus a rendered fragment, assets immutable' +
					(experiment === 'projection'
						? "; the projection page receives one department's records (about 60,000 rows, 1.73 MB JSON) and aggregates them in the page"
						: ''),
				...(experiment === 'projection' ? { 'records bytes': 1_730_000 } : {})
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'inference') {
		if (!options.gpu)
			throw new Error('the inference run needs --gpu, the host-side nvidia-smi CSV');
		return {
			...base,
			question:
				'joules per request for a locally served 8B model, against a cached copy of the same response',
			instrument: `${INSTRUMENT}; the GPU board is nvidia-smi power.draw.instant sampled at 10 Hz and integrated per window, layer L1-sampled (stated accuracy +-5 W, no energy counter on this card)`,
			machine: { ...machine, gpu: 'NVIDIA RTX 4070, 200 W limit' },
			software: { model: `${meta.model} (Q4) under ollama`, container: CONTAINER },
			method: {
				'requests per window': meta.nreq,
				'requests per cache window': CACHE_WINDOW_REQUESTS,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				options: { temperature: 0, seed: 7, num_predict: 120 },
				prompt: 'a 473-token department statistics prompt; every request produced 120 output tokens',
				arms: ['idle-unloaded', 'idle-loaded', 'ai-recompute', 'ai-cache'],
				'model state':
					'unloaded with keep_alive 0 before each round; ollama container CPU is reported apart as ollamaCpuMs and counts as part of the arm',
				gpu: 'gpuJ is the trapezoid integral of the samples inside the window scaled to the window length'
			},
			exclusions: [
				...EXCLUSIONS,
				'DRAM, PSU loss and any component that is neither the package nor the GPU board'
			],
			rows: inferenceRows(raw, options.gpu, options.ollama)
		};
	}
	const rows = raw.map((r) => ({ set: r.set ?? 'sweep', ...stripRow(r) }));
	return {
		...base,
		question:
			'package watts and C-state activity against request rate, steady and bursty, with a timer-only control',
		instrument: `${INSTRUMENT}; C-state time and usage from /sys/devices/system/cpu/cpu*/cpuidle summed over all CPUs, /proc/stat busy fraction, scaling_cur_freq every 2 s`,
		machine: { ...machine, cpus: meta.ncpu ?? machine.cpus ?? 24 },
		software: {
			origin: 'Node http server and a separate open-loop Node generator in the same container',
			container: CONTAINER
		},
		method: {
			'window s': meta.windowS,
			'settle s': meta.settleS,
			rounds: meta.rounds,
			'burst period s': 5,
			'frequency sample ms': 2000,
			conditions: conditions('sweep').map((c) => c.name),
			order: 'shuffled per round with an idle window at the start, middle and end',
			steady: 'one request every 1/rate seconds',
			bursty: 'the same count issued back to back once per period',
			'timer set':
				'a generator that fires its timer with no network and no origin (and a null route), at 50, 200 and 1000 per second, steady and bursty',
			data: DATA
		},
		rows
	};
}

// #endregion

const HELP = `usage:
  rapl.ts run <${EXPERIMENTS.join('|')}> [--rounds N] [--idle-s S] [--navs N] [--raw FILE] [--rapl DIR] [--cgroup DIR] [--mirror DIR] [--data DIR]
  rapl.ts publish <experiment> --raw FILE [--timer-raw FILE] [--gpu CSV] [--machine-json JSON] [--date D] [--out DIR] [--force]
  rapl.ts data [--data DIR]        builds the synthetic databases
  rapl.ts mirror <origin> <dir>    snapshots a site for the views and compute origins
Runs on paisley-park inside the rig container; see docs/impact.md, Reproducing.`;

/** the plan a dry run prints: what would run, with every default resolved, and where the result would go */
export function plan(parsed: ReturnType<typeof parse>) {
	const { config } = parsed;
	return {
		command: parsed.command,
		experiment: config.experiment,
		rounds: config.rounds,
		idleS: config.idleS,
		raw: config.raw,
		rapl: config.rapl,
		output: `measurements/rapl/${parsed.date ?? utcDate()}-${config.experiment}.json`
	};
}

if (isMain(import.meta.url)) {
	const parsed = parse(process.argv.slice(2));
	const { command, config } = parsed;
	if (!command) {
		console.log(HELP);
	} else if (parsed.dryRun) {
		console.log(JSON.stringify(plan(parsed), null, 2));
	} else if (command === 'data') {
		console.log(buildAll(config.data).join('\n'));
	} else if (command === 'run') {
		writeFileSync(config.raw, '');
		const meter = new Meter(config.rapl, config.cgroup);
		const meta: Raw = {
			rounds: config.rounds,
			idleS: config.idleS,
			navs: config.navs,
			range: meter.range,
			windowS: config.windowS,
			settleS: config.settleS,
			nreq: config.nreq,
			model: config.model,
			set: config.set,
			ncpu: readdirSync('/sys/devices/system/cpu').filter((x) => /^cpu\d+$/.test(x)).length,
			governor: config.governor,
			started: new Date().toISOString()
		};
		if (config.experiment === 'views') {
			meta.pages = (
				JSON.parse(readFileSync(join(config.mirror, 'manifest.json'), 'utf8')) as {
					pages: string[];
				}
			).pages;
		}
		writeFileSync(`${config.raw}.meta.json`, `${JSON.stringify(meta, null, '\t')}\n`);
		const runs: Record<Experiment, (c: Config, m: Meter) => Promise<void>> = {
			views: runViews,
			'compute-server': runComputeServer,
			'compute-browser': runComputeBrowser,
			projection: runComputeBrowser,
			inference: runInference,
			'power-state': runPowerState
		};
		await runs[config.experiment](config, meter);
		writeFileSync(`${config.raw}.DONE`, new Date().toISOString());
		process.exit(0);
	} else if (command === 'publish') {
		const raw = readJsonl(config.raw).map((r) => ({ set: 'sweep', ...r }));
		if (parsed.timerRaw)
			raw.push(...readJsonl(parsed.timerRaw).map((r) => ({ set: 'timer', ...r })));
		const meta = JSON.parse(readFileSync(`${config.raw}.meta.json`, 'utf8')) as Raw;
		const gpu = parsed.gpu ? parseNvidiaCsv(readFileSync(parsed.gpu, 'utf8')) : undefined;
		const draft = publishDraft(config.experiment, raw, meta, {
			date: parsed.date,
			machine: parsed.machineJson
				? (JSON.parse(parsed.machineJson) as Record<string, string | number>)
				: undefined,
			gpu,
			ollama: process.env.OLLAMA_CONTAINER
		});
		console.log(
			writeMeasurement(parsed.out, draft, {
				experiment: config.experiment,
				overwrite: parsed.force
			})
		);
	} else {
		const [, origin, dir] = parsed.positionals;
		if (!origin || !dir) throw new Error('usage: rapl.ts mirror <origin> <dir>');
		console.log(JSON.stringify(await snapshotMirror(origin, dir)));
	}
}
