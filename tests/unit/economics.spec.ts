import { describe, expect, it } from 'vitest';
import {
	AZURE_EGRESS,
	BOOTSTRAP_EXTRA_NO_WORKER,
	GCP_EGRESS,
	HISTORY,
	WORKLOADS,
	avoidedShare,
	baselinePerReadView,
	bestAndWorst,
	demandCounts,
	demandDocumentCounts,
	demandWorkerCounts,
	documentRequests,
	egressUsd,
	firstViewDocumentMedian,
	freeReadViewsPerDay,
	heldShare,
	libraryBytes,
	libraryStages,
	multiplierOf,
	netBytesShare,
	noWorkerRequestsPerReadView,
	overIncluded,
	paidRequestsUsd,
	repaidAfter,
	requestsByClass,
	requestsPerReadView,
	requireLayers,
	spoolBytes,
	stageMultiplier,
	webkitStubPerReadView,
	type Headline,
	type Measurement
} from '../../src/report/index';

const [short, daily, library, workspace, twoView] = WORKLOADS;

describe('the request law', () => {
	it('gives the request count per read view for each workload, with a worker', () => {
		expect(requestsPerReadView(short!)).toBeCloseTo(0.6, 12);
		expect(requestsPerReadView(daily!)).toBeCloseTo(0.04, 12);
		expect(requestsPerReadView(library!)).toBeCloseTo(0.015, 12);
		expect(requestsPerReadView(workspace!)).toBeCloseTo(0.165, 12);
		expect(requestsPerReadView(twoView!)).toBeCloseTo(1.5, 12);
	});

	it('takes one fewer bootstrap request per lifetime without a worker', () => {
		expect(requestsPerReadView(short!, BOOTSTRAP_EXTRA_NO_WORKER.value)).toBeCloseTo(0.4, 12);
		expect(requestsPerReadView(workspace!, BOOTSTRAP_EXTRA_NO_WORKER.value)).toBeCloseTo(
			0.164,
			12
		);
	});

	it('counts the writes on both paths and the held share without them', () => {
		expect(baselinePerReadView(workspace!)).toBeCloseTo(1.1, 12);
		expect(heldShare(workspace!, 0.165)).toBeCloseTo(0.935, 12);
		expect(heldShare(library!, 0.015)).toBeCloseTo(0.985, 12);
	});

	it('clamps the held share at zero when requests exceed one per view', () => {
		expect(heldShare(twoView!, 1.5)).toBe(0);
	});

	it('takes the WebKit macOS term per navigation, scaled by each workload', () => {
		expect(webkitStubPerReadView(short!)).toBeCloseTo(1, 12);
		expect(webkitStubPerReadView(daily!)).toBeCloseTo(0.05, 12);
		expect(webkitStubPerReadView(library!)).toBeCloseTo(0.05, 12);
		expect(webkitStubPerReadView(workspace!)).toBeCloseTo(0.1, 12);
		expect(webkitStubPerReadView(twoView!)).toBeCloseTo(1, 12);
	});

	it('gives the WebKit macOS cohort the Chromium count plus the script term', () => {
		expect(requestsPerReadView(short!) + webkitStubPerReadView(short!)).toBeCloseTo(1.6, 12);
		expect(requestsPerReadView(daily!) + webkitStubPerReadView(daily!)).toBeCloseTo(0.09, 12);
		expect(requestsPerReadView(library!) + webkitStubPerReadView(library!)).toBeCloseTo(
			0.065,
			12
		);
		expect(requestsPerReadView(workspace!) + webkitStubPerReadView(workspace!)).toBeCloseTo(
			0.265,
			12
		);
		expect(requestsPerReadView(twoView!) + webkitStubPerReadView(twoView!)).toBeCloseTo(
			2.5,
			12
		);
	});
});

describe('the Free plan', () => {
	it('gives the read views a day the 100,000-request limit supports', () => {
		expect(freeReadViewsPerDay(1)).toBe(100_000);
		expect(freeReadViewsPerDay(0.04)).toBeCloseTo(2_500_000, 6);
		expect(freeReadViewsPerDay(2.5)).toBe(40_000);
	});
});

describe('the paid plan', () => {
	it('charges nothing inside the 10 million included requests', () => {
		expect(overIncluded(10_000_000)).toBe(0);
		expect(paidRequestsUsd(9_999_999)).toBe(0);
	});

	it('prices the workspace at 100 million views without spool', () => {
		expect(paidRequestsUsd(1.1 * 100_000_000)).toBeCloseTo(30, 9);
	});

	it('prices the workspace at 100 million views with the stub on a static tier', () => {
		expect(paidRequestsUsd(100_000_000 * requestsPerReadView(workspace!))).toBeCloseTo(1.95, 9);
	});

	it('prices the workspace at 100 million views with the WebKit stub on the Worker', () => {
		const requests =
			100_000_000 * (requestsPerReadView(workspace!) + webkitStubPerReadView(workspace!));
		expect(paidRequestsUsd(requests)).toBeCloseTo(4.95, 6);
	});

	it('charges nothing for the daily reader at 100 million views on the WebKit macOS cohort', () => {
		const requests =
			100_000_000 * (requestsPerReadView(daily!) + webkitStubPerReadView(daily!));
		expect(requests).toBeCloseTo(9_000_000, 3);
		expect(paidRequestsUsd(requests)).toBe(0);
	});
});

