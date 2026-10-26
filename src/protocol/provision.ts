import type { ProvisionConfig } from './config.js';
import { lowerBound } from './navigation.js';

/** a cost in the two units the model keeps apart: bytes moved and requests made */
export type Cost = { bytes: number; requests: number };

/**
 * What the worker assumes until the server's telemetry sets it. All six are scenario priors
 * (L3), not measurements; `avoidedBytes` is the median repeat-view document a local view replaces
 * (`DOCUMENT_BYTES` in `src/report/inputs.ts`, L1).
 */
export type ProvisionPrior = {
	/** P_reuse: the chance a provisioned artifact serves a later view */
	reuse: number;
	/** N_future: later views one provisioned artifact serves */
	futureViews: number;
	/** what one request weighs in bytes, so requests and bytes share a scale */
	requestBytes: number;
	/** size of one artifact before the worker has fetched any */
	artifactBytes: number;
	/** bytes one local view keeps off the wire */
	avoidedBytes: number;
	/** how often one dependency tag changes, per day, before the worker has seen any */
	changesPerDay: number;
};

/** the defaults a config without `provision` gets */
export const DEFAULT_PRIOR: ProvisionPrior = {
	reuse: 0.5,
	futureViews: 2,
	requestBytes: 2000,
	artifactBytes: 20_000,
	avoidedBytes: 17_054,
	changesPerDay: 1
};

/** the prior with whatever the config overrides */
export function priorFrom(config: ProvisionConfig | undefined): ProvisionPrior {
	const { hot: _hot, ...numbers } = config ?? {};
	return { ...DEFAULT_PRIOR, ...numbers };
}

/** a cost as one number: its bytes plus `requestBytes` for each request */
export function weigh(cost: Cost, requestBytes: number): number {
	return cost.bytes + cost.requests * requestBytes;
}

/** something the worker could fetch ahead of the visit that needs it */
export type Opportunity = {
	id: string;
	/** `layout`, `template` and `asset` are shared by many pages; `route` is a page the server calls hot; `expansion` is a page the user has not asked for yet */
	kind: 'layout' | 'template' | 'asset' | 'route' | 'expansion';
	/** what fetching it costs, once */
	provision: Cost;
	/** what keeping it current costs over its life; none when omitted */
	maintain?: Cost;
	/** what each view served from it keeps off the wire */
	avoided: Cost;
	/** overrides {@link ProvisionPrior.futureViews} */
	futureViews?: number;
	/** overrides {@link ProvisionPrior.reuse} */
	reuse?: number;
};

const NONE: Cost = { bytes: 0, requests: 0 };

/**
 * `P_reuse x N_future x C_avoided - C_provision - C_maintain`, each cost weighed in bytes. A
 * positive number means fetching it ahead moves fewer bytes and requests than leaving it to the
 * network.
 */
export function benefit(opportunity: Opportunity, prior: ProvisionPrior = DEFAULT_PRIOR): number {
	const reuse = opportunity.reuse ?? prior.reuse;
	const future = opportunity.futureViews ?? prior.futureViews;
	const weigh_ = (cost: Cost) => weigh(cost, prior.requestBytes);
	return (
		reuse * future * weigh_(opportunity.avoided) -
		weigh_(opportunity.provision) -
		weigh_(opportunity.maintain ?? NONE)
	);
}

const RANK: Record<Opportunity['kind'], number> = {
	layout: 0,
	template: 0,
	asset: 0,
	route: 1,
	expansion: 2
};

/** an opportunity with the benefit {@link benefit} gave it */
export type Planned = Opportunity & { benefit: number };

/**
 * What to fetch, in order: shared layout, templates and immutable assets, then hot routes, then
 * incremental expansion, each group by benefit with the id as tie-break. An opportunity whose
 * benefit is not positive is left out.
 */
export function plan(
	opportunities: readonly Opportunity[],
	prior: ProvisionPrior = DEFAULT_PRIOR
): Planned[] {
	return opportunities
		.map((o): Planned => ({ ...o, benefit: benefit(o, prior) }))
		.filter((o) => o.benefit > 0)
		.sort(
			(a, b) =>
				RANK[a.kind] - RANK[b.kind] ||
				b.benefit - a.benefit ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
		);
}

