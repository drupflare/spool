import { fileStaticSink } from '@drupflare/spool/node';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { courseSpool } from '../examples/courses/shared/site';
import { staticSite } from '../examples/static/shared/site';
import { GATE_ATTR } from '../src/protocol/tag';

// each Worker example names a page it serves: the campus and dashboard roots answer 404
const WORKERS = [
	{ dir: 'examples/courses/cloudflare-worker', page: '/courses' },
	{ dir: 'examples/campus/cloudflare-worker', page: '/courses' },
	{ dir: 'examples/blog/cloudflare-worker', page: '/' },
	{ dir: 'examples/homepage/cloudflare-worker', page: '/' },
	{ dir: 'examples/dashboard/cloudflare-worker', page: '/projects/site' }
];

// the framework rows build, then start the built server; `install` is printed when node_modules is missing
const FRAMEWORKS = [
	{
		dir: 'examples/dashboard/nuxt',
		build: ['nuxt', 'build'],
		start: ['.output/server/index.mjs'],
		install: 'bun install --force --ignore-scripts',
		writes: true
	},
	{
		dir: 'examples/dashboard/next',
		build: ['next', 'build'],
		start: ['server.ts'],
		install: 'bun install --force --ignore-scripts',
		writes: true
	},
	{
		dir: 'examples/homepage/nuxt',
		build: ['nuxt', 'build'],
		start: ['.output/server/index.mjs'],
		install: 'npm install',
		writes: false
	},
	{
		dir: 'examples/homepage/next',
		build: ['next', 'build'],
		start: ['server.ts'],
		install: 'npm install',
		writes: false
	}
];

// the static tiers of a framework build; the spool files sit in the build output
const STATIC_FRAMEWORKS = [
	{
		dir: 'examples/static/vite-vue',
		publishFirst: false,
		build: ['vite', 'build'],
		start: ['server.ts'],
		out: 'dist',
		bundle: '/.spool/bundle/0'
	},
	{
		dir: 'examples/static/nuxt',
		publishFirst: true,
		build: ['nuxt', 'build'],
		start: ['.output/server/index.mjs'],
		out: '.output/public',
		bundle: '/.spool/bundle/0'
	}
];

const PAGES = 'examples/courses/cloudflare-pages';
const STATIC = 'examples/static/cloudflare-worker';
const SHARED = 'examples/courses/shared';
const BUNDLE = '/.spool/bundle/1';
const CLIENT = '/.spool/1.0.0/client.js';
const WORKER_SCRIPT = '/spool-sw.js';
const GATE_OR_RING = new RegExp(`${GATE_ATTR}|spool-ring`);
const READY_MS = 90_000;
const BUILD_MS = 600_000;

type Probe = { name: string; ok: boolean };
type Row = {
	example: string;
	port?: number;
	probes: Probe[];
	skip?: string;
	error?: string;
};

const root = join(import.meta.dir, '..');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

function get(url: string, init?: RequestInit): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

async function statusOf(url: string, init?: RequestInit): Promise<number> {
	const response = await get(url, init);
	await response.arrayBuffer();
	return response.status;
}

