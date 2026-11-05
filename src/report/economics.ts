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
