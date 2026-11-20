import { median } from './derive.js';
import {
	DOCUMENT_BYTES,
	EGRID_LB_PER_MWH,
	ELECTRICITY_PRICE,
	G_PER_LB,
	type EgridSubregion,
	type HostPrice,
	type Input,
	type PriceState
} from './inputs.js';
import type { Measurement } from './measurement.js';

/** egress dollars for `localViews` that no longer send the document, at the host's tier price */
export function egressUsd(
	localViews: number,
	host: HostPrice,
	bytes: number = DOCUMENT_BYTES.value
): number {
	return ((localViews * bytes) / host.bytesPerUnit) * host.egress.value;
}

/** request dollars for `localViews`, one request each, where the host bills requests */
export function requestUsd(localViews: number, host: HostPrice): number {
	return host.requests ? (localViews / 1e6) * host.requests.value : 0;
}

/** egress plus request dollars, before any free allowance */
export function bandwidthUsd(
	localViews: number,
	host: HostPrice,
	bytes: number = DOCUMENT_BYTES.value
): number {
	return egressUsd(localViews, host, bytes) + requestUsd(localViews, host);
}

/**
 * egress dollars per million views when `share` of them are views that move `bytes` fewer bytes,
 * at the host's tier price. A trimmed file is the same request, so there is no request term.
 */
export function perMillionViewsUsd(bytes: number, share: number, host: HostPrice): number {
	return egressUsd(1e6 * share, host, bytes);
}

/** decimal GB a month that `annualLocalViews` no longer move */
export function monthlyGb(annualLocalViews: number, bytes: number = DOCUMENT_BYTES.value): number {
	return (annualLocalViews * bytes) / 12 / 1e9;
}

/** the price record for a state and sector; throws on a state the price table does not hold */
export function electricityPrice(state: string, sector: 'commercial' | 'industrial'): Input {
	if (!Object.hasOwn(ELECTRICITY_PRICE, state))
		throw new RangeError(
			`no electricity price for ${state}; the table holds ${Object.keys(ELECTRICITY_PRICE).join(', ')}`
		);
	return ELECTRICITY_PRICE[state as PriceState][sector];
}

/** dollars for `mwh` at `centsPerKwh` (one cent per kWh is $10 per MWh) */
export const usdForMwh = (mwh: number, centsPerKwh: number): number => mwh * centsPerKwh * 10;

/** grams CO2e per kWh from a rate in pounds per MWh, the unit eGRID prints */
export const gPerKwhFromLbPerMwh = (lbPerMwh: number): number => (lbPerMwh * G_PER_LB) / 1000;

/** tonnes CO2e from megawatt-hours at `gPerKwh` */
export const tonnesFromMwh = (mwh: number, gPerKwh: number): number => (mwh * gPerKwh) / 1000;

/** the eGRID2023 rate of a subregion as grams per kWh; throws on a subregion the table does not hold */
export function egridGPerKwh(subregion: EgridSubregion): number {
	if (!Object.hasOwn(EGRID_LB_PER_MWH, subregion))
		throw new RangeError(`no eGRID subregion ${subregion}`);
	return gPerKwhFromLbPerMwh(EGRID_LB_PER_MWH[subregion].value);
}

/** the day the vendor pages below were read */
export const ECON_PRICES_READ = '2026-11-18';

/** requests a Free account may send a day before Cloudflare stops it (L0) */
export const CF_FREE_REQUESTS_PER_DAY: Input = {
	value: 100_000,
	unit: 'requests/day',
	layer: 'L0',
	source: `developers.cloudflare.com/workers/platform/pricing (web page read ${ECON_PRICES_READ}): "100,000 per day" on the Free plan`
};

/** requests a paid account includes each month before the per-million price applies (L0) */
export const CF_PAID_INCLUDED: Input = {
	value: 10_000_000,
	unit: 'requests/month',
	layer: 'L0',
	source: `developers.cloudflare.com/workers/platform/pricing (web page read ${ECON_PRICES_READ}): "10 million included per month"`
};

