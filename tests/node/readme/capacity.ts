import { capacityPlan, institutionReport } from '../../../src/report/index';

const plan = capacityPlan(
	[
		{
			start: Date.UTC(2026, 8, 1, 14),
			seconds: 300,
			demand: { busyMs: 9000 },
			avoided: { busyMs: 6300 }
		},
		{
			start: Date.UTC(2026, 8, 1, 14, 5),
			seconds: 300,
			demand: { busyMs: 7000 },
			avoided: { busyMs: 4900 }
		}
	],
	{ perNode: { busyMs: 700 }, spares: 1, floor: 2 }
);

export const report = institutionReport({ plan, planLayer: 'L3' });
