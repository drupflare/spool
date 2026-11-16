import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { rotate } from './lib.ts';
import type { Config, Meter } from './rapl.ts';

type Row = Record<string, unknown>;

/** the origin on the rig's Docker network: the PHP server container's name and port */
export const DEFAULT_ORIGIN = 'http://b4-srv:8080';

/** the arms of the run; `mode` is the cache state the origin is switched to before the arm */
export type DrupalArm = {
	name: string;
	mode: string;
	requests: number;
	/** a cold arm clears its bins first and splits its window into one first request and the rest */
	cold: boolean;
};

/**
 * The 304 arm is not here: Drupal 11.4.6's internal page cache sends no ETag and no Last-Modified
 * (checked on paisley-park, 2026-11-15), so a validator-based 304 would be the rig's own answer.
 */
export const DRUPAL_ARMS: readonly DrupalArm[] = [
	{ name: 'uncached', mode: 'uncached', requests: 40, cold: true },
	{ name: 'render-warm', mode: 'render-warm', requests: 40, cold: true },
	{ name: 'page-cache', mode: 'page-cache', requests: 400, cold: false }
];

/** the null route answers from the PHP server with no Drupal bootstrap: the server and the connection */
export const DRUPAL_NULL = { name: 'null', requests: 2000 } as const;

export const URL_CLASSES = ['front', 'node', 'term'] as const;
export type UrlClass = (typeof URL_CLASSES)[number];

const SETTLE_MS = 1500;
const WARMUP_REQUESTS = 8;
const CONTAINER_ID = /^[0-9a-f]{12}$/;

/**
 * Planning figures for the dry run's wall-time estimate only. They are assumptions, not
 * measurements; the smoke run replaces them before any schedule is trusted.
 */
const PLANNED_MS_PER_REQUEST: Record<string, number> = {
	uncached: 100,
	'render-warm': 50,
	'page-cache': 10,
	null: 2
};

export const DRUPAL_QUESTION =
	'package joules per request from a PHP 8.5 server running Drupal 11: an uncached render, a render with warm render caches, the internal page cache answering, and a null route with no Drupal bootstrap';

/** the rounds, windows and planned time of one run, from its parameters */
export function drupalPlan(rounds: number, idleS: number) {
	const perArm = DRUPAL_ARMS.map((arm) => {
		const ms = (PLANNED_MS_PER_REQUEST[arm.name] ?? 0) as number;
		const seconds = (SETTLE_MS / 1000 + 1 + arm.requests * (ms / 1000)) * URL_CLASSES.length;
		return {
			arm: arm.name,
			windows: arm.cold ? 2 : 1,
			requests: arm.requests,
			seconds
		};
	});
	const nullSeconds =
		SETTLE_MS / 1000 + DRUPAL_NULL.requests * ((PLANNED_MS_PER_REQUEST['null'] ?? 0) / 1000);
	const idleSeconds = 2 * (idleS + 2);
	const roundSeconds = idleSeconds + perArm.reduce((s, a) => s + a.seconds, 0) + nullSeconds;
	return {
		rounds,
		idleWindowsPerRound: 2,
		armWindowsPerRound: perArm.reduce((s, a) => s + a.windows * URL_CLASSES.length, 0) + 1,
		arms: perArm,
		estimateSeconds: Math.round(rounds * roundSeconds),
		basis:
			'planning assumption per request (not measured): ' +
			JSON.stringify(PLANNED_MS_PER_REQUEST)
	};
}