/** the paid plan's price for each additional million requests (L0) */
export const CF_PAID_PER_MILLION: Input = {
	value: 0.3,
	unit: 'USD/million requests',
	layer: 'L0',
	source: `developers.cloudflare.com/workers/platform/pricing (web page read ${ECON_PRICES_READ}): "$0.30 per additional million"`
};

/** requests after the first document in a bootstrap, with a worker (L3, design value) */
export const BOOTSTRAP_EXTRA_WORKER: Input = {
	value: 2,
	unit: 'requests',
	layer: 'L3',
	source: 'design: the stub and one pack after the first document; the 2026-11-20 demand reading shows the same two non-document requests (boot script and stub) for Chromium and Firefox at 121 views'
};

/** the same count without a worker (L3, design value) */
export const BOOTSTRAP_EXTRA_NO_WORKER: Input = {
	value: 1,
	unit: 'requests',
	layer: 'L3',
	source: 'design: one pack after the first document; no reading under measurements/ fixes it yet'
};

/** WebKit for macOS script-check requests per document navigation (L1) */
export const WEBKIT_STUB_RATE: Input = {
	value: 1,
	unit: 'requests per navigation',
	layer: 'L1',
	source: 'WebKit on macOS, Playwright, 1.5 s between navigations: /sw.js reached the origin on 6 of 6 document navigations and 3 of 3 new tabs'
};

/** a read workload as the request law takes it (L3 values) */
export type Workload = {
	name: string;
	/** read views a replica serves per lifetime */
	viewsPerLifetime: number;
	/** lifetimes a bootstrap lasts */
	lifetimes: number;
	/** syncs per lifetime */
	syncs: number;
	/** updates per lifetime */
	updates: number;
	/** writes per read view, each one request on either path */
	writes: number;
	/** contacts per read view that leave the replica */
	contacts: number;
	/** document navigations on WebKit for macOS per lifetime (L3) */
	webkitNavigations: Input;
};

/** the five workloads the outputs project (L3) */
export const WORKLOADS: readonly Workload[] = [
	{
		name: 'Short read lifetime',
		viewsPerLifetime: 5,
		lifetimes: 1,
		syncs: 0,
		updates: 0,
		writes: 0,
		contacts: 0,
		webkitNavigations: {
			value: 5,
			unit: 'navigations per lifetime',
			layer: 'L3',
			source: 'scenario: each of the five views is a document, since a short visit has no in-page views'
		}
	},
	{
		name: 'Engaged daily public reader',
		viewsPerLifetime: 100,
		lifetimes: 1,
		syncs: 1,
		updates: 0,
		writes: 0,
		contacts: 0,
		webkitNavigations: {
			value: 5,
			unit: 'navigations per lifetime',
			layer: 'L3',
			source: 'scenario: five of the 100 views start a document (new visit, reload or new tab); the rest are in-page'
		}
	},
	{
		name: 'Retained public library',
		viewsPerLifetime: 100,
		lifetimes: 10,
		syncs: 1,
		updates: 0.2,
		writes: 0,
		contacts: 0,
		webkitNavigations: {
			value: 5,
			unit: 'navigations per lifetime',
			layer: 'L3',
			source: 'scenario: five of the 100 views per lifetime start a document; the rest are in-page'
		}
	},
	{
		name: 'Read/write workspace',
		viewsPerLifetime: 100,
		lifetimes: 10,
		syncs: 1,
		updates: 0.2,
		writes: 0.1,
		contacts: 0.05,
		webkitNavigations: {
			value: 10,
			unit: 'navigations per lifetime',
			layer: 'L3',
			source: 'scenario: ten of the 100 views per lifetime start a document, twice the reader share, for reloads and new tabs'
		}
	},
	{
		name: 'Ungated two-view lifetime',
		viewsPerLifetime: 2,
		lifetimes: 1,
		syncs: 0,
		updates: 0,
		writes: 0,
		contacts: 0,
		webkitNavigations: {
			value: 2,
			unit: 'navigations per lifetime',
			layer: 'L3',
			source: 'scenario: both views are documents, since a two-view lifetime has no in-page view'
		}
	}
];

