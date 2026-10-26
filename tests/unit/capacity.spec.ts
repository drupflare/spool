import { describe, expect, it } from 'vitest';
import * as capacityModule from '../../src/report/capacity';
import * as channelsModule from '../../src/report/channels';
import {
	capacityPlan,
	channelRows,
	institutionReport,
	intervalsFromWork,
	nodesNeeded,
	serverYearMWh,
	type CapacityPlan,
	type Channels,
	type InstitutionReport,
	type RetirementEntry,
	type WorkSample
} from '../../src/report/index';
import * as institutionModule from '../../src/report/institution';

const limits = { perNode: { busyMs: 1000, memoryMb: 512 } };

describe('nodesNeeded', () => {
	it('takes the largest need and names the resource that set it', () => {
		expect(nodesNeeded({ busyMs: 2500, memoryMb: 100 }, limits)).toEqual({
			nodes: 3,
			binding: 'busyMs'
		});
		expect(nodesNeeded({ busyMs: 100, memoryMb: 1200 }, limits)).toEqual({
			nodes: 3,
			binding: 'memoryMb'
		});
	});

	it('breaks a tie toward the name that sorts first, whatever the declaration order', () => {
		expect(nodesNeeded({ a: 25, b: 25 }, { perNode: { b: 10, a: 10 } })).toEqual({
			nodes: 3,
			binding: 'a'
		});
	});

	it('adds spares on top of the binding need', () => {
		expect(nodesNeeded({ x: 25 }, { perNode: { x: 10 }, spares: 2 })).toEqual({
			nodes: 5,
			binding: 'x'
		});
	});

	it('raises the count to the floor', () => {
		expect(nodesNeeded({ x: 5 }, { perNode: { x: 10 }, floor: 4 })).toEqual({
			nodes: 4,
			binding: 'x'
		});
	});

	it('raises the count to regions times minPerRegion when that is larger', () => {
		expect(
			nodesNeeded({ x: 5 }, { perNode: { x: 10 }, spares: 1, regions: 3, minPerRegion: 2 })
		).toEqual({ nodes: 6, binding: 'x' });
	});

	it('reports no binding and one node when no resource needs any', () => {
		expect(nodesNeeded({ x: 0 }, { perNode: { x: 10 } })).toEqual({ nodes: 1, binding: null });
		expect(nodesNeeded({}, { perNode: { x: 10 } })).toEqual({ nodes: 1, binding: null });
	});

	it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a perNode of %s', (perNode) => {
		expect(() => nodesNeeded({ x: 1 }, { perNode: { x: perNode } })).toThrow(RangeError);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a demand of %s', (need) => {
		expect(() => nodesNeeded({ x: need }, { perNode: { x: 10 } })).toThrow(RangeError);
	});
});

describe('capacityPlan', () => {
	it('gives exact nodes before and after, the retirable count and the binding resources', () => {
		const plan = capacityPlan(
			[
				{
					start: 0,
					seconds: 1,
					demand: { busyMs: 2500, memoryMb: 100 },
					avoided: { busyMs: 1500 }
				},
				{
					start: 1000,
					seconds: 1,
					demand: { busyMs: 4200, memoryMb: 300 },
					avoided: { busyMs: 1200 }
				},
				{ start: 2000, seconds: 1, demand: { busyMs: 1000, memoryMb: 1200 } },
				{
					start: 3000,
					seconds: 1,
					demand: { busyMs: 500, memoryMb: 200 },
					avoided: { busyMs: 400 }
				}
			],
			limits
		);
		expect(plan).toEqual({
			before: 5,
			after: 3,
			retirable: 2,
			bindingBefore: 'busyMs',
			bindingAfter: 'busyMs',
			intervals: 4
		});
	});

	it('retires nothing when memory sets the fleet, even if busy demand falls by 90%', () => {
		const plan = capacityPlan(
			[
				{
					start: 0,
					seconds: 1,
					demand: { busyMs: 2000, memoryMb: 4096 },
					avoided: { busyMs: 1800 }
				}
			],
			limits
		);
		expect(plan).toEqual({
			before: 8,
			after: 8,
			retirable: 0,
			bindingBefore: 'memoryMb',
			bindingAfter: 'memoryMb',
			intervals: 1
		});
	});

	it('sizes an empty series at the base fleet with no binding', () => {
		expect(capacityPlan([], { perNode: { busyMs: 1000 }, floor: 2 })).toEqual({
			before: 2,
			after: 2,
			retirable: 0,
			bindingBefore: null,
			bindingAfter: null,
			intervals: 0
		});
	});

	it('clamps avoided work at the demand it removes from', () => {
		const plan = capacityPlan(
			[{ start: 0, seconds: 1, demand: { busyMs: 1500 }, avoided: { busyMs: 4000 } }],
			{ perNode: { busyMs: 1000 } }
		);
		expect(plan).toEqual({
			before: 2,
			after: 1,
			retirable: 1,
			bindingBefore: 'busyMs',
			bindingAfter: null,
			intervals: 1
		});
	});
});

