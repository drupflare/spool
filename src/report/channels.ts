import type { Layer } from './inputs.js';
import type { InstitutionReport } from './institution.js';

/** a figure with the layer it is at and the source it came from */
export type Labelled<T> = {
	/** the figure, in the shape T gives it */
	value: T;
	/** L0 published, L1 measured here, L2 derived, L3 scenario */
	layer: Layer;
	/** where the figure came from, so a reader can check it */
	source: string;
};

/** what spool kept off the origin and the network, per measure; null where nothing was measured */
export type AvoidedDemand = {
	/** bytes not sent over the network */
	transferredBytes: number | null;
	/** requests not made */
	requests: number | null;
	/** origin CPU milliseconds not spent */
	serverCpuMs: number | null;
	/** browser CPU milliseconds not spent */
	browserCpuMs: number | null;
	/** data centre work milliseconds not done */
	dataCentreWorkMs: number | null;
	/** nodes the peak no longer needs */
	peakNodes: number | null;
};

/**
 * The four channels. They are reported side by side and never summed, so there is no total across
 * them.
 */
export type Channels = {
	/** energy a meter read, in joules; null when nothing was read */
	metered: Labelled<{
		/** joules the meter read */
		joules: number;
	}> | null;
	/** energy attributed to the workload; null when none is attributed */
	attributional: Labelled<{
		/** joules attributed to the workload */
		joules: number;
	}> | null;
	/** the institution report's capacity figures; null without a report */
	capacity: Labelled<InstitutionReport> | null;
	/** what spool kept off the origin and the network; null when not measured */
	avoided: Labelled<AvoidedDemand> | null;
};

export type ChannelRow = {
	/** the channel the number belongs to */
	channel: keyof Channels;
	/** what the number measures, as a short label */
	measure: string;
	/** the number, in unit */
	value: number;
	/** unit of value, such as J, nodes or MWh */
	unit: string;
	/** the layer the number is at */
	layer: Layer;
};

/** one row per present number, in channel order; rows from different channels are never combined */
export function channelRows(channels: Channels): ChannelRow[] {
	const rows: ChannelRow[] = [];
	for (const channel of ['metered', 'attributional'] as const) {
		const labelled = channels[channel];
		if (labelled) {
			rows.push({
				channel,
				measure: 'energy',
				value: labelled.value.joules,
				unit: 'J',
				layer: labelled.layer
			});
		}
	}

	const capacity = channels.capacity;
	if (capacity) {
		const { potential, financial, physical } = capacity.value;
		if (potential) {
			rows.push({
				channel: 'capacity',
				measure: 'potential retirable nodes',
				value: potential.plan.retirable,
				unit: 'nodes',
				layer: potential.layer
			});
		}
		if (financial) {
			rows.push({
				channel: 'capacity',
				measure: 'financial saving',
				value: financial.saving,
				unit: financial.currency,
				layer: financial.layer
			});
		}
		if (physical) {
			rows.push({
				channel: 'capacity',
				measure: 'physical energy',
				value: physical.mwh,
				unit: 'MWh',
				layer: physical.layer
			});
		}
	}

	const avoided = channels.avoided;
	if (avoided) {
		const fields: Array<[keyof AvoidedDemand, string]> = [
			['transferredBytes', 'B'],
			['requests', 'requests'],
			['serverCpuMs', 'ms'],
			['browserCpuMs', 'ms'],
			['dataCentreWorkMs', 'ms'],
			['peakNodes', 'nodes']
		];
		for (const [measure, unit] of fields) {
			const value = avoided.value[measure];
			if (value !== null) {
				rows.push({ channel: 'avoided', measure, value, unit, layer: avoided.layer });
			}
		}
	}
	return rows;
}
