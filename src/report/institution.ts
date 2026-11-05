import type { TimedView } from '../protocol/view.js';
import type { CapacityPlan } from './capacity.js';
import { egridGPerKwh, electricityPrice, tonnesFromMwh, usdForMwh } from './economics.js';
import {
	EMBER_US_G_PER_KWH,
	FIRST_VIEW_BYTES,
	FIRST_VIEW_SHARE,
	GOAL_HIGH_SHARE,
	GOAL_SHARES,
	HOSTING_KWH_PER_SITE,
	REPEAT_VIEW_BYTES,
	SWD_V4,
	WATER_DIRECT,
	WATER_INDIRECT,
	WATER_INDIRECT_LBNL,
	type EgridSubregion,
	type Input
} from './inputs.js';
import { serverYearMWh } from './model.js';
import { mismatchesByRoute } from './traffic.js';

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

/** a campus and the sites its host serves; what the economics and research blocks price */
export type InstitutionProfile = {
	/** two-letter state code for the electricity price; a state the price table lacks throws */
	state: string;
	/** the eGRID2023 subregion the campus's electricity comes from */
	subregion: EgridSubregion;
	/** sites the host serves for the institution; the hosting saving is per site */
	sites: number;
	/** the institution's page views a year; the basis of the goal ladder */
	viewsPerYear: number;
	/** spool's attributional saving a year across all three boundaries, in MWh, from the caller's views channel */
	attributionalMwh: number;
};

/** bytes one dataset holds on the device or on the server */
export type Holding = {
	/** the dataset's name in the site's manifest */
	dataset: string;
	/** where the bytes sit */
	where: 'device' | 'server';
	/** bytes held; non-negative */
	bytes: number;
};

/** the bytes held per dataset against the declared budget for each side */
export type StorageInputs = {
	/** the declared budget in bytes, for the device and for the server */
	budget: { device: number; server: number };
	/** what each dataset holds; a side with no holding reads zero */
	holdings: readonly Holding[];
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
	/** the campus and its sites, for the economics and research blocks */
	institution?: InstitutionProfile;
	/** bytes held per dataset on the device and the server, for the storage block */
	storage?: StorageInputs;
	/** the views spool recorded, for the trust block; read the worker's own counters from these */
	views?: readonly TimedView[];
};

/** what the worker does not count; the trust block reads each as unknown, not as zero */
const NOT_COUNTED = ['proof failures', 'reseeds', 'rollbacks'] as const;