/** the method block of the published reading, from the run's meta file */
export function drupalMethod(meta: Record<string, unknown>): Record<string, unknown> {
	const drupal = (meta.drupal ?? {}) as Record<string, unknown>;
	return {
		site: 'generated: 300 article nodes of 3 to 6 seeded paragraphs, 2 of 20 tags each, the standard profile front page (10 per page); anonymous visitors only; no contrib modules',
		urls: drupal.urls,
		server: 'PHP built-in server (php -S) in corpus-native:latest; it stands in for php-fpm, so nothing here measures php-fpm',
		php: drupal.php,
		drupal: drupal.drupal,
		opcache: drupal.opcache,
		'php cli server workers': drupal.workers,
		bins: {
			uncached:
				'page, dynamic_page_cache and render on cache.backend.memory.memory (Drupal 11.4 has no null backend; a memory bin lives in one request, so every request renders)',
			'render-warm':
				'page on cache.backend.memory.memory; dynamic_page_cache and render on their database backends, warm after the first request',
			'page-cache': "Drupal's defaults: the internal page cache answers anonymous pages"
		},
		'source tree':
			"a copy of the Drupal 11.4.6 tree in drupflare's own rig. Its Renderer, AccessPolicyProcessor and EntityReferenceItemBase construct PhpWasmSyncFiber, a class only the PHP-WASM runtime defines; upstream Drupal uses \\Fiber there (not checked against an upstream download), so this tree is not stock core",
		shim: 'fiber-shim.php defines PhpWasmSyncFiber on top of \\Fiber, loaded with auto_prepend_file in the server and the setup scripts; its cost sits inside every arm and the null route does not subtract it',
		connections:
			'php -S closed every connection after its response (server log), so every request, null route included, pays a new TCP connection',
		'validators seen':
			'none: Drupal 11.4.6 sends no ETag or Last-Modified on anonymous pages, so no 304 arm is run',
		arms: DRUPAL_ARMS.map((a) => ({ name: a.name, requests: a.requests, cold: a.cold })),
		'null route': `${DRUPAL_NULL.requests} requests to a fixed string through the same server`,
		'cold windows':
			'the bins are cleared before the window, the first request is its own window, and the rest of the arm follows',
		'rounds per window': meta.rounds,
		'idle window s': meta.idleS,
		'arm order': 'rotated per round, URL classes rotated within each arm',
		'emulated rtt ms': 0,
		client: 'a keep-alive client in the harness container (bun); it sends the same requests for every arm, so the null route subtracts its share',
		'energy counter range uJ': meta.range
	};
}