/** Azure internet egress from North America and Europe, first paid tier, USD (L0) */
export const AZURE_EGRESS: HostPrice = {
	name: 'Microsoft Azure',
	tier: 'internet egress from North America and Europe, the next 10 TB a month',
	page: 'azure.microsoft.com/en-us/pricing/details/bandwidth',
	egress: {
		value: 0.087,
		unit: 'USD/GB',
		layer: 'L0',
		source: `azure.microsoft.com/en-us/pricing/details/bandwidth (web page read ${ECON_PRICES_READ}): "From North America, Europe to any destination", next 10 TB a month $0.087 per GB`
	},
	bytesPerUnit: 1e9,
	freeAllowance: {
		value: 100,
		unit: 'GB/month',
		layer: 'L0',
		source: `azure.microsoft.com/en-us/pricing/details/bandwidth (web page read ${ECON_PRICES_READ}): first 100 GB a month free`
	}
};

/** Google Cloud Premium Tier data transfer out to North America, USD (L0) */
export const GCP_EGRESS: HostPrice = {
	name: 'Google Cloud (Premium Tier)',
	tier: 'data transfer out to North America, 1 GiB to 1,024 GiB a month',
	page: 'cloud.google.com/vpc/network-pricing',
	egress: {
		value: 0.12,
		unit: 'USD/GiB',
		layer: 'L0',
		source: `cloud.google.com/vpc/network-pricing (web page read ${ECON_PRICES_READ}): "Network (data transfer out) TO North America (per GiB in USD)", 1 gibibyte to 1,024 gibibyte $0.12 per gibibyte`
	},
	bytesPerUnit: 2 ** 30,
	freeAllowance: {
		value: 1,
		unit: 'GiB/month',
		layer: 'L0',
		source: `cloud.google.com/vpc/network-pricing (web page read ${ECON_PRICES_READ}): 0 gibibyte to 1 gibibyte $0.00 (Free)`
	}
};

/** the first-view document median of a first-view reading, over its corpus pages (L1) */
export function firstViewDocumentMedian(reading: Measurement): number {
	const pages = reading.method['corpus pages'] as
		Array<{ classBytes: { document: number } }> | undefined;
	if (!pages?.length) throw new RangeError('the first-view reading has no corpus pages');
	return median(pages.map((p) => p.classBytes.document));
}

/** Worker requests per read view under spool, excluding the WebKit script check */
export function requestsPerReadView(
	w: Workload,
	bootstrapExtra: number = BOOTSTRAP_EXTRA_WORKER.value
): number {
	return (
		(1 + bootstrapExtra) / (w.lifetimes * w.viewsPerLifetime) +
		(w.syncs + w.updates) / w.viewsPerLifetime +
		w.writes +
		w.contacts
	);
}

/** Worker requests per read view without spool: the document request and the writes */
export const baselinePerReadView = (w: Workload): number => 1 + w.writes;

/** share of read views a replica answers with no request; writes reach the origin either way */
export function heldShare(w: Workload, requests: number): number {
	return Math.min(1, Math.max(0, 1 - (requests - w.writes)));
}

/** Worker requests the WebKit macOS script check adds per read view, stub on the Worker */
export const webkitStubPerReadView = (w: Workload): number =>
	(WEBKIT_STUB_RATE.value * w.webkitNavigations.value) / w.viewsPerLifetime;

/** read views a day the Free plan's request limit supports at `requestsPerView` each */
export const freeReadViewsPerDay = (requestsPerView: number): number =>
	CF_FREE_REQUESTS_PER_DAY.value / requestsPerView;

/** requests above the paid plan's included amount */
export const overIncluded = (requests: number): number =>
	Math.max(0, requests - CF_PAID_INCLUDED.value);

/** dollars at the paid plan's per-million price for the requests above the included amount */
export const paidRequestsUsd = (requests: number): number =>
	(overIncluded(requests) / 1e6) * CF_PAID_PER_MILLION.value;
