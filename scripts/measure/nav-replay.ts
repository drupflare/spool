import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NavModel, shouldAct, type NavOptions } from '../../src/protocol/navigation.ts';
import { JOULES_PER_BYTE, ORIGIN_JOULES } from '../../src/protocol/provision.ts';
import { DOCUMENT_BYTES } from '../../src/report/inputs.ts';
import type { Draft } from './lib.ts';
import { isMain, localMachine, MEASUREMENTS_DIR, utcDate, writeMeasurement } from './lib.ts';

const HELP = `Usage: bun scripts/measure/nav-replay.ts --data <msnbc990928.seq> [--out DIR] [--force]
       [--dry-run]

Replays the MSNBC category sequences (UCI dataset 133) through seven provisioning arms and writes
the accuracy counts and net joules per arm, entry size and z.`;

const Z_VALUES = [1.28, 0];
const ORACLE_WEIGHT = 1e9;
const KB = 1000;

/** the entry sizes replayed, each with the layer its number carries */
export const ENTRIES = [
	{ bytes: 473, layer: 'L1', source: 'measurements/payload, median compressed rendered node' },
	{ bytes: 2048, layer: 'L3', source: 'scenario' },
	{ bytes: DOCUMENT_BYTES.value, layer: 'L1', source: 'DOCUMENT_BYTES (src/report/inputs.ts)' }
] as const;

export type Route = { route: string; p: number; weight: number };

export type Predictor = {
	propose(user: number, context: readonly string[]): Route[];
	observe(user: number, context: readonly string[], next: string): void;
};

export type Arm = { name: string; make(): Predictor };

export type Case = { entryBytes: number; z: number };

export type ReplayOptions = { documentBytes: number; cases: readonly Case[] };

export type ArmResult = {
	arm: string;
	entryBytes: number;
	z: number;
	steps: number;
	firstSteps: number;
	provisions: number;
	hits: number;
	hit1: number;
	hit3: number;
	provisionedBytes: number;
	netJ: number;
	netJPerKB: number | null;
};

type Counts = {
	first: Record<string, Record<string, number>>;
	/** the same transitions, only those whose next route the visitor had not opened before */
	firstViews: Record<string, Record<string, number>>;
	marginal: Record<string, number>;
};

const byP = (a: Route, b: Route) =>
	b.p - a.p || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0);

/** the line index of the category names (the first non-blank line after the comment) and the names */
function headerNames(lines: readonly string[]): { index: number; names: string[] } {
	const at = lines.findIndex((line) => line.startsWith('% Different categories'));
	if (at < 0) throw new Error('no "% Different categories" header');
	const index = lines.findIndex((line, i) => i > at && line.trim() !== '');
	if (index < 0) throw new Error('the category header has no names');
	return { index, names: (lines[index] ?? '').trim().split(/\s+/) };
}

/** user sequences of category numbers 1 to N, N being the header's count of names */
export function parseSequences(text: string): number[][] {
	const lines = text.split(/\r?\n/);
	const { index: namesAt, names } = headerNames(lines);
	const max = names.length;
	const out: number[][] = [];
	lines.forEach((raw, i) => {
		const line = raw.trim();
		if (i === namesAt || line === '' || line.startsWith('%')) return;
		out.push(
			line.split(/\s+/).map((token) => {
				const category = Number(token);
				if (!/^\d+$/.test(token) || category < 1 || category > max) {
					throw new Error(`line ${i + 1}: "${token}" is not a category from 1 to ${max}`);
				}
				return category;
			})
		);
	});
	return out;
}

