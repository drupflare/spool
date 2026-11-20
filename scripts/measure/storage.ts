import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { BLOCK_ROWS, buildPack, type BundleRows } from '../../src/protocol/bundle.ts';
import { compileTemplate } from '../../src/protocol/template/compile.ts';
import { interpretTemplate } from '../../src/protocol/template/interpret.ts';
import { measurementProblems } from '../../src/report/measurement.ts';
import { isMain, localMachine, MEASUREMENTS_DIR, utcDate } from './lib.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type EngineName = (typeof ENGINES)[number];
export const TABLE = 'records';
const PAGE_PATH = '/bench/page';
const PACK_PATH = '/spool/pack';
const BUNDLES: Record<string, string> = {
	'/bench/protocol.js': 'src/protocol/index.ts',
	'/bench/pack.js': 'src/sw/pack/store.ts',
	'/bench/client.js': 'src/client/bootstrap.ts'
};
const DEFAULT_ROWS = [1000, 10000, 100000];
const DEFAULT_BUDGET_MS = 120_000;
const ITEM_VIEWS = 200;
const COLD_VIEWS = 20;
const LIST_PASSES = 2;
const ITEM_SOURCE =
	'<!doctype html><html><head><title>{{row.title}}</title></head><body><h1>{{row.title}}</h1><p>{{row.body}}</p></body></html>';
const LIST_SOURCE =
	'<!doctype html><html><head><title>Records</title></head><body><ul>{{#each rows}}<li>{{title}}</li>{{/each}}</ul></body></html>';

export type Options = {
	engines: EngineName[];
	rows: number[];
	budgetMs: number;
	out: string;
	force: boolean;
	dryRun: boolean;
	machine?: string;
};

export type Page = {
	goto(url: string): Promise<unknown>;
	waitForFunction(fn: () => boolean): Promise<unknown>;
	evaluate(fn: (arg: any) => unknown, arg?: unknown): Promise<unknown>;
};
export type Session = { page: Page; close(): Promise<void> };
export type Engine = { version: string; open(profile: string): Promise<Session> };
export type Served = { origin: string; close(): Promise<void> };
export type Seams = {
	engine(name: EngineName): Promise<Engine>;
	serve(fixture: Fixture): Promise<Served>;
};

export type Fixture = {
	count: number;
	pack: Uint8Array<ArrayBuffer>;
	digest: string;
	blocks: number;
	wire: { plain: number; gzip: number; brotli: number };
	keys: string[];
	expected: { items: Map<string, string>; list: string };
};

type Row = Record<string, unknown>;
type Outcome<T> = { value: T } | { error: string } | { timedOut: true };
type PageRig = {
	protocol: {
		compileTemplate(input: { source: string }): unknown;
		interpretTemplate(template: unknown, data: unknown): string;
	};
	pack: { createPackStore(factory: IDBFactory): PageStore };
	client: {
		bootstrap(options: { store: PageStore }): { installed: Promise<void> };
	};
	store?: PageStore;
};
type PageStore = {
	counters: Record<string, number>;
	head(): Promise<{ version: number; partial?: true; tables: string[] } | undefined>;
	recordCounts(): Promise<{ blocks: number; index: number; overlay: number; head: number }>;
	getRow(table: string, key: string): Promise<unknown>;
	scanTable(table: string): Promise<Array<[string, unknown]>>;
};

