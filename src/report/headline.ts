import type { DemandCount } from './demand.js';
import {
	BOOTSTRAP_EXTRA_NO_WORKER,
	CF_FREE_REQUESTS_PER_DAY,
	paidRequestsUsd,
	requestsPerReadView,
	webkitStubPerReadView,
	type Workload
} from './economics.js';
import { DOCUMENT_BYTES, type Layer } from './inputs.js';
import type { Measurement } from './measurement.js';

/** engine classes the headline compares; WebKit under the default `workerMode: 'auto'` has no worker */
export const ENGINE_CLASSES = ['worker', 'webkit-auto', 'webkit-always', 'no-worker'] as const;

export type EngineClass = (typeof ENGINE_CLASSES)[number];

/** what each engine class is, as the page words it */
export const ENGINE_CLASS_LABELS: Record<EngineClass, string> = {
	worker: 'Chromium and Firefox, worker',
	'webkit-auto': 'WebKit, default (no worker)',
	'webkit-always': "WebKit, `workerMode: 'always'`",
	'no-worker': 'no worker'
};

/** the WebKit default registers no worker, so it is the no-worker class */
export const CLASS_OF_ENGINE_DEFAULT: Record<EngineClass, EngineClass> = {
	worker: 'worker',
	'webkit-auto': 'no-worker',
	'webkit-always': 'webkit-always',
	'no-worker': 'no-worker'
};

/** share of a baseline that spool avoids; negative where spool sends more than the baseline */
export function avoidedShare(baseline: number, spool: number): number {
	if (!(baseline > 0)) throw new RangeError(`baseline must be positive, got ${baseline}`);
	return (baseline - spool) / baseline;
}

/** baseline over spool; Infinity when spool sends nothing, below 1 when spool sends more */
export function multiplierOf(baseline: number, spool: number): number {
	if (!(baseline > 0)) throw new RangeError(`baseline must be positive, got ${baseline}`);
	return spool === 0 ? Infinity : baseline / spool;
}

/**
 * Requests per read view for a client with no worker. Each document navigation after the first
 * reaches the origin (L1, `never` arm in the WebKit lane), so `lifetimes x e - 1` of them add to the
 * bootstrap count. `e` is the workload's document navigations per lifetime.
 */
export function noWorkerRequestsPerReadView(w: Workload): number {
	const extra =
		(w.lifetimes * w.webkitNavigations.value - 1) / (w.lifetimes * w.viewsPerLifetime);
	return requestsPerReadView(w, BOOTSTRAP_EXTRA_NO_WORKER.value) + extra;
}

/** Worker requests per read view for an engine class; WebKit `auto` is the no-worker class */
export function requestsByClass(w: Workload, cls: EngineClass): number {
	switch (CLASS_OF_ENGINE_DEFAULT[cls]) {
		case 'worker':
			return requestsPerReadView(w);
		case 'webkit-always':
			return requestsPerReadView(w) + webkitStubPerReadView(w);
		default:
			return noWorkerRequestsPerReadView(w);
	}
}

/** the best and the worst engine class for one workload, by requests per read view */
export function bestAndWorst(
	w: Workload,
	baseline: number
): {
	best: { cls: EngineClass; requests: number; share: number; multiplier: number };
	worst: { cls: EngineClass; requests: number; share: number; multiplier: number };
	reversed: EngineClass[];
} {
	const rows = ENGINE_CLASSES.map((cls) => {
		const requests = requestsByClass(w, cls);
		return {
			cls,
			requests,
			share: avoidedShare(baseline, requests),
			multiplier: multiplierOf(baseline, requests)
		};
	});
	const sorted = [...rows].sort((a, b) => a.requests - b.requests);
	return {
		best: sorted[0]!,
		worst: sorted[sorted.length - 1]!,
		reversed: rows.filter((r) => r.requests >= baseline).map((r) => r.cls)
	};
}

/** monthly Worker requests and the paid-plan dollars for `views` read views at `requests` each */
export function paidMonth(views: number, requests: number): { requests: number; usd: number } {
	return { requests: views * requests, usd: paidRequestsUsd(views * requests) };
}

