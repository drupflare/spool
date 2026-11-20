import { toNodeListener } from '@drupflare/spool/node';
import type { Spool } from '@drupflare/spool/server';
import type { BrowserContext, BrowserType } from '@playwright/test';
import { chromium, firefox, webkit } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { blogSite } from '../../examples/blog/shared/site.ts';
import { campusSite } from '../../examples/campus/shared/site.ts';
import { courseSpool } from '../../examples/courses/shared/site.ts';
import { dashboardSite } from '../../examples/dashboard/shared/site.ts';
import { homepageSite } from '../../examples/homepage/shared/site.ts';
import { measurementPath, serialiseMeasurement } from '../../src/report/measurement.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';
import { clickHref, clickOffered, fnv1a, isDocumentView, settleOn } from './reader.ts';

type Row = Record<string, unknown>;
type Arm = 'spool' | 'no-spool';
type EngineName = 'chromium' | 'firefox' | 'webkit';
type Engine = Pick<BrowserType, 'name' | 'launchPersistentContext' | 'launch'>;
type Handler = (request: Request) => Response | Promise<Response>;
/** one request that reached the node listener: who answered it, and with what */
type Line = {
	method: string;
	path: string;
	status: number;
	bytes: number;
	origin: boolean;
	dest: string | null;
};

/** the site as an arm sees it: the spool when there is one, and the origin page */
export type Origin = { spool: Spool | undefined; page: Handler };

export type SiteSpec = {
	name: string;
	/** the path a reader opens first, then the paths it falls back to where a page offers no link */
	views: readonly string[];
	/** a dashboard needs a signed-in reader and a write every second view */
	writes: boolean;
	/** `docBytes` is the hidden filler each page's layout carries; 0 leaves the sites as built */
	open: (spooled: boolean, docBytes?: number) => Promise<Origin>;
};

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ARMS: readonly Arm[] = ['spool', 'no-spool'];
export const ENGINES: Record<EngineName, Engine> = { chromium, firefox, webkit };
export const WORKER_VIEWS = 3;
export const WORKER_ENGINE: EngineName = 'chromium';
/** every sixth view is a document navigation to a typed path; the other views click a link the page offers */
export const DOCUMENT_EVERY = 6;
/** the pause before each in-page click, the same gap demand.ts uses to stay inside the history budget */
export const CLICK_GAP_MS = 150;
/** the bytes `<div hidden></div>` spends on its own tags; a padded layout adds exactly --doc-bytes */
export const LAYOUT_TAGS_BYTES = 18;

// the sites share one loopback port and one shape; each is opened fresh for every run
export const SITES: readonly SiteSpec[] = [
	{
		name: 'courses',
		views: ['/courses', '/courses/101', '/courses/102', '/courses/103'],
		writes: false,
		open: async (spooled, docBytes = 0) =>
			spooled ? courseSpool(3, { docBytes }) : courseSpool(3, { spool: false, docBytes })
	},
	{
		name: 'campus',
		views: [
			'/courses',
			'/courses/101',
			'/catalogue?department=web',
			'/people/ada',
			'/news/2026/pack-release',
			'/teams/web'
		],
		writes: false,
		open: async (spooled, docBytes = 0) =>
			spooled ? campusSite({ docBytes }) : campusSite({ spool: false, docBytes })
	},
	{
		name: 'blog',
		views: [
			'/',
			'/posts/09999',
			'/posts/09998',
			'/authors/ada',
			'/archive/2024/01',
			'/tags?tag=web'
		],
		writes: false,
		open: async (spooled, docBytes = 0) =>
			spooled ? blogSite({ docBytes }) : blogSite({ spool: false, docBytes })
	},
	{
		name: 'homepage',
		views: ['/', '/news', '/news/story-01', '/events', '/events/event-01', '/departments'],
		writes: false,
		open: async (spooled, docBytes = 0) =>
			spooled ? homepageSite({ docBytes }) : homepageSite({ spool: false, docBytes })
	},
	{
		name: 'dashboard',
		views: ['/me', '/projects/site', '/projects/app', '/tasks', '/tasks/t1', '/tasks/t4'],
		writes: true,
		open: async (spooled, docBytes = 0) =>
			spooled ? dashboardSite({ docBytes }) : dashboardSite({ spool: false, docBytes })
	}
];

