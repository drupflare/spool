import {
	CF_FREE_REQUESTS_PER_DAY,
	DOCUMENT_BYTES,
	ENGINE_CLASS_LABELS,
	HISTORY,
	NOT_SHIPPED,
	STUB_304_BYTES,
	WORKLOADS,
	avoidedShare,
	baselinePerReadView,
	bestAndWorst,
	demandBytes,
	demandCounts,
	demandDocumentCounts,
	demandWorkerCounts,
	freeReadViewsPerDay,
	heldShare,
	libraryBytes,
	libraryStages,
	multiplierOf,
	netBytesShare,
	paidMonth,
	repaidAfter,
	requestsByClass,
	requireLayers,
	spoolBytes,
	spoolControlled,
	stageMultiplier,
	type DemandCount,
	type Headline,
	type Measurement,
	type Provenance,
	type Stage
} from '../src/report/index';
import type { Figures, Readings } from './impact';

export const DEMAND_READING = 'demand/2026-11-20-single.json';
export const DAYS_READING = 'demand/2026-11-20-days-ship-a.json';
export const SESSION_READING = 'demand/2026-11-20-days-ship-b.json';
export const PERSISTENT_READING = 'demand/2026-11-20-days-ship-c.json';

const PERSISTENT_STAYS =
	'Principal reader, session stays valid, persistent retention and depends on members';
const PERSISTENT_ENDS =
	'Principal reader, session ends on the server after day 2, persistent retention and depends on members';
const SESSION_STAYS = 'Principal reader, session stays valid, session retention';
const SESSION_ENDS = 'Principal reader, session ends on the server after day 2, session retention';

type DayRow = {
	engine: string;
	scenario: string;
	arm: string;
	days?: { day: number; requests: number }[];
};

/** the three formatting helpers of `scripts/impact.ts`, passed in so the two scripts do not import each other */
export type Helpers = {
	fixed: (value: number, digits?: number) => string;
	table: (headers: string[], rows: string[][], right?: number[]) => string;
	pinned: (readings: Readings, name: string) => Measurement;
};

const MONTHLY_VIEWS = 1e8;

