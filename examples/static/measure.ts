import { fileStaticSink, toNodeListener } from '@drupflare/spool/node';
import { memoryStaticSink } from '@drupflare/spool/server';
import { chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { clickLink, linksOn, settleOn } from '../../scripts/measure/reader.ts';
import { handle, staticFiles } from './node/server.ts';
import { staticSite } from './shared/site.ts';

/**
 * The visit script behind the Results tables of the static examples. Run it from the repo root:
 * `bun examples/static/measure.ts --runtime node` or `--runtime worker` (the worker folder needs
 * `bun install` and `wrangler`). One Chromium run per arm, serial. Ports 5720 to 5739.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DWELL_MS = 4000;
const CLICKS = 6;
const TIERS = ['static', 'spool', 'page', 'worker'] as const;
type Tier = (typeof TIERS)[number];
type Line = { path: string; tier: Tier; bytes: number; at: number };
type Counts = Record<Tier | 'requests' | 'bytes', number>;

const { values } = parseArgs({
	options: {
		runtime: { type: 'string', default: 'node' },
		lease: { type: 'string', default: '12' },
		arms: { type: 'string', default: 'static,handler,none' },
		control: { type: 'boolean', default: false },
		trace: { type: 'boolean', default: false }
	}
});
const LEASE = Number(values.lease);
const GATED = /^\/(spool-sw\.js|\.spool\/[^/]+\/(client|navigate)\.js|\.spool\/bundle\/)/;

const blank = (): Counts => ({ requests: 0, bytes: 0, static: 0, spool: 0, page: 0, worker: 0 });
const lines: Line[] = [];
let counts = blank();

function note(path: string, tier: Tier, bytes: number) {
	counts.requests += 1;
	counts[tier] += 1;
	counts.bytes += bytes;
	lines.push({ path, tier, bytes, at: Date.now() });
}

function listen(server: Server, port: number) {
	return new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
}

async function bodyOf(response: Response) {
	const body = new Uint8Array(await response.arrayBuffer());
	const empty = response.status === 204 || response.status === 304;
	return { body, out: new Response(empty ? null : body, response) };
}

/** a node arm: the site behind a counting handler, with or without the spool and the files */
async function nodeArm(arm: 'static' | 'handler' | 'none', port: number) {
	const root = mkdtempSync(join(tmpdir(), 'spool-static-'));
	const site = await staticSite({ lease: LEASE });
	const publish = async () => {
		await site.publish(arm === 'static' ? fileStaticSink(root) : memoryStaticSink());
	};
	await publish();
	const files = arm === 'static' ? staticFiles(root) : () => undefined;
	const handler = async (request: Request): Promise<Response> => {
		let tier: Tier = 'spool';
		const served = async (r: Request) => {
			const response = await files(r);
			if (response) tier = 'static';
			return response;
		};
		const origin = (r: Request) => {
			tier = 'page';
			return site.page(r);
		};
		const answer =
			arm === 'none' ? origin(request) : handle(served, site.spool, origin)(request);
		const { body, out } = await bodyOf(await answer);
		const url = new URL(request.url);
		note(url.pathname + url.search, tier, body.length);
		return out;
	};
	const server = createServer(toNodeListener(handler));
	await listen(server, port);
	return {
		base: `http://127.0.0.1:${port}`,
		publish: async () => {
			if (values.control) return; // no entry and no stamp: the stub's bytes stay the same
			await site.addEntry({
				title: 'Added the export command in 2.0',
				area: 'cli',
				date: '2026-01-05',
				body: 'Release 2.0 of the library.'
			});
			await publish();
		},
		stop: async () => {
			server.close();
			rmSync(root, { recursive: true, force: true });
		}
	};
}

/** the worker arm: wrangler dev over a published `public/`, behind a proxy that reads the Worker mark */
async function workerArm(port: number) {
	const dir = join(HERE, 'cloudflare-worker');
	const site = await staticSite({ lease: LEASE });
	const sink = fileStaticSink(join(dir, 'public'));
	await site.publish(sink);
	let output = '';
	const child: ChildProcess = spawn(
		join(dir, 'node_modules', '.bin', 'wrangler'),
		[
			'dev',
			'-c',
			'wrangler.count.jsonc',
			'--local',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port + 1)
		],
		{ cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, detached: true }
	);
	child.stdout?.on('data', (chunk) => (output += chunk));
	child.stderr?.on('data', (chunk) => (output += chunk));
	const target = `http://127.0.0.1:${port + 1}`;
	for (let wait = 0; wait < 90; wait += 1) {
		if (
			await fetch(`${target}/nope`).then(
				() => true,
				() => false
			)
		)
			break;
		await new Promise((done) => setTimeout(done, 500));
	}
	const server = createServer(async (req, res) => {
		const upstream = await fetch(target + (req.url ?? '/'), {
			headers: { accept: String(req.headers.accept ?? '*/*') },
			redirect: 'manual'
		});
		const sent = new Uint8Array(await upstream.arrayBuffer());
		note(
			req.url ?? '/',
			upstream.headers.has('x-worker-invoked') ? 'worker' : 'static',
			sent.length
		);
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
	await listen(server, port);
	return {
		base: `http://127.0.0.1:${port}`,
		// the Worker holds its own data, so a publish here only advances the stamp
		publish: async () => void (await site.publish(sink)),
		stop: async () => {
			server.close();
			if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
			if (output.includes('ERROR')) console.error(output);
		}
	};
}

type Phase = { name: string; counts: Counts };

/** when the stub was last requested, or 0 */
const stubAt = () =>
	Math.max(0, ...lines.filter((line) => line.path === '/spool-sw.js').map((line) => line.at));

async function visit(
	base: string,
	publish: () => Promise<void>,
	spooled: boolean
): Promise<Phase[]> {
	const profile = mkdtempSync(join(tmpdir(), 'spool-static-profile-'));
	const context = await chromium.launchPersistentContext(profile, { headless: true });
	const page: Page = context.pages()[0] ?? (await context.newPage());
	const phases: Phase[] = [];
	const phase = async (name: string, run: () => Promise<void>) => {
		counts = blank();
		await run();
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(DWELL_MS);
		phases.push({ name, counts: { ...counts } });
	};
	const leaseEnds = async (from: number) => {
		await page.waitForTimeout(Math.max(0, from + LEASE * 1000 + 1000 - Date.now()));
	};
	try {
		await phase('first view', async () => void (await page.goto(`${base}/`)));
		await phase(`${CLICKS} in-page clicks`, async () => {
			// the first entry link not seen yet, else an area link: entry, area, entry, area
			const seen = new Set<string>();
			for (let n = 0; n < CLICKS; n += 1) {
				await page.waitForTimeout(150);
				const hrefs = await linksOn(page);
				const target =
					hrefs.find((href) => href.startsWith('/entries/') && !seen.has(href)) ??
					hrefs.find((href) => href.startsWith('/areas?')) ??
					hrefs[0];
				if (target === undefined || !(await clickLink(page, target))) break;
				seen.add(target);
				await settleOn(page, target);
			}
		});
		// the page registers the worker on a document load; the lease runs from that stub request
		// the worker registers on the third typed document view, so one more typed view comes first
		await phase('typed document view before the registration', async () => {
			await page.goto(`${base}/entries/8992`);
		});
		await phase('document view that registers the worker', async () => {
			await page.goto(`${base}/entries/8991`);
		});
		if (spooled && stubAt() === 0)
			throw new Error(
				`the browser never requested the stub; requests seen: ${lines.map((line) => line.path).join(' ')}`
			);
		await phase('document view inside the lease', async () => {
			await page.goto(`${base}/entries/8990`);
		});
		await leaseEnds(stubAt() || Date.now());
		await phase('document view after the lease', async () => {
			await page.goto(`${base}/entries/8985`);
		});
		await publish();
		await leaseEnds(stubAt() || Date.now());
		await phase('next contact after a publish', async () => {
			await page.goto(`${base}/`);
		});
	} finally {
		await context.close();
		rmSync(profile, { recursive: true, force: true });
	}
	return phases;
}

const rows: string[] = [];
let gate = true;
const chosen = values.arms.split(',');
const every =
	values.runtime === 'worker'
		? [{ key: 'worker', name: 'spool, static assets', open: () => workerArm(5730) }]
		: [
				{ key: 'static', name: 'spool, static files', open: () => nodeArm('static', 5720) },
				{
					key: 'handler',
					name: 'spool, files from the handler',
					open: () => nodeArm('handler', 5721)
				},
				{ key: 'none', name: 'no spool', open: () => nodeArm('none', 5722) }
			];
const arms = every.filter((arm) => values.runtime === 'worker' || chosen.includes(arm.key));
for (const arm of arms) {
	lines.length = 0;
	const opened = await arm.open();
	const phases = await visit(opened.base, opened.publish, arm.name !== 'no spool').finally(
		opened.stop
	);
	if (values.trace) {
		for (const line of lines)
			console.log(`${arm.name}: ${line.tier} ${line.path} ${line.bytes}`);
	}
	for (const { name, counts: c } of phases) {
		const tiers = TIERS.filter((tier) => c[tier] > 0)
			.map((tier) => `${tier} ${c[tier]}`)
			.join(', ');
		rows.push(`| ${arm.name} | ${name} | ${c.requests} | ${tiers || '-'} | ${c.bytes} |`);
	}
	if (arm.name.startsWith('spool, static')) {
		const leaked = lines.filter((line) => GATED.test(line.path) && line.tier !== 'static');
		const seen = lines.filter((line) => GATED.test(line.path)).length;
		gate &&= leaked.length === 0 && seen > 0;
		const boots = lines.filter((line) => line.path.includes('/boot/')).length;
		console.log(
			`gate (${arm.name}): ${seen} stub, client, navigate and bundle requests, ${leaked.length} not served as files; ${boots} boot script requests (not in the static tier)`
		);
	}
}
console.log('| arm | phase | requests | tiers | response bytes |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) console.log(row);
process.exit(gate ? 0 : 1);