export const SITE_NAMES = SITES.map((site) => site.name);
export const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[];
export const CHECKPOINTS = [1, 2, 3, 10, 100];

/** the dwell between document navigations; WebKit needs 1.5 s or it coalesces its script check */
export function dwellMs(engine: string): number {
	return engine === 'webkit' ? 1500 : 0;
}

export type Options = {
	dryRun: boolean;
	views: number[];
	engines: EngineName[];
	sites: string[];
	port: number;
	work: string;
	measurements: string;
	date: string;
	docBytes: number;
	/** a suffix for the reading's file name, so a padded and an unpadded run can share a date */
	experiment?: string;
	/** the reading's machine name; the platform label when unset */
	machine?: string;
	trace?: string;
};

/** the command line as options; throws on a value the rig cannot run */
export function parseOptions(argv: readonly string[]): Options {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			'dry-run': { type: 'boolean', default: false },
			views: { type: 'string', default: CHECKPOINTS.join(',') },
			engines: { type: 'string', default: ENGINE_NAMES.join(',') },
			sites: { type: 'string', default: SITE_NAMES.join(',') },
			port: { type: 'string', default: '4500' },
			work: { type: 'string' },
			measurements: { type: 'string' },
			date: { type: 'string' },
			'doc-bytes': { type: 'string', default: '0' },
			experiment: { type: 'string' },
			machine: { type: 'string' },
			trace: { type: 'string' }
		},
		strict: true
	});
	const views = (values.views ?? '').split(',').map(Number);
	const ascending = views.every(
		(n, i) => Number.isInteger(n) && n >= 1 && (i === 0 || n > (views[i - 1] ?? 0))
	);
	if (!ascending)
		throw new Error(`--views must be ascending positive integers, got ${values.views}`);
	const engines = (values.engines ?? '').split(',') as EngineName[];
	const badEngine = engines.find((name) => !ENGINE_NAMES.includes(name));
	if (badEngine)
		throw new Error(`unknown engine ${badEngine}; one of ${ENGINE_NAMES.join(', ')}`);
	const sites = (values.sites ?? '').split(',');
	const badSite = sites.find((name) => !SITE_NAMES.includes(name));
	if (badSite) throw new Error(`unknown site ${badSite}; one of ${SITE_NAMES.join(', ')}`);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 1024 || port > 65533) {
		throw new Error(`--port must leave room for port + 1, got ${values.port}`);
	}
	const date = values.date ?? utcDate();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
		throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
	const docBytes = Number(values['doc-bytes']);
	if (!Number.isInteger(docBytes) || (docBytes !== 0 && docBytes < LAYOUT_TAGS_BYTES)) {
		throw new Error(
			`--doc-bytes must be 0 or at least ${LAYOUT_TAGS_BYTES}, got ${values['doc-bytes']}`
		);
	}
	if (values.experiment !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.experiment)) {
		throw new Error(
			`--experiment must be lowercase words joined by dashes, got ${values.experiment}`
		);
	}
	return {
		dryRun: values['dry-run'] ?? false,
		views,
		engines,
		sites,
		port,
		work: values.work ?? join(ROOT, 'node_modules', '.cache', 'spool-examples'),
		measurements: values.measurements ?? MEASUREMENTS_DIR,
		date,
		docBytes,
		experiment: values.experiment,
		machine: values.machine,
		trace: values.trace
	};
}

/** the runs and outputs a set of options will produce, without starting anything */
export function planFor(options: Options) {
	const sites = SITES.filter((site) => options.sites.includes(site.name));
	const runs = sites.flatMap((site) =>
		ARMS.flatMap((arm) =>
			options.engines.map((engine) => ({
				site: site.name,
				arm,
				engine,
				views: options.views.at(-1)
			}))
		)
	);
	return {
		runs,
		// the worker entries do not take the padding, so a padded run skips them
		workerRuns:
			options.docBytes === 0
				? sites.map((site) => ({
						site: site.name,
						engine: WORKER_ENGINE,
						views: WORKER_VIEWS,
						port: options.port + 1
					}))
				: [],
		views: options.views,
		doc_bytes: options.docBytes,
		dwell_ms: Object.fromEntries(options.engines.map((name) => [name, dwellMs(name)])),
		draft: join(options.work, `examples-${options.date}.json`),
		reading: join(
			options.measurements,
			measurementPath({ rig: 'examples', date: options.date }, options.experiment)
		)
	};
}