/** a headline figure as the pages print it; `layer` is required and checked by {@link requireLayers} */
export type Headline = {
	id: string;
	name: string;
	baseline: string;
	/** share avoided, a fraction; negative where spool sends more */
	share: number;
	multiplier: number;
	layer: Layer | '';
	basis: 'net' | 'gross' | 'floor';
	scope: string;
};

const LAYERS = new Set(['L0', 'L1', 'L2', 'L3']);

/** throws a RangeError naming every headline whose layer is missing or not one of L0 to L3 */
export function requireLayers(rows: readonly Headline[]): readonly Headline[] {
	const bad = rows.filter((r) => !LAYERS.has(r.layer)).map((r) => r.id);
	if (bad.length) throw new RangeError(`headline without a layer: ${bad.join(', ')}`);
	return rows;
}

// #region library readings
type DemandRow = {
	engine: string;
	scenario: string;
	arm: string;
	views: number;
	requests: number;
	bytes: number;
	wrong?: number;
	fatal?: string;
	paths?: Record<string, number>;
	days?: Array<{ byType?: Record<string, { requests: number; bytes: number }> }>;
};

const rowsOf = (reading: Measurement): DemandRow[] => reading.rows as unknown as DemandRow[];

const usable = (r: DemandRow): boolean => !r.fatal && !(r.wrong && r.wrong > 0);

/** paths the demand site's spool arm requests, by role */
export const DEMAND_PATHS = {
	boot: 'GET /.spool/1.0.0/boot/1.js',
	stub: 'GET /spool-sw.js'
} as const;

/** baseline and spool request counts for every scenario and engine where both arms finished (L1) */
export function demandCounts(reading: Measurement): DemandCount[] {
	const rows = rowsOf(reading).filter(usable);
	const out: DemandCount[] = [];
	for (const spool of rows.filter((r) => r.arm === 'spool')) {
		const base = rows.find(
			(r) =>
				r.arm === 'baseline' && r.engine === spool.engine && r.scenario === spool.scenario
		);
		if (!base) continue;
		out.push({
			scenario: spool.scenario,
			engine: spool.engine,
			views: spool.views,
			baseline: base.requests,
			spool: spool.requests
		});
	}
	return out;
}

/** bytes of the baseline and spool arms for a scenario and engine (L1) */
export function demandBytes(
	reading: Measurement,
	engine: string,
	scenario: string
): { baseline: number; spool: number } {
	const rows = rowsOf(reading).filter(usable);
	const base = rows.find(
		(r) => r.arm === 'baseline' && r.engine === engine && r.scenario === scenario
	);
	const spool = rows.find(
		(r) => r.arm === 'spool' && r.engine === engine && r.scenario === scenario
	);
	if (!base || !spool) throw new RangeError(`no finished ${engine} arms for ${scenario}`);
	return { baseline: base.bytes, spool: spool.bytes };
}

/** Worker-invocation equivalents: every request but the boot script and the stub, which a static tier serves (L2) */
export function workerRequests(row: { requests: number; paths?: Record<string, number> }): number {
	const paths = row.paths ?? {};
	return row.requests - (paths[DEMAND_PATHS.boot] ?? 0) - (paths[DEMAND_PATHS.stub] ?? 0);
}

/** Worker-invocation equivalents with a stub and boot script on a static tier, per finished scenario (L2) */
export function demandWorkerCounts(reading: Measurement): DemandCount[] {
	const rows = rowsOf(reading).filter(usable);
	return demandCounts(reading).map((c) => {
		const spool = rows.find(
			(r) => r.arm === 'spool' && r.engine === c.engine && r.scenario === c.scenario
		)!;
		return { ...c, spool: workerRequests(spool) };
	});
}

/** network documents a spool arm sent: every request but the boot script, the stub, the beacon and a favicon (L2) */
export function documentRequests(row: {
	requests: number;
	paths?: Record<string, number>;
}): number {
	const paths = row.paths ?? {};
	return (
		workerRequests(row) - (paths['POST /.spool/beacon'] ?? 0) - (paths['GET /favicon.ico'] ?? 0)
	);
}