describe('intervalsFromWork', () => {
	const samples: WorkSample[] = [
		{
			start: 0,
			seconds: 2,
			busyMs: { '/a': 1000, '/.spool/sync': 200 },
			requests: { '/a': 4 }
		},
		{ start: 2000, seconds: 4, busyMs: { '/b': 600 }, requests: {} }
	];

	it('converts handler milliseconds to a per-second rate, busy and avoided', () => {
		expect(intervalsFromWork(samples, [800, 0])).toEqual([
			{ start: 0, seconds: 2, demand: { busyMs: 600 }, avoided: { busyMs: 400 } },
			{ start: 2000, seconds: 4, demand: { busyMs: 150 }, avoided: { busyMs: 0 } }
		]);
	});

	it('throws when the avoided list does not match the samples', () => {
		expect(() => intervalsFromWork(samples, [800])).toThrow(RangeError);
	});
});

describe('institutionReport', () => {
	const plan: CapacityPlan = {
		before: 5,
		after: 3,
		retirable: 2,
		bindingBefore: 'busyMs',
		bindingAfter: 'busyMs',
		intervals: 4
	};
	const server = (over: Partial<RetirementEntry> = {}): RetirementEntry => ({
		id: 'rack-07',
		kind: 'server',
		removedOn: '2026-09-30',
		years: 2,
		evidence: 'decommission ticket INC-1042',
		...over
	});

	it('reports all three results when a plan, invoices and a ledger are given', () => {
		const report = institutionReport({
			plan,
			invoices: { currency: 'USD', period: 'month', before: 1200, after: 900 },
			ledger: [server()]
		});
		expect(report).toEqual({
			observed: null,
			potential: { plan, layer: 'L3' },
			financial: { currency: 'USD', period: 'month', saving: 300, layer: 'L1' },
			physical: { mwh: 2 * serverYearMWh(), servers: 2, unpriced: [], layer: 'L2' },
			statement: 'Physical saving from 2 retired server-years across 1 ledger entry.'
		});
	});

	it('reports only the potential when a plan is the one input', () => {
		expect(institutionReport({ plan })).toEqual({
			observed: null,
			potential: { plan, layer: 'L3' },
			financial: null,
			physical: null,
			statement: 'No physical capacity saving demonstrated.'
		});
	});

	it('takes the layer of the plan from planLayer', () => {
		expect(institutionReport({ plan, planLayer: 'L2' }).potential).toEqual({
			plan,
			layer: 'L2'
		});
	});

	it('reports a negative financial saving when invoices rose', () => {
		expect(
			institutionReport({
				invoices: { currency: 'EUR', period: 'year', before: 900, after: 1000 }
			})
		).toEqual({
			observed: null,
			potential: null,
			financial: { currency: 'EUR', period: 'year', saving: -100, layer: 'L1' },
			physical: null,
			statement: 'No physical capacity saving demonstrated.'
		});
	});

	it('reports no physical saving when every entry is unpriced, and names them', () => {
		const report = institutionReport({
			ledger: [
				{
					id: 'vm-3',
					kind: 'instance',
					removedOn: '2026-08-01',
					years: 1,
					evidence: 'ticket'
				}
			]
		});
		expect(report.physical).toBeNull();
		expect(report.statement).toBe(
			'No physical capacity saving demonstrated. Unpriced entries: vm-3.'
		);
	});

	it('uses the singular for one server-year across several entries', () => {
		const report = institutionReport({
			ledger: [server({ years: 0.5 }), server({ id: 'srv-2', years: 0.5 })]
		});
		expect(report.statement).toBe(
			'Physical saving from 1 retired server-year across 2 ledger entries.'
		);
	});

	it('lists an instance without watts as unpriced and adds nothing for it', () => {
		const report = institutionReport({
			ledger: [
				server({ watts: 400 }),
				{
					id: 'vm-3',
					kind: 'instance',
					removedOn: '2026-08-01',
					years: 1,
					evidence: 'ticket'
				}
			]
		});
		expect(report.physical).toEqual({
			mwh: 2 * serverYearMWh(400),
			servers: 2,
			unpriced: ['vm-3'],
			layer: 'L2'
		});
		expect(report.statement).toBe(
			'Physical saving from 2 retired server-years across 1 ledger entry.'
		);
	});

	it('prices an instance that has watts', () => {
		const report = institutionReport({
			ledger: [
				{
					id: 'vm-9',
					kind: 'instance',
					removedOn: '2026-08-01',
					years: 0.5,
					watts: 300,
					evidence: 'ticket'
				}
			]
		});
		expect(report.physical).toEqual({
			mwh: 0.5 * serverYearMWh(300),
			servers: 0.5,
			unpriced: [],
			layer: 'L2'
		});
		expect(report.statement).toBe(
			'Physical saving from 0.5 retired server-years across 1 ledger entry.'
		);
	});

	it('rounds the server count to three significant figures in the statement', () => {
		expect(institutionReport({ ledger: [server({ years: 12.345 })] }).statement).toBe(
			'Physical saving from 12.3 retired server-years across 1 ledger entry.'
		);
	});

	it('reports no physical saving for an empty ledger', () => {
		expect(institutionReport({ ledger: [] }).physical).toBeNull();
	});

	it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY])('rejects years of %s', (years) => {
		expect(() => institutionReport({ ledger: [server({ years })] })).toThrow(RangeError);
	});

	it('rejects an instance with zero years even when it has no watts', () => {
		expect(() =>
			institutionReport({
				ledger: [
					{
						id: 'vm-3',
						kind: 'instance',
						removedOn: '2026-08-01',
						years: 0,
						evidence: 'x'
					}
				]
			})
		).toThrow(RangeError);
	});

	it.each(['', '   '])('rejects an entry whose evidence is %j', (evidence) => {
		expect(() => institutionReport({ ledger: [server({ evidence })] })).toThrow(RangeError);
	});

	it('reports what telemetry saw change beside the plan, and refuses a negative or non-finite measurement', () => {
		const observed = {
			metric: 'peak handler work',
			unit: 'ms/s',
			period: '2026-09',
			before: 9000,
			after: 6300
		};
		const report = institutionReport({ plan, observed });
		expect(report.observed).toEqual({ ...observed, reduction: 0.3, layer: 'L1' });
		expect(report.physical).toBeNull();
		expect(
			institutionReport({ observed: { ...observed, before: 0, after: 0 } }).observed
				?.reduction
		).toBeNull();
		for (const bad of [{ before: -1 }, { after: Number.NaN }]) {
			expect(() => institutionReport({ observed: { ...observed, ...bad } })).toThrow(
				RangeError
			);
		}
	});

	it('has no total field across the three results', () => {
		const report = institutionReport({ plan, ledger: [server()] });
		expect(Object.keys(report).sort()).toEqual([
			'financial',
			'observed',
			'physical',
			'potential',
			'statement'
		]);
	});
});

