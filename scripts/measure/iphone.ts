import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
	MEASUREMENTS_DIR,
	batteryFromRegistry,
	isMain,
	phoneWindow,
	rotate,
	utcDate,
	writeMeasurement,
	type BatteryRead,
	type Draft
} from './lib';

/** one arm: the origin it loads, the pages it cycles through and whether a worker controls them */
export type PhoneArm = { origin: string; pages: string[]; sw: boolean };

export type Experiment = 'burst' | 'paced' | 'projection';

const HOME_PAGES = ['/', '/node/3', '/node/2', '/node/1'];

/** the arms of each experiment; `net` serves no worker, `sw` registers one. `idle` has no entry. */
export function armsFor(experiment: Experiment, net: string, sw: string): Record<string, PhoneArm> {
	if (experiment === 'projection') {
		const pages = ['/baked', '/baked2'];
		const proj = ['/proj', '/proj2'];
		return {
			'net-baked': { origin: net, pages, sw: false },
			'spool-baked': { origin: sw, pages, sw: true },
			'spool-proj': { origin: sw, pages: proj, sw: true },
			'net-proj': { origin: net, pages: proj, sw: false }
		};
	}
	return {
		network: { origin: net, pages: HOME_PAGES, sw: false },
		spool: { origin: sw, pages: HOME_PAGES, sw: true }
	};
}