/** an observed change, then the three results of the capacity plan; none is added to another and any can be null or read zero */
export type InstitutionReport = {
	/** host-meter energy and its dollars; null without an institution profile */
	economics: {
		/** the state the prices are for */
		state: string;
		/** average industrial price, EIA 2025 */
		industrial: Input;
		/** average commercial price, EIA 2025 */
		commercial: Input;
		/** the hosting saving at each deployment, headline first; priced at both sector rates */
		cases: {
			/** the deployment the saving is against */
			name: 'peak' | 'production' | 'floor';
			/** kWh a site a year */
			kwhPerSite: number;
			/** the host-meter energy a year, in MWh */
			mwh: number;
			/** dollars at the industrial rate */
			usdIndustrial: number;
			/** dollars at the commercial rate */
			usdCommercial: number;
		}[];
		/** the data-centre share of spool's attributional saving; it is already inside the hosting saving, so it is not added */
		dataCentreMwh: number;
		/** spool's attributional share outside the institution's meter: visitors' devices and networks */
		offMeterMwh: number;
		/** L2, derived from the profile and the hosting model */
		layer: 'L2';
	} | null;
	/** bytes held against the declared budget; null without storage inputs */
	storage: {
		/** the declared budget, in bytes */
		budget: { device: number; server: number };
		/** bytes the holdings sum to, per side */
		held: { device: number; server: number };
		/** whether each side is within its budget */
		within: { device: boolean; server: boolean };
		/** the holdings as given */
		holdings: readonly Holding[];
		/** L1, measured here */
		layer: 'L1';
	} | null;
	/** correctness counters from the views; null without views */
	trust: {
		/** views counted */
		views: number;
		/** shadow views the worker compared with the network's answer */
		sampled: number;
		/** sampled views whose local answer differed from the network's */
		mismatches: number;
		/** views the worker declined to answer locally or to render */
		refused: number;
		/** views answered from the network because a stored copy was outdated */
		fallbacks: number;
		/** counters the worker does not keep; read each as unknown, not as zero */
		notCounted: readonly string[];
		/** L1, measured here */
		layer: 'L1';
	} | null;
	/** energy by meter boundary, carbon, water and the goal ladder; null without an institution profile */
	research: {
		/** spool's attributional saving by boundary; only the data-centre part is on a host's meter */
		boundary: {
			devices: { mwh: number; share: number };
			networks: { mwh: number; share: number };
			dataCentres: { mwh: number; share: number };
		};
		/** tonnes CO2e of the whole attributional saving, at the campus subregion and at Ember's national figure */
		carbon: {
			subregion: EgridSubregion;
			gPerKwh: number;
			tonnes: number;
			ember: { gPerKwh: number; tonnes: number };
		};
		/** litres for the data-centre share; a locality figure, never summed across institutions */
		water: { directLitres: number; indirectLitres: number; indirectLbnlLitres: number };
		/** the goal ladder: the saving at each share of the institution's own page-view footprint, kWh a year */
		goal: {
			viewsPerYear: number;
			footprintMwh: number;
			rungs: { share: number; kwh: number }[];
			high: { share: number; kwh: number };
		};
		/** L2, derived from the profile and the published factors */
		layer: 'L2';
	} | null;
	/** an observed change, read from the caller's measurement */
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

const SWD_TOTAL = SWD_V4.network.value + SWD_V4.datacentre.value + SWD_V4.device.value;
/** the share of spool's attributional saving that is data-centre energy: 0.055 of 0.194 kWh/GB */
const DATA_CENTRE_SHARE = SWD_V4.datacentre.value / SWD_TOTAL;
const DEVICE_SHARE = SWD_V4.device.value / SWD_TOTAL;
const NETWORK_SHARE = SWD_V4.network.value / SWD_TOTAL;

/** joules per byte at the SWD v4 total: kWh per GB, times J per kWh, over bytes per GB */
const J_PER_BYTE = (SWD_TOTAL * 3.6e6) / 1e9;

/** joules an average page view costs on the attributional basis: first views at their share, repeat views the rest */
function footprintJoulesPerView(): number {
	const first = FIRST_VIEW_SHARE.central.value;
	return J_PER_BYTE * (first * FIRST_VIEW_BYTES.value + (1 - first) * REPEAT_VIEW_BYTES.value);
}

/** the page-view footprint of `viewsPerYear` views, in MWh a year, on the attributional basis */
export function footprintMwh(viewsPerYear: number): number {
	return (viewsPerYear * footprintJoulesPerView()) / 3.6e9;
}

function economicsFrom(profile: InstitutionProfile | undefined): InstitutionReport['economics'] {
	if (!profile) return null;
	const industrial = electricityPrice(profile.state, 'industrial');
	const commercial = electricityPrice(profile.state, 'commercial');
	const dataCentreMwh = profile.attributionalMwh * DATA_CENTRE_SHARE;
	return {
		state: profile.state,
		industrial,
		commercial,
		cases: (
			[
				['peak', HOSTING_KWH_PER_SITE.peak],
				['production', HOSTING_KWH_PER_SITE.production],
				['floor', HOSTING_KWH_PER_SITE.floor]
			] as const
		).map(([name, perSite]) => {
			const mwh = (profile.sites * perSite.value) / 1000;
			return {
				name,
				kwhPerSite: perSite.value,
				mwh,
				usdIndustrial: usdForMwh(mwh, industrial.value),
				usdCommercial: usdForMwh(mwh, commercial.value)
			};
		}),
		dataCentreMwh,
		offMeterMwh: profile.attributionalMwh - dataCentreMwh,
		layer: 'L2'
	};
}

function storageFrom(inputs: StorageInputs | undefined): InstitutionReport['storage'] {
	if (!inputs) return null;
	for (const h of inputs.holdings) {
		if (!Number.isFinite(h.bytes) || h.bytes < 0) {
			throw new RangeError(`${h.dataset}: bytes must be a non-negative finite number`);
		}
	}
	const held = { device: 0, server: 0 };
	for (const h of inputs.holdings) held[h.where] += h.bytes;
	return {
		budget: inputs.budget,
		held,
		within: {
			device: held.device <= inputs.budget.device,
			server: held.server <= inputs.budget.server
		},
		holdings: inputs.holdings,
		layer: 'L1'
	};
}

function trustFrom(views: readonly TimedView[] | undefined): InstitutionReport['trust'] {
	if (!views) return null;
	const routes = mismatchesByRoute(views);
	return {
		views: views.length,
		sampled: routes.reduce((n, r) => n + r.compared, 0),
		mismatches: routes.reduce((n, r) => n + r.mismatches, 0),
		refused: views.filter((v) => v.reason === 'refused' || v.reason === 'hard-refused').length,
		fallbacks: views.filter(
			(v) => v.reason === 'invalidated' || v.reason === 'stale-after-sync'
		).length,
		notCounted: NOT_COUNTED,
		layer: 'L1'
	};
}

function waterLitres(dataCentreMwh: number) {
	const kwh = dataCentreMwh * 1000;
	return {
		directLitres: kwh * WATER_DIRECT.value,
		indirectLitres: kwh * WATER_INDIRECT.value,
		indirectLbnlLitres: kwh * WATER_INDIRECT_LBNL.value
	};
}

function researchFrom(profile: InstitutionProfile | undefined): InstitutionReport['research'] {
	if (!profile) return null;
	const att = profile.attributionalMwh;
	const gPerKwh = egridGPerKwh(profile.subregion);
	const footprint = footprintMwh(profile.viewsPerYear);
	const goal = (share: number) => ({ share, kwh: footprint * share * 1000 });
	return {
		boundary: {
			devices: { mwh: att * DEVICE_SHARE, share: DEVICE_SHARE },
			networks: { mwh: att * NETWORK_SHARE, share: NETWORK_SHARE },
			dataCentres: { mwh: att * DATA_CENTRE_SHARE, share: DATA_CENTRE_SHARE }
		},
		carbon: {
			subregion: profile.subregion,
			gPerKwh,
			tonnes: tonnesFromMwh(att, gPerKwh),
			ember: {
				gPerKwh: EMBER_US_G_PER_KWH.value,
				tonnes: tonnesFromMwh(att, EMBER_US_G_PER_KWH.value)
			}
		},
		water: waterLitres(att * DATA_CENTRE_SHARE),
		goal: {
			viewsPerYear: profile.viewsPerYear,
			footprintMwh: footprint,
			rungs: GOAL_SHARES.map(goal),
			high: goal(GOAL_HIGH_SHARE.value)
		},
		layer: 'L2'
	};
}

/** one institution in a roll-up: its attributional saving and the subregion its electricity comes from */
export type InstitutionRow = {
	/** a label for the row; the report prints it beside the institution's own litres */
	name: string;
	/** the eGRID2023 subregion the institution's electricity comes from */
	subregion: EgridSubregion;
	/** spool's attributional saving a year across all three boundaries, in MWh */
	attributionalMwh: number;
};

/**
 * A roll-up across institutions. Energy and carbon add up. Water does not add up: it is local, so
 * each institution keeps its own litres and the type has no total.
 */
export type Rollup = {
	/** rows summed */
	institutions: number;
	/** attributional MWh a year, summed */
	mwh: number;
	/** tonnes CO2e a year, summed; each row uses its own subregion */
	tonnes: number;
	/** litres for each row's data-centre share, one entry per institution */
	water: { name: string; directLitres: number; indirectLitres: number }[];
};

/** sums energy and carbon across institutions and keeps water per institution */
export function rollUpInstitutions(rows: readonly InstitutionRow[]): Rollup {
	let mwh = 0;
	let tonnes = 0;
	const water = rows.map((row) => {
		mwh += row.attributionalMwh;
		tonnes += tonnesFromMwh(row.attributionalMwh, egridGPerKwh(row.subregion));
		const { directLitres, indirectLitres } = waterLitres(
			row.attributionalMwh * DATA_CENTRE_SHARE
		);
		return { name: row.name, directLitres, indirectLitres };
	});
	return { institutions: rows.length, mwh, tonnes, water };
}

export function institutionReport(inputs: InstitutionInputs): InstitutionReport {
	const ledger = inputs.ledger ?? [];
	const potential: InstitutionReport['potential'] = inputs.plan
		? { plan: inputs.plan, layer: inputs.planLayer ?? 'L3' }
		: null;
	const blocks = {
		economics: economicsFrom(inputs.institution),
		storage: storageFrom(inputs.storage),
		trust: trustFrom(inputs.views),
		research: researchFrom(inputs.institution)
	};
	const found = physicalFrom(ledger);
	if (!found || !('mwh' in found)) {
		const unpriced = found?.unpriced ?? [];
		return {
			...blocks,
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
		...blocks,
		observed: observedFrom(inputs.observed),
		potential,
		financial: financialFrom(inputs.invoices),
		physical: found,
		statement: `Physical saving from ${servers} retired ${years} across ${priced} ledger ${entries}.`
	};
}
