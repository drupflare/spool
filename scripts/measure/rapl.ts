import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openHiddenBrowser } from './cdp-hidden.ts';
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
import {
	ACTIVITY_ARMS,
	DECODE_METHODS,
	DECODE_VARIANTS,
	HIDDEN_ARMS,
	fileFor,
	loadTinyimg,
	readSet,
	runEncodeChild
} from './rapl-media.ts';
import { ARM_ASSET, SW_ARMS, requestsFor, type SwArm } from './rapl-sw.ts';

/** the experiments, which are also the file suffixes under `measurements/rapl/` */
export const EXPERIMENTS = [
	'views',
	'compute-server',
	'compute-browser',
	'projection',
	'inference',
	'power-state',
	'sw-request',
	'image-decode',
	'image-encode',
	'dictionary-load',
	'idle-activity',
	'idle-activity-hidden'
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
const CHROMIUM =
	'Chromium (new headless), container mcr.microsoft.com/playwright:v1.62.1-noble, --memory 6g';
const CONTAINER_TINY = 'container mcr.microsoft.com/playwright:v1.62.1-noble, --cpus 2 --memory 2g';
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
	requests: number;
	set: 'sweep' | 'timer';
	model: string;
	ollama: string;
	images: string;
	tinyimg: string;
	dictFile: string;
	targetFile: string;
	passes: number;
};

const DEFAULT_ROUNDS: Record<Experiment, number> = {
	views: 8,
	'compute-server': 8,
	'compute-browser': 8,
	projection: 8,
	inference: 5,
	'power-state': 4,
	'sw-request': 8,
	'image-decode': 6,
	'image-encode': 6,
	'dictionary-load': 6,
	'idle-activity': 4,
	'idle-activity-hidden': 8
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
			requests: { type: 'string', default: '20000' },
			set: { type: 'string', default: 'sweep' },
			model: { type: 'string', default: 'llama3.1:8b' },
			ollama: { type: 'string', default: 'http://host.docker.internal:11434' },
			images: { type: 'string', default: '/rig/images' },
			tinyimg: { type: 'string', default: '/rig/tinyimg' },
			'dict-file': { type: 'string', default: '/rig/dict/base.bin' },
			'target-file': { type: 'string', default: '/rig/dict/target.bin' },
			passes: { type: 'string', default: '6' },
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
		requests: Number(values.requests),
		set: values.set === 'timer' ? 'timer' : 'sweep',
		model: values.model as string,
		ollama: values.ollama as string,
		images: values.images as string,
		tinyimg: values.tinyimg as string,
		dictFile: values['dict-file'] as string,
		targetFile: values['target-file'] as string,
		passes: Number(values.passes)
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

/** closed loop from the page: one `fetch` of the arm's asset at a time, the body read, the bytes summed */
const fetchLoop = async ({ url, n }: { url: string; n: number }) => {
	let bytes = 0;
	for (let i = 0; i < n; i++) bytes += (await (await fetch(url)).arrayBuffer()).byteLength;
	return bytes;
};

const workerEvents = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<number>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (e) => resolve(e.data as number);
				navigator.serviceWorker.controller?.postMessage('count', [channel.port2]);
			})
	);

/** joules per request on the page's side: the browser cache, a worker that answers or passes, a 304, a 200 */
async function runSwRequest(config: Config, meter: Meter) {
	const port = 8951;
	const origin = spawn('node', [join(HERE, 'rapl-sw.ts')], {
		stdio: 'inherit',
		env: { ...process.env, PORT: String(port) }
	});
	await sleep(2000);
	const base = `http://127.0.0.1:${port}`;
	for (let round = 0; round < config.rounds; round++) {
		for (const name of rotate([...SW_ARMS, 'idle'], round, 3)) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			const arm = name as SwArm;
			const url = base + ARM_ASSET[arm];
			const n = requestsFor(arm, config.requests);
			const worker = arm === 'sw-cache' || arm === 'sw-pass';
			const browser = await launch();
			const page: Page = await (await browser.newContext()).newPage();
			await page.goto(`${base}/`);
			if (worker) {
				await page.evaluate(
					(u) => navigator.serviceWorker.register(u, { updateViaCache: 'all' }),
					`/${arm}.js`
				);
				await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {
					timeout: 30_000
				});
				await page.reload();
			}
			await page.evaluate(fetchLoop, { url, n: 200 });
			await page.waitForTimeout(2000);
			const o0 = await stats(port);
			const e0 = worker ? await workerEvents(page) : null;
			const w = await meter.window(() => page.evaluate(fetchLoop, { url, n }));
			const o1 = await stats(port);
			const e1 = worker ? await workerEvents(page) : null;
			const path = ARM_ASSET[arm];
			emit(config, {
				arm,
				round,
				n,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				bytes: w.result,
				originReqs: (o1.hits[path] ?? 0) - (o0.hits[path] ?? 0),
				originNotModified: o1.notModified - o0.notModified,
				originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
				workerEvents: e1 === null || e0 === null ? null : e1 - e0,
				otherCpuMs: w.others
			});
			await browser.close();
		}
	}
	origin.kill();
}