/** network documents the spool arm of each finished scenario sent, in the `spool` field (L2) */
export function demandDocumentCounts(reading: Measurement): DemandCount[] {
	const rows = rowsOf(reading).filter(usable);
	return demandCounts(reading).map((c) => {
		const spool = rows.find(
			(r) => r.arm === 'spool' && r.engine === c.engine && r.scenario === c.scenario
		)!;
		return { ...c, spool: documentRequests(spool) };
	});
}

/** sizes the library adds to a view, from the readings (L1) */
export type LibraryBytes = {
	/** bytes the ring and runtime tag add to a document, spool arm over baseline arm, one view */
	ring: number;
	/** the boot script and pack, fetched once per bootstrap */
	boot: number;
	/** the worker script, fetched unconditionally on every held day in the multi-day reading */
	stub: number;
};

/** the three sizes from the single-day reading (ring) and the multi-day reading (boot, stub) */
export function libraryBytes(single: Measurement, days: Measurement): LibraryBytes {
	const one = demandCounts(single).find((c) => c.views === 1 && c.engine === 'chromium');
	if (!one) throw new RangeError('the single-day reading has no finished one-view Chromium pair');
	const bytes = demandBytes(single, 'chromium', one.scenario);
	const types = rowsOf(days)
		.filter((r) => usable(r) && r.arm === 'spool')
		.flatMap((r) => r.days ?? [])
		.flatMap((d) => Object.entries(d.byType ?? {}));
	const size = (type: string): number => {
		const found = types.find(([name, v]) => name === type && v.bytes > 0);
		if (!found) throw new RangeError(`the multi-day reading has no ${type} bytes`);
		return found[1].bytes;
	};
	return { ring: bytes.spool - bytes.baseline, boot: size('asset'), stub: size('stub') };
}

/** the stub's header bytes on a 304, counted from the response object (L1, Mac, 2 s lease, lane ST) */
export const STUB_304_BYTES = 169;

/** the stub on a full re-check in the lane ST rig, bytes (L1) */
export const STUB_FULL_ST_BYTES = 137_529;

/**
 * Bytes a client sends over `documents` network documents, one bootstrap and `stubFetches` stub
 * fetches, with documents of `documentBytes` plus the ring on each (L2 over L1 sizes).
 */
export function spoolBytes(args: {
	documents: number;
	documentBytes?: number;
	stubFetches: number;
	stubBytes: number;
	bootFetches?: number;
	sizes: LibraryBytes;
}): number {
	const doc = args.documentBytes ?? DOCUMENT_BYTES.value;
	return (
		args.documents * (doc + args.sizes.ring) +
		(args.bootFetches ?? 1) * args.sizes.boot +
		args.stubFetches * args.stubBytes
	);
}

/** the document views of a stub fetch that repay it: stub bytes over document bytes (L2) */
export const repaidAfter = (
	stubBytes: number,
	documentBytes: number = DOCUMENT_BYTES.value
): number => stubBytes / documentBytes;

/**
 * Net bytes saved per read view as a share of the baseline document, for a workload with a worker.
 * Held views save a document; a network view pays the ring; one bootstrap per `lifetimes` pays the
 * boot script; each lifetime pays `stubFetches` stub fetches (L3 count). Negative is a loss.
 */
export function netBytesShare(
	w: Workload,
	held: number,
	sizes: LibraryBytes,
	stubBytes: number,
	stubFetches = 1
): number {
	const doc = DOCUMENT_BYTES.value;
	const v = w.viewsPerLifetime;
	const saved =
		held * doc -
		(1 - held) * sizes.ring -
		sizes.boot / (w.lifetimes * v) -
		(stubFetches * stubBytes) / v;
	return saved / doc;
}
// #endregion

// #region moving numbers
export type StageStatus = 'current' | 'superseded' | 'withdrawn';

/** one row of a moving-numbers table; a count pair gives the ratio, otherwise `figure` is the text */
export type Stage = {
	quantity: 'origin' | 'reader' | 'free' | 'bytes' | 'worker' | 'energy';
	stage: string;
	date: string;
	baseline?: number;
	spool?: number;
	/** the printed figure of a row whose source gives no count pair */
	figure?: string;
	condition: string;
	layer: Layer;
	source: string;
	status: StageStatus;
};

