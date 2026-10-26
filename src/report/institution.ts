import type { CapacityPlan } from './capacity.js';
import { serverYearMWh } from './model.js';

/**
 * A server or instance the institution retired because spool made it unneeded. `watts` is the
 * draw of one unit; without it an instance has no energy figure and is listed as unpriced.
 */
export type RetirementEntry = {
	/** the server or instance's identifier in the institution's records */
	id: string;
	/** whether a physical server or a cloud instance */
	kind: 'server' | 'instance';
	/** the date the unit was removed */
	removedOn: string;
	/** server-years the removal saves; must be a positive finite number */
	years: number;
	/** draw of one unit in watts; without it an instance is listed as unpriced */
	watts?: number;
	/** the source for the removal; required, must not be blank */
	evidence: string;
};

/** a period's invoice totals before and after spool, in the invoice currency */
export type Invoices = {
	/** the currency the totals are in, such as USD */
	currency: string;
	/** whether the totals cover a month or a year */
	period: 'month' | 'year';
	/** invoice total for the period before spool */
	before: number;
	/** invoice total for the same period with spool */
	after: number;
};

/** a production measurement of the same workload before and after spool, over one stated period */
export type Observed = {
	/** name of the measured quantity */
	metric: string;
	/** unit the before and after values are in */
	unit: string;
	/** the period both readings cover */
	period: string;
	/** metric value before spool, in unit; non-negative */
	before: number;
	/** metric value with spool, in unit; non-negative */
	after: number;
};

export type InstitutionInputs = {
	/** the capacity plan behind the potential channel */
	plan?: CapacityPlan;
	/** a production measurement of the same workload before and after spool */
	observed?: Observed;
	/** the layer the plan is reported at; a plan from a real trace and SLO is L2 */
	planLayer?: 'L2' | 'L3';
	/** invoice totals before and after spool */
	invoices?: Invoices;
	/** servers and instances the institution retired */
	ledger?: readonly RetirementEntry[];
};

/** an observed change, then the three results of the capacity plan; none is added to another and any can be null or read zero */
export type InstitutionReport = {
	/** what telemetry saw change, which is neither what the model says could change nor what was removed */
	observed:
		| (Observed & {
				/** fractional drop from before to after; null when before is zero */
				reduction: number | null;
				/** L1, measured here */
				layer: 'L1';
		  })
		| null;
	/** the capacity plan's node counts; null without a plan */
	potential: {
		/** the capacity plan the figures come from */
		plan: CapacityPlan;
		/** L2 when the plan comes from a real trace and SLO, else L3 */
		layer: 'L2' | 'L3';
	} | null;
	/** the invoice saving; null without invoices */
	financial: {
		/** currency of the saving */
		currency: string;
		/** month or year, as the invoices stated */
		period: 'month' | 'year';
		/** invoice before minus after, in currency */
		saving: number;
		/** L1, measured here */
		layer: 'L1';
	} | null;
	/** priced capacity saving from the ledger; null when no entry is priced */
	physical: {
		/** energy the retired servers drew, in MWh */
		mwh: number;
		/** server-years retired */
		servers: number;
		/** ids of retired entries with no energy figure */
		unpriced: string[];
		/** L2, derived from the ledger */
		layer: 'L2';
	} | null;
	/** sentence stating the physical saving, or that none was shown */
	statement: string;
};

/** the priced part of the ledger, or only the unpriced ids when no entry has an energy figure */
function physicalFrom(
	ledger: readonly RetirementEntry[]
): NonNullable<InstitutionReport['physical']> | { unpriced: string[] } | null {
	if (ledger.length === 0) return null;
	let mwh = 0;
	let servers = 0;
	const unpriced: string[] = [];
	for (const entry of ledger) {
		if (!Number.isFinite(entry.years) || entry.years <= 0) {
			throw new RangeError(`${entry.id}: years must be a positive finite number`);
		}
		if (entry.evidence.trim() === '') {
			throw new RangeError(`${entry.id}: evidence is required`);
		}
		if (entry.kind === 'instance' && entry.watts === undefined) {
			unpriced.push(entry.id);
			continue;
		}
		mwh += entry.years * serverYearMWh(entry.watts);
		servers += entry.years;
	}
	if (servers === 0) return { unpriced };
	return { mwh, servers, unpriced, layer: 'L2' };
}

function observedFrom(observed: Observed | undefined): InstitutionReport['observed'] {
	if (!observed) return null;
	for (const n of [observed.before, observed.after]) {
		if (!Number.isFinite(n) || n < 0) {
			throw new RangeError(
				`${observed.metric}: before and after must be non-negative finite numbers`
			);
		}
	}
	return {
		...observed,
		reduction:
			observed.before > 0 ? (observed.before - observed.after) / observed.before : null,
		layer: 'L1'
	};
}

function financialFrom(invoices: Invoices | undefined): InstitutionReport['financial'] {
	if (!invoices) return null;
	return {
		currency: invoices.currency,
		period: invoices.period,
		saving: invoices.before - invoices.after,
		layer: 'L1'
	};
}

export function institutionReport(inputs: InstitutionInputs): InstitutionReport {
	const ledger = inputs.ledger ?? [];
	const potential: InstitutionReport['potential'] = inputs.plan
		? { plan: inputs.plan, layer: inputs.planLayer ?? 'L3' }
		: null;
	const found = physicalFrom(ledger);
	if (!found || !('mwh' in found)) {
		const unpriced = found?.unpriced ?? [];
		return {
			observed: observedFrom(inputs.observed),
			potential,
			financial: financialFrom(inputs.invoices),
			physical: null,
			statement:
				'No physical capacity saving demonstrated.' +
				(unpriced.length > 0 ? ` Unpriced entries: ${unpriced.join(', ')}.` : '')
		};
	}
	const servers = Number(found.servers.toPrecision(3)).toString();
	const priced = ledger.length - found.unpriced.length;
	const years = servers === '1' ? 'server-year' : 'server-years';
	const entries = priced === 1 ? 'entry' : 'entries';
	return {
		observed: observedFrom(inputs.observed),
		potential,
		financial: financialFrom(inputs.invoices),
		physical: found,
		statement: `Physical saving from ${servers} retired ${years} across ${priced} ledger ${entries}.`
	};
}