// #region media experiments

const MEDIA_PORT = 8961;

/** starts the media origin and resolves once it answers; rejects when the origin exits first */
export async function mediaOrigin(env: Record<string, string> = {}): Promise<ChildProcess> {
	const origin = spawn('node', [join(HERE, 'rapl-media.ts')], {
		stdio: 'inherit',
		env: { ...process.env, PORT: String(MEDIA_PORT), ...env }
	});
	let exited = null as number | null;
	origin.on('exit', (code) => (exited = code ?? -1));
	for (let i = 0; i < 40; i++) {
		if (exited !== null)
			throw new Error(`the media origin exited ${exited} before it listened`);
		try {
			await mediaStats();
			return origin;
		} catch {
			await sleep(250);
		}
	}
	origin.kill();
	throw new Error('the media origin did not answer /__stats within 10 s');
}

const mediaStats = async () => stats(MEDIA_PORT);

/** the window order of one round: an idle window before the first arm, after every second arm and after the last */
export function activitySchedule(arms: readonly string[]): string[] {
	return [
		'idle',
		...arms.flatMap((arm, i) => (i % 2 === 1 || i === arms.length - 1 ? [arm, 'idle'] : [arm]))
	];
}

/** package joules per minute for each activity arm, every page visible */
async function runIdleActivity(config: Config, meter: Meter) {
	const origin = await mediaOrigin();
	try {
		const client = await fetch(`http://127.0.0.1:${MEDIA_PORT}/client.js`);
		if (!client.ok)
			throw new Error('the origin has no /client.js; run bun run build:cdn first');
		await idleActivityRounds(config, meter);
	} finally {
		origin.kill();
	}
}

/**
 * package joules per minute for a quiet page and a poller with and without the pause hook, each in
 * a tab behind another one, in a headed Chromium under a virtual display and driven over raw CDP
 */
async function runIdleActivityHidden(config: Config, meter: Meter) {
	const { chromium } = await import('playwright');
	const origin = await mediaOrigin();
	try {
		const base = `http://127.0.0.1:${MEDIA_PORT}`;
		const client = await fetch(`${base}/client.js`);
		if (!client.ok)
			throw new Error('the origin has no /client.js; run bun run build:cdn first');
		for (let round = 0; round < config.rounds; round++) {
			for (const name of activitySchedule(rotate([...HIDDEN_ARMS], round))) {
				if (name === 'idle') {
					await idleWindow(meter, config, round);
					continue;
				}
				const browser = await openHiddenBrowser(
					chromium.executablePath(),
					`${base}/${name}`
				);
				try {
					await browser.hideFirstTab();
					await sleep(8000);
					const o0 = await mediaStats();
					const c0 = await browser.evaluate<number>('window.__count');
					const w = await meter.window(() => sleep(config.windowS * 1000));
					const c1 = await browser.evaluate<number>('window.__count');
					const o1 = await mediaStats();
					const visibility = await browser.visibility();
					if (visibility !== 'hidden') {
						throw new Error(
							`${name} in round ${round} ended ${visibility}, not hidden`
						);
					}
					emit(config, {
						arm: name,
						round,
						n: 0,
						windowS: config.windowS,
						elapsedMs: w.elapsedMs,
						pkgJ: w.pkgJ,
						load0: w.load0,
						load1: w.load1,
						pageEvents: c1 - c0,
						originPings: o1.ping - o0.ping,
						originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
						visibility,
						otherCpuMs: w.others
					});
				} finally {
					await browser.close();
				}
			}
		}
	} finally {
		origin.kill();
	}
}