/** the multiplier of a stage with a count pair; throws on a stage with none */
export function stageMultiplier(s: Stage): number {
	if (s.baseline === undefined || s.spool === undefined)
		throw new RangeError(`stage ${s.stage} has no count pair`);
	return multiplierOf(s.baseline, s.spool);
}

/**
 * Stages before the library, with the counts each source printed. Rows come from the earlier stage reports, named by date.
 * Every ratio is the two counts
 * divided; no source's ratio is typed in.
 */
export const HISTORY: readonly Stage[] = [
	{
		quantity: 'origin',
		stage: 'v0.4',
		date: '2026-11-16',
		figure: 'no count; bars of 3x to 1,500x proposed',
		condition: 'targets, none measured',
		layer: 'L3',
		source: 'v0.4 interim, 2026-11-16',
		status: 'withdrawn'
	},
	{
		quantity: 'origin',
		stage: 'original v1, minimal construction',
		date: '2026-11-18',
		baseline: 121,
		spool: 3,
		condition: "Chromium, Codex's 121-view mix, scratch model, loopback, all requests",
		layer: 'L2',
		source: 'v1 review, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'origin',
		stage: 'original v1, Codex construction',
		date: '2026-11-18',
		baseline: 121,
		spool: 4,
		condition: "Chromium, same mix, Codex's construction",
		layer: 'L2',
		source: 'v1 review, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'origin',
		stage: 'follow-ups, retrofit',
		date: '2026-11-18',
		baseline: 121,
		spool: 4,
		condition: 'Chromium and Firefox, same mix, local clone under workerd, no deployment',
		layer: 'L2',
		source: 'follow-ups, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'origin',
		stage: 'follow-ups, retrofit, WebKit origin requests',
		date: '2026-11-18',
		baseline: 121,
		spool: 23,
		condition: 'WebKit, same mix, each navigation adds a script check',
		layer: 'L2',
		source: 'follow-ups, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'origin',
		stage: 'follow-ups, retrofit, WebKit Worker calls',
		date: '2026-11-18',
		baseline: 121,
		spool: 6,
		condition: 'WebKit, same mix, Worker calls only, not origin requests',
		layer: 'L2',
		source: 'follow-ups, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'origin',
		stage: 'first library run',
		date: '2026-11-18',
		baseline: 121,
		spool: 9,
		condition: 'Chromium, same mix, library, one run per arm',
		layer: 'L2',
		source: 'first library run, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'original v1, daily reader',
		date: '2026-11-18',
		baseline: 600,
		spool: 68,
		condition: '20 views in 2 visits over 30 days, Chromium, scratch model count',
		layer: 'L3',
		source: 'v1 review, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'original v1, engaged reader',
		date: '2026-11-18',
		baseline: 3000,
		spool: 98,
		condition: '100 views in 3 visits over 30 days, Chromium, scratch model count',
		layer: 'L3',
		source: 'v1 review, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'original v1, one tab all day',
		date: '2026-11-18',
		baseline: 60000,
		spool: 38,
		condition:
			'2,000 views in one visit; a floor-based bound over a model count, never a measured count',
		layer: 'L3',
		source: 'v1 review, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'review 2, daily reader',
		date: '2026-11-18',
		baseline: 601,
		spool: 33,
		condition:
			'600 views in 60 visits over 30 days, Chromium 157 headless on Linux, final construction',
		layer: 'L3',
		source: 'review 2, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'review 2, engaged reader',
		date: '2026-11-18',
		baseline: 3001,
		spool: 33,
		condition: '3,000 views in 90 visits, same construction',
		layer: 'L3',
		source: 'review 2, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'review 2, one tab all day, low end',
		date: '2026-11-18',
		baseline: 60001,
		spool: 33,
		condition:
			'60,000 in-page views; a floor-based bound over a model count, never a measured count',
		layer: 'L3',
		source: 'review 2, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'review 2, one tab all day, high end',
		date: '2026-11-18',
		baseline: 60001,
		spool: 28,
		condition: 'same row at 28 requests; a floor-based bound, never a measured count',
		layer: 'L3',
		source: 'review 2, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'review 2, population of 40 clients',
		date: '2026-11-18',
		baseline: 259,
		spool: 112,
		condition: 'mixed visits, same construction',
		layer: 'L3',
		source: 'review 2, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'reader',
		stage: 'library today, earlier tree, daily reader',
		date: '2026-11-20',
		baseline: 5,
		spool: 8,
		condition:
			'one view a day for 5 days, Chromium, before the third-view window of src/client/gate.ts; 495,557 B against 645 B',
		layer: 'L2',
		source: '`measurements/demand/2026-11-20-days.json`',
		status: 'superseded'
	},
	{
		quantity: 'free',
		stage: 'follow-ups, retrofit',
		date: '2026-11-18',
		figure: 'views a day: 100,000 x 121 / 4 = 3,025,000 (Chromium, Firefox); 100,000 x 121 / 6 = 2,016,666 (WebKit)',
		condition:
			'Free-plan allowance over Worker calls; the source says it is not a deployed quota test',
		layer: 'L2',
		source: 'follow-ups, 2026-11-18',
		status: 'superseded'
	},
	{
		quantity: 'worker',
		stage: 'original v1 and review 2, static host',
		date: '2026-11-18',
		figure: '121x, 600x, 3,000x and 60,000x over one Worker invocation',
		condition:
			'the stub, pack and client served as static files; the 1 is one measured session on a Free test Worker, the workloads are L3',
		layer: 'L3',
		source: 'v1 review and review 2, 2026-11-18',
		status: 'current'
	},
	{
		quantity: 'bytes',
		stage: 'original v1',
		date: '2026-11-18',
		figure: 'spool sends more bytes than no spool at 10 views on 1 to 3 KB documents; no figure',
		condition: 'direction only',
		layer: 'L1',
		source: 'v1 restart notes, 2026-11-18',
		status: 'current'
	},
	{
		quantity: 'bytes',
		stage: 'v0.3 and v0.4, dataset update',
		date: 'date not recorded',
		figure: '227 to 232 B for one changed row against 2,236 to 191,744 B for a list refetch of 50 to 5,000 rows',
		condition: 'synthetic rows; a dataset, not a document',
		layer: 'L1',
		source: 'v0.4 release notes',
		status: 'current'
	}
];

