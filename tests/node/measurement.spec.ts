import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	deviceCpuFigures,
	findLeaks,
	inferenceFigures,
	MeasurementError,
	measurementPath,
	measurementProblems,
	parseMeasurement,
	parseMeasurementText,
	pathMatches,
	phoneRun,
	powerSweep,
	raplRun,
	repeatNavFigures,
	RIGS,
	serialiseMeasurement,
	zeroNetworkFigures,
	type Measurement
} from '../../src/report/index';

const ROOT = fileURLToPath(new URL('../../measurements/', import.meta.url));

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name))
			: e.name.endsWith('.json')
				? [join(dir, e.name)]
				: []
	);
}

const FILES = walk(ROOT).map((path) => relative(ROOT, path));

const load = (name: string): Measurement =>
	parseMeasurementText(readFileSync(join(ROOT, name), 'utf8'), name);

const valid = (): Record<string, unknown> => ({
	schema: 1,
	rig: 'rapl',
	date: '2026-10-19',
	layer: 'L1',
	question: 'q',
	instrument: 'i',
	machine: { name: 'box', cores: 12 },
	software: { browser: 'x' },
	method: { rounds: 1 },
	exclusions: [],
	rows: [{ arm: 'a' }]
});

describe('the measurement format', () => {
	it('accepts a complete document', () => {
		expect(measurementProblems(valid())).toEqual([]);
		expect(parseMeasurement(valid()).rig).toBe('rapl');
	});

	it.each([
		['a non-object', 'x', 'the file is not a JSON object'],
		['a wrong schema', { schema: 2 }, 'schema must be 1'],
		['an unknown rig', { rig: 'toaster' }, 'rig must be one of'],
		['a bad date', { date: '2026-02-30' }, 'date must be a real UTC date'],
		['a date with a time', { date: '2026-10-19T00:00:00Z' }, 'date must be a real UTC date'],
		['a derived layer', { layer: 'L2' }, 'layer must be L1'],
		['an empty question', { question: ' ' }, 'question must be a non-empty string'],
		['no instrument', { instrument: undefined }, 'instrument must be a non-empty string'],
		['an unnamed machine', { machine: { cpu: 'x' } }, 'machine needs a name'],
		['a nested machine value', { machine: { name: 'a', extra: { b: 1 } } }, 'machine values'],
		['a numeric software version', { software: { a: 1 } }, 'software must map'],
		['a method list', { method: [] }, 'method must be an object'],
		['an exclusion that is not text', { exclusions: [1] }, 'exclusions must be a list'],
		['no rows', { rows: [] }, 'rows must be a non-empty list'],
		['a row that is not an object', { rows: [1] }, 'rows must be a non-empty list']
	])('rejects %s', (_, change, problem) => {
		const doc = typeof change === 'object' ? { ...valid(), ...change } : change;
		expect(measurementProblems(doc).join('\n')).toContain(problem);
	});

	it('reports every problem in one error and names the source', () => {
		const error = (() => {
			try {
				parseMeasurement({ ...valid(), schema: 9, rows: [] }, 'rapl/x.json');
			} catch (e) {
				return e as MeasurementError;
			}
		})();
		expect(error).toBeInstanceOf(MeasurementError);
		expect(error?.problems).toHaveLength(2);
		expect(error?.message).toMatch(/^rapl\/x\.json: /);
	});

	it('refuses invalid JSON and files that carry device ids, container ids or addresses', () => {
		expect(() => parseMeasurementText('{', 'a.json')).toThrow(/invalid JSON/);
		const withText = (extra: Record<string, unknown>) =>
			JSON.stringify({ ...valid(), ...extra });
		expect(() => parseMeasurementText(withText({ udid: '00008120-00015880216BC01E' }))).toThrow(
			/device id/
		);
		expect(() => parseMeasurementText(withText({ other: { '578b7b29bf94': 1 } }))).toThrow(
			/container id/
		);
		expect(() => parseMeasurementText(withText({ note: 'from 192.168.1.20' }))).toThrow(
			/IP address/
		);
		expect(parseMeasurementText(withText({ note: 'http://127.0.0.1:8931' })).rig).toBe('rapl');
		expect(findLeaks('nothing here')).toEqual([]);
	});

	it('names the file after the rig, the date and an optional experiment', () => {
		const m = { rig: 'iphone', date: '2026-10-19' } as const;
		expect(measurementPath(m)).toBe('iphone/2026-10-19.json');
		expect(measurementPath(m, 'burst')).toBe('iphone/2026-10-19-burst.json');
		expect(pathMatches('iphone/2026-10-19-burst.json', m)).toBe(true);
		expect(pathMatches('iphone/2026-10-19.json', m)).toBe(true);
		expect(pathMatches('rapl/2026-10-19.json', m)).toBe(false);
		expect(pathMatches('iphone/2026-10-20.json', m)).toBe(false);
	});

	it('round-trips through serialise and parse with schema first', () => {
		const { schema, ...draft } = valid() as unknown as Measurement;
		void schema;
		const text = serialiseMeasurement(draft);
		expect(text.startsWith('{\n\t"schema": 1,')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
		expect(parseMeasurementText(text).rows).toEqual([{ arm: 'a' }]);
	});
});

describe('the published files', () => {
	it('finds files in every rig folder', () => {
		const folders = new Set(FILES.map((f) => f.split('/')[0]));
		expect([...folders].sort()).toEqual([...RIGS].sort());
	});

	it.each(FILES)('%s validates, sits under its rig and date, and carries no ids', (name) => {
		const m = load(name);
		expect(pathMatches(name, m)).toBe(true);
		expect(readFileSync(join(ROOT, name), 'utf8').endsWith('\n')).toBe(true);
	});

	it('lists every rig in the README table', () => {
		const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
		for (const rig of RIGS) expect(readme).toContain(`\`${rig}\``);
	});
});

describe('figures from the published files', () => {
	it('keeps zero service-worker navigations off the origin in Chromium and Firefox', () => {
		const figures = zeroNetworkFigures(load('zero-network/2026-10-18.json').rows);
		const tuned = figures.filter((f) => f.arm.startsWith('updateViaCache all'));
		expect(tuned.map((f) => [f.engine, f.viewsWithHits])).toEqual([
			['chromium', 0],
			['firefox', 0],
			['webkit', 5]
		]);
		expect(
			Object.keys(
				figures.find((f) => f.engine === 'webkit' && f.arm.startsWith('updateViaCache'))
					?.hits ?? {}
			)
		).toEqual(['/sw.js']);
	});

	it('has eight rounds for every arm of the views run and no dropped window', () => {
		const run = raplRun(load('rapl/2026-10-19-views.json').rows);
		expect(run.dropped).toBe(0);
		expect(
			Object.fromEntries(Object.entries(run.arms).map(([arm, f]) => [arm, f.windows]))
		).toEqual({
			network: 8,
			spool: 8,
			shipping: 8
		});
		expect(run.arms['spool']?.originRequests).toBeLessThan(0.01);
	});

	it('has five usable rounds and 120 output tokens per request in the inference run', () => {
		const figures = inferenceFigures(load('rapl/2026-10-19-inference.json'));
		expect(figures.rounds).toBe(5);
		expect(figures.outputTokens).toBe(120);
	});

	it('has both sets in the power-state file', () => {
		const rows = load('rapl/2026-10-19-power-state.json').rows;
		expect(powerSweep(rows, 'sweep').conditions).toHaveLength(22);
		expect(powerSweep(rows, 'timer').conditions).toHaveLength(7);
	});

	it('has no charging window among the used phone windows', () => {
		for (const name of ['iphone/2026-10-19-burst.json', 'iphone/2026-10-19-projection.json']) {
			expect(phoneRun(load(name).rows).dropped).toBe(0);
		}
	});

	it('counts the navigations that loaded, per kind, without the 403 block page', () => {
		const figures = repeatNavFigures(load('repeat-nav/2026-10-18.json').rows);
		expect(Object.keys(figures).sort()).toEqual([
			'cold-home',
			'warm-home-repeat',
			'warm-internal'
		]);
		expect(figures['cold-home']?.sites).toBe(15);
	});

	it('reads two arms and two runs in the device CPU file', () => {
		const figures = deviceCpuFigures(load('device-cpu/2026-10-18.json'));
		expect(figures['spool']?.serverHits).toBe(0);
		expect(figures['network']?.runs).toBe(2);
	});
});