async function idleActivityRounds(config: Config, meter: Meter) {
	const base = `http://127.0.0.1:${MEDIA_PORT}`;
	for (let round = 0; round < config.rounds; round++) {
		for (const name of activitySchedule(rotate([...ACTIVITY_ARMS], round))) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			const browser = await launch();
			const context = await browser.newContext();
			const page: Page = await context.newPage();
			await page.goto(`${base}/${name}`);
			await page.waitForTimeout(8000);
			const o0 = await mediaStats();
			const c0 = (await page.evaluate(() => (window as any).__count)) as number;
			const w = await meter.window(() => sleep(config.windowS * 1000));
			const c1 = (await page.evaluate(() => (window as any).__count)) as number;
			const o1 = await mediaStats();
			const visibility = await page.evaluate(() => document.visibilityState);
			if (visibility !== 'visible') {
				await browser.close();
				throw new Error(`${name} in round ${round} ended ${visibility}, not visible`);
			}
			emit(config, {
				arm: name,
				round,
				n: 0,
				windowS: config.windowS,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				pageEvents: c1 - c0,
				originPings: o1.ping - o0.ping,
				originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
				visibility,
				otherCpuMs: w.others
			});
			await browser.close();
		}
	}
}

/** package joules per image converted by tinyimg in Node on one busy thread, with the module loaded (warm) or loaded in a fresh process per pass (cold) */
async function runImageEncode(config: Config, meter: Meter) {
	const set = readSet(config.images);
	const tiny = await loadTinyimg(config.tinyimg);
	const inputs = set.images.map((image) => readFileSync(join(config.images, image.original)));
	const bytesPerPass = inputs.reduce((sum, input) => sum + input.length, 0);
	const warm = async (resized: boolean) => {
		let out = 0;
		let encodeMs = 0;
		for (const [i, input] of inputs.entries()) {
			const image = set.images[i];
			const t0 = performance.now();
			const result = await tiny.transform(tiny.module, input, {
				format: 'webp',
				quality: set.quality,
				...(resized && image ? { width: image.resizedWidth, fit: 'scale-down' } : {})
			});
			encodeMs += performance.now() - t0;
			out += result.bytes().length;
		}
		return { out, encodeMs };
	};
	for (let round = 0; round < config.rounds; round++) {
		for (const name of rotate(['warm-native', 'warm-resized', 'cold-native', 'idle'], round)) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			if (name === 'cold-native') {
				await sleep(2000);
				const w = await meter.window(async () => {
					const runs: Array<Record<string, number>> = [];
					for (let p = 0; p < config.passes; p++)
						runs.push(await runEncodeChild(config.images, config.tinyimg));
					return runs;
				});
				const runs = w.result;
				emit(config, {
					arm: name,
					round,
					n: set.images.length * config.passes,
					images: set.images.length,
					passes: config.passes,
					bytesIn: bytesPerPass * config.passes,
					bytesOut: runs.reduce((sum, r) => sum + (r.bytesOut ?? 0), 0),
					encodeMs: runs.reduce((sum, r) => sum + (r.encodeMs ?? 0), 0),
					loadMs: runs.reduce((sum, r) => sum + (r.loadMs ?? 0), 0),
					elapsedMs: w.elapsedMs,
					pkgJ: w.pkgJ,
					load0: w.load0,
					load1: w.load1,
					otherCpuMs: w.others
				});
				continue;
			}
			const resized = name === 'warm-resized';
			await warm(resized);
			await sleep(2000);
			const w = await meter.window(async () => {
				let out = 0;
				let encodeMs = 0;
				for (let p = 0; p < config.passes; p++) {
					const r = await warm(resized);
					out += r.out;
					encodeMs += r.encodeMs;
				}
				return { out, encodeMs };
			});
			emit(config, {
				arm: name,
				round,
				n: set.images.length * config.passes,
				images: set.images.length,
				passes: config.passes,
				bytesIn: bytesPerPass * config.passes,
				bytesOut: w.result.out,
				encodeMs: w.result.encodeMs,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				otherCpuMs: w.others
			});
		}
	}
}