/** library-today stages computed from the two demand readings (L1 counts, L2 ratios) */
export function libraryStages(
	single: Measurement,
	days: Measurement,
	daysFile = 'demand/2026-11-20-days.json',
	singleFile = 'demand/2026-11-20-single.json'
): Stage[] {
	const mark = (
		c: DemandCount,
		q: Stage['quantity'],
		reading: Measurement,
		what: string
	): Stage => ({
		quantity: q,
		stage:
			q === 'reader'
				? `library today, final tree, ${c.engine}`
				: `library today, ${c.engine}`,
		date: reading.date,
		baseline: c.baseline,
		spool: c.spool,
		condition: `${c.scenario}; ${what}`,
		layer: 'L2',
		source: `\`measurements/${q === 'reader' ? daysFile : singleFile}\``,
		status: 'current'
	});
	const mix = demandCounts(single).filter((c) => c.views === 121);
	const long = demandCounts(days);
	const worker = demandWorkerCounts(single).filter((c) => c.views === 121);
	return [
		...mix.map((c) => mark(c, 'origin', single, 'all origin requests, counted')),
		...long.map((c) =>
			mark(c, 'reader', days, 'all origin requests, counted, one lease length')
		),
		...worker.map((c) => ({
			...mark(c, 'worker', single, 'stub and boot script on a static tier'),
			stage: `library today, ${c.engine}, Worker-invocation equivalents`
		}))
	];
}
// #endregion

/** read views a day at `baselineRequests` and `spoolRequests` per view, over the Free-plan allowance */
export function freeViewsPair(
	baseline: number,
	spool: number
): { baseline: number; spool: number; multiplier: number } {
	const limit = CF_FREE_REQUESTS_PER_DAY.value;
	return {
		baseline: limit / baseline,
		spool: spool === 0 ? Infinity : limit / spool,
		multiplier: multiplierOf(baseline, spool)
	};
}