export const DEFAULT_TICKS: Record<Experiment, number> = { burst: 6, paced: 9, projection: 5 };

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			experiment: { type: 'string', default: 'burst' },
			net: { type: 'string' },
			sw: { type: 'string' },
			driver: { type: 'string', default: 'http://127.0.0.1:4444' },
			ticks: { type: 'string' },
			rounds: { type: 'string', default: '4' },
			pace: { type: 'string' },
			machine: { type: 'string', default: 'iPhone' },
			os: { type: 'string' },
			network: { type: 'string', default: 'Wi-Fi' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	const experiment = values.experiment as Experiment;
	if (!['burst', 'paced', 'projection'].includes(experiment)) {
		throw new Error('experiment must be burst, paced or projection');
	}
	const pace = Number(values.pace ?? (experiment === 'paced' ? 15 : 0));
	return {
		experiment,
		net: values.net,
		sw: values.sw,
		driver: values.driver as string,
		ticks: Number(values.ticks ?? DEFAULT_TICKS[experiment]),
		rounds: Number(values.rounds),
		pace,
		machine: values.machine as string,
		os: values.os,
		network: values.network as string,
		udid: process.env.UDID,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

/** the plan a dry run prints; the device id is never printed, only whether one is set */
export function plan(args: ReturnType<typeof parse>) {
	return {
		rig: 'iphone',
		experiment: args.experiment,
		date: utcDate(),
		arms: Object.keys(armsFor(args.experiment, args.net ?? '<net>', args.sw ?? '<sw>')),
		ticks: args.ticks,
		rounds: args.rounds,
		pace: args.pace,
		udid: args.udid ? 'set' : 'unset',
		output: `measurements/iphone/${utcDate()}-${args.experiment}.json`
	};
}

/** the battery registry as JSON: `idevicediagnostics` prints a plist, `plutil` converts it */
function readBattery(udid: string): BatteryRead {
	const dump = spawnSync('idevicediagnostics', ['-u', udid, 'ioregentry', 'AppleSmartBattery'], {
		encoding: 'buffer'
	});
	if (dump.status !== 0) throw new Error(`idevicediagnostics failed: ${dump.stderr.toString()}`);
	const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
		input: dump.stdout,
		encoding: 'utf8'
	});
	if (json.status !== 0) throw new Error(`plutil failed: ${json.stderr}`);
	return batteryFromRegistry(JSON.parse(json.stdout));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(args: ReturnType<typeof parse>) {
	if (!args.udid) throw new Error('set UDID to the device id (idevicediagnostics -u)');
	if (!args.net || !args.sw)
		throw new Error('pass --net and --sw, the two origins (without and with a worker)');
	const { udid, net, sw } = args as typeof args & { udid: string; net: string; sw: string };
	const arms = armsFor(args.experiment, net, sw);
	const wd = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(args.driver + path, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const json = (await res.json()) as { value: any };
		if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
		return json.value;
	};
	const session = (await wd('POST', '/session', {
		capabilities: {
			alwaysMatch: { browserName: 'safari', platformName: 'iOS', 'safari:deviceUDID': udid }
		}
	})) as { sessionId: string };
	const go = (url: string) => wd('POST', `/session/${session.sessionId}/url`, { url });
	const script = (code: string) =>
		wd('POST', `/session/${session.sessionId}/execute/async`, { script: code, args: [] });

	const prime = async (origin: string, withWorker: boolean) => {
		const pages = Object.values(arms).find((a) => a.origin === origin)?.pages ?? ['/'];
		await go(origin + pages[0]);
		if (withWorker) {
			await script(
				"const done=arguments[0];navigator.serviceWorker.register('/spool-sw.js',{updateViaCache:'all'}).then(()=>navigator.serviceWorker.ready).then(()=>done(true)).catch(e=>done(String(e)))"
			);
			await sleep(3000);
			await go(origin + pages[0]);
			const controlled = await script('arguments[0](!!navigator.serviceWorker.controller)');
			if (controlled !== true)
				throw new Error(
					`the worker does not control ${origin}; the arm would not measure a local view`
				);
		}
		for (let i = 0; i < 8; i++) await go(origin + (pages[i % pages.length] as string));
		await sleep(3000);
	};
	await prime(net, false);
	await prime(sw, true);

	const nextTick = async (after: number) => {
		for (;;) {
			const read = readBattery(udid);
			if (read.update !== after) return read;
			await sleep(500);
		}
	};
	const rows: Array<Record<string, unknown>> = [];
	const order = [...Object.keys(arms), 'idle'];
	for (let round = 0; round < args.rounds; round++) {
		for (const arm of rotate(order, round)) {
			const first = await nextTick(readBattery(udid).update);
			const reads: BatteryRead[] = [first];
			let done = false;
			const watch = (async () => {
				while (reads.length < args.ticks + 1)
					reads.push(await nextTick((reads[reads.length - 1] as BatteryRead).update));
				done = true;
			})();
			let navs = 0;
			let flushed = false;
			const spec = arms[arm];
			while (!done) {
				if (!spec) {
					await sleep(500);
					continue;
				}
				const slot = Date.now();
				await go(spec.origin + (spec.pages[navs % spec.pages.length] as string));
				navs += 1;
				while (args.pace && !done && Date.now() - slot < args.pace * 1000) await sleep(200);
				if (spec.sw && reads.length === args.ticks && !flushed) {
					await script(
						"const done=arguments[0];navigator.serviceWorker.controller&&navigator.serviceWorker.controller.postMessage('flush');setTimeout(()=>done(true),300)"
					);
					flushed = true;
				}
			}
			await watch;
			const row = phoneWindow(reads, { arm, round, navs, pace: args.pace });
			rows.push(row);
			console.log(JSON.stringify(row));
		}
	}
	await wd('DELETE', `/session/${session.sessionId}`);
	return rows;
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(JSON.stringify(plan(args), null, 2));
	} else {
		const rows = await run(args);
		const arms = armsFor(args.experiment, args.net as string, args.sw as string);
		const draft: Draft = {
			rig: 'iphone',
			date: utcDate(),
			layer: 'L1',
			question:
				args.experiment === 'projection'
					? 'phone joules per view: network fetch of a computed page, local render of it, and a local render that aggregates stored records on the device'
					: `phone joules per view, network vs spool, ${args.pace ? `one view every ${args.pace} s` : 'back to back'}`,
			instrument:
				'AppleSmartBattery PowerTelemetryData via libimobiledevice idevicediagnostics: AccumulatedSystemEnergyConsumed (uWh) for energy_j, AccumulatedSystemLoad / count for mean_mw; 20 s ticks',
			machine: {
				name: args.machine,
				...(args.os ? { os: args.os } : {}),
				network: args.network,
				power: 'wired to the Mac'
			},
			software: {
				browser: 'Safari, driven by safaridriver (W3C WebDriver)',
				origins: 'two static-assets sites, one without a service worker and one with'
			},
			method: {
				arms: [...Object.keys(arms), 'idle'],
				'arm order': 'rotated per round',
				rounds: args.rounds,
				'window ticks': args.ticks,
				pages: Object.fromEntries(Object.entries(arms).map(([name, a]) => [name, a.pages])),
				'pace s': args.pace,
				'service worker':
					'registered in the same session with updateViaCache all; controlled asserted before the run'
			},
			exclusions: [
				'windows with any tick charging true: the energy counter then includes charge power'
			],
			rows
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	}
}
