import { fileStaticSink, toNodeListener } from '@drupflare/spool/node';
import { chromium } from '@playwright/test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DIST, origin, type Arm, type Tier } from './server.ts';
import { STAMP } from './server/spool.ts';

// the lease is short so the run can cross it; the figures are L1, one run per arm
const { values } = parseArgs({
	options: {
		lease: { type: 'string', default: '20' },
		arms: { type: 'string', default: 'static,handler,none' },
		control: { type: 'boolean', default: false }
	}
});
const LEASE = Number(values.lease);
const WAIT_MS = 2000;
const CLICKS = 6;
const PHASES = [
	'first view',
	'6 in-app clicks',
	'view that registers the worker',
	'view inside the lease',
	'view after the lease',
	'publish, then the next contact'
];
const ARMS = values.arms.split(',') as Arm[];

type Count = {
	requests: number;
	bytes: number;
	static: number;
	spool: number;
	page: number;
	paths: string[];
};
const blank = (): Count => ({ requests: 0, bytes: 0, static: 0, spool: 0, page: 0, paths: [] });

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
}

async function arm(name: Arm, port: number): Promise<Count[]> {
	const scratch = mkdtempSync(join(tmpdir(), 'spool-vite-vue-'));
	cpSync(DIST, scratch, { recursive: true });
	const counts = PHASES.map(blank);
	let current = 0;
	let stamp = STAMP;
	const { spool, handle } = await origin({
		lease: LEASE,
		stamp: () => stamp,
		root: scratch,
		arm: name,
		note: (path, tier: Tier, bytes) => {
			const count = counts[current]!;
			count.requests += 1;
			count.bytes += bytes;
			count[tier] += 1;
			count.paths.push(`${path} (${tier})`);
		}
	});
	const server = createServer(toNodeListener(handle));
	await listen(server, port);
	const base = `http://127.0.0.1:${port}`;
	const profile = mkdtempSync(join(tmpdir(), 'spool-vite-vue-profile-'));
	const context = await chromium.launchPersistentContext(profile, { headless: true });
	const tab = await context.newPage();
	const view = async (phase: number) => {
		current = phase;
		await tab.goto(`${base}/`, { waitUntil: 'load' });
		await tab.waitForTimeout(WAIT_MS);
	};
	const pause = (ms: number) => tab.waitForTimeout(ms);
	try {
		await view(0);
		current = 1;
		for (let step = 0; step < CLICKS; step++) {
			const to = step % 2 === 0 ? '/articles' : '/';
			await tab.click(`nav a[href="${to}"]`);
			await pause(300);
		}
		await view(2);
		await view(3);
		await pause(LEASE * 1000 + 1000);
		await view(4);
		// the control changes nothing: no stamp and no publish, so the stub's bytes stay the same
		if (name !== 'none' && !values.control) {
			stamp = STAMP + 1;
			await spool.publishStatic(fileStaticSink(scratch));
		}
		await pause(LEASE * 1000 + 1000);
		await view(5);
	} finally {
		await context.close();
		await new Promise((resolve) => server.close(resolve));
		rmSync(profile, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
	return counts;
}

const results: Record<string, Count[]> = {};
let port = 5731;
for (const name of ARMS) {
	results[name] = await arm(name, port);
	port += 1;
}

for (const name of ARMS) {
	console.log(`\narm: ${name}`);
	console.log('phase'.padEnd(34) + 'requests  static  spool  page  bytes');
	PHASES.forEach((phase, index) => {
		const count = results[name]![index]!;
		console.log(
			phase.padEnd(34) +
				`${String(count.requests).padEnd(10)}${String(count.static).padEnd(8)}` +
				`${String(count.spool).padEnd(7)}${String(count.page).padEnd(6)}${count.bytes}`
		);
		for (const path of count.paths) console.log(`    ${path}`);
	});
}
