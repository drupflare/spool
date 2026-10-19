import { DOCUMENT_BYTES, type HostPrice } from './inputs.js';

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

/** decimal GB a month that `annualLocalViews` no longer move */
export function monthlyGb(annualLocalViews: number, bytes: number = DOCUMENT_BYTES.value): number {
	return (annualLocalViews * bytes) / 12 / 1e9;
}