/** the site with its counters: requests that reach the handler, origin calls and response bytes */
export async function startArm(site: SiteSpec, arm: Arm, port: number, docBytes = 0) {
	const origin = await site.open(arm === 'spool', docBytes);
	const counts = { requests: 0, origin: 0, bytes: 0, lines: [] as Line[] };
	const fromOrigin = new WeakSet<Request>();
	const page = async (request: Request): Promise<Response> => {
		counts.origin += 1;
		fromOrigin.add(request);
		return origin.page(request);
	};
	const spool = origin.spool;
	const answer = spool ? (request: Request) => spool.handle(request, page) : page;
	const handler = async (request: Request): Promise<Response> => {
		counts.requests += 1;
		const response = await answer(request);
		const body = new Uint8Array(await response.arrayBuffer());
		counts.bytes += body.length;
		const url = new URL(request.url);
		counts.lines.push({
			method: request.method,
			path: url.pathname + url.search,
			status: response.status,
			bytes: body.length,
			origin: fromOrigin.has(request),
			dest: request.headers.get('sec-fetch-dest')
		});
		const nullBody = response.status === 204 || response.status === 304;
		return new Response(nullBody ? null : body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	};
	const server = createServer(toNodeListener(handler));
	await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
	return { server, counts };
}

/** the counting proxy in front of a wrangler dev process: one forwarded request is one worker invocation */
export function countingProxy(port: number, target: string) {
	const counts = { requests: 0, invocations: 0, bytes: 0 };
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		counts.requests += 1;
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
		counts.invocations += 1;
		counts.bytes += sent.length;
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
	return { server, counts };
}

/** one browser visit to a site through `base`: a document every sixth view, a click otherwise, with the counters read at each checkpoint */
export async function visit(input: {
	site: SiteSpec;
	engine: Engine;
	base: string;
	profile: string;
	views: number;
	checkpoints: readonly number[];
	counters: () => Record<string, number>;
	runtime: string;
	arm: string;
	/** the node listener's request lines so far; read only when a trace is written */
	lines?: () => Line[];
	/** one entry per action: the node lines and browser requests it caused */
	trace?: (entry: Row) => void;
}): Promise<Row[]> {
	const context: BrowserContext = await input.engine.launchPersistentContext(input.profile, {
		headless: true
	});
	let browserRequests = 0;
	let scriptRequests = 0;
	let offPath = 0;
	const visited: string[] = [];
	const browserLog: Row[] = [];
	context.on('request', (request) => {
		browserRequests += 1;
		if (!input.trace) return;
		const url = new URL(request.url());
		browserLog.push({
			method: request.method(),
			path: url.pathname + url.search,
			type: request.resourceType(),
			service_worker: request.serviceWorker() !== null
		});
	});
	const rows: Row[] = [];
	const mark = () => ({ lines: input.lines?.().length ?? 0, browser: browserLog.length });
	const emit = (
		action: string,
		view: number,
		path: string,
		from: ReturnType<typeof mark>,
		controlled: boolean | null,
		extra: Row = {}
	) =>
		input.trace?.({
			runtime: input.runtime,
			site: input.site.name,
			arm: input.arm,
			engine: input.engine.name(),
			action,
			view,
			path,
			controlled,
			...extra,
			node: (input.lines?.() ?? []).slice(from.lines),
			browser: browserLog.slice(from.browser)
		});
	try {
		if (input.site.writes) {
			const from = mark();
			await context.request.post(`${input.base}/login?as=ada`);
			scriptRequests += 1;
			emit('login', 0, '/login?as=ada', from, null);
		}
		const page = context.pages()[0] ?? (await context.newPage());
		for (let view = 1; view <= input.views; view += 1) {
			const start = input.site.views[(view - 1) % input.site.views.length] ?? '/';
			const from = mark();
			let target = start;
			let kind: 'document' | 'click' | 'fallback' = 'document';
			let offered = 0;
			if (view === 1 || isDocumentView(view, DOCUMENT_EVERY)) {
				await page.goto(input.base + start, { waitUntil: 'load' });
			} else {
				await page.waitForTimeout(CLICK_GAP_MS);
				const picked = await clickOffered(page, `${input.site.name}:${view}`);
				if (picked) {
					target = picked.href;
					kind = 'click';
					offered = picked.count;
				} else {
					kind = 'fallback';
					await clickHref(page, start);
				}
			}
			const settled = await settleOn(page, target);
			if (!settled) offPath += 1;
			visited.push(target);
			await page.waitForLoadState('networkidle');
			if (input.trace) {
				const controlled = await page.evaluate(
					() => navigator.serviceWorker.controller !== null
				);
				emit('view', view, target, from, controlled, {
					kind,
					offered,
					settled
				});
			}
			if (input.site.writes && view % 2 === 0) {
				const writeFrom = mark();
				const status = view % 4 === 0 ? 'doing' : 'todo';
				await context.request.patch(`${input.base}/tasks/t2`, { data: { status } });
				scriptRequests += 1;
				emit('write', view, '/tasks/t2', writeFrom, null);
			}
			if (input.checkpoints.includes(view)) {
				rows.push({
					runtime: input.runtime,
					site: input.site.name,
					arm: input.arm,
					engine: input.engine.name(),
					views: view,
					...input.counters(),
					browser_requests: browserRequests,
					script_requests: scriptRequests,
					off_path: offPath,
					path_digest: fnv1a(visited.join('\n'))
				});
			}
			await page.waitForTimeout(dwellMs(input.engine.name()));
		}
		return rows;
	} finally {
		await context.close();
	}
}

/** one site, one arm, one engine: a fresh origin, a fresh server and a fresh profile */
export async function measureArm(
	site: SiteSpec,
	arm: Arm,
	engine: Engine,
	options: {
		port: number;
		profile: string;
		views: number;
		checkpoints: readonly number[];
		docBytes: number;
		trace?: (entry: Row) => void;
	}
): Promise<Row[]> {
	const { server, counts } = await startArm(site, arm, options.port, options.docBytes);
	try {
		return await visit({
			site,
			engine,
			base: `http://127.0.0.1:${options.port}`,
			profile: options.profile,
			views: options.views,
			checkpoints: options.checkpoints,
			lines: () => counts.lines,
			trace: options.trace,
			counters: () => ({
				server_requests: counts.requests,
				origin_calls: counts.origin,
				server_bytes: counts.bytes
			}),
			runtime: 'node',
			arm
		});
	} finally {
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
}

async function waitForWorker(port: number, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 120_000;
	let lastError = 'not started';
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}`);
		try {
			await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
			return;
		} catch (error) {
			lastError = (error as Error).message;
			await new Promise((done) => setTimeout(done, 500));
		}
	}
	throw new Error(`wrangler dev did not answer on ${port}: ${lastError}`);
}

/** one site's cloudflare-worker example under wrangler dev --local, behind a counting proxy */
export async function workerRun(site: SiteSpec, port: number, profile: string): Promise<Row[]> {
	const cwd = join(ROOT, 'examples', site.name, 'cloudflare-worker');
	const child = spawn(
		join(ROOT, 'node_modules', '.bin', 'wrangler'),
		['dev', '--local', '--ip', '127.0.0.1', '--port', String(port + 1)],
		{
			cwd,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
			stdio: 'ignore'
		}
	);
	try {
		await waitForWorker(port + 1, child);
		const proxy = countingProxy(port, `http://127.0.0.1:${port + 1}`);
		await new Promise<void>((done) => proxy.server.listen(port, '127.0.0.1', done));
		try {
			return await visit({
				site,
				engine: ENGINES[WORKER_ENGINE],
				base: `http://127.0.0.1:${port}`,
				profile,
				views: WORKER_VIEWS,
				checkpoints: [WORKER_VIEWS],
				counters: () => ({
					server_requests: proxy.counts.requests,
					worker_invocations: proxy.counts.invocations,
					server_bytes: proxy.counts.bytes
				}),
				runtime: 'cloudflare-worker',
				arm: 'spool'
			});
		} finally {
			proxy.server.closeAllConnections();
			await new Promise((done) => proxy.server.close(done));
		}
	} finally {
		child.kill('SIGINT');
	}
}