export function parse(argv: string[], env: Record<string, string | undefined> = {}): Options {
	const { values } = parseArgs({
		args: argv,
		options: {
			out: { type: 'string', default: MEASUREMENTS_DIR },
			machine: { type: 'string' },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	const engines = (env['ENGINES'] ?? ENGINES.join(',')).split(',').map((name) => name.trim());
	for (const name of engines) {
		if (!(ENGINES as readonly string[]).includes(name))
			throw new Error(`unknown engine ${name}`);
	}
	return {
		engines: engines as EngineName[],
		rows: (env['ROWS'] ?? DEFAULT_ROWS.join(','))
			.split(',')
			.map((text) => positive(text, 'ROWS')),
		budgetMs: positive(env['BUDGET_MS'] ?? String(DEFAULT_BUDGET_MS), 'BUDGET_MS'),
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		machine: values.machine
	};
}

function positive(text: string, name: string): number {
	const value = Number(text.trim());
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer, got ${text}`);
	return value;
}

export function planOf(options: Options) {
	const file = join(options.out, 'storage', `${utcDate()}.json`);
	return {
		rig: 'storage',
		engines: options.engines,
		rows: options.rows,
		store: 'createPackStore, one pack per run, installed by the page client bootstrap',
		blockRows: BLOCK_ROWS,
		budgetMs: options.budgetMs,
		itemViews: ITEM_VIEWS,
		coldViews: COLD_VIEWS,
		listPasses: LIST_PASSES,
		out: options.out,
		file,
		fileExists: existsSync(file)
	};
}

function bodyOf(index: number): string {
	const sections = Array.from(
		{ length: 12 },
		(_, j) =>
			`Section ${j + 1} covers workflow ${(index * 37 + j * 13) % 997}, ownership and delivery. `
	);
	return `This record is synthetic. ${sections.join('')}`;
}

/** one record per row, keyed the way the courses site keys its rows, sorted by key */
export function makeRecords(count: number): BundleRows {
	const rows: BundleRows = [];
	for (let i = 0; i < count; i++) {
		const id = String(101 + i);
		rows.push([id, { id, title: `Record ${id}`, body: bodyOf(i) }]);
	}
	return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const fixtures = new Map<number, Promise<Fixture>>();

export function fixtureOf(count: number): Promise<Fixture> {
	let fixture = fixtures.get(count);
	if (!fixture) {
		fixture = buildFixture(count);
		fixtures.set(count, fixture);
	}
	return fixture;
}

async function buildFixture(count: number): Promise<Fixture> {
	const rows = makeRecords(count);
	const { index, bytes } = await buildPack({ version: 1, tables: { [TABLE]: rows } });
	const item = compileTemplate({ source: ITEM_SOURCE });
	const list = compileTemplate({ source: LIST_SOURCE });
	const views = Math.min(ITEM_VIEWS, count);
	const picks = Array.from({ length: views }, (_, k) => Math.floor((k * count) / views));
	const keys: string[] = [];
	const items = new Map<string, string>();
	for (const i of picks) {
		const [key, row] = rows[i] as BundleRows[number];
		keys.push(key);
		items.set(key, interpretTemplate(item, { row }));
	}
	return {
		count,
		pack: bytes,
		digest: index.digest,
		blocks: index.tables[0]?.blocks.length ?? 0,
		wire: {
			plain: bytes.length,
			gzip: gzipSync(bytes, { level: 9 }).length,
			brotli: brotliCompressSync(bytes, {
				params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
			}).length
		},
		keys,
		expected: { items, list: interpretTemplate(list, { rows: rows.map(([, row]) => row) }) }
	};
}

function ringOf(fixture: Fixture) {
	return {
		protocol: 1,
		version: 1,
		digest: fixture.digest,
		routes: [],
		templates: {},
		tables: {},
		complete: false,
		bootstrap: 'first-view',
		worker: 'never',
		pack: { url: PACK_PATH, bytes: fixture.pack.length }
	};
}

export function pageOf(fixture: Fixture): string {
	return (
		'<!doctype html><meta charset="utf-8"><title>storage rig</title>' +
		`<script id="spool-ring" type="application/json">${JSON.stringify(ringOf(fixture))}</script>` +
		'<script type="module">' +
		"import * as protocol from '/bench/protocol.js';" +
		"import * as pack from '/bench/pack.js';" +
		"import * as client from '/bench/client.js';" +
		'window.rig = { protocol, pack, client };' +
		'</script>'
	);
}

// the functions below run in the page; they read everything through their argument and window.rig
export async function installPhase() {
	const rig = (window as unknown as { rig: PageRig }).rig;
	const estimate = async () => (await navigator.storage.estimate()).usage ?? 0;
	const usageBefore = await estimate();
	const store = rig.pack.createPackStore(indexedDB);
	rig.store = store;
	const started = performance.now();
	await rig.client.bootstrap({ store }).installed;
	const bootstrapMs = performance.now() - started;
	const usageAfter = await estimate();
	return {
		bootstrapMs,
		usageBefore,
		usageAfter,
		head: (await store.head()) ?? null,
		recordCounts: await store.recordCounts(),
		userAgent: navigator.userAgent
	};
}

export async function itemsPhase(arg: {
	table: string;
	itemSource: string;
	keys: string[];
	deadline: number;
}) {
	const rig = (window as unknown as { rig: PageRig }).rig;
	const store = rig.store as PageStore;
	const item = rig.protocol.compileTemplate({ source: arg.itemSource });
	const results: Array<{ key: string; lookupMs: number; viewMs: number; html: string | null }> =
		[];
	let timedOut = false;
	for (const key of arg.keys) {
		if (Date.now() > arg.deadline) {
			timedOut = true;
			break;
		}
		const started = performance.now();
		const row = await store.getRow(arg.table, key);
		const looked = performance.now();
		const html = row === undefined ? null : rig.protocol.interpretTemplate(item, { row });
		results.push({
			key,
			lookupMs: looked - started,
			viewMs: performance.now() - started,
			html
		});
	}
	return { results, timedOut };
}

export async function listsPhase(arg: {
	table: string;
	listSource: string;
	passes: number;
	deadline: number;
}) {
	const rig = (window as unknown as { rig: PageRig }).rig;
	const store = rig.store as PageStore;
	const list = rig.protocol.compileTemplate({ source: arg.listSource });
	const results: Array<{ pass: number; ms: number; html: string }> = [];
	let timedOut = false;
	for (let pass = 1; pass <= arg.passes; pass++) {
		if (Date.now() > arg.deadline) {
			timedOut = true;
			break;
		}
		const started = performance.now();
		const rows = await store.scanTable(arg.table);
		const html = rig.protocol.interpretTemplate(list, { rows: rows.map(([, row]) => row) });
		results.push({ pass, ms: performance.now() - started, html });
	}
	return { results, timedOut };
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
function median(xs: number[]): number | null {
	const s = sorted(xs);
	const n = s.length;
	if (!n) return null;
	return n % 2 ? (s[(n - 1) / 2] ?? null) : ((s[n / 2 - 1] ?? 0) + (s[n / 2] ?? 0)) / 2;
}
function nearest(xs: number[], p: number): number | null {
	const s = sorted(xs);
	return s.length ? (s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? null) : null;
}

async function budget<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Outcome<T>>((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true }), ms);
	});
	const settled = promise.then(
		(value): Outcome<T> => ({ value }),
		(error: unknown): Outcome<T> => ({
			error: String((error as Error)?.stack ?? error)
				.split('\n')
				.slice(0, 3)
				.join(' | ')
		})
	);
	try {
		return await Promise.race([settled, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function measureRun(
	engine: Engine,
	name: EngineName,
	fixture: Fixture,
	origin: string,
	budgetMs: number
): Promise<Row> {
	const row: Row = {
		kind: 'store',
		engine: name,
		engineVersion: engine.version,
		rows: fixture.count,
		blocks: fixture.blocks,
		wire: fixture.wire,
		timeouts: [] as string[],
		notes: [] as string[]
	};
	const stop = (phase: string, outcome: Outcome<unknown>) => {
		if ('value' in outcome) return false;
		if ('timedOut' in outcome) {
			(row['timeouts'] as string[]).push(phase);
			(row['notes'] as string[]).push(`${phase} stopped at the ${budgetMs} ms budget`);
		} else {
			row['error'] = outcome.error;
			(row['notes'] as string[]).push(`${phase} failed: ${outcome.error}`);
		}
		return true;
	};
	const profile = await mkdtemp(join(tmpdir(), 'spool-storage-'));
	let session: Session | undefined;
	try {
		session = await engine.open(profile);
		await session.page.goto(origin + PAGE_PATH);
		await session.page.waitForFunction(() => 'rig' in window);
		const install = await budget(session.page.evaluate(installPhase), budgetMs);
		if (stop('install', install)) return row;
		const boot = (install as { value: Awaited<ReturnType<typeof installPhase>> }).value;
		const head = boot.head;
		const installed =
			head !== null &&
			head.version === 1 &&
			head.partial !== true &&
			boot.recordCounts.blocks === fixture.blocks &&
			boot.recordCounts.index === 1;
		const growth = boot.usageAfter - boot.usageBefore;
		Object.assign(row, {
			userAgent: boot.userAgent,
			installed,
			bootstrapMs: boot.bootstrapMs,
			usageBefore: boot.usageBefore,
			usageAfter: boot.usageAfter,
			usageGrowthBytes: growth,
			usageGrowthPerRow: growth / fixture.count
		});
		if (!installed) {
			(row['notes'] as string[]).push(
				'the page client did not install the pack; no views ran'
			);
			return row;
		}

		const itemRun = await budget(
			session.page.evaluate(itemsPhase, {
				table: TABLE,
				itemSource: ITEM_SOURCE,
				keys: fixture.keys,
				deadline: Date.now() + budgetMs
			}),
			budgetMs + 15_000
		);
		const compared: string[] = [];
		const mismatches: string[] = [];
		if (!stop('item views', itemRun)) {
			const { results, timedOut } = (
				itemRun as { value: { results: ItemResult[]; timedOut: boolean } }
			).value;
			for (const r of results) {
				compared.push(r.key);
				if (r.html !== (fixture.expected.items.get(r.key) ?? null)) mismatches.push(r.key);
			}
			const view = results.map((r) => r.viewMs);
			row['items'] = {
				n: results.length,
				viewP50Ms: median(view),
				viewP95Ms: nearest(view, 0.95),
				coldViewP50Ms: median(view.slice(0, COLD_VIEWS)),
				lookupP50Ms: median(results.map((r) => r.lookupMs)),
				timedOut
			};
			if (timedOut) stop('item views', { timedOut: true });
		}

		const listRun = await budget(
			session.page.evaluate(listsPhase, {
				table: TABLE,
				listSource: LIST_SOURCE,
				passes: LIST_PASSES,
				deadline: Date.now() + budgetMs
			}),
			budgetMs + 15_000
		);
		if (!stop('list views', listRun)) {
			const { results, timedOut } = (
				listRun as {
					value: {
						results: Array<{ pass: number; ms: number; html: string }>;
						timedOut: boolean;
					};
				}
			).value;
			for (const r of results) {
				compared.push(`list pass ${r.pass}`);
				if (r.html !== fixture.expected.list) mismatches.push(`list pass ${r.pass}`);
			}
			row['lists'] = {
				n: results.length,
				passMs: results.map((r) => r.ms),
				timedOut
			};
			if (timedOut) stop('list views', { timedOut: true });
		}
		row['compared'] = compared.length;
		row['mismatches'] = mismatches.slice(0, 5);
		row['equal'] = compared.length > 0 ? mismatches.length === 0 : null;
		if (mismatches.length > 0) {
			(row['notes'] as string[]).push(
				`${mismatches.length} rendered pages differ from the Node render`
			);
		}
	} catch (error) {
		row['error'] = String((error as Error)?.stack ?? error)
			.split('\n')
			.slice(0, 3)
			.join(' | ');
		(row['notes'] as string[]).push(`run failed: ${row['error']}`);
	} finally {
		await session?.close().catch(() => undefined);
		await rm(profile, { recursive: true, force: true });
	}
	return row;
}

type ItemResult = { key: string; lookupMs: number; viewMs: number; html: string | null };

export async function runStorage(
	options: Options,
	seams: Seams
): Promise<{ reading: Record<string, unknown>; problems: string[]; failures: number }> {
	const engines = new Map<EngineName, Engine>();
	const rows: Row[] = [];
	for (const count of options.rows) {
		const fixture = await fixtureOf(count);
		const served = await seams.serve(fixture);
		try {
			for (const name of options.engines) {
				let engine = engines.get(name);
				if (!engine) {
					engine = await seams.engine(name);
					engines.set(name, engine);
				}
				rows.push(await measureRun(engine, name, fixture, served.origin, options.budgetMs));
			}
		} finally {
			await served.close();
		}
	}
	const playwright = JSON.parse(
		readFileSync(join(ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')
	) as { version: string };
	const reading = {
		schema: 1,
		rig: 'storage',
		date: utcDate(),
		layer: 'L1',
		question:
			'for the library pack at each row count and in each engine: wire bytes (plain, gzip, brotli), bootstrap time through the page client, navigator.storage.estimate() growth, item-view and list-view time through createPackStore, and whether every rendered page equals a Node render over the same rows',
		instrument:
			'Playwright persistent contexts with a fresh profile per run, running the bundled createPackStore, client bootstrap and template interpreter; view times are performance.now deltas in the page; node:zlib gzip (level 9) and brotli (quality 11) of the pack bytes',
		machine: localMachine(options.machine),
		software: {
			runtime: process.versions.bun
				? `bun ${process.versions.bun}`
				: `node ${process.version}`,
			playwright: playwright.version,
			cpu: cpus()[0]?.model ?? 'unknown'
		},
		method: {
			engines: options.engines,
			rows: options.rows,
			blockRows: BLOCK_ROWS,
			budgetMs: options.budgetMs,
			itemViews: ITEM_VIEWS,
			coldViews: COLD_VIEWS,
			listPasses: LIST_PASSES,
			record: 'one row per key: { id, title, body }, keys from the courses site (String(101 + i)), body about 0.8 kB as in the v1 scratch model',
			install:
				'a partial ring with no tables and one pack url; bootstrap writes the ring, fetches the pack, installs it, and the rig reads the head and record counts',
			items: `${ITEM_VIEWS} keys evenly spaced over the rows; each view is getRow then interpretTemplate of the item template`,
			lists: `scanTable of every row then interpretTemplate of the list template, ${LIST_PASSES} passes`,
			equality:
				'every rendered string equals interpretTemplate in Node over the same sorted rows'
		},
		exclusions: [
			'none; a run that stopped at the budget or failed keeps its row with timeouts or error set'
		],
		rows
	};
	const problems = measurementProblems(reading);
	const failures = rows.filter(
		(r) => r['error'] !== undefined || r['equal'] === false || r['installed'] === false
	).length;
	return { reading, problems, failures };
}

async function playwrightEngine(name: EngineName): Promise<Engine> {
	const playwright = await import('@playwright/test');
	const type = playwright[name];
	const probe = await type.launch({ headless: true });
	const version = probe.version();
	await probe.close();
	return {
		version,
		open: async (profile) => {
			const context = await type.launchPersistentContext(profile, { headless: true });
			const page = await context.newPage();
			return {
				page: {
					goto: (url) => page.goto(url),
					waitForFunction: (fn) => page.waitForFunction(fn),
					evaluate: (fn, arg) => page.evaluate(fn, arg)
				},
				close: () => context.close()
			};
		}
	};
}

let bundles: Record<string, string> | undefined;
function buildBundles(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, entry] of Object.entries(BUNDLES)) {
		const built = spawnSync(
			process.execPath,
			['build', join(ROOT, entry), '--target', 'browser', '--format', 'esm'],
			{
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024
			}
		);
		if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
		out[path] = built.stdout;
	}
	return out;
}

function send(response: ServerResponse, type: string, body: string | Uint8Array) {
	response.setHeader('content-type', type);
	response.setHeader('cache-control', 'no-store');
	response.end(body);
}

function serveFixture(fixture: Fixture, files: Record<string, string>): Promise<Served> {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (pathname === PAGE_PATH)
			return send(response, 'text/html; charset=utf-8', pageOf(fixture));
		if (pathname === PACK_PATH) return send(response, 'application/octet-stream', fixture.pack);
		const script = files[pathname];
		if (script !== undefined) return send(response, 'text/javascript; charset=utf-8', script);
		response.statusCode = 404;
		response.end('not found');
	});
	return new Promise((resolveServe) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolveServe({
				origin: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					})
			});
		});
	});
}

export function realSeams(): Seams {
	return {
		engine: playwrightEngine,
		serve: (fixture) => {
			bundles ??= buildBundles();
			return serveFixture(fixture, bundles);
		}
	};
}

if (isMain(import.meta.url)) {
	const options = parse(process.argv.slice(2), process.env);
	if (options.dryRun) {
		console.log(JSON.stringify(planOf(options), null, 2));
	} else {
		const { reading, problems, failures } = await runStorage(options, realSeams());
		console.log(JSON.stringify(reading, null, '\t'));
		if (problems.length > 0) {
			console.error(`schema-1 reader refused the reading: ${problems.join('; ')}`);
		}
		if (problems.length === 0 && failures === 0) {
			const dir = join(options.out, 'storage');
			const path = join(dir, `${reading['date']}.json`);
			if (existsSync(path) && !options.force)
				throw new Error(`${path} exists; pass --force to replace it`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(path, `${JSON.stringify(reading, null, '\t')}\n`);
			console.error(`wrote ${path}`);
		}
		process.exitCode = problems.length > 0 || failures > 0 ? 1 : 0;
	}
}