/** the software block of the published reading */
export function drupalSoftware(meta: Record<string, unknown>): Record<string, string> {
	const drupal = (meta.drupal ?? {}) as Record<string, unknown>;
	return {
		server: `PHP ${String(drupal.php ?? 'unknown')} built-in server, image corpus-native:latest`,
		drupal: String(drupal.drupal ?? 'unknown'),
		harness: 'spool-rig-bun:1 (bun), --cpus 2 --memory 2g'
	};
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

type Reply = {
	status: number;
	bytes: number;
	text: string;
	pageCache: string;
	dynamicCache: string;
	headers: http.IncomingHttpHeaders;
};

const header = (value: string | string[] | undefined) =>
	typeof value === 'string' ? value : 'none';

function drupalGet(
	origin: string,
	path: string,
	headers: Record<string, string>,
	keepText = false
) {
	const url = new URL(path, origin);
	return new Promise<Reply>((resolve, reject) => {
		const req = http.request(
			{
				host: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				agent,
				headers
			},
			(res) => {
				let bytes = 0;
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => {
					bytes += c.length;
					if (keepText) chunks.push(c);
				});
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						bytes,
						text: Buffer.concat(chunks).toString('utf8'),
						pageCache: header(res.headers['x-drupal-cache']),
						dynamicCache: header(res.headers['x-drupal-dynamic-cache']),
						headers: res.headers
					})
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function control(origin: string, path: string): Promise<Reply> {
	const reply = await drupalGet(origin, path, {}, true);
	if (reply.status !== 200) throw new Error(`${path} answered ${reply.status}`);
	return reply;
}

function emit(raw: string, row: Row) {
	appendFileSync(raw, `${JSON.stringify(row)}\n`);
	console.log(JSON.stringify(row).slice(0, 160));
}

function mergeMeta(raw: string, patch: Record<string, unknown>) {
	const path = `${raw}.meta.json`;
	const meta = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	writeFileSync(path, `${JSON.stringify({ ...meta, ...patch }, null, '\t')}\n`);
}

const tally = (into: Record<string, number>, key: string) => {
	into[key] = (into[key] ?? 0) + 1;
};

type Base = { arm: string; url: string; phase: string; round: number };

/** one window of `n` requests to `path`, metered with the origin's container CPU excluded from the others */
async function timed(
	meter: Meter,
	config: Config,
	origin: string,
	serverId: string,
	base: Base,
	n: number,
	path: string,
	headers: Record<string, string>
): Promise<Row> {
	const status: Record<string, number> = {};
	const pageCache: Record<string, number> = {};
	const dynamicCache: Record<string, number> = {};
	let bytes = 0;
	const s0 = meter.snap()[serverId] ?? 0;
	const c0 = process.cpuUsage();
	const w = await meter.window(
		async () => {
			for (let i = 0; i < n; i++) {
				const r = await drupalGet(origin, path, headers);
				bytes += r.bytes;
				tally(status, String(r.status));
				tally(pageCache, r.pageCache);
				tally(dynamicCache, r.dynamicCache);
			}
		},
		false,
		[serverId]
	);
	const c1 = process.cpuUsage();
	const s1 = meter.snap()[serverId] ?? 0;
	const row: Row = {
		...base,
		n,
		status,
		pageCache,
		dynamicCache,
		bytesPerOp: bytes / n,
		elapsedMs: w.elapsedMs,
		pkgJ: w.pkgJ,
		load0: w.load0,
		load1: w.load1,
		otherCpuMs: w.others,
		serverCpuMs: (s1 - s0) / 1000,
		clientCpuMs: (c1.user + c1.system - c0.user - c0.system) / 1000
	};
	emit(config.raw, row);
	return row;
}

async function idle(meter: Meter, config: Config, serverId: string, round: number) {
	await sleep(2000);
	const w = await meter.window(() => sleep(config.idleS * 1000), false, [serverId]);
	emit(config.raw, {
		arm: 'idle',
		round,
		n: 0,
		elapsedMs: w.elapsedMs,
		pkgJ: w.pkgJ,
		load0: w.load0,
		load1: w.load1,
		otherCpuMs: w.others
	});
}

async function armWindows(
	meter: Meter,
	config: Config,
	origin: string,
	serverId: string,
	round: number,
	arm: DrupalArm,
	url: string,
	path: string
) {
	await control(origin, `/__b4/arm?name=${arm.mode}`);
	if (arm.cold) {
		await control(origin, '/__b4/clear');
	} else {
		for (let i = 0; i < WARMUP_REQUESTS; i++) await drupalGet(origin, path, {});
	}
	await sleep(SETTLE_MS);
	const base = { arm: arm.name, url, round };
	if (arm.cold) {
		await timed(meter, config, origin, serverId, { ...base, phase: 'first' }, 1, path, {});
		await timed(
			meter,
			config,
			origin,
			serverId,
			{ ...base, phase: 'steady' },
			arm.requests - 1,
			path,
			{}
		);
		return;
	}
	await timed(
		meter,
		config,
		origin,
		serverId,
		{ ...base, phase: 'steady' },
		arm.requests,
		path,
		{}
	);
}

async function nullWindow(
	meter: Meter,
	config: Config,
	origin: string,
	serverId: string,
	round: number
) {
	for (let i = 0; i < WARMUP_REQUESTS; i++) await drupalGet(origin, '/__b4/null', {});
	await sleep(SETTLE_MS);
	await timed(
		meter,
		config,
		origin,
		serverId,
		{ arm: 'null', url: 'null', phase: 'steady', round },
		DRUPAL_NULL.requests,
		'/__b4/null',
		{}
	);
}

/** the Drupal render run: one round is idle, every arm for every URL class, the null route, idle */
export async function runDrupalRender(config: Config, meter: Meter): Promise<void> {
	const origin = process.env.DRUPAL_ORIGIN ?? DEFAULT_ORIGIN;
	const info = JSON.parse((await control(origin, '/__b4/info')).text) as {
		php: string;
		drupal: string;
		opcache: string;
		workers: string;
		hostname: string;
		urls: Record<UrlClass, string>;
	};
	if (!CONTAINER_ID.test(info.hostname))
		throw new Error(`the origin's hostname is not a container id: ${info.hostname}`);
	const serverId = info.hostname;
	if (!(serverId in meter.snap()))
		throw new Error('the origin container has no cgroup under the host cgroup mount');
	mergeMeta(config.raw, {
		drupal: {
			php: info.php,
			drupal: info.drupal,
			opcache: info.opcache,
			workers: info.workers,
			urls: info.urls
		}
	});
	const urls = URL_CLASSES.map((c) => [c, info.urls[c]] as const);
	for (let round = 0; round < config.rounds; round++) {
		await idle(meter, config, serverId, round);
		for (const arm of rotate([...DRUPAL_ARMS], round)) {
			for (const [url, path] of rotate([...urls], round)) {
				await armWindows(meter, config, origin, serverId, round, arm, url, path);
			}
		}
		await nullWindow(meter, config, origin, serverId, round);
		await idle(meter, config, serverId, round);
	}
}