/** the next-category counts of the even-index users; the odd-index users are never counted */
export function trainCounts(sequences: readonly number[][]): Counts {
	const first: Record<string, Record<string, number>> = {};
	const firstViews: Record<string, Record<string, number>> = {};
	const marginal: Record<string, number> = {};
	for (let user = 0; user < sequences.length; user += 2) {
		const seq = sequences[user] ?? [];
		const opened = new Set<number>();
		for (let t = 1; t < seq.length; t++) {
			opened.add(seq[t - 1] as number);
			const prev = String(seq[t - 1]);
			const next = String(seq[t]);
			const row = (first[prev] ??= {});
			row[next] = (row[next] ?? 0) + 1;
			if (!opened.has(seq[t] as number)) {
				const fresh = (firstViews[prev] ??= {});
				fresh[next] = (fresh[next] ?? 0) + 1;
			}
			marginal[next] = (marginal[next] ?? 0) + 1;
		}
	}
	return { first, firstViews, marginal };
}

/** routes from counts, most probable first, each p its share of the counts */
function rank(counts: Record<string, number>): Route[] {
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
	return Object.entries(counts)
		.filter(([, n]) => n > 0)
		.map(([route, n]) => ({ route, p: n / total, weight: total }))
		.sort(byP);
}

function staticArm(name: string, ranked: Route[]): Arm {
	return {
		name,
		make: () => ({ propose: () => ranked, observe: () => {} })
	};
}

function populationArm(first: Record<string, Record<string, number>>): Arm {
	const table = new Map<string, Route[]>();
	for (const [prev, row] of Object.entries(first)) table.set(prev, rank(row));
	return {
		name: 'population-1',
		make: () => ({
			propose: (_user, context) => table.get(context[context.length - 1] ?? '') ?? [],
			observe: () => {}
		})
	};
}

/**
 * The share of all views from a page that were a first view of each next page: the first-view
 * counts over the whole row. A server can compute this from `spool.view` events (a first view has
 * the reason `cold` or `catalogue`), and it never exceeds the share among visitors who had not
 * opened the page.
 */
function firstViewArm(counts: Counts): Arm {
	const table = new Map<string, Route[]>();
	for (const [prev, row] of Object.entries(counts.first)) {
		const total = Object.values(row).reduce((sum, n) => sum + n, 0);
		const fresh = counts.firstViews[prev] ?? {};
		table.set(
			prev,
			Object.entries(fresh)
				.map(([route, n]) => ({ route, p: n / total, weight: total }))
				.sort(byP)
		);
	}
	return {
		name: 'population-first',
		make: () => ({
			propose: (_user, context) => table.get(context[context.length - 1] ?? '') ?? [],
			observe: () => {}
		})
	};
}

function navArm(name: string, options: NavOptions): Arm {
	return {
		name,
		make: () => {
			const model = new NavModel(options);
			return {
				propose: (_user, context) => model.predict(context),
				observe: (_user, context, next) => model.observe(context, next)
			};
		}
	};
}

/** proposes the true next route with certainty; reads the sequences it is replayed over */
function oracleArm(sequences: readonly number[][]): Arm {
	return {
		name: 'oracle',
		make: () => ({
			propose: (user, context) => {
				const next = sequences[user]?.[context.length];
				return next === undefined
					? []
					: [{ route: String(next), p: 1, weight: ORACLE_WEIGHT }];
			},
			observe: () => {}
		})
	};
}

export function buildArms(sequences: readonly number[][], counts: Counts): Arm[] {
	const prior = counts.first;
	return [
		staticArm('none', []),
		staticArm('popularity', rank(counts.marginal)),
		populationArm(counts.first),
		firstViewArm(counts),
		navArm('device-1', { order: 1 }),
		navArm('blend-1', { order: 1, prior, alpha: 5 }),
		navArm('blend-2', { order: 2, halfLife: 50, prior, alpha: 5 }),
		oracleArm(sequences)
	];
}

/**
 * Replays the odd-index users (the even ones are the population counts and are never scored). A
 * step is each position from the second; its context is the routes before it. A candidate is
 * provisioned when `shouldAct` says so and is held for the rest of the user's sequence. A page
 * the visitor already opened is held without a prediction, so it is never proposed and never a
 * hit: only the first view of a route (a `firstStep`) can be saved, and hit@1 and hit@3 rank the
 * candidates the visitor had not opened.
 */