describe('channelRows', () => {
	const report: InstitutionReport = {
		observed: null,
		potential: {
			plan: {
				before: 5,
				after: 3,
				retirable: 2,
				bindingBefore: 'busyMs',
				bindingAfter: 'busyMs',
				intervals: 4
			},
			layer: 'L3'
		},
		financial: { currency: 'USD', period: 'month', saving: 300, layer: 'L1' },
		physical: { mwh: 4, servers: 1, unpriced: ['vm-3'], layer: 'L2' },
		statement: 'Physical saving from 1 retired server-year across 1 ledger entry.'
	};

	it('gives exact rows in channel order, whatever order the channels are written in', () => {
		const channels: Channels = {
			avoided: {
				value: {
					transferredBytes: 17054,
					requests: 30,
					serverCpuMs: 12,
					browserCpuMs: null,
					dataCentreWorkMs: 40,
					peakNodes: 1
				},
				layer: 'L2',
				source: 'test'
			},
			capacity: { value: report, layer: 'L3', source: 'test' },
			attributional: { value: { joules: 3.5 }, layer: 'L2', source: 'test' },
			metered: { value: { joules: 120 }, layer: 'L1', source: 'test' }
		};
		expect(channelRows(channels)).toEqual([
			{ channel: 'metered', measure: 'energy', value: 120, unit: 'J', layer: 'L1' },
			{ channel: 'attributional', measure: 'energy', value: 3.5, unit: 'J', layer: 'L2' },
			{
				channel: 'capacity',
				measure: 'potential retirable nodes',
				value: 2,
				unit: 'nodes',
				layer: 'L3'
			},
			{
				channel: 'capacity',
				measure: 'financial saving',
				value: 300,
				unit: 'USD',
				layer: 'L1'
			},
			{ channel: 'capacity', measure: 'physical energy', value: 4, unit: 'MWh', layer: 'L2' },
			{
				channel: 'avoided',
				measure: 'transferredBytes',
				value: 17054,
				unit: 'B',
				layer: 'L2'
			},
			{ channel: 'avoided', measure: 'requests', value: 30, unit: 'requests', layer: 'L2' },
			{ channel: 'avoided', measure: 'serverCpuMs', value: 12, unit: 'ms', layer: 'L2' },
			{ channel: 'avoided', measure: 'dataCentreWorkMs', value: 40, unit: 'ms', layer: 'L2' },
			{ channel: 'avoided', measure: 'peakNodes', value: 1, unit: 'nodes', layer: 'L2' }
		]);
	});

	it('leaves out capacity parts that are null', () => {
		const rows = channelRows({
			metered: null,
			attributional: null,
			capacity: { value: { ...report, potential: null }, layer: 'L3', source: 'test' },
			avoided: null
		});
		expect(rows.map((row) => row.measure)).toEqual(['financial saving', 'physical energy']);
	});

	it('returns no rows when every channel is null', () => {
		expect(
			channelRows({ metered: null, attributional: null, capacity: null, avoided: null })
		).toEqual([]);
	});

	it('exports no total or sum function from the three modules', () => {
		for (const mod of [capacityModule, channelsModule, institutionModule]) {
			expect(Object.keys(mod).filter((name) => /total|sum/i.test(name))).toEqual([]);
		}
	});
});

describe('JSON round trip', () => {
	it('returns an equal CapacityPlan and InstitutionReport', () => {
		const plan = capacityPlan(
			[{ start: 0, seconds: 1, demand: { busyMs: 2500 }, avoided: { busyMs: 1500 } }],
			{ perNode: { busyMs: 1000 } }
		);
		const report = institutionReport({
			plan,
			invoices: { currency: 'USD', period: 'month', before: 1200, after: 900 },
			ledger: [
				{
					id: 'rack-07',
					kind: 'server',
					removedOn: '2026-09-30',
					years: 2,
					evidence: 'ticket'
				}
			]
		});
		expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
		expect(JSON.parse(JSON.stringify(report))).toEqual(report);
	});
});
