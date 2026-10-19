import {
	DOCUMENT_BYTES,
	FREE_TIER_VIEWS,
	MOBILE_SHARE,
	ORIGIN_J,
	PUE,
	RADIO_J,
	READ_SHARE,
	SERVER_FLOOR,
	SERVER_WATTS,
	SWD_V4
} from './inputs.js';

const J_PER_KWH = 3.6e6;
const J_PER_MWH = 3.6e9;
const HOURS_PER_YEAR = 8760;

/** SWD v4 network + data centre + device, in kWh/GB */
export function swdTotal(): number {
	return SWD_V4.network.value + SWD_V4.datacentre.value + SWD_V4.device.value;
}

/** attributional joules for moving `bytes`, at `kwhPerGb` */
export function attributionalJoules(bytes: number, kwhPerGb = swdTotal()): number {
	return (bytes / 1e9) * kwhPerGb * J_PER_KWH;
}

/** what one zero-network local view avoids, before a rig replaces the modelled terms */
export type ViewTerms = {
	bytes: number;
	originJ: number;
	radioJ: number;
	mobileShare: number;
};

/** the modelled defaults: the replaced document, a conventional origin, the attributed radio wake */
export const MODELLED_VIEW: ViewTerms = {
	bytes: DOCUMENT_BYTES.value,
	originJ: ORIGIN_J.conventional.value,
	radioJ: RADIO_J.attributed.value,
	mobileShare: MOBILE_SHARE.value
};

/** joules avoided per local view: attributional bytes + origin request + radio wake on phones */
export function joulesPerView(terms: ViewTerms = MODELLED_VIEW): number {
	return attributionalJoules(terms.bytes) + terms.originJ + terms.mobileShare * terms.radioJ;
}

/**
 * Joules avoided per local view where the origin's own energy for that workload was measured. The
 * measured joules replace SWD's data-centre term and the modelled origin request, so the figure
 * keeps the network and device terms of the bytes, the measured origin joules and the radio wake.
 */
export function joulesPerViewWithOrigin(
	originJ: number,
	terms: Pick<ViewTerms, 'bytes' | 'radioJ' | 'mobileShare'> = MODELLED_VIEW
): number {
	const outside = SWD_V4.network.value + SWD_V4.device.value;
	return attributionalJoules(terms.bytes, outside) + originJ + terms.mobileShare * terms.radioJ;
}

/** the data-centre term of the bytes in a view, the part measured origin joules replace */
export function dataCentreJoules(bytes: number = DOCUMENT_BYTES.value): number {
	return attributionalJoules(bytes, SWD_V4.datacentre.value);
}

/** the views channel: annual views x local share x joules per local view, in MWh */
export function viewsChannelMWh(
	annualViews: number,
	localShare: number,
	jPerView = joulesPerView()
): number {
	return (annualViews * localShare * jPerView) / J_PER_MWH;
}

/** a year of one server's facility draw, in MWh */
export function serverYearMWh(watts = SERVER_WATTS.value, pue = PUE.value): number {
	return (watts * pue * HOURS_PER_YEAR) / 1e6;
}

/** origin work removed at peak: local share x the share of load that is reads */
export function peakCut(localShare: number, readShare = READ_SHARE.value): number {
	return localShare * readShare;
}

/**
 * Servers still needed after spool removes `cut` of the peak work.
 *
 * A sensitivity model only: a real institution is sized from its peak traces and SLOs, which this
 * proportional rule does not see.
 */
export function serversAfter(before: number, cut: number, floor = SERVER_FLOOR.value): number {
	return Math.max(floor, Math.ceil(before * (1 - cut)));
}

/** MWh a year from the servers the cut frees, if they are actually removed */
export function capacityMWh(
	before: number,
	cut: number,
	floor = SERVER_FLOOR.value,
	perServer = serverYearMWh()
): number {
	return (before - serversAfter(before, cut, floor)) * perServer;
}

/** the smallest throughput-sized fleet whose freed servers plus the views channel reach `target` */
export function fleetFor(
	targetMWh: number,
	viewsMWh: number,
	cut: number,
	floor = SERVER_FLOOR.value,
	perServer = serverYearMWh()
): number {
	if (cut <= 0) throw new RangeError('a cut of zero frees no server');
	let n = floor;
	while (capacityMWh(n, cut, floor, perServer) + viewsMWh < targetMWh) n++;
	return n;
}

/** monthly views under the free request allowance when `localShare` of views make no request */
export function freeTierCeiling(
	localShare: number,
	localViewsPerSync = 20,
	base = FREE_TIER_VIEWS.value
): number {
	return base / (1 - localShare + localShare / localViewsPerSync);
}