export function replay(
	sequences: readonly number[][],
	arms: readonly Arm[],
	options: ReplayOptions
): ArmResult[] {
	const avoided = JOULES_PER_BYTE * options.documentBytes + ORIGIN_JOULES;
	const { cases } = options;
	const acc = arms.flatMap((arm) =>
		cases.map((c) => ({
			arm: arm.name,
			entryBytes: c.entryBytes,
			z: c.z,
			steps: 0,
			firstSteps: 0,
			provisions: 0,
			hits: 0,
			hit1: 0,
			hit3: 0,
			provisionedBytes: 0
		}))
	);
	for (let user = 1; user < sequences.length; user += 2) {
		const routes = (sequences[user] ?? []).map(String);
		const predictors = arms.map((arm) => arm.make());
		const held = arms.map(() => cases.map(() => new Set<string>()));
		for (let t = 1; t < routes.length; t++) {
			const context = routes.slice(0, t);
			const next = routes[t] as string;
			// a page the visitor opened is already held without a prediction
			const visited = new Set(context);
			const first = !visited.has(next);
			arms.forEach((_, a) => {
				const predictor = predictors[a] as Predictor;
				const open = predictor
					.propose(user, context)
					.slice()
					.sort(byP)
					.filter((r) => !visited.has(r.route));
				const top = open.slice(0, 3).map((r) => r.route);
				cases.forEach((c, k) => {
					const cell = acc[a * cases.length + k] as (typeof acc)[number];
					const provision = JOULES_PER_BYTE * c.entryBytes;
					const set = held[a]?.[k] as Set<string>;
					cell.steps++;
					if (first) {
						cell.firstSteps++;
						if (top[0] === next) cell.hit1++;
						if (top.includes(next)) cell.hit3++;
					}
					for (const cand of open) {
						if (set.has(cand.route)) continue;
						const input = { p: cand.p, weight: cand.weight, avoided, provision };
						if (!shouldAct(input, c.z)) continue;
						set.add(cand.route);
						cell.provisions++;
						cell.provisionedBytes += c.entryBytes;
					}
					if (first && set.has(next)) cell.hits++;
				});
				predictor.observe(user, context, next);
			});
		}
	}
	return acc.map((cell) => {
		const netJ = cell.hits * avoided - cell.provisions * JOULES_PER_BYTE * cell.entryBytes;
		return {
			...cell,
			netJ,
			netJPerKB: cell.provisions > 0 ? netJ / (cell.provisionedBytes / KB) : null
		};
	});
}

/** the edges of the probability bins calibration groups by; the last bin includes 1 */
export const CALIBRATION_EDGES = [0, 0.05, 0.1, 0.2, 0.4, 1] as const;

/** one probability bin of one arm: how often a candidate in it was the next route, against the probability the arm gave */
export type CalibrationRow = {
	arm: string;
	from: number;
	to: number;
	/** candidates in the bin, over every scored step, among pages the visitor had not opened */
	n: number;
	/** the mean probability the arm gave them */
	predicted: number;
	/** the share that was the next route */
	observed: number;
};

/**
 * Whether the probabilities an arm gives match how often those candidates came next. Every
 * candidate a visitor had not opened is binned by its probability at each scored step, so this does
 * not depend on any decision rule or entry size. The `none` and `oracle` arms are left out.
 */