describe('bandwidth', () => {
	const doc = 17_054;

	it('prices the held bytes of the daily reader at the Azure list price', () => {
		const held = 1_000_000 * 0.95;
		expect(egressUsd(held, AZURE_EGRESS, doc)).toBeCloseTo(1.4095131, 7);
	});

	it('prices the same bytes per GiB at Google Cloud', () => {
		const held = 1_000_000 * 0.95;
		expect(egressUsd(held, GCP_EGRESS, doc)).toBeCloseTo(1.810636, 5);
	});
});

describe('the first-view document', () => {
	it('takes the median document over the corpus pages', () => {
		const reading = {
			method: {
				'corpus pages': [
					{ classBytes: { document: 10 } },
					{ classBytes: { document: 30 } },
					{ classBytes: { document: 20 } }
				]
			}
		} as unknown as Measurement;
		expect(firstViewDocumentMedian(reading)).toBe(20);
	});

	it('refuses a reading with no corpus pages', () => {
		const reading = { method: {} } as unknown as Measurement;
		expect(() => firstViewDocumentMedian(reading)).toThrow(/no corpus pages/);
	});
});

const reading = (rows: unknown[], date = '2026-11-20'): Measurement =>
	({ schema: 1, rig: 'demand', date, layer: 'L1', rows }) as unknown as Measurement;

const arm = (engine: string, scenario: string, kind: string, views: number, extra: object) => ({
	engine,
	scenario,
	arm: kind,
	views,
	wrong: 0,
	...extra
});

const single = reading([
	arm('chromium', 'One', 'baseline', 1, { requests: 1, bytes: 100 }),
	arm('chromium', 'One', 'spool', 1, { requests: 1, bytes: 2_600 }),
	arm('chromium', 'Mix', 'baseline', 121, { requests: 121, bytes: 12_100 }),
	arm('chromium', 'Mix', 'spool', 121, {
		requests: 5,
		bytes: 300_000,
		paths: { 'GET /doc': 3, 'GET /.spool/1.0.0/boot/1.js': 1, 'GET /spool-sw.js': 1 }
	}),
	arm('firefox', 'Mix', 'baseline', 121, { requests: 122, bytes: 0 }),
	arm('firefox', 'Mix', 'spool', 121, { requests: 6, bytes: 0, fatal: 'did not start' })
]);

const days = reading([
	arm('chromium', 'Daily', 'spool', 5, {
		requests: 8,
		bytes: 0,
		days: [
			{
				byType: {
					asset: { requests: 1, bytes: 75_000 },
					stub: { requests: 1, bytes: 137_000 }
				}
			}
		]
	}),
	arm('chromium', 'Daily', 'baseline', 5, { requests: 5, bytes: 0 })
]);