/** the figures every page that carries the headline section prints; each page uses a subset */
export function buildHeadlineFigures(readings: Readings, h: Helpers): Figures {
	const { fixed, table } = h;
	const pct = (z: number): string => `${fixed(z * 100, 1)}%`;
	const times = (x: number): string =>
		!Number.isFinite(x)
			? 'no finite value'
			: x < 1
				? `${Number(x.toPrecision(2))}x`
				: `${fixed(x, x < 100 ? 2 : 0)}x`;
	const pct3 = (z: number): string => `${fixed(z * 100, 3)}%`;
	const pct2 = (z: number): string => `${fixed(z * 100, 2)}%`;
	const single = h.pinned(readings, DEMAND_READING);
	const days = h.pinned(readings, DAYS_READING);
	const session = h.pinned(readings, SESSION_READING);
	const persistent = h.pinned(readings, PERSISTENT_READING);
	const scenarioPair = (from: Measurement, name: string, engine = 'chromium'): DemandCount => {
		const found = demandCounts(from).find((c) => c.engine === engine && c.scenario === name);
		if (!found) throw new Error(`no finished Chromium pair for ${name}`);
		return found;
	};
	const dayRequests = (
		from: Measurement,
		name: string,
		arm: 'baseline' | 'spool',
		day: number
	): number => {
		const row = (from.rows as unknown as DayRow[]).find(
			(r) => r.engine === 'chromium' && r.scenario === name && r.arm === arm
		);
		const found = row?.days?.find((d) => d.day === day);
		if (!found) throw new Error(`no day ${day} for the ${arm} arm of ${name}`);
		return found.requests;
	};
	const workerInvocations = (reading: Measurement): number =>
		(reading.rows as unknown as { phase?: string; worker_invocations?: number }[])
			.filter((r) => r.phase !== undefined)
			.reduce((sum, r) => sum + (r.worker_invocations ?? 0), 0);
	const staticPair = (engine: string, spoolArm: string) => ({
		baseline: workerInvocations(
			h.pinned(readings, `static-host/2026-11-20-${engine}-no-spool.json`)
		),
		spool: workerInvocations(
			h.pinned(readings, `static-host/2026-11-20-${engine}-${spoolArm}.json`)
		)
	});
	const tabChromium = scenarioPair(single, 'One tab, 2,000 views');
	const tabFirefox = scenarioPair(single, 'One tab, 2,000 views', 'firefox');
	const signedInPair = scenarioPair(persistent, PERSISTENT_STAYS);
	const sessionPair = scenarioPair(session, SESSION_STAYS);
	const revokedPair = scenarioPair(persistent, PERSISTENT_ENDS);
	const familyEditPair = scenarioPair(days, 'Public edit: a held course changes between days');
	const storedEditPair = scenarioPair(
		days,
		'Public edit, stored page route with depends: a held course changes between days'
	);
	const sizes = libraryBytes(single, days);
	const doc = DOCUMENT_BYTES.value;
	const counts = demandCounts(single);
	const longCounts = demandCounts(days);
	const workerCounts = demandWorkerCounts(single);
	const workerLong = demandWorkerCounts(days);
	const mix = (engine: string, from: DemandCount[] = counts): DemandCount => {
		const found = from.find((c) => c.engine === engine && c.views === 121);
		if (!found) throw new Error(`no finished ${engine} 121-view pair in the demand reading`);
		return found;
	};
	const daily = (from: DemandCount[]): DemandCount => {
		const found = from.find(
			(c) => c.engine === 'chromium' && c.scenario.startsWith('Daily reader')
		);
		if (!found)
			throw new Error('no finished Chromium daily-reader pair in the multi-day reading');
		return found;
	};
	const localOnly = (from: DemandCount[]): DemandCount => {
		const found = from.find(
			(c) => c.engine === 'chromium' && c.scenario.startsWith('Local-only')
		);
		if (!found)
			throw new Error('no finished Chromium local-only pair in the multi-day reading');
		return found;
	};
	const chromiumMix = mix('chromium');
	const firefoxMix = mix('firefox');
	const bytesMix = demandBytes(single, 'chromium', chromiumMix.scenario);
	const bytesDaily = demandBytes(days, 'chromium', daily(longCounts).scenario);
	const mixDocuments = mix('chromium', demandDocumentCounts(single)).spool;
	const dailyDocuments = daily(demandDocumentCounts(days)).spool;
	const dailyStubFetches = 3;
	const medianBaseline = chromiumMix.views * doc;
	const medianSpool = spoolBytes({
		documents: mixDocuments,
		stubFetches: 1,
		stubBytes: sizes.stub,
		sizes
	});
	const dailyBaseline = daily(longCounts).views * doc;
	const dailyFull = spoolBytes({
		documents: dailyDocuments,
		stubFetches: dailyStubFetches,
		stubBytes: sizes.stub,
		sizes
	});
	const dailyRevalidated =
		spoolBytes({ documents: dailyDocuments, stubFetches: 1, stubBytes: sizes.stub, sizes }) +
		(dailyStubFetches - 1) * STUB_304_BYTES;

	const pair = (c: { baseline: number; spool: number }) =>
		[avoidedShare(c.baseline, c.spool), multiplierOf(c.baseline, c.spool)] as const;
	const headline = (
		id: string,
		name: string,
		baseline: string,
		[share, multiplier]: readonly [number, number],
		layer: Headline['layer'],
		basis: Headline['basis'],
		scope: string
	): Headline => ({
		id,
		name,
		baseline,
		share,
		multiplier,
		layer,
		basis,
		scope,
		provenance: PROVENANCE_OF[id]!
	});
	const shipped = (from: Measurement, name: string, engine = 'chromium'): Provenance =>
		spoolControlled(from, engine, name)
			? 'library 1.0.0, measured'
			: 'library 1.0.0 page runtime, no worker';
	const SIGNED_IN_ON =
		'not what a default install produces: needs `principalDatasets: true`, the `identity` option and a principal route; behind `spoolProxy`, a public route sends a request with a cookie outside the allowlist or an `Authorization` header to the origin, and a principal route needs `identity`';
	const PROVENANCE_OF: Record<string, Provenance> = {
		'origin-chromium': shipped(single, chromiumMix.scenario),
		'origin-firefox': shipped(single, firefoxMix.scenario, 'firefox'),
		'origin-daily': shipped(days, daily(longCounts).scenario),
		'worker-chromium': shipped(single, chromiumMix.scenario),
		'worker-daily': shipped(days, daily(workerLong).scenario),
		'bytes-median': 'model over library counts (L3)',
		'origin-signed-in': shipped(persistent, PERSISTENT_STAYS),
		'origin-session': shipped(session, SESSION_STAYS),
		'held-day-persistent': shipped(persistent, PERSISTENT_STAYS),
		'origin-revoked': shipped(persistent, PERSISTENT_ENDS),
		'origin-edit-family': shipped(days, 'Public edit: a held course changes between days'),
		'origin-edit-stored': shipped(
			days,
			'Public edit, stored page route with depends: a held course changes between days'
		),
		'static-chromium': 'library 1.0.0, measured',
		'static-firefox': 'library 1.0.0, measured',
		'static-vs-worker-chromium': 'library 1.0.0, measured',
		'static-vs-worker-firefox': 'library 1.0.0, measured',
		'tab-chromium': shipped(single, 'One tab, 2,000 views'),
		'tab-firefox': shipped(single, 'One tab, 2,000 views', 'firefox'),
		floor: 'bound, no count'
	};
	const rows: Headline[] = [
		headline(
			'origin-chromium',
			'Origin requests, 121 views',
			`${chromiumMix.baseline} requests, no spool`,
			pair(chromiumMix),
			'L2',
			'net',
			`Chromium, ${chromiumMix.spool} requests with spool; counts L1; all origin hits, stub on the Worker`
		),
		headline(
			'origin-firefox',
			'Origin requests, 121 views',
			`${firefoxMix.baseline} requests, no spool`,
			pair(firefoxMix),
			'L2',
			'net',
			`Firefox, ${firefoxMix.spool} requests with spool; counts L1; all origin hits, stub on the Worker`
		),
		headline(
			'origin-daily',
			'Origin requests, one view a day for 5 days',
			`${daily(longCounts).baseline} requests, no spool`,
			pair(daily(longCounts)),
			'L2',
			'net',
			`Chromium, ${daily(longCounts).spool} requests with spool, no saving; counts L1; no stub fetched; Firefox did not start`
		),
		headline(
			'worker-chromium',
			'Worker-invocation equivalents, 121 views',
			`${chromiumMix.baseline} requests, no spool`,
			pair(mix('chromium', workerCounts)),
			'L2',
			'net',
			'Chromium; the stub and boot script served from a static tier'
		),
		headline(
			'worker-daily',
			'Worker-invocation equivalents, one view a day for 5 days',
			`${daily(workerLong).baseline} requests, no spool`,
			pair(daily(workerLong)),
			'L2',
			'net',
			'Chromium; the stub and boot script served from a static tier'
		),
		headline(
			'bytes-median',
			'Bytes, 121 views, the median document',
			`${fixed(medianBaseline)} B, no spool`,
			[avoidedShare(medianBaseline, medianSpool), multiplierOf(medianBaseline, medianSpool)],
			'L2',
			'net',
			`Chromium; ${fixed(medianSpool)} B with spool after the ring, boot script and one stub fetch; the ${fixed(doc)} B median over L1 sizes`
		),
		headline(
			'origin-signed-in',
			'Origin requests, signed-in reader on defaults, 4 days',
			`${signedInPair.baseline} requests, no spool`,
			pair(signedInPair),
			'L2',
			'net',
			`Chromium, ${signedInPair.spool} requests with spool, a loss; counts L1; persistent retention, the default; 6 views over 4 days; the spool arm has a memory sink; ${SIGNED_IN_ON}`
		),
		headline(
			'origin-session',
			'Origin requests, signed-in reader, session retention (opt-in), 4 days',
			`${sessionPair.baseline} requests, no spool`,
			pair(sessionPair),
			'L2',
			'net',
			`Chromium, ${sessionPair.spool} requests with spool, a loss; counts L1; 6 views over 4 days; the spool arm has a memory sink; ${SIGNED_IN_ON}`
		),
		headline(
			'held-day-persistent',
			'Origin requests on a held day, persistent retention, day 2',
			`${dayRequests(persistent, PERSISTENT_STAYS, 'baseline', 2)} request, no spool`,
			pair({
				baseline: dayRequests(persistent, PERSISTENT_STAYS, 'baseline', 2),
				spool: dayRequests(persistent, PERSISTENT_STAYS, 'spool', 2)
			}),
			'L2',
			'net',
			`Chromium, day 2 of the persistent reader; ${dayRequests(persistent, PERSISTENT_STAYS, 'spool', 2)} requests with spool (a beacon, the sync and the dataset request, and a stub check), a loss; counts L1; ${SIGNED_IN_ON}`
		),
		headline(
			'origin-revoked',
			'Origin requests, session revoked on the server after day 2',
			`${revokedPair.baseline} requests, no spool`,
			pair(revokedPair),
			'L2',
			'net',
			`Chromium, ${revokedPair.spool} requests with spool, a loss; counts L1; persistent retention; no held page on day 3; ${SIGNED_IN_ON}`
		),
		headline(
			'origin-edit-family',
			'Origin requests, public edit, family route',
			`${familyEditPair.baseline} requests, no spool`,
			pair(familyEditPair),
			'L2',
			'net',
			`Chromium, ${familyEditPair.spool} requests with spool, a loss; counts L1; 9 views over 4 days`
		),
		headline(
			'origin-edit-stored',
			'Origin requests, public edit, stored-page route',
			`${storedEditPair.baseline} requests, no spool`,
			pair(storedEditPair),
			'L2',
			'net',
			`Chromium, ${storedEditPair.spool} requests with spool, a loss; counts L1; 9 views over 4 days`
		),
		headline(
			'static-chromium',
			'Worker invocations over the visit, static tier, Chromium',
			`${staticPair('chromium', 'static-stamped').baseline} invocations, no spool`,
			pair(staticPair('chromium', 'static-stamped')),
			'L2',
			'net',
			`Chromium, stamped static files; unstamped files also give ${workerInvocations(h.pinned(readings, 'static-host/2026-11-20-chromium-static-unstamped.json'))} (counts L1)`
		),
		headline(
			'static-firefox',
			'Worker invocations over the visit, static tier, Firefox',
			`${staticPair('firefox', 'static-stamped').baseline} invocations, no spool`,
			pair(staticPair('firefox', 'static-stamped')),
			'L2',
			'net',
			`Firefox, stamped static files; unstamped files also give ${workerInvocations(h.pinned(readings, 'static-host/2026-11-20-firefox-static-unstamped.json'))} (counts L1)`
		),
		headline(
			'static-vs-worker-chromium',
			'Worker invocations over the visit, static tier against worker only, Chromium',
			`${staticPair('chromium', 'worker-only').spool} invocations, worker only`,
			pair({
				baseline: staticPair('chromium', 'worker-only').spool,
				spool: staticPair('chromium', 'static-stamped').spool
			}),
			'L2',
			'net',
			'Chromium, stamped static files; counts L1'
		),
		headline(
			'static-vs-worker-firefox',
			'Worker invocations over the visit, static tier against worker only, Firefox',
			`${staticPair('firefox', 'worker-only').spool} invocations, worker only`,
			pair({
				baseline: staticPair('firefox', 'worker-only').spool,
				spool: staticPair('firefox', 'static-stamped').spool
			}),
			'L2',
			'net',
			'Firefox, stamped static files; counts L1'
		),
		headline(
			'tab-chromium',
			'Origin requests, one tab, 2,000 views, Chromium',
			`${fixed(tabChromium.baseline)} requests, no spool`,
			pair(tabChromium),
			'L2',
			'net',
			`Chromium, ${tabChromium.spool} requests with spool; counts L1; the spool arm was not controlled by the worker in this reading (controlled false)`
		),
		headline(
			'tab-firefox',
			'Origin requests, one tab, 2,000 views, Firefox',
			`${fixed(tabFirefox.baseline)} requests, no spool`,
			pair(tabFirefox),
			'L2',
			'net',
			`Firefox, ${tabFirefox.spool} requests with spool; counts L1; the spool arm was not controlled by the worker in this reading (controlled false)`
		),
		headline(
			'floor',
			'Origin requests, request law',
			'r x V requests',
			[1, Infinity],
			'L2',
			'floor',
			'a bound over a floor of one request per client (Q >= 1 + W + F), never a count'
		)
	];
	requireLayers(rows);
	const t: Record<string, string> = {};
	const v: Record<string, string> = {};
	t.headline = table(
		['figure', 'baseline', 'net saving', 'multiplier', 'label', 'applies to', 'provenance'],
		rows
			.filter((r) => !NOT_SHIPPED.includes(r.provenance))
			.map((r) => [
				r.name,
				r.baseline,
				pct(r.share),
				times(r.multiplier),
				r.layer,
				r.scope,
				r.provenance
			]),
		[2, 3]
	);

	const allBytesRows: string[][] = [
		[
			'121 views, 127 B demo page, as measured',
			fixed(bytesMix.baseline),
			fixed(bytesMix.spool),
			pct(avoidedShare(bytesMix.baseline, bytesMix.spool)),
			times(multiplierOf(bytesMix.baseline, bytesMix.spool)),
			'L1 bytes, L2 ratio'
		],
		[
			'121 views, median document, one stub fetch',
			fixed(medianBaseline),
			fixed(medianSpool),
			pct(avoidedShare(medianBaseline, medianSpool)),
			times(multiplierOf(medianBaseline, medianSpool)),
			'L2'
		],
		[
			'one view a day for 5 days, 127 B demo page, as measured',
			fixed(bytesDaily.baseline),
			fixed(bytesDaily.spool),
			pct(avoidedShare(bytesDaily.baseline, bytesDaily.spool)),
			times(multiplierOf(bytesDaily.baseline, bytesDaily.spool)),
			'L1 bytes, L2 ratio; stub fetched in full on 3 of the 5 days, no validator'
		],
		[
			'one view a day for 5 days, median document, stub in full each held day',
			fixed(dailyBaseline),
			fixed(dailyFull),
			pct(avoidedShare(dailyBaseline, dailyFull)),
			times(multiplierOf(dailyBaseline, dailyFull)),
			'L2'
		],
		[
			'one view a day for 5 days, median document, stub revalidated with a 304 after the first',
			fixed(dailyBaseline),
			fixed(dailyRevalidated),
			pct(avoidedShare(dailyBaseline, dailyRevalidated)),
			times(multiplierOf(dailyBaseline, dailyRevalidated)),
			`L2; the ${STUB_304_BYTES} B 304 is L1 at a 2 s lease in Chromium and Firefox, not at 25 h`
		]
	];
	const bytesRows = allBytesRows.filter((_, i) => i !== 0 && i !== 2);
	const demoBytesRows = allBytesRows.filter((_, i) => i === 0 || i === 2);
	t['demo-bytes'] = table(
		['case', 'bytes, no spool', 'bytes, spool', 'net saving', 'multiplier', 'label'],
		demoBytesRows,
		[1, 2, 3, 4]
	);
	t['headline-bytes'] = table(
		[
			'case',
			'bytes, no spool',
			'bytes, spool',
			'net saving',
			'multiplier',
			'label',
			'provenance'
		],
		bytesRows.map((r) => [...r, 'model over library counts (L3)']),
		[1, 2, 3, 4]
	);

	const perWorkload = WORKLOADS.map((w) => {
		const base = baselinePerReadView(w);
		const bw = bestAndWorst(w, base);
		const free = (r: number) => freeReadViewsPerDay(r);
		const paid = (r: number) => paidMonth(MONTHLY_VIEWS, r);
		const usd = (n: number) => `$${fixed(n, 2)}`;
		const held = heldShare(w, bw.best.requests);
		const avgStub304 = (sizes.stub + (w.lifetimes - 1) * STUB_304_BYTES) / w.lifetimes;
		return {
			w,
			bw,
			cells: [
				w.name,
				fixed(base, 1),
				`${fixed(bw.best.requests, 3)} (${ENGINE_CLASS_LABELS[bw.best.cls]})`,
				pct(bw.best.share),
				times(bw.best.multiplier),
				`${times(bw.worst.multiplier)} (${ENGINE_CLASS_LABELS[bw.worst.cls]})`,
				bw.reversed.length
					? bw.reversed.map((c) => ENGINE_CLASS_LABELS[c]).join('; ')
					: 'none',
				`${fixed(free(base))} to ${fixed(free(bw.best.requests))}`,
				`${usd(paid(base).usd)} to ${usd(paid(bw.best.requests).usd)} (worst class ${usd(paid(bw.worst.requests).usd)})`,
				pct(netBytesShare(w, held, sizes, sizes.stub)),
				pct(netBytesShare(w, held, sizes, avgStub304))
			]
		};
	});
	t['headline-workloads'] = table(
		[
			'workload',
			'requests per read view, no spool (L3)',
			'best engine class, requests per read view (L3)',
			'net requests saved, best (L3)',
			'multiplier, best (L3)',
			'worst engine class, multiplier (L3)',
			'classes at or below 1x (L3)',
			'Free plan read views a day, no spool to best (L3)',
			'paid plan, 100 million read views a month, no spool to best (L3)',
			'net bytes saved per read view, worker, stub in full each lifetime (L3)',
			'net bytes saved per read view, worker, stub revalidated (L3)',
			'provenance'
		],
		perWorkload.map((p) => [...p.cells, 'model over library counts (L3)']),
		[1, 3, 4, 7, 8, 9, 10]
	);

	const always = WORKLOADS.map((w) => {
		const requests = requestsByClass(w, 'webkit-always');
		const base = baselinePerReadView(w);
		return { share: avoidedShare(base, requests), multiplier: multiplierOf(base, requests) };
	});
	const stage = (name: string): Stage => {
		const found = HISTORY.find((s) => s.stage === name);
		if (!found) throw new Error(`no history stage ${name}`);
		return found;
	};
	const stageCell = (s: Stage): string[] => [
		pct(avoidedShare(s.baseline!, s.spool!)),
		times(stageMultiplier(s))
	];
	const workspace = perWorkload.find((p) => p.w.name === 'Read/write workspace')!;
	const twoView = perWorkload.find((p) => p.w.name === 'Ungated two-view lifetime')!;
	const tab = stage('review 2, one tab all day, low end');
	const tabHigh = stage('review 2, one tab all day, high end');
	const population = stage('review 2, population of 40 clients');
	const EXTREMES_HEADERS = [
		'case',
		'best saving',
		'best multiplier',
		'label',
		'where the saving disappears or reverses',
		'provenance'
	];
	t['headline-extremes'] = table(EXTREMES_HEADERS, [
		[
			'Signed-in reader on defaults, 4 days',
			pct(avoidedShare(signedInPair.baseline, signedInPair.spool)),
			times(multiplierOf(signedInPair.baseline, signedInPair.spool)),
			'L1 counts, L2 ratio; Chromium; memory sink',
			`Day 0 carries the bootstrap; days 1 to 3 cost ${dayRequests(persistent, PERSISTENT_STAYS, 'spool', 1)}, ${dayRequests(persistent, PERSISTENT_STAYS, 'spool', 2)} and ${dayRequests(persistent, PERSISTENT_STAYS, 'spool', 3)} requests against 1 each on the baseline; ${SIGNED_IN_ON}`,
			PROVENANCE_OF['origin-signed-in']!
		],
		[
			'Read/write workspace, 10% writes',
			pct(workspace.bw.best.share),
			times(workspace.bw.best.multiplier),
			'L3 scenario; no reading of a visitor writing through the worker exists',
			'Writes reach the origin on every path, so they cap the saving at the writes share',
			'model over library counts (L3)'
		],
		[
			'Ungated two-view lifetime',
			pct(twoView.bw.best.share),
			times(twoView.bw.best.multiplier),
			'L3 scenario',
			'Bootstrap costs more than the one view it serves; the saving is a loss under every engine class',
			'model over library counts (L3)'
		],
		[
			'One view a day on a 127 B page, 5 days',
			pct(avoidedShare(daily(longCounts).baseline, daily(longCounts).spool)),
			times(multiplierOf(daily(longCounts).baseline, daily(longCounts).spool)),
			'L1 counts, L2 ratio; Chromium; before the stub validator',
			`Spool sent ${daily(longCounts).spool} requests against ${daily(longCounts).baseline}, one per day; no stub or boot script was fetched (the bytes are in the measured readings)`,
			PROVENANCE_OF['origin-daily']!
		],
		[
			"WebKit with `workerMode: 'always'`",
			pct(Math.max(...always.map((a) => a.share))),
			`${times(Math.min(...always.map((a) => a.multiplier)))} to ${times(Math.max(...always.map((a) => a.multiplier)))}`,
			'L3; WebKit sent a script check on every navigation (L1)',
			'The script check is one request per navigation, so a workload whose views are all documents gains nothing; the WebKit default avoids the check by registering no worker',
			'model over library counts (L3)'
		]
	]);
	const notShippedRows = rows
		.filter((r) => NOT_SHIPPED.includes(r.provenance))
		.map((r) => [
			r.name,
			'no finite ceiling',
			'no finite value',
			r.layer,
			r.scope,
			r.provenance
		]);
	t['headline-not-shipped'] = table(EXTREMES_HEADERS, [
		...notShippedRows,
		[
			'A tab held open all day, 60,000 in-page views',
			`${pct3(avoidedShare(tab.baseline!, tab.spool!))} to ${pct3(avoidedShare(tabHigh.baseline!, tabHigh.spool!))}`,
			`${times(stageMultiplier(tab))} to ${times(stageMultiplier(tabHigh))}`,
			'L3 workload over an L2 floor of one request; never a measured count',
			'A client that opens a new document each time pays the document, so the saving falls to the daily rows',
			'review construction, not shipped'
		],
		[
			'A population of 40 clients with mixed visits',
			...stageCell(population),
			'L3 workload, review construction, Chromium',
			'Fewer views per client; a client with one view costs the baseline',
			'review construction, not shipped'
		],
		[
			'Durable Object requests',
			'not a saving',
			'not a saving',
			'L2 over L0',
			'Spool without the live stream uses none; the stream adds one request per stream open and one per bump or revoke',
			'bound, no count'
		]
	]);

	v.headlineStub = fixed(sizes.stub);
	v.headlineBoot = fixed(sizes.boot);
	v.headlineRing = fixed(sizes.ring);
	v.headlineRepaid = fixed(repaidAfter(sizes.stub), 1);
	v.headlineStub304 = fixed(STUB_304_BYTES);
	v.headlineDocument = fixed(doc);
	v.headlineFreeLimit = fixed(CF_FREE_REQUESTS_PER_DAY.value);
	v.headlineChromiumBaseline = fixed(chromiumMix.baseline);
	v.headlineChromiumSpool = fixed(chromiumMix.spool);
	v.headlineChromiumX = times(multiplierOf(chromiumMix.baseline, chromiumMix.spool));
	v.headlineChromiumShare = pct(avoidedShare(chromiumMix.baseline, chromiumMix.spool));
	v.headlineFirefoxX = times(multiplierOf(firefoxMix.baseline, firefoxMix.spool));
	v.headlineMedianX = times(multiplierOf(medianBaseline, medianSpool));
	v.headlineMedianShare = pct(avoidedShare(medianBaseline, medianSpool));
	v.headlineFreeChromium = fixed(freeReadViewsPerDay(chromiumMix.spool / chromiumMix.views));
	v.headlineDailyBaseline = fixed(daily(longCounts).baseline);
	v.headlineDailySpool = fixed(daily(longCounts).spool);
	v.headlineDailyBytesBaseline = fixed(bytesDaily.baseline);
	v.headlineDailyBytesSpool = fixed(bytesDaily.spool);
	v.headlineLocalOnlyBaseline = fixed(localOnly(longCounts).baseline);
	v.headlineLocalOnlySpool = fixed(localOnly(longCounts).spool);
	v.headlineDate = single.date;
	v.headlineDaysDate = days.date;

	const stageTable = (quantity: Stage['quantity'], extra: Stage[] = []): string => {
		const all = [...HISTORY.filter((s) => s.quantity === quantity), ...extra];
		return table(
			[
				'stage',
				'date',
				'multiplier and net saving',
				'condition',
				'label',
				'source',
				'status'
			],
			all.map((s) => [
				s.stage,
				s.date,
				s.figure ??
					`${times(stageMultiplier(s))} (${fixed(s.spool!)} of ${fixed(s.baseline!)}; ${pct2(avoidedShare(s.baseline!, s.spool!))} saved)`,
				s.condition,
				s.layer,
				s.source,
				s.status
			])
		);
	};
	const earlierMix: Stage[] = demandCounts(h.pinned(readings, 'demand/2026-11-20.json'))
		.filter((c) => c.views === 121)
		.map((c): Stage => ({
			quantity: 'origin',
			stage: `library today, earlier reading, ${c.engine}`,
			date: '2026-11-20',
			baseline: c.baseline,
			spool: c.spool,
			condition: `${c.scenario}; all origin requests, counted; superseded by the single-day reading`,
			layer: 'L2',
			source: '`measurements/demand/2026-11-20.json`',
			status: 'superseded'
		}));
	const tabStages: Stage[] = demandCounts(single)
		.filter((c) => c.views === 2000)
		.map((c): Stage => ({
			quantity: 'origin',
			stage: `library today, one tab, ${c.engine}`,
			date: single.date,
			baseline: c.baseline,
			spool: c.spool,
			condition:
				'One tab, 2,000 views; all origin requests, counted; the spool arm was not controlled by the worker',
			layer: 'L2',
			source: `\`measurements/${DEMAND_READING}\``,
			status: 'current'
		}));
	const library = [
		...earlierMix,
		...tabStages,
		...libraryStages(single, days, DAYS_READING),
		...libraryStages(single, session, SESSION_READING).filter((s) => s.quantity === 'reader'),
		...libraryStages(single, persistent, PERSISTENT_READING).filter(
			(s) => s.quantity === 'reader' && !s.condition.includes('maxStaleMs')
		)
	];
	t['moving-origin'] = stageTable(
		'origin',
		library.filter((s) => s.quantity === 'origin')
	);
	t['moving-reader'] = stageTable(
		'reader',
		library.filter((s) => s.quantity === 'reader')
	);
	t['moving-worker'] = stageTable(
		'worker',
		library.filter((s) => s.quantity === 'worker')
	);
	t['moving-bytes'] = stageTable('bytes', [
		{
			quantity: 'bytes',
			stage: 'library today, Chromium, demo page',
			date: single.date,
			figure: `${times(multiplierOf(bytesMix.baseline, bytesMix.spool))} (${fixed(bytesMix.spool)} B of ${fixed(bytesMix.baseline)} B; ${pct(avoidedShare(bytesMix.baseline, bytesMix.spool))} saved)`,
			condition:
				'121 views, the 127 B demo document; a tiny page does not repay the stub and boot script',
			layer: 'L2',
			source: `\`measurements/${DEMAND_READING}\``,
			status: 'current'
		},
		{
			quantity: 'bytes',
			stage: 'library today, Chromium, median document',
			date: single.date,
			figure: `${times(multiplierOf(medianBaseline, medianSpool))} (${fixed(medianSpool)} B of ${fixed(medianBaseline)} B; ${pct(avoidedShare(medianBaseline, medianSpool))} saved)`,
			condition: `121 views over the ${fixed(doc)} B median document, one stub fetch`,
			layer: 'L2',
			source: `\`measurements/${DEMAND_READING}\`, \`measurements/${DAYS_READING}\``,
			status: 'current'
		}
	]);
	const freeRows = HISTORY.filter((s) => s.quantity === 'free');
	t['moving-free'] = table(
		['stage', 'date', 'read views a day', 'condition', 'label', 'source', 'status'],
		[
			...freeRows.map((s) => [
				s.stage,
				s.date,
				s.figure ?? '',
				s.condition,
				s.layer,
				s.source,
				s.status
			]),
			...(['chromium', 'firefox'] as const).map((engine) => {
				const c = mix(engine);
				return [
					`library today, ${engine}`,
					single.date,
					`${fixed(CF_FREE_REQUESTS_PER_DAY.value)} x ${c.baseline} / ${c.spool} = ${fixed((CF_FREE_REQUESTS_PER_DAY.value * c.baseline) / c.spool)}`,
					'121-view mix; counts all origin hits, not Worker invocations only',
					'L2',
					`\`measurements/${DEMAND_READING}\``,
					'current'
				];
			}),
			...WORKLOADS.filter((w) => w.name !== 'Short read lifetime').map((w) => {
				const base = baselinePerReadView(w);
				const r = bestAndWorst(w, base).best;
				return [
					`docs, economics model, ${w.name}`,
					'2026-11-19',
					`${fixed(freeReadViewsPerDay(base))} to ${fixed(freeReadViewsPerDay(r.requests))}`,
					`${ENGINE_CLASS_LABELS[r.cls]}; L3 workload with bootstrap of 2 requests after the first document`,
					'L3',
					'`docs/economics.md`',
					'current'
				];
			})
		]
	);
	return { values: v, tables: t };
}