/** package joules per image decoded in Chromium (createImageBitmap, and an <img> shown at its CSS width): the original, the WebP at native size, the WebP at the rendered width */
async function runImageDecode(config: Config, meter: Meter) {
	const set = readSet(config.images);
	const origin = await mediaOrigin({ IMAGES: config.images });
	const base = `http://127.0.0.1:${MEDIA_PORT}`;
	const arms = DECODE_METHODS.flatMap((method) =>
		DECODE_VARIANTS.map((variant) => ({ method, variant, name: `${method}-${variant}` }))
	);
	for (let round = 0; round < config.rounds; round++) {
		for (const name of rotate(['idle', ...arms.map((a) => a.name)], round, 3)) {
			if (name === 'idle') {
				await idleWindow(meter, config, round);
				continue;
			}
			const arm = arms.find((a) => a.name === name) as (typeof arms)[number];
			const files = set.images.map((image) => ({ file: fileFor(image, arm.variant) }));
			const widths = set.images.map((image) => image.cssWidth);
			const bytes = set.images.reduce(
				(sum, image) =>
					sum +
					(arm.variant === 'original'
						? image.bytes
						: arm.variant === 'native'
							? image.webpBytes
							: image.resizedBytes),
				0
			);
			const browser = await launch();
			const page: Page = await (await browser.newContext()).newPage();
			await page.goto(`${base}/decode`);
			await page.evaluate((f) => (window as any).prepare(f), files);
			await page.evaluate((a) => (window as any).decodeAll(a.method, a.widths, 1), {
				method: arm.method,
				widths
			});
			await page.waitForTimeout(2000);
			const w = await meter.window(() =>
				page.evaluate(
					(a) =>
						(window as any).decodeAll(a.method, a.widths, a.passes) as Promise<number>,
					{
						method: arm.method,
						widths,
						passes: config.passes
					}
				)
			);
			emit(config, {
				arm: name,
				method: arm.method,
				variant: arm.variant,
				round,
				n: w.result,
				images: set.images.length,
				passes: config.passes,
				bytes: bytes * config.passes,
				elapsedMs: w.elapsedMs,
				pkgJ: w.pkgJ,
				load0: w.load0,
				load1: w.load1,
				otherCpuMs: w.others
			});
			await browser.close();
		}
	}
	origin.kill();
}

/** package joules per page load that fetches one aggregate file delivered as plain brotli or as dcz against a stored dictionary, after checking that Chromium negotiates the transport at all */
async function runDictionaryLoad(config: Config, meter: Meter) {
	const origin = await mediaOrigin({
		DICT_FILE: config.dictFile,
		TARGET_FILE: config.targetFile
	});
	const base = `http://127.0.0.1:${MEDIA_PORT}`;
	const probe = await launch();
	const probePage: Page = await (await probe.newContext()).newPage();
	await probePage.goto(`${base}/dict-page`);
	await probePage.waitForTimeout(2500);
	await probePage.goto(`${base}/page?n=0`);
	await probePage.waitForFunction(() => (window as any).__done === true, null, {
		timeout: 60_000
	});
	const bytesRead = await probePage.evaluate(() => (window as any).__bytes as number);
	const seen = await mediaStats();
	const negotiated = seen.dcz > 0;
	emit(config, {
		arm: 'negotiation',
		round: 0,
		n: 0,
		negotiated,
		chromium: probe.version(),
		withDictionaryHeader: seen.withDictionaryHeader,
		dczServed: seen.dcz,
		acceptEncoding: seen.acceptEncodings,
		bytesRead,
		dictBytes: seen.dictBytes,
		targetBytes: seen.targetBytes,
		targetBrotliBytes: seen.targetBrotliBytes,
		targetDczBytes: seen.targetDczBytes,
		elapsedMs: 0,
		pkgJ: 0,
		load0: meter.load(),
		load1: meter.load(),
		otherCpuMs: 0
	});
	await probe.close();
	if (negotiated) {
		for (let round = 0; round < config.rounds; round++) {
			for (const name of rotate(['plain', 'dictionary', 'idle'], round)) {
				if (name === 'idle') {
					await idleWindow(meter, config, round);
					continue;
				}
				const browser = await launch();
				const page: Page = await (await browser.newContext()).newPage();
				if (name === 'dictionary') {
					await page.goto(`${base}/dict-page`);
					await page.waitForTimeout(2500);
				}
				const loaded = () =>
					page.waitForFunction(() => (window as any).__done === true, null, {
						timeout: 60_000
					});
				await page.goto(`${base}/page?n=-1`);
				await loaded();
				await page.waitForTimeout(1500);
				const o0 = await mediaStats();
				const w = await meter.window(async () => {
					for (let i = 1; i <= config.navs; i++) {
						await page.goto(`${base}/page?n=${i}`, { waitUntil: 'load' });
						await loaded();
					}
				});
				const o1 = await mediaStats();
				emit(config, {
					arm: name,
					round,
					n: config.navs,
					elapsedMs: w.elapsedMs,
					pkgJ: w.pkgJ,
					load0: w.load0,
					load1: w.load1,
					originDcz: o1.dcz - o0.dcz,
					originBrotli: o1.brotli - o0.brotli,
					originWithDictionaryHeader: o1.withDictionaryHeader - o0.withDictionaryHeader,
					originCpuMs: (o1.cpuUs - o0.cpuUs) / 1000,
					otherCpuMs: w.others
				});
				await browser.close();
			}
		}
	}
	origin.kill();
}