async function waitForAnswer(child: ChildProcess, url: string, log: () => string): Promise<void> {
	const until = Date.now() + READY_MS;
	while (Date.now() < until) {
		if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log()}`);
		try {
			await get(url);
			return;
		} catch {
			await Bun.sleep(500);
		}
	}
	throw new Error(`no answer from ${url} within ${READY_MS} ms\n${log()}`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
	if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	process.kill(-child.pid, 'SIGTERM');
	await exited;
}

function serve(
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string> }
): { child: ChildProcess; output: () => string } {
	let output = '';
	const collect = (chunk: Buffer) => {
		output += chunk.toString();
	};
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout?.on('data', collect);
	child.stderr?.on('data', collect);
	return { child, output: () => output };
}

// the spool paths every held page answers, whatever runs the example
async function spoolProbes(base: string, page: string): Promise<Probe[]> {
	const home = await get(base + page);
	const html = await home.text();
	return [
		{
			name: `${page} ${home.status} with the gate or ring`,
			ok: home.status === 200 && GATE_OR_RING.test(html)
		},
		{ name: `${CLIENT} 200`, ok: (await statusOf(base + CLIENT)) === 200 },
		{ name: `${WORKER_SCRIPT} 200`, ok: (await statusOf(base + WORKER_SCRIPT)) === 200 },
		{
			name: '/.spool/artifact without have 400',
			ok: (await statusOf(`${base}/.spool/artifact`)) === 400
		}
	];
}

async function writeProbe(base: string): Promise<Probe[]> {
	const title = `smoke ${Date.now()}`;
	const created = await get(`${base}/tasks`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: 'user=ada' },
		body: JSON.stringify({ project: 'site', title, due: '2999-12-05' })
	});
	await created.arrayBuffer();
	const list = await get(`${base}/tasks`);
	const listed = await list.text();
	return [
		{
			name: 'POST /tasks as ada 201 with Spool-Delta',
			ok: created.status === 201 && created.headers.has('spool-delta')
		},
		{ name: 'GET /tasks lists the new row', ok: list.status === 200 && listed.includes(title) }
	];
}

async function workerRow(example: (typeof WORKERS)[number]): Promise<Row> {
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const row: Row = { example: example.dir, port, probes: [] };
	const { child, output } = serve(
		wrangler,
		['dev', '--local', '--ip', '127.0.0.1', '--port', String(port)],
		{ cwd: join(root, example.dir), env: { WRANGLER_SEND_METRICS: 'false' } }
	);
	try {
		await waitForAnswer(child, base + example.page, output);
		const page = await get(base + example.page);
		const bundle = await get(base + BUNDLE);
		row.probes.push(
			{ name: `${example.page} ${page.status}`, ok: page.status === 200 },
			{ name: `${BUNDLE} ${bundle.status}`, ok: bundle.status === 200 }
		);
	} catch (error) {
		row.error = (error as Error).message;
	} finally {
		await stop(child);
	}
	return row;
}

async function frameworkRow(example: (typeof FRAMEWORKS)[number]): Promise<Row> {
	const row: Row = { example: example.dir, probes: [] };
	const dir = join(root, example.dir);
	if (!existsSync(join(dir, 'node_modules'))) {
		row.skip = `no node_modules; run: cd ${example.dir} && ${example.install}`;
		return row;
	}
	const built = spawnSync('npx', example.build, {
		cwd: dir,
		encoding: 'utf8',
		timeout: BUILD_MS
	});
	if (built.status !== 0) {
		row.error = `npx ${example.build.join(' ')} exit ${built.status}\n${(built.stdout + built.stderr).slice(-2000)}`;
		return row;
	}
	const port = await freePort();
	row.port = port;
	const base = `http://127.0.0.1:${port}`;
	const { child, output } = serve('node', example.start, {
		cwd: dir,
		env: { PORT: String(port) }
	});
	try {
		await waitForAnswer(child, `${base}/`, output);
		row.probes.push(...(await spoolProbes(base, '/')));
		if (example.writes) row.probes.push(...(await writeProbe(base)));
	} catch (error) {
		row.error = (error as Error).message;
	} finally {
		await stop(child);
	}
	return row;
}

// the stub a static framework's spool would serve, built in this process from the same site code
async function staticStub(dir: string): Promise<string> {
	if (dir.endsWith('vite-vue')) {
		const { appSpool, ORIGIN } = await import('../examples/static/vite-vue/server/spool.ts');
		const shell = readFileSync(join(root, dir, 'dist', 'index.html'), 'utf8');
		const spool = appSpool(shell);
		await spool.publish(new URL(ORIGIN));
		return (await spool.stub()).text();
	}
	const { default: spool } = await import('../examples/static/nuxt/server/spool.ts');
	return (await spool.stub()).text();
}

async function staticFrameworkRow(example: (typeof STATIC_FRAMEWORKS)[number]): Promise<Row> {
	const row: Row = { example: example.dir, probes: [] };
	const dir = join(root, example.dir);
	if (!existsSync(join(dir, 'node_modules'))) {
		row.skip = `no node_modules; run: cd ${example.dir} && bun install --force --ignore-scripts`;
		return row;
	}
	const publish: [string, string[]] = ['node', ['publish.ts']];
	const build: [string, string[]] = ['npx', example.build];
	const steps = example.publishFirst ? [publish, build] : [build, publish];
	for (const [command, args] of steps) {
		const result = spawnSync(command, args, { cwd: dir, encoding: 'utf8', timeout: BUILD_MS });
		if (result.status !== 0) {
			row.error = `${command} ${args.join(' ')} exit ${result.status}\n${(result.stdout + result.stderr).slice(-2000)}`;
			return row;
		}
	}
	const port = await freePort();
	row.port = port;
	const base = `http://127.0.0.1:${port}`;
	const { child, output } = serve('node', example.start, {
		cwd: dir,
		env: { PORT: String(port) }
	});
	try {
		await waitForAnswer(child, `${base}/`, output);
		row.probes.push(...(await spoolProbes(base, '/')));
		row.probes.push({
			name: `${example.bundle} 200`,
			ok: (await statusOf(base + example.bundle)) === 200
		});
		const served = await (await get(base + WORKER_SCRIPT)).text();
		const file = readFileSync(join(dir, example.out, 'spool-sw.js'), 'utf8');
		row.probes.push({ name: 'the served stub equals the published file', ok: served === file });
		row.probes.push({
			name: 'the served stub equals spool.stub() for the same stamp',
			ok: served === (await staticStub(example.dir))
		});
	} catch (error) {
		row.error = (error as Error).message;
	} finally {
		await stop(child);
	}
	return row;
}