export function calibration(
	sequences: readonly number[][],
	arms: readonly Arm[]
): CalibrationRow[] {
	const bins = CALIBRATION_EDGES.length - 1;
	const scored = arms.filter((arm) => arm.name !== 'none' && arm.name !== 'oracle');
	const acc = scored.map(() => Array.from({ length: bins }, () => ({ n: 0, p: 0, hits: 0 })));
	const binOf = (p: number) => {
		for (let i = 0; i < bins; i++) {
			if (p < (CALIBRATION_EDGES[i + 1] as number)) return i;
		}
		return bins - 1;
	};
	for (let user = 1; user < sequences.length; user += 2) {
		const routes = (sequences[user] ?? []).map(String);
		const predictors = scored.map((arm) => arm.make());
		for (let t = 1; t < routes.length; t++) {
			const context = routes.slice(0, t);
			const next = routes[t] as string;
			const visited = new Set(context);
			scored.forEach((_, a) => {
				const predictor = predictors[a] as Predictor;
				for (const cand of predictor.propose(user, context)) {
					if (visited.has(cand.route)) continue;
					const cell = (acc[a] as (typeof acc)[number])[
						binOf(cand.p)
					] as (typeof acc)[number][number];
					cell.n++;
					cell.p += cand.p;
					if (cand.route === next) cell.hits++;
				}
				predictor.observe(user, context, next);
			});
		}
	}
	return scored.flatMap((arm, a) =>
		(acc[a] as (typeof acc)[number]).flatMap((cell, i) =>
			cell.n === 0
				? []
				: [
						{
							arm: arm.name,
							from: CALIBRATION_EDGES[i] as number,
							to: CALIBRATION_EDGES[i + 1] as number,
							n: cell.n,
							predicted: cell.p / cell.n,
							observed: cell.hits / cell.n
						}
					]
		)
	);
}

/** sequence lengths: min, median, p90, max and mean, from the whole file */
export function lengthSummary(sequences: readonly number[][]) {
	const lengths = sequences.map((s) => s.length).sort((a, b) => a - b);
	const at = (q: number) =>
		lengths[Math.min(lengths.length - 1, Math.floor(q * (lengths.length - 1)))];
	const sum = lengths.reduce((total, n) => total + n, 0);
	return { min: at(0), median: at(0.5), p90: at(0.9), max: at(1), mean: sum / lengths.length };
}