// #endregion

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
	if (experiment === 'sw-request') {
		return {
			...base,
			question:
				'package joules per fetch from a page in Chromium: the browser cache, a worker answering from CacheStorage, a worker passing the request through, a 304 revalidation and a full 200',
			machine,
			software: {
				browser:
					'Chromium (new headless), container mcr.microsoft.com/playwright:v1.62.1-noble, --cpus 8 --memory 6g',
				origin: 'Node http server in the same container'
			},
			method: {
				asset: '4,096 B, one URL per header set',
				arms: 'http-cache (immutable, no worker), sw-cache (worker answers from CacheStorage), sw-pass (worker with a fetch handler that answers nothing), revalidate (max-age=0 with an ETag, 304), network-200 (no-store)',
				loop: 'fetch() and the body read, one at a time, in a loop inside the page',
				'requests per window': meta.requests,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				'arm order': 'rotated per round',
				'emulated rtt ms': 0,
				'energy counter range uJ': meta.range
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'idle-activity') {
		return {
			...base,
			question:
				'package joules per minute in headless Chromium for quiet, polling and requestAnimationFrame pages, and for a loop off screen with and without a pause hook',
			machine,
			software: { browser: CHROMIUM, origin: 'Node http server in the same container' },
			method: {
				arms: {
					quiet: 'a static page with no timers',
					poll: 'setInterval every 1000 ms, fetch() of a 204 endpoint',
					raf: 'a requestAnimationFrame loop that moves a composited 80 px box',
					'raf-off-plain':
						'the raf loop with its box at top 3000 px, off screen in a 900 px viewport',
					'raf-off-hook':
						'raf-off-plain plus the page runtime, which cancels the frame while the box is off screen'
				},
				'window s': meta.windowS,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				'idle windows':
					'four per round, no browser running; the drift between them is in the rows',
				'arm order':
					'rotated per round; an idle window before the first arm, after every second arm and after the last',
				settle: 'the page loaded, then 8 s before the window opens',
				visibility:
					"every row records document.visibilityState at the end of its window and a row that is not visible stops the run. A hidden-page arm is not run: no headless Chromium launch mode reports a backgrounded page as hidden (probe 2026-10-25, three modes), so the hook's hidden-time pause is covered by contract tests in three engines and has no power reading"
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'idle-activity-hidden') {
		return {
			...base,
			question:
				'package joules per minute in a headed Chromium under a virtual display for a quiet page and a polling page, each in a tab behind another tab, with and without the page runtime pausing the poll',
			machine,
			software: {
				browser: CHROMIUM,
				display: 'Xvfb through xvfb-run, no window manager',
				driver: 'raw CDP over a WebSocket (no Playwright, which turns on focus emulation and makes every tab report visible)',
				origin: 'Node http server in the same container'
			},
			method: {
				arms: {
					'quiet-hidden': 'a static page with no timers, in a tab behind another',
					'poll-hidden-plain':
						'setInterval every 1000 ms with a fetch() of a 204 endpoint, in a tab behind another',
					'poll-hidden-hook':
						'poll-hidden-plain plus the page runtime, which clears the interval once the page has been hidden for 1000 ms'
				},
				'window s': meta.windowS,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				'idle windows':
					'three or four per round, no browser running; the drift between them is in the rows',
				'arm order':
					'rotated per round; an idle window before the first arm, after every second arm and after the last',
				settle: 'the page loaded, a second tab opened and brought to the front, then 8 s before the window opens',
				visibility:
					'every row records document.visibilityState of the first tab at the end of its window, and a row that is not hidden stops the run'
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'image-encode') {
		return {
			...base,
			question:
				'package joules per image converted to WebP by tinyimg in Node on one busy thread, with the module loaded and in a fresh process, and per megabyte of input',
			machine,
			software: {
				tinyimg: String(meta.tinyimg ?? 'unknown'),
				runtime: 'Node 24 in the container, --cpus 2',
				container: CONTAINER_TINY
			},
			method: {
				images: meta.images,
				'passes per window': meta.passes,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				quality: meta.quality,
				arms: {
					'warm-native':
						'module loaded and warmed up, every image encoded at native size, repeated for the passes',
					'warm-resized':
						'the same with the width set to the image rendered width (fit scale-down)',
					'cold-native':
						'one fresh Node process per pass that loads the module and encodes the set once; the window covers the process start, the load and the encode'
				},
				'arm order': 'rotated per round',
				source: 'JPEG and PNG files first seen by measurements/image-crawl, copied to the box'
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'image-decode') {
		return {
			...base,
			question:
				'package joules per image decoded in headless Chromium: the original JPEG or PNG, the WebP at native size and the WebP resized to the rendered width, by createImageBitmap and by an <img> shown at its CSS width',
			machine,
			software: { browser: CHROMIUM, origin: 'Node http server in the same container' },
			method: {
				images: meta.images,
				'passes per window': meta.passes,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				bitmap: 'createImageBitmap(blob) then close(), blobs fetched before the window',
				img: 'a new <img> at the CSS width of the image, src a fresh object URL, await decode(), two animation frames, remove',
				'arm order': 'rotated per round',
				source: 'JPEG and PNG files first seen by measurements/image-crawl, the WebP files made by tinyimg at quality 80'
			},
			rows: raw.map((r) => stripRow(r))
		};
	}
	if (experiment === 'dictionary-load') {
		return {
			...base,
			question:
				'whether Chromium negotiates compression dictionary transport, and the package joules per page load that fetches one real aggregate file delivered as brotli 11 or as dcz against a stored dictionary',
			machine,
			software: {
				browser: CHROMIUM,
				origin: 'Node http server in the same container; dcz is a 40-byte header plus zstd level 19 with the dictionary as raw content'
			},
			method: {
				'loads per window': meta.navs,
				rounds: meta.rounds,
				'idle window s': meta.idleS,
				arms: {
					plain: 'no dictionary stored; the file arrives as brotli 11',
					dictionary:
						'the dictionary file was fetched with Use-As-Dictionary first; the target arrives as dcz'
				},
				negotiation:
					'a first row (arm negotiation) records whether the origin saw Available-Dictionary and served dcz; the windows run only when it did',
				files: 'a real pair of JavaScript aggregates from one Drupal site, a dictionary and the aggregate served on a later page of the same visit; the page fetches the target and reads its bytes without running it',
				'why not a stylesheet':
					'no stylesheet pair of the sizing corpus had a dictionary that beat plain brotli by a margin the encode could show; the churned JavaScript aggregates did',
				cache: 'every load asks for a new query string, which the dictionary match ignores, so no load is a cache hit'
			},
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
  rapl.ts run <${EXPERIMENTS.join('|')}> [--rounds N] [--idle-s S] [--navs N] [--requests N] [--raw FILE] [--rapl DIR] [--cgroup DIR] [--mirror DIR] [--data DIR]
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
			requests: config.requests,
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
		meta.passes = config.passes;
		if (config.experiment === 'image-decode' || config.experiment === 'image-encode') {
			const set = readSet(config.images);
			meta.images = set.images.length;
			meta.quality = set.quality;
			meta.tinyimg = set.tinyimg;
		}
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
			'power-state': runPowerState,
			'sw-request': runSwRequest,
			'image-decode': runImageDecode,
			'image-encode': runImageEncode,
			'dictionary-load': runDictionaryLoad,
			'idle-activity': runIdleActivity,
			'idle-activity-hidden': runIdleActivityHidden
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
