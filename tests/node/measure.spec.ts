import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { parse as parseDeviceCpu, psCpuSeconds } from '../../scripts/measure/device-cpu';
import { armsFor, plan as iphonePlan, parse as parseIphone } from '../../scripts/measure/iphone';
import {
	batteryFromRegistry,
	counterDelta,
	integrateWatts,
	localMachine,
	otherCpuMs,
	parseNvidiaCsv,
	parseUsageUsec,
	phoneWindow,
	rotate,
	shuffle,
	utcDate,
	writeMeasurement,
	type Draft
} from '../../scripts/measure/lib';
import { parse as parseOnWire } from '../../scripts/measure/on-wire';
import {
	PAISLEY,
	conditions,
	inferenceRows,
	parse as parseRapl,
	publishDraft,
	plan as raplPlan,
	stripRow
} from '../../scripts/measure/rapl';
import {
	SITES,
	pageOrigin,
	parse as parseRepeatNav,
	sameOrigin
} from '../../scripts/measure/repeat-nav';
import { parseTrace, parseViews, peakWork } from '../../scripts/measure/traces';
import {
	createCa,
	startWireProxy,
	summarise,
	type WireEntry
} from '../../scripts/measure/wire-proxy';
import { ARMS, parse as parseZeroNetwork } from '../../scripts/measure/zero-network';
import type { TimedView } from '../../src/protocol/index';
import { parseMeasurement, type Measurement } from '../../src/report/index';

const draft = (over: Partial<Draft> = {}): Draft => ({
	rig: 'device-cpu',
	date: '2026-10-19',
	layer: 'L1',
	question: 'q',
	instrument: 'i',
	machine: { name: 'box' },
	software: {},
	method: {},
	exclusions: [],
	rows: [{ arm: 'a' }],
	...over
});

describe('writing a measurement', () => {
	it('writes <rig>/<date>[-<experiment>].json, validated, and refuses to replace a file', () => {
		const root = mkdtempSync(join(tmpdir(), 'measure-'));
		const path = writeMeasurement(root, draft(), { experiment: 'run2' });
		expect(path).toBe(join(root, 'device-cpu/2026-10-19-run2.json'));
		expect(parseMeasurement(JSON.parse(readFileSync(path, 'utf8'))).rig).toBe('device-cpu');
		expect(() => writeMeasurement(root, draft(), { experiment: 'run2' })).toThrow(/--force/);
		expect(writeMeasurement(root, draft(), { experiment: 'run2', overwrite: true })).toBe(path);
	});

	it('refuses a draft the format rejects before it touches the disk', () => {
		const root = mkdtempSync(join(tmpdir(), 'measure-'));
		expect(() => writeMeasurement(root, draft({ rows: [] }))).toThrow(/rows must be/);
	});

	it('describes this computer and the UTC day', () => {
		expect(localMachine('Laptop').name).toBe('Laptop');
		expect(localMachine().name).toMatch(/ /);
		expect(utcDate(new Date('2026-10-19T23:59:59-05:00'))).toBe('2026-10-20');
	});
});