// the course pages are static files behind the Pages function, so the script writes the origin page of /courses
async function pagesRow(): Promise<Row> {
	const row: Row = { example: PAGES, probes: [] };
	const scratch = mkdtempSync(join(tmpdir(), 'spool-pages-'));
	const link = join(scratch, 'node_modules', '@drupflare', 'spool');
	let linked = false;
	let child: ChildProcess | undefined;
	try {
		mkdirSync(join(scratch, 'functions'));
		copyFileSync(
			join(root, PAGES, 'cloudflare-pages.ts'),
			join(scratch, 'functions', '[[path]].ts')
		);
		cpSync(join(root, SHARED), join(scratch, 'shared'), { recursive: true });
		mkdirSync(join(scratch, 'node_modules', '@drupflare'), { recursive: true });
		symlinkSync(root, link, 'dir');
		linked = true;
		const build = join(scratch, 'build');
		mkdirSync(build);
		const { page } = await courseSpool();
		const origin = await page(new Request('https://site.test/courses'));
		writeFileSync(join(build, 'courses.html'), await origin.text());

		const port = await freePort();
		row.port = port;
		const base = `http://127.0.0.1:${port}`;
		const served = serve(
			wrangler,
			['pages', 'dev', build, '--ip', '127.0.0.1', '--port', String(port)],
			{ cwd: scratch, env: { WRANGLER_SEND_METRICS: 'false' } }
		);
		child = served.child;
		await waitForAnswer(child, `${base}/courses`, served.output);
		row.probes.push(...(await spoolProbes(base, '/courses')));
		row.probes.push({
			name: `${BUNDLE} 200`,
			ok: (await statusOf(base + BUNDLE)) === 200
		});
	} catch (error) {
		row.error = (error as Error).message;
	} finally {
		await stop(child);
		if (linked) unlinkSync(link);
		rmSync(scratch, { recursive: true, force: true });
	}
	return row;
}

// the stub, the runtime and the pack come from the assets; the count entry marks what the Worker answered
async function staticRow(): Promise<Row> {
	const row: Row = { example: STATIC, probes: [] };
	const dir = join(root, STATIC);
	const site = await staticSite();
	await site.publish(fileStaticSink(join(dir, 'public')));
	const port = await freePort();
	row.port = port;
	const base = `http://127.0.0.1:${port}`;
	const { child, output } = serve(
		wrangler,
		[
			'dev',
			'-c',
			'wrangler.count.jsonc',
			'--local',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port)
		],
		{ cwd: dir, env: { WRANGLER_SEND_METRICS: 'false' } }
	);
	try {
		await waitForAnswer(child, `${base}/`, output);
		const from = async (path: string, worker: boolean): Promise<Probe> => {
			const response = await get(base + path);
			await response.arrayBuffer();
			const marked = response.headers.has('x-worker-invoked');
			return {
				name: `${path} ${response.status} from the ${worker ? 'Worker' : 'assets'}`,
				ok: response.status === 200 && marked === worker
			};
		};
		row.probes.push(
			await from('/', true),
			await from(WORKER_SCRIPT, false),
			await from(CLIENT, false),
			await from(BUNDLE, false)
		);
		const served = await (await get(base + WORKER_SCRIPT)).text();
		row.probes.push({
			name: 'the stub bytes equal spool.stub() for the same stamp',
			ok: served === (await (await site.spool.stub()).text())
		});
	} catch (error) {
		row.error = (error as Error).message;
	} finally {
		await stop(child);
	}
	return row;
}

if (!existsSync(join(root, 'dist', 'index.js'))) {
	console.error('dist/index.js is missing; run bun run build first');
	process.exit(1);
}

const rows: Row[] = [];
for (const example of WORKERS) rows.push(await workerRow(example));
rows.push(await pagesRow());
rows.push(await staticRow());
for (const example of FRAMEWORKS) rows.push(await frameworkRow(example));
for (const example of STATIC_FRAMEWORKS) rows.push(await staticFrameworkRow(example));

const passed = (row: Row) => row.probes.filter((probe) => probe.ok).length;
const failedRows = rows.filter(
	(row) => !row.skip && (row.error || passed(row) < row.probes.length)
);
const skipped = rows.filter((row) => row.skip);

console.log('');
console.log(['example', 'port', 'probes', 'result'].map((cell) => cell.padEnd(34)).join(''));
for (const row of rows) {
	const result = row.skip
		? 'SKIP'
		: row.error || passed(row) < row.probes.length
			? 'FAIL'
			: 'pass';
	const cells = [
		row.example,
		row.port === undefined ? '-' : String(row.port),
		row.skip ? '-' : `${passed(row)}/${row.probes.length}`,
		result
	];
	console.log(cells.map((cell) => cell.padEnd(34)).join(''));
}
for (const row of rows) {
	for (const probe of row.probes) {
		if (!probe.ok) console.log(`FAIL ${row.example}: ${probe.name}`);
	}
	if (row.error) console.log(`FAIL ${row.example}: ${row.error}`);
	if (row.skip) console.log(`SKIP ${row.example}: ${row.skip}`);
}

if (skipped.length > 0) {
	console.log(`SKIPPED ${skipped.length} of ${rows.length} examples; their checks did not run`);
}
console.log(
	failedRows.length === 0
		? `all ${rows.length - skipped.length} checked examples answer`
		: `${failedRows.length} failed`
);
process.exit(failedRows.length === 0 ? 0 : 1);