describe('the headline arithmetic', () => {
	it('gives the avoided share and the multiplier of a worked case', () => {
		expect(avoidedShare(100, 25)).toBe(0.75);
		expect(multiplierOf(100, 25)).toBe(4);
		expect(multiplierOf(100, 0)).toBe(Infinity);
	});

	it('reports a negative share and a multiplier below 1 where spool sends more', () => {
		expect(avoidedShare(2, 3)).toBe(-0.5);
		expect(multiplierOf(2, 3)).toBeCloseTo(2 / 3, 12);
	});

	it('refuses a baseline that is not positive', () => {
		expect(() => avoidedShare(0, 1)).toThrow(RangeError);
		expect(() => multiplierOf(-1, 1)).toThrow(RangeError);
	});

	it('adds the navigations after the first document to the no-worker count', () => {
		expect(noWorkerRequestsPerReadView(short!)).toBeCloseTo(0.4 + 4 / 5, 12);
		expect(noWorkerRequestsPerReadView(library!)).toBeCloseTo(0.002 + 0.012 + 0.049, 12);
	});

	it('makes the WebKit default column equal the no-worker column for every workload', () => {
		for (const w of WORKLOADS) {
			expect(requestsByClass(w, 'webkit-auto')).toBe(requestsByClass(w, 'no-worker'));
		}
	});

	it('gives WebKit with a worker the worker count plus the script term', () => {
		for (const w of WORKLOADS) {
			expect(requestsByClass(w, 'webkit-always')).toBeCloseTo(
				requestsPerReadView(w) + webkitStubPerReadView(w),
				12
			);
		}
	});

	it('finds the two-view lifetime reverses under every class and the engaged reader gains', () => {
		const two = bestAndWorst(twoView!, baselinePerReadView(twoView!));
		expect(two.best.multiplier).toBeLessThan(1);
		expect(two.reversed).toHaveLength(4);
		const engaged = bestAndWorst(daily!, baselinePerReadView(daily!));
		expect(engaged.best.cls).toBe('worker');
		expect(engaged.best.multiplier).toBeCloseTo(25, 9);
		expect(engaged.reversed).toEqual([]);
	});

	it('takes the net bytes as the gross saving minus the ring, boot and stub terms', () => {
		const sizes = { ring: 1_000, boot: 20_000, stub: 100_000 };
		const doc = 17_054;
		const share = netBytesShare(daily!, 0.96, sizes, sizes.stub);
		const gross = 0.96 * doc;
		const terms = 0.04 * 1_000 + 20_000 / 100 + 100_000 / 100;
		expect(share).toBeCloseTo((gross - terms) / doc, 12);
		expect(netBytesShare(daily!, 0.96, sizes, 169)).toBeGreaterThan(share);
	});

	it('counts the stub per lease in the bytes and the documents that repay it', () => {
		const sizes = { ring: 10, boot: 100, stub: 1_000 };
		expect(
			spoolBytes({ documents: 2, documentBytes: 50, stubFetches: 3, stubBytes: 1_000, sizes })
		).toBe(2 * 60 + 100 + 3_000);
		expect(repaidAfter(17_054)).toBe(1);
	});

	it('requires a layer on every headline', () => {
		const ok: Headline = {
			id: 'a',
			name: 'a',
			baseline: 'b',
			share: 0.5,
			multiplier: 2,
			layer: 'L2',
			basis: 'net',
			provenance: 'library 1.0.0, measured',
			scope: 's'
		};
		expect(requireLayers([ok])).toHaveLength(1);
		expect(() => requireLayers([ok, { ...ok, id: 'missing', layer: '' }])).toThrow(/missing/);
	});
});

describe('the library readings', () => {
	it('pairs the finished arms and drops a row with fatal set', () => {
		const counts = demandCounts(single);
		expect(counts.map((c) => `${c.engine} ${c.scenario}`)).toEqual([
			'chromium One',
			'chromium Mix'
		]);
		expect(counts[1]).toMatchObject({ views: 121, baseline: 121, spool: 5 });
	});

	it('counts the Worker-invocation equivalents without the boot script and the stub', () => {
		expect(demandWorkerCounts(single).find((c) => c.scenario === 'Mix')!.spool).toBe(3);
	});

	it('leaves the beacon and a favicon out of the network documents', () => {
		const paths = {
			'GET /doc': 3,
			'GET /.spool/1.0.0/boot/1.js': 1,
			'GET /spool-sw.js': 3,
			'POST /.spool/beacon': 1,
			'GET /favicon.ico': 1
		};
		expect(documentRequests({ requests: 9, paths })).toBe(3);
		expect(demandDocumentCounts(single).find((c) => c.scenario === 'Mix')!.spool).toBe(3);
	});

	it('reads the ring, boot and stub sizes from the two readings', () => {
		expect(libraryBytes(single, days)).toEqual({ ring: 2_500, boot: 75_000, stub: 137_000 });
	});

	it('refuses a multi-day reading with no stub bytes', () => {
		expect(() => libraryBytes(single, reading([]))).toThrow(/stub|asset/);
	});

	it('gives each library stage its two counts and a layer', () => {
		const stages = libraryStages(single, days);
		expect(stages.map((s) => s.quantity)).toEqual(['origin', 'reader', 'worker']);
		expect(stageMultiplier(stages[0]!)).toBeCloseTo(121 / 5, 12);
		expect(stageMultiplier(stages[1]!)).toBeCloseTo(5 / 8, 12);
		expect(stageMultiplier(stages[2]!)).toBeCloseTo(121 / 3, 12);
	});
});

describe('the moving numbers', () => {
	it('divides the counts each earlier stage printed', () => {
		const find = (text: string) => HISTORY.find((s) => s.stage === text)!;
		expect(stageMultiplier(find('original v1, minimal construction'))).toBeCloseTo(121 / 3, 12);
		expect(stageMultiplier(find('follow-ups, retrofit'))).toBe(30.25);
		expect(stageMultiplier(find('first library run'))).toBeCloseTo(121 / 9, 12);
	});

	it('carries a layer, a source and a status on every stage', () => {
		for (const s of HISTORY) {
			expect(['L0', 'L1', 'L2', 'L3']).toContain(s.layer);
			expect(s.source).not.toBe('');
			expect(['current', 'superseded', 'withdrawn']).toContain(s.status);
		}
	});

	it('refuses the multiplier of a stage with no count pair', () => {
		expect(() => stageMultiplier(HISTORY[0]!)).toThrow(/no count pair/);
	});
});
