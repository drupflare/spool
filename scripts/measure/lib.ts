import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	measurementPath,
	parseMeasurement,
	serialiseMeasurement,
	type Measurement
} from '../../src/report/measurement.ts';

/** the repository's `measurements/` folder */
export const MEASUREMENTS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../measurements'
);

/** whether `meta` (an `import.meta.url`) is the script the process was started with */
export function isMain(meta: string): boolean {
	const entry = process.argv[1];
	return entry !== undefined && resolve(entry) === fileURLToPath(meta);
}

/** the UTC date of `now` as `YYYY-MM-DD` */
export function utcDate(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** a rig's output before it gets its `schema` and path */
export type Draft = Omit<Measurement, 'schema'>;

/**
 * Validates a run and writes it to `measurements/<rig>/<date>[-<experiment>].json` under `root`.
 * An existing file is kept unless `overwrite` is set, so a second run on the same day cannot
 * replace the first. Returns the path written.
 */
export function writeMeasurement(
	root: string,
	draft: Draft,
	options: { experiment?: string; overwrite?: boolean } = {}
): string {
	parseMeasurement({ schema: 1, ...draft }, `${draft.rig} ${draft.date}`);
	const path = join(root, measurementPath(draft, options.experiment));
	if (existsSync(path) && !options.overwrite) {
		throw new Error(`${path} exists; pass --force to replace it`);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, serialiseMeasurement(draft));
	return path;
}

/** the machine block for a run on this computer; `name` overrides the generic platform label */
export function localMachine(name?: string): Record<string, string | number> {
	return {
		name: name ?? `${platform()} ${arch()}`,
		cpu: cpus()[0]?.model ?? 'unknown',
		os: `${platform()} ${release()}`
	};
}

/** the difference between two reads of a wrapping counter whose maximum is `range` */
export function counterDelta(before: number, after: number, range: number): number {
	return after >= before ? after - before : after + range - before;
}

/** `usage_usec` from a cgroup `cpu.stat` file */
export function parseUsageUsec(stat: string): number {
	return Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0);
}

/**
 * The CPU other containers used over a window, in milliseconds, from two cgroup snapshots. A
 * container that started inside the window counts from zero; one that stopped inside it leaves no
 * second snapshot and is not counted.
 */
export function otherCpuMs(
	before: Record<string, number>,
	after: Record<string, number>,
	selfId: string,
	only?: (id: string) => boolean
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [id, usec] of Object.entries(after)) {
		if (selfId.startsWith(id) || (only && !only(id))) continue;
		out[id] = (usec - (before[id] ?? 0)) / 1000;
	}
	return out;
}

/** a power sample: epoch milliseconds and watts */
export type PowerSample = readonly [ms: number, watts: number];

/** `nvidia-smi --query-gpu=timestamp,power.draw.instant,... --format=csv,noheader,nounits` lines as samples (UTC) */
export function parseNvidiaCsv(text: string): PowerSample[] {
	const samples: PowerSample[] = [];
	for (const line of text.split('\n')) {
		const cells = line.split(',');
		if (cells.length < 2) continue;
		const stamp = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/.exec(
			cells[0]?.trim() ?? ''
		);
		const watts = Number(cells[1]);
		if (!stamp || !Number.isFinite(watts)) continue;
		const [, y, mo, d, h, mi, s, frac] = stamp;
		const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
		samples.push([ms + Number(`0.${frac}`) * 1000, watts]);
	}
	return samples.sort((a, b) => a[0] - b[0]);
}

/**
 * Joules a power trace delivered between `from` and `to` (epoch ms): the trapezoid integral of the
 * samples inside the window, scaled to the window's length when the first and last sample fall
 * short of its edges. Null with fewer than three samples inside.
 */
export function integrateWatts(
	samples: readonly PowerSample[],
	from: number,
	to: number
): { joules: number; spanS: number; samples: number } | null {
	const inside = samples.filter(([ms]) => ms >= from && ms <= to);
	if (inside.length < 3) return null;
	let joules = 0;
	for (let i = 0; i + 1 < inside.length; i++) {
		const [t0, w0] = inside[i] as PowerSample;
		const [t1, w1] = inside[i + 1] as PowerSample;
		joules += ((t1 - t0) / 1000) * ((w0 + w1) / 2);
	}
	const spanS =
		((inside[inside.length - 1] as PowerSample)[0] - (inside[0] as PowerSample)[0]) / 1000;
	return { joules: (joules * ((to - from) / 1000)) / spanS, spanS, samples: inside.length };
}

/** the battery fields a phone window needs, as read from `AppleSmartBattery` */
export type BatteryRead = {
	update: number;
	secUwh: number;
	slAcc: number;
	slCnt: number;
	charging: boolean;
	capacity: number;
};

/** a battery read from the registry JSON `plutil -convert json` makes of the `ioregentry` plist */
export function batteryFromRegistry(json: unknown): BatteryRead {
	const registry = (json as { IORegistry?: Record<string, unknown> }).IORegistry;
	const telemetry = registry?.PowerTelemetryData as Record<string, number> | undefined;
	if (!registry || !telemetry)
		throw new Error('no AppleSmartBattery PowerTelemetryData in the registry');
	return {
		update: registry.UpdateTime as number,
		secUwh: telemetry.AccumulatedSystemEnergyConsumed as number,
		slAcc: telemetry.AccumulatedSystemLoad as number,
		slCnt: telemetry.SystemLoadAccumulatorCount as number,
		charging: registry.IsCharging as boolean,
		capacity: registry.CurrentCapacity as number
	};
}

/** one phone window from the reads at its first and last tick; `reads` holds every tick between */
export function phoneWindow(
	reads: readonly BatteryRead[],
	meta: { arm: string; round: number; navs: number; pace: number }
): Record<string, unknown> {
	const first = reads[0];
	const last = reads[reads.length - 1];
	if (!first || !last || reads.length < 2) throw new Error('a window needs at least two ticks');
	return {
		arm: meta.arm,
		round: meta.round,
		navs: meta.navs,
		pace: meta.pace,
		seconds: last.update - first.update,
		energy_j: (last.secUwh - first.secUwh) * 3.6e-3,
		mean_mw: (last.slAcc - first.slAcc) / Math.max(1, last.slCnt - first.slCnt),
		charging: reads.map((r) => r.charging),
		capacity: [first.capacity, last.capacity]
	};
}

/** the arms in the order a round runs them: the list rotated by the round number */
export function rotate<T>(arms: readonly T[], round: number, step = 1): T[] {
	const k = (round * step) % arms.length;
	return [...arms.slice(k), ...arms.slice(0, k)];
}

/** a deterministic shuffle (linear congruential, seeded) so a power sweep's order can be reproduced */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let s = seed >>> 0;
	const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}