function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			data: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false }
		}
	});
	return {
		data: values.data,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

export { parse };

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (!args.data) {
		throw new Error('pass --data <msnbc990928.seq>');
	} else if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'nav-replay',
					date: utcDate(),
					data: args.data,
					out: args.out,
					entries: ENTRIES.map((e) => e.bytes),
					z: Z_VALUES
				},
				null,
				2
			)
		);
	} else {
		const sequences = parseSequences(readFileSync(args.data, 'utf8'));
		const counts = trainCounts(sequences);
		const cases = ENTRIES.flatMap((e) => Z_VALUES.map((z) => ({ entryBytes: e.bytes, z })));
		const results = replay(sequences, buildArms(sequences, counts), {
			documentBytes: DOCUMENT_BYTES.value,
			cases
		});
		const layerOf = (bytes: number) => ENTRIES.find((e) => e.bytes === bytes)?.layer;
		const rows = results.map((r) => ({ ...r, entryLayer: layerOf(r.entryBytes) }));
		const bins = calibration(sequences, buildArms(sequences, counts)).map((r) => ({
			kind: 'calibration',
			...r
		}));
		const train = sequences.filter((_, i) => i % 2 === 0).length;
		const test = sequences.length - train;
		const scored = results[0]?.steps ?? 0;

		console.log(
			['arm', 'entry', 'z', 'hit@1', 'hit@3', 'prov', 'hits', 'netJ', 'J/KB'].join('\t')
		);
		for (const r of rows) {
			console.log(
				[
					r.arm,
					r.entryBytes,
					r.z,
					(r.hit1 / r.firstSteps).toFixed(4),
					(r.hit3 / r.firstSteps).toFixed(4),
					r.provisions,
					r.hits,
					r.netJ.toFixed(1),
					r.netJPerKB === null ? 'null' : r.netJPerKB.toFixed(6)
				].join('\t')
			);
		}

		const draft: Draft = {
			rig: 'nav-replay',
			date: utcDate(),
			layer: 'L1',
			question:
				'which provisioning arms repay their cost when replayed on a per-visitor sequence of page categories; the counts are L1, the net joules are L2 from those counts and the model constants, and the entry sizes are L1 for 473 and 17054 and L3 for 2048',
			instrument:
				'replay of the MSNBC category sequences through NavModel and frozen first-order counts, with JOULES_PER_BYTE and ORIGIN_JOULES from src/protocol/provision.ts',
			machine: localMachine(),
			software: { runtime: `Bun ${process.versions.bun}`, node: process.versions.node },
			method: {
				dataset: 'msnbc.com anonymous web data (UCI ML Repository dataset 133)',
				url: 'https://archive.ics.uci.edu/dataset/133/msnbc+com+anonymous+web+data',
				license: 'CC BY 4.0 (UCI dataset page)',
				file: 'msnbc990928.seq, from msnbc990928.seq.gz in the UCI zip',
				header: 'comment lines, then one line per user of space-separated category numbers 1 to 17; categories are in header order',
				categories:
					'frontpage, news, tech, local, opinion, on-air, misc, weather, msn-news, health, living, business, msn-sports, sports, summary, bbs, travel. Categories stand in for route classes; the data has no URLs.',
				span: 'one day, 28 September 1999 (file header); requests served by a cache are absent (file header)',
				users: { sequences: sequences.length, train, test },
				'sequence length': lengthSummary(sequences),
				'scored steps': scored,
				split: 'user index parity: even index trains the population counts and is never scored; odd index is scored',
				steps: 'each position from the second of a test user; context is the routes before it, newest last. The first view of a user has no context and is not scored',
				provision:
					'a candidate not yet held is provisioned when shouldAct gives true, with avoided = JOULES_PER_BYTE * documentBytes + ORIGIN_JOULES and provision = JOULES_PER_BYTE * entryBytes; no render, maintain or model term',
				hit: 'a first step is a hit when the held set holds the next route; a page the visitor already opened is held without a prediction, so it is never proposed and never counted',
				'hit@1 and hit@3':
					'the top 1 or top 3 proposals by p among pages the visitor had not opened, whatever shouldAct said; counted over first steps, the steps whose next route is new to the visitor',
				joules: 'netJ = hits * avoided - provisions * provision; netJPerKB = netJ / (provisionedBytes / 1000), null with no provisions',
				z: '1.28 for the decision and 0 (the point estimate) for every arm',
				documentBytes: `${DOCUMENT_BYTES.value} B (DOCUMENT_BYTES, L1)`,
				entries: ENTRIES.map((e) => ({ bytes: e.bytes, layer: e.layer, source: e.source })),
				arms: {
					none: 'provisions nothing',
					popularity:
						'the train share of each category as the next route, ignoring context',
					'population-1': 'first-order train counts, frozen',
					'population-first':
						'population-1 counting only transitions to a page the visitor had not opened, over every transition from the page (what a server can compute from view events)',
					'device-1': 'a fresh NavModel per test user, order 1, no prior',
					'blend-1':
						'a fresh NavModel per test user, order 1, prior = train first-order counts, alpha 5',
					'blend-2': 'as blend-1 with order 2 and halfLife 50',
					oracle: 'proposes the true next route with p 1 and weight 1e9'
				},
				calibration:
					'rows with kind calibration: for each arm but none and oracle, every candidate the visitor had not opened at each scored step is binned by its probability (edges 0, 0.05, 0.1, 0.2, 0.4, 1); predicted is the mean probability in the bin and observed the share that was the next route',
				limits: 'each visitor here is one session of a few pages on one day, so a device history is one session; the multi-day device learning the product relies on is not tested by this data. Categories are not URLs, and the data is a 1999 news portal.'
			},
			exclusions: [
				'the first view of each test user (no context)',
				'even-index users (population counts, never scored)',
				'blank and comment lines of the file (header, no user)'
			],
			rows: [...rows, ...bins] as unknown as Draft['rows']
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