/** a sink that appends each action as one JSON line to a fresh file; undefined when no path was given */
function traceSink(path: string | undefined): ((entry: Row) => void) | undefined {
	if (path === undefined) return undefined;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, '');
	return (entry) => appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function versionOf(path: string): string {
	return JSON.parse(readFileSync(join(ROOT, path), 'utf8')).version as string;
}

async function engineVersions(names: readonly EngineName[]): Promise<Record<string, string>> {
	const versions: Record<string, string> = {};
	for (const name of names) {
		const browser = await ENGINES[name].launch();
		versions[name] = browser.version();
		await browser.close();
	}
	return versions;
}

async function main(argv: string[]): Promise<void> {
	const options = parseOptions(argv);
	const plan = planFor(options);
	if (options.dryRun) {
		console.log(JSON.stringify(plan, null, '\t'));
		return;
	}
	mkdirSync(options.work, { recursive: true });
	const sites = SITES.filter((site) => options.sites.includes(site.name));
	const rows: Row[] = [];
	const trace = traceSink(options.trace);
	let run = 0;
	for (const site of sites) {
		for (const arm of ARMS) {
			for (const name of options.engines) {
				run += 1;
				const profile = join(
					options.work,
					'profiles',
					`${options.date}-${run}-${site.name}-${arm}-${name}`
				);
				rows.push(
					...(await measureArm(site, arm, ENGINES[name], {
						port: options.port,
						profile,
						views: options.views.at(-1) ?? 1,
						checkpoints: options.views,
						docBytes: options.docBytes,
						trace
					}))
				);
			}
		}
	}
	// the worker entries take no padding, so a padded run skips them (planFor lists none)
	for (const site of options.docBytes === 0 ? sites : []) {
		run += 1;
		const profile = join(
			options.work,
			'profiles',
			`${options.date}-${run}-${site.name}-worker`
		);
		rows.push(...(await workerRun(site, options.port, profile)));
	}
	const draft: Draft = {
		rig: 'examples',
		date: options.date,
		layer: 'L1',
		question:
			'requests, origin calls and response bytes of the same visit script with spool and with no spool, per example site',
		instrument:
			'a counting wrapper around each node listener handler; a counting proxy in front of wrangler dev --local; Playwright persistent contexts',
		machine: localMachine(options.machine),
		software: {
			node: process.version,
			spool: versionOf('package.json'),
			'@playwright/test': versionOf('node_modules/@playwright/test/package.json'),
			wrangler: versionOf('node_modules/wrangler/package.json'),
			...(await engineVersions(options.engines))
		},
		method: {
			sites: sites.map((site) => site.name),
			arms: ARMS,
			engines: options.engines,
			views: options.views,
			checkpoints: options.views,
			dwell_ms: plan.dwell_ms,
			click_gap_ms: CLICK_GAP_MS,
			document_every: DOCUMENT_EVERY,
			reader: 'view 1 and every sixth view open a typed path with page.goto; other views click one same-origin link the page offers, chosen by an FNV-1a hash of site and view; a page with no link takes a synthetic anchor to the typed path',
			loopback_port: options.port,
			worker:
				options.docBytes === 0 ? { engine: WORKER_ENGINE, views: WORKER_VIEWS } : 'skipped',
			visits: Object.fromEntries(sites.map((site) => [site.name, site.views])),
			doc_bytes: options.docBytes,
			design:
				options.docBytes === 0
					? 'unpadded: each site serves its pages as built'
					: `padded: a hidden block of ${options.docBytes} bytes in the page layout of every site page, in both arms and in each template; the rows are unchanged; the worker entries take no padding, so their runs are skipped`
		},
		exclusions: [
			'a run that throws stops the rig and writes no reading; the draft stays in the work folder',
			'the worker counts forwarded requests; origin calls are not counted inside a worker',
			'off_path counts views whose location did not reach the target path; a reading with off_path above 0 has a view the reader did not take'
		],
		rows
	};
	const draftPath = join(options.work, `examples-${options.date}.json`);
	writeFileSync(draftPath, serialiseMeasurement(draft));
	console.log(`draft ${draftPath}`);
	console.log(
		`reading ${writeMeasurement(options.measurements, draft, { experiment: options.experiment })}`
	);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