/** the figures of `all` whose names are listed, so a page carries only what its template uses */
export function pickFigures(all: Figures, values: string[], tables: string[]): Figures {
	return {
		values: Object.fromEntries(values.map((n) => [n, all.values[n]!])),
		tables: Object.fromEntries(tables.map((n) => [n, all.tables[n]!]))
	};
}

export const HEADLINE_VALUES = [
	'headlineStub',
	'headlineBoot',
	'headlineRing',
	'headlineRepaid',
	'headlineStub304',
	'headlineDocument',
	'headlineFreeLimit',
	'headlineChromiumBaseline',
	'headlineChromiumSpool',
	'headlineChromiumX',
	'headlineChromiumShare',
	'headlineFirefoxX',
	'headlineFreeChromium',
	'headlineDailyBaseline',
	'headlineDailySpool',
	'headlineLocalOnlyBaseline',
	'headlineLocalOnlySpool',
	'headlineDate'
];

/** the values the impact page's headline section and moving-numbers section use */
export const IMPACT_VALUES = [
	'headlineDate',
	'headlineChromiumBaseline',
	'headlineChromiumSpool',
	'headlineChromiumShare',
	'headlineChromiumX',
	'headlineFirefoxX',
	'headlineFreeChromium',
	'headlineFreeLimit',
	'headlineStub',
	'headlineRepaid',
	'headlineDocument',
	'headlineDailyBaseline',
	'headlineDailySpool'
];

export const HEADLINE_TABLES = [
	'headline',
	'headline-workloads',
	'headline-bytes',
	'headline-extremes',
	'headline-not-shipped'
];

/** the 127 B demo page's bytes: measured, printed beside the readings, never in the headline */
export const MEASURED_TABLES = ['demo-bytes'];

export const MOVING_TABLES = [
	'moving-origin',
	'moving-reader',
	'moving-worker',
	'moving-bytes',
	'moving-free'
];
