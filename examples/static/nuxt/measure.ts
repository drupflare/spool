import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Nuxt build has one arm: Nitro serves the public files and the server answers the rest. The proxy
// classifies a response as a file when the path is a file under .output/public, which is what Nitro
// serves first. The publish step is not measured: Nitro lists public files at build time.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '.output', 'public');
const ORIGIN_PORT = 5712;
const PROXY_PORT = 5713;
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
const WAIT_MS = 2000;
const PHASES = [
	'first view',
	'2 in-app clicks',
	'view that registers the worker',
	'view inside the lease'
];
type Tier = 'static' | 'origin';
type Count = { requests: number; bytes: number; static: number; origin: number; paths: string[] };
const blank = (): Count => ({ requests: 0, bytes: 0, static: 0, origin: 0, paths: [] });
const counts = PHASES.map(blank);
let current = 0;

function tierOf(pathname: string): Tier {
	const file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
	if (!file.startsWith(PUBLIC + sep)) return 'origin';
	return statSync(file, { throwIfNoEntry: false })?.isFile() ? 'static' : 'origin';
}

function note(path: string, tier: Tier, bytes: number) {
	const count = counts[current]!;
	count.requests += 1;
	count.bytes += bytes;
	count[tier] += 1;
	count.paths.push(`${path} (${tier})`);
}

async function waitForOrigin() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const up = await fetch(`${ORIGIN}/`).then(
			() => true,
			() => false
		);
		if (up) return;
		await new Promise((done) => setTimeout(done, 500));
	}
	throw new Error('the Nuxt server did not answer');
}

const server = spawn(process.execPath, [join(HERE, '.output', 'server', 'index.mjs')], {
	cwd: HERE,
	env: { ...process.env, PORT: String(ORIGIN_PORT) },
	stdio: 'ignore'
});
await waitForOrigin();

const proxy = createServer(async (req, res) => {
	const url = req.url ?? '/';
	const upstream = await fetch(ORIGIN + url, {
		headers: { accept: String(req.headers.accept ?? '*/*') },
		redirect: 'manual'
	});
	const body = new Uint8Array(await upstream.arrayBuffer());
	note(url, tierOf(new URL(url, ORIGIN).pathname), body.length);
	const headers: Record<string, string> = {};
	upstream.headers.forEach((value, key) => {
		if (
			!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)
		) {
			headers[key] = value;
		}
	});
	res.writeHead(upstream.status, headers);
	res.end(body);
});
await new Promise<void>((done) => proxy.listen(PROXY_PORT, '127.0.0.1', done));

const base = `http://127.0.0.1:${PROXY_PORT}`;
const profile = mkdtempSync(join(tmpdir(), 'spool-static-nuxt-profile-'));
const context = await chromium.launchPersistentContext(profile, { headless: true });
const tab = await context.newPage();

async function view(phase: number, path: string) {
	current = phase;
	await tab.goto(`${base}${path}`, { waitUntil: 'load' });
	await tab.waitForTimeout(WAIT_MS);
}

try {
	await view(0, '/');
	current = 1;
	await tab.click('a[href="/about"]');
	await tab.waitForTimeout(500);
	await tab.click('a[href="/"]');
	await tab.waitForTimeout(500);
	await view(2, '/');
	await view(3, '/');
} finally {
	await context.close();
	await new Promise((done) => proxy.close(done));
	server.kill('SIGTERM');
	rmSync(profile, { recursive: true, force: true });
}

console.log('\nphase'.padEnd(34) + 'requests  static  origin  bytes');
PHASES.forEach((phase, index) => {
	const count = counts[index]!;
	console.log(
		phase.padEnd(34) +
			`${String(count.requests).padEnd(10)}${String(count.static).padEnd(8)}` +
			`${String(count.origin).padEnd(8)}${count.bytes}`
	);
	for (const path of count.paths) console.log(`    ${path}`);
});
process.exit(0);