/** joules to move one byte: SWD v4, 0.194 kWh/GB over decimal GB (L2) */
export const JOULES_PER_BYTE = 6.984e-4;

/** joules of the origin request a local view avoids (L1, `ORIGIN_J.conventional` in `src/report/inputs.ts`) */
export const ORIGIN_JOULES = 0.455;

/** the default cap on one catalogue bundle, in compressed bytes */
export const DEFAULT_CATALOGUE_BYTES = 32_768;

/**
 * The share of devices that must open a catalogue entry for it to repay its transfer:
 * `k*E / (k*D + o)`, with `E` the entry's compressed bytes and `D` the document it replaces. At 1
 * or above the entry never pays.
 */
export function entryBreakEven(entryBytes: number, documentBytes: number): number {
	return (JOULES_PER_BYTE * entryBytes) / (JOULES_PER_BYTE * documentBytes + ORIGIN_JOULES);
}

/** a page a catalogue could carry the data of, with what the break-even rule needs to weigh it */
export type EntryCandidate = {
	path: string;
	/** the predicted share of devices that will open the page, 0 to 1 */
	p: number;
	/** the observations behind `p`; with a `z` it lowers `p` to a confidence bound, so a share seen once does not count as one seen a thousand times */
	weight?: number;
	/** compressed bytes of the entry */
	entryBytes: number;
	/** bytes of the document the entry replaces */
	documentBytes: number;
};

const sound = (n: number) => Number.isFinite(n) && n >= 0;

/** the share the decision uses: `p`, or its lower confidence bound at `z` when the candidate says how many observations back it */
function shareOf(c: EntryCandidate, z: number): number {
	return c.weight !== undefined && z > 0 ? lowerBound(c.p, c.weight, z) : c.p;
}

/** expected joules of shipping an entry: `p * (k*D + o) - k*E` */
function expectedNet(c: EntryCandidate, z: number): number {
	return (
		shareOf(c, z) * (JOULES_PER_BYTE * c.documentBytes + ORIGIN_JOULES) -
		JOULES_PER_BYTE * c.entryBytes
	);
}

/**
 * The candidates worth shipping: those whose `p` is at least their break-even, best expected net
 * first, kept while their entry bytes fit under `capBytes`. A candidate that does not fit is
 * skipped and a smaller one may still go. A path is chosen once. A candidate with a `p` outside 0
 * to 1 or a negative or non-finite size is never chosen. With `z` above 0, a candidate that has a
 * `weight` is judged on the lower confidence bound of its `p` (the Wilson bound at `z`), and the
 * order follows the net at that bound; one with no `weight` keeps its `p`.
 */
export function chooseEntries(
	candidates: readonly EntryCandidate[],
	options: { capBytes: number; z?: number }
): EntryCandidate[] {
	const z = options.z ?? 0;
	const paying = candidates
		.filter(
			(c) =>
				sound(c.entryBytes) &&
				sound(c.documentBytes) &&
				c.p >= 0 &&
				c.p <= 1 &&
				shareOf(c, z) >= entryBreakEven(c.entryBytes, c.documentBytes)
		)
		.sort(
			(a, b) =>
				expectedNet(b, z) - expectedNet(a, z) ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
		);
	const out: EntryCandidate[] = [];
	const seen = new Set<string>();
	let bytes = 0;
	for (const c of paying) {
		if (seen.has(c.path) || bytes + c.entryBytes > options.capBytes) continue;
		seen.add(c.path);
		bytes += c.entryBytes;
		out.push(c);
	}
	return out;
}

/**
 * P_reuse from aggregate telemetry: the share of a route's views that found a stored copy, pulled
 * toward the prior by `weight` pseudo-views so a few views do not decide it. The telemetry
 * has no device identity, so this is a share of views, not of provisioned copies.
 */
export function smoothReuse(
	warmViews: number,
	coldViews: number,
	prior: ProvisionPrior = DEFAULT_PRIOR,
	weight = 10
): number {
	return (prior.reuse * weight + warmViews) / (weight + warmViews + coldViews);
}