describe('window maths', () => {
	it('reads a counter across its wrap', () => {
		expect(counterDelta(10, 25, 100)).toBe(15);
		expect(counterDelta(90, 5, 100)).toBe(15);
	});

	it('sums the CPU of the other containers, leaving out this one', () => {
		expect(parseUsageUsec('usage_usec 42\nuser_usec 1')).toBe(42);
		expect(parseUsageUsec('')).toBe(0);
		const before = { aaa111: 1000, bbb222: 2000, ccc333: 0 };
		const after = { aaa111: 4000, bbb222: 2500, ccc333: 10, ddd444: 9 };
		expect(otherCpuMs(before, after, 'aaa111abcdef')).toEqual({ bbb222: 0.5, ccc333: 0.01 });
		expect(otherCpuMs(before, after, 'x', (id) => id === 'bbb222')).toEqual({ bbb222: 0.5 });
	});

	it('rotates the arms by the round and shuffles reproducibly', () => {
		expect(rotate(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
		expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
		expect(rotate(['a', 'b', 'c', 'd'], 1, 2)).toEqual(['c', 'd', 'a', 'b']);
		const items = [1, 2, 3, 4, 5, 6, 7, 8];
		expect(shuffle(items, 7)).toEqual(shuffle(items, 7));
		expect([...shuffle(items, 7)].sort()).toEqual(items);
		expect(shuffle(items, 7)).not.toEqual(shuffle(items, 8));
	});
});

describe('GPU power traces', () => {
	const csv = [
		'2026/10/19 02:30:08.500, 100.0, 0, P8, 210, 9',
		'2026/10/19 02:30:09.500, 100.0, 0, P8, 210, 9',
		'2026/10/19 02:30:10.500, 200.0, 0, P8, 210, 9',
		'2026/10/19 02:30:11.500, 200.0, 0, P8, 210, 9',
		'garbage',
		'2026/10/19 02:30:12.500, [N/A], 0, P8, 210, 9'
	].join('\n');

	it('parses UTC timestamps and skips lines that are not samples', () => {
		const samples = parseNvidiaCsv(csv);
		expect(samples).toHaveLength(4);
		expect(samples[0]).toEqual([Date.UTC(2026, 9, 19, 2, 30, 8, 500), 100]);
	});

	it('integrates with the trapezoid rule and scales to the window length', () => {
		const samples = parseNvidiaCsv(csv);
		const from = Date.UTC(2026, 9, 19, 2, 30, 8, 500);
		const whole = integrateWatts(samples, from, from + 3000);
		expect(whole).toEqual({ joules: 450, spanS: 3, samples: 4 });
		const wider = integrateWatts(samples, from - 500, from + 3500);
		expect(wider?.joules).toBeCloseTo(450 * (4 / 3), 8);
		expect(integrateWatts(samples, from, from + 1500)).toBeNull();
	});
});

describe('phone windows', () => {
	const registry = (update: number, uwh: number, charging: boolean) => ({
		IORegistry: {
			UpdateTime: update,
			IsCharging: charging,
			CurrentCapacity: 95,
			PowerTelemetryData: {
				AccumulatedSystemEnergyConsumed: uwh,
				AccumulatedSystemLoad: uwh * 10,
				SystemLoadAccumulatorCount: update
			}
		}
	});

	it('reads the battery registry', () => {
		expect(batteryFromRegistry(registry(100, 5000, false))).toEqual({
			update: 100,
			secUwh: 5000,
			slAcc: 50000,
			slCnt: 100,
			charging: false,
			capacity: 95
		});
		expect(() => batteryFromRegistry({ IORegistry: {} })).toThrow(/PowerTelemetryData/);
	});

	it('turns the first and last tick into joules, mean power and the charging flags', () => {
		const reads = [
			registry(100, 5000, false),
			registry(120, 5100, false),
			registry(140, 5200, true)
		].map(batteryFromRegistry);
		const row = phoneWindow(reads, { arm: 'spool', round: 2, navs: 40, pace: 0 });
		expect(row).toMatchObject({
			arm: 'spool',
			round: 2,
			navs: 40,
			seconds: 40,
			charging: [false, false, true],
			capacity: [95, 95]
		});
		expect(row.energy_j).toBeCloseTo(0.72, 10);
		expect(row.mean_mw).toBe(50);
		expect(() =>
			phoneWindow(reads.slice(0, 1), { arm: 'a', round: 0, navs: 0, pace: 0 })
		).toThrow(/two ticks/);
	});

	it('offers the arms of each experiment and never prints the device id', () => {
		expect(Object.keys(armsFor('burst', 'N', 'S'))).toEqual(['network', 'spool']);
		const projection = armsFor('projection', 'N', 'S');
		expect(Object.keys(projection)).toEqual([
			'net-baked',
			'spool-baked',
			'spool-proj',
			'net-proj'
		]);
		expect(projection['spool-proj']).toEqual({
			origin: 'S',
			pages: ['/proj', '/proj2'],
			sw: true
		});
		const args = parseIphone(['--experiment', 'paced', '--dry-run']);
		expect(args).toMatchObject({ experiment: 'paced', pace: 15, ticks: 9, dryRun: true });
		expect(
			JSON.stringify(iphonePlan({ ...args, udid: '00008120-00015880216BC01E' }))
		).not.toContain('00008120');
		expect(iphonePlan({ ...args, udid: undefined }).udid).toBe('unset');
		expect(() => parseIphone(['--experiment', 'x'])).toThrow(/experiment must be/);
	});
});

describe('rig arguments', () => {
	it('keeps the defaults of each rig', () => {
		expect(parseRepeatNav([]).sites).toEqual(SITES);
		expect(parseRepeatNav(['--site', 'https://a.test/']).sites).toEqual(['https://a.test/']);
		expect(parseOnWire(['--links', '2']).links).toBe(2);
		expect(parseDeviceCpu([])).toMatchObject({ navs: 60, rttMs: 40, runs: 2 });
		expect(parseZeroNetwork(['--dry-run']).dryRun).toBe(true);
		expect(ARMS.map((a) => a.updateViaCache)).toEqual(['imports', 'all']);
	});

	it('counts same-origin requests against where a redirected home page landed', () => {
		expect(pageOrigin('https://www.uiowa.edu/', 'https://uiowa.edu/')).toBe(
			'https://uiowa.edu'
		);
		expect(pageOrigin('https://a.test/x', undefined)).toBe('https://a.test');
		expect(sameOrigin('https://a.test/x.js', 'https://a.test')).toBe(true);
		expect(sameOrigin('https://a.test.cdn.net/x.js', 'https://a.test')).toBe(false);
		expect(sameOrigin('data:,x', 'https://a.test')).toBe(false);
	});

	it('sums the CPU of the Chromium processes in a ps listing', () => {
		const listing = [
			' 0:12.50 /x/ms-playwright/chromium-1/chrome --type=renderer',
			' 1:02:03 /x/ms-playwright/chromium-1/chrome',
			' 9:99.99 /usr/bin/other'
		].join('\n');
		expect(psCpuSeconds(listing)).toBeCloseTo(12.5 + 3723, 8);
		expect(psCpuSeconds('')).toBe(0);
	});
});

describe('the RAPL runner', () => {
	it('lays out the power-state conditions', () => {
		expect(conditions('sweep')).toHaveLength(24);
		expect(conditions('timer').map((c) => c.name)).toContain('timer-bursty-1000');
		expect(conditions('timer')).toHaveLength(9);
		expect(conditions('sweep')[1]?.freq).toBe(false);
	});

	it('parses a command and prints a plan without touching the counters', () => {
		const parsed = parseRapl(['run', 'inference', '--dry-run']);
		expect(parsed.config.rounds).toBe(5);
		expect(raplPlan(parsed)).toMatchObject({
			experiment: 'inference',
			rapl: '/rapl/intel-rapl:0'
		});
		expect(parseRapl(['run', 'power-state', '--set', 'timer']).config.set).toBe('timer');
		expect(parseRapl([]).command).toBeUndefined();
		expect(() => parseRapl(['run', 'nope'])).toThrow(/experiment must be/);
		expect(() => parseRapl(['bake'])).toThrow(/unknown command/);
	});

	it('replaces container ids with their sum and names the ollama container apart', () => {
		const row = { arm: 'a', otherCpuMs: { aaa: 1.0006, ollama: 4, ccc: 2 } };
		expect(stripRow(row)).toEqual({ arm: 'a', otherCpuMs: 7.001 });
		expect(stripRow(row, 'ollama')).toEqual({ arm: 'a', otherCpuMs: 3.001, ollamaCpuMs: 4 });
		expect(stripRow({ otherContainersCpuMs: { a: 1 } })).toEqual({ otherContainersCpuMs: 1 });
		expect(stripRow({ otherCpuMs: 5 })).toEqual({ otherCpuMs: 5 });
	});

	it('adds GPU joules to the inference windows and refuses a window with no samples', () => {
		const start = Date.UTC(2026, 9, 19, 2, 30, 0);
		const samples = Array.from({ length: 11 }, (_, i) => [start + i * 1000, 100] as const);
		const raw = [
			{
				arm: 'ai-recompute',
				round: 0,
				epochStartMs: start,
				epochEndMs: start + 10_000,
				elapsedMs: 10_000,
				otherCpuMs: { x: 1 }
			}
		];
		const [row] = inferenceRows(raw, samples);
		expect(row).toMatchObject({ gpuJ: 1000, gpuSamples: 11, gpuSpanS: 10, otherCpuMs: 1 });
		expect(row).not.toHaveProperty('epochStartMs');
		expect(() =>
			inferenceRows([{ ...raw[0], epochStartMs: 0, epochEndMs: 5 }], samples)
		).toThrow(/no GPU samples/);
	});

	it('builds a valid, id-free measurement for every experiment', () => {
		const meta = {
			rounds: 1,
			idleS: 30,
			navs: 300,
			range: 1,
			pages: ['/'],
			windowS: 20,
			settleS: 4,
			nreq: 24,
			model: 'm',
			ncpu: 24
		};
		const start = Date.UTC(2026, 9, 19, 2, 30, 0);
		const gpu = Array.from({ length: 11 }, (_, i) => [start + i * 1000, 50] as const);
		const rows = [
			{
				arm: 'idle',
				round: 0,
				n: 0,
				elapsedMs: 1000,
				pkgJ: 19,
				otherCpuMs: { aaaaaaaaaaaa: 1 }
			}
		];
		const inference = [{ ...rows[0], epochStartMs: start, epochEndMs: start + 10_000 }];
		for (const experiment of [
			'views',
			'compute-server',
			'compute-browser',
			'projection',
			'power-state'
		] as const) {
			const made = publishDraft(experiment, rows, meta, { date: '2026-10-19' });
			const text = JSON.stringify({ schema: 1, ...made });
			expect(parseMeasurement(JSON.parse(text)).rig).toBe('rapl');
			expect(text).not.toMatch(/aaaaaaaaaaaa/);
		}
		const made = publishDraft('inference', inference, meta, { gpu, date: '2026-10-19' });
		expect((made as Measurement).method['requests per cache window']).toBe(300_000);
		expect(made.machine).toMatchObject({ ...PAISLEY, gpu: expect.stringContaining('4070') });
		expect(() => publishDraft('inference', inference, meta)).toThrow(/--gpu/);
		expect(
			publishDraft('power-state', rows, meta, { machine: { name: 'other' } }).machine.name
		).toBe('other');
	});
});

describe('traces', () => {
	const csv = [
		'start,seconds,route,requests,busy_ms',
		'2026-10-19T00:00:00Z,60,/a,10,100',
		'2026-10-19T00:00:00Z,60,/.spool/sync,2,20',
		'2026-10-19T00:01:00Z,60,/a,40,400',
		`${Date.UTC(2026, 9, 19, 0, 2)},60,/a,20,200`
	].join('\n');

	it('groups routes into one interval each, in time order', () => {
		const samples = parseTrace(csv);
		expect(samples).toHaveLength(3);
		expect(samples[0]).toEqual({
			start: Date.UTC(2026, 9, 19),
			seconds: 60,
			busyMs: { '/a': 100, '/.spool/sync': 20 },
			requests: { '/a': 10, '/.spool/sync': 2 }
		});
	});

	it.each([
		['a wrong header', 'a,b\n1,2', /header must be/],
		['a short row', 'start,seconds,route,requests,busy_ms\n1,2,3', /expected 5 columns/],
		['a bad time', 'start,seconds,route,requests,busy_ms\nlater,60,/a,1,1', /neither epoch/],
		['a zero length', 'start,seconds,route,requests,busy_ms\n1,0,/a,1,1', /seconds above zero/],
		['a negative count', 'start,seconds,route,requests,busy_ms\n1,60,/a,-1,1', /non-negative/]
	])('rejects %s', (_, text, message) => {
		expect(() => parseTrace(text)).toThrow(message);
	});

	it('prices local views at their route and reports the work they avoided', () => {
		const view = (at: number): TimedView => ({
			id: 'v',
			crossOriginLoads: 0,
			tier: 'local',
			reason: 'fresh',
			staleSec: 0,
			engine: 'chromium',
			scope: 'public',
			strategy: 'template',
			route: '/a',
			mismatch: null,
			swAgeMs: 0,
			gapMs: null,
			at
		});
		const jsonl = [view(Date.UTC(2026, 9, 19, 0, 1, 30)), view(Date.UTC(2026, 9, 19, 0, 1, 40))]
			.map((v) => JSON.stringify(v))
			.join('\n');
		const peak = peakWork(parseViews(jsonl), parseTrace(csv), 0.34);
		expect(peak.intervals).toBe(2);
		expect(peak.unpriced).toBe(0);
		expect(peak.avoided).toBe(2 * (700 / 70));
	});
});

describe('the counting proxy', () => {
	const answer = (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (req.url?.startsWith('/missing')) {
			res.writeHead(404);
			return void res.end();
		}
		res.writeHead(200, { 'content-type': 'text/plain', 'x-seen': '1' });
		res.end('hello world');
	};

	const listen = (server: http.Server | https.Server) =>
		new Promise<number>((resolve) =>
			server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
		);

	const fetchVia = (options: http.RequestOptions) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			http.get(options, (res) => {
				let body = '';
				res.on('data', (c) => (body += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
			}).on('error', reject);
		});

	it('counts requests, statuses and body bytes in reverse mode and strips the query', async () => {
		const origin = http.createServer(answer);
		const originPort = await listen(origin);
		const proxy = await startWireProxy({ target: `127.0.0.1:${originPort}` });
		const mark = proxy.mark();
		const ok = await fetchVia({ host: '127.0.0.1', port: proxy.port, path: '/page?a=1' });
		const missing = await fetchVia({ host: '127.0.0.1', port: proxy.port, path: '/missing' });
		await proxy.idle();
		expect([ok, missing]).toEqual([
			{ status: 200, body: 'hello world' },
			{ status: 404, body: '' }
		]);
		const entries = proxy.entries.slice(mark);
		expect(entries.map((e) => [e.method, e.path, e.status, e.bodyBytes])).toEqual([
			['GET', '/page', 200, 11],
			['GET', '/missing', 404, 0]
		]);
		const summary = summarise(entries, '127.0.0.1');
		expect(summary).toMatchObject({
			requests: 2,
			bodyBytes: 11,
			byStatus: { '200': 1, '404': 1 },
			sameHost: 2,
			thirdParty: 0,
			hosts: 1
		});
		expect(summary.bytes).toBeGreaterThan(summary.responseBytes);
		expect(summary.responseBytes).toBeGreaterThan(summary.bodyBytes);
		await proxy.stop();
		origin.close();
	});

	it('forwards plain HTTP for a browser proxy and counts an unreachable origin as status 0', async () => {
		const origin = http.createServer(answer);
		const originPort = await listen(origin);
		const proxy = await startWireProxy();
		const ok = await fetchVia({
			host: '127.0.0.1',
			port: proxy.port,
			path: `http://127.0.0.1:${originPort}/x`
		});
		expect(ok.body).toBe('hello world');
		const dead = await fetchVia({
			host: '127.0.0.1',
			port: proxy.port,
			path: 'http://127.0.0.1:1/x'
		});
		expect(dead.status).toBe(502);
		await proxy.idle();
		expect(proxy.entries.map((e) => e.status)).toEqual([200, 0]);
		await proxy.stop();
		origin.close();
	});

	it('refuses a CONNECT tunnel when it has no CA', async () => {
		const proxy = await startWireProxy();
		const reply = await new Promise<string>((resolve) => {
			const socket = net.connect(proxy.port, '127.0.0.1', () =>
				socket.write('CONNECT example.test:443 HTTP/1.1\r\n\r\n')
			);
			let text = '';
			socket.on('data', (c) => (text += c));
			socket.on('end', () => resolve(text));
		});
		expect(reply).toContain('501 Not Implemented');
		await proxy.stop();
	});

	it.skipIf(spawnSync('openssl', ['version']).status !== 0)(
		'counts the requests inside an HTTPS tunnel it decrypts',
		async () => {
			const ca = createCa();
			const origin = https.createServer(
				{ SNICallback: (name, cb) => cb(null, ca.contextFor(name)) },
				answer
			);
			const originPort = await listen(origin);
			const proxy = await startWireProxy({ ca, upstreamCa: ca.certPem });
			const reply = await new Promise<string>((resolve, reject) => {
				http.request({
					host: '127.0.0.1',
					port: proxy.port,
					method: 'CONNECT',
					path: `localhost:${originPort}`
				})
					.on('connect', (_res, socket) => {
						const secure = tls.connect(
							{
								socket,
								servername: 'localhost',
								ca: ca.certPem,
								ALPNProtocols: ['http/1.1']
							},
							() => {
								secure.write(
									'GET /secure?x=1 HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n'
								);
							}
						);
						let text = '';
						secure.on('data', (c) => (text += c));
						secure.on('end', () => resolve(text));
						secure.on('error', reject);
					})
					.on('error', reject)
					.end();
			});
			expect(reply).toContain('200 OK');
			expect(reply).toContain('hello world');
			await proxy.idle();
			const entries: WireEntry[] = proxy.entries;
			expect(entries.map((e) => [e.host, e.path, e.status, e.bodyBytes])).toEqual([
				['localhost', '/secure', 200, 11]
			]);
			await proxy.stop();
			origin.close();
		}
	);

	it('summarises an empty list', () => {
		expect(summarise([])).toEqual({
			requests: 0,
			bytes: 0,
			responseBytes: 0,
			bodyBytes: 0,
			byStatus: {},
			sameHost: 0,
			thirdParty: 0,
			hosts: 0
		});
	});
});
