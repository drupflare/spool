import type { WorkSample } from './traffic.js';

/**
 * What one node can do within the latency SLO, per resource. A resource is any name the trace uses,
 * such as `busyMs` or `memoryMb`. `perNode.busyMs` is handler milliseconds a node can do per second
 * within the SLO, for example 1000 times cores times a target utilisation, so callers pass busy time
 * as a per-second rate.
 */
export type NodeLimits = {
	/** what one node serves per second within the SLO, per resource; must be positive */
	perNode: Record<string, number>;
	/** fewest nodes the fleet runs; default 1 */
	floor?: number;
	/** nodes kept above the peak need; default 0 */
	spares?: number;
	/** regions the fleet spans; default 1 */
	regions?: number;
	/** nodes each region must run; default 1 */
	minPerRegion?: number;
};

/** demand in one interval: what the origin did, and what spool removed of it, per resource */
export type IntervalDemand = {
	/** when the interval starts, on the clock of the samples it came from */
	start: number;
	/** length of the interval in seconds */
	seconds: number;
	/** the origin's need per resource, per second */
	demand: Record<string, number>;
	/** the part of demand spool removed, per resource and per second; missing means none */
	avoided?: Record<string, number>;
};

/** `bindingBefore` and `bindingAfter` name the resource that set the worst interval's need */
export type CapacityPlan = {
	/** nodes the worst interval needs without spool */
	before: number;
	/** nodes the worst interval needs once avoided work is removed */
	after: number;
	/** nodes spool makes unneeded: before minus after */
	retirable: number;
	/** resource that sets the need before spool; null when no interval needs a node */
	bindingBefore: string | null;
	/** resource that sets the need after spool; null when no interval needs a node */
	bindingAfter: string | null;
	/** number of intervals in the plan */
	intervals: number;
};

/** nodes one interval's demand needs, and the resource with the largest need */
export function nodesNeeded(
	demand: Record<string, number>,
	limits: NodeLimits
): {
	/** nodes needed: peak need plus spares, not below the floor or the regional minimum */
	nodes: number;
	/** resource with the largest need, first by name on a tie; null when none needs a node */
	binding: string | null;
} {
	for (const [name, per] of Object.entries(limits.perNode)) {
		if (!Number.isFinite(per) || per <= 0) {
			throw new RangeError(`perNode.${name} must be a positive finite number`);
		}
	}
	for (const [name, need] of Object.entries(demand)) {
		if (!Number.isFinite(need) || need < 0) {
			throw new RangeError(`demand.${name} must be a finite, non-negative number`);
		}
	}

	let peak = 0;
	let binding: string | null = null;
	// sorted so a tie goes to the name that sorts first
	const names = Object.entries(limits.perNode).sort(([a], [b]) => (a < b ? -1 : 1));
	for (const [name, per] of names) {
		const need = Math.ceil((demand[name] ?? 0) / per);
		if (need > peak) {
			peak = need;
			binding = name;
		}
	}

	const nodes = Math.max(
		peak + (limits.spares ?? 0),
		limits.floor ?? 1,
		(limits.regions ?? 1) * (limits.minPerRegion ?? 1)
	);
	return { nodes, binding };
}

/** the interval that needs the most nodes, first on a tie; an empty list needs the base fleet */
function worstOf(
	demands: readonly Record<string, number>[],
	limits: NodeLimits
): { nodes: number; binding: string | null } {
	let worst: { nodes: number; binding: string | null } | null = null;
	for (const demand of demands) {
		const got = nodesNeeded(demand, limits);
		if (worst === null || got.nodes > worst.nodes) worst = got;
	}
	return worst ?? nodesNeeded({}, limits);
}

/** demand after avoided work, clamped at zero; a resource with no avoided keeps its need */
function afterAvoided({ demand, avoided = {} }: IntervalDemand): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [name, need] of Object.entries(demand)) {
		out[name] = Math.max(0, need - (avoided[name] ?? 0));
	}
	return out;
}

/** the fleet the intervals need before and after spool removes its avoided work */
export function capacityPlan(
	intervals: readonly IntervalDemand[],
	limits: NodeLimits
): CapacityPlan {
	const before = worstOf(
		intervals.map((interval) => interval.demand),
		limits
	);
	const after = worstOf(intervals.map(afterAvoided), limits);
	return {
		before: before.nodes,
		after: after.nodes,
		retirable: before.nodes - after.nodes,
		bindingBefore: before.binding,
		bindingAfter: after.binding,
		intervals: intervals.length
	};
}

/**
 * Per-second demand for each sample, with `busyMs` summed over its routes. `avoidedBusyMs` holds the
 * handler milliseconds spool removed in each interval, in the order of `samples` sorted by start.
 */
export function intervalsFromWork(
	samples: readonly WorkSample[],
	avoidedBusyMs: readonly number[]
): IntervalDemand[] {
	if (avoidedBusyMs.length !== samples.length) {
		throw new RangeError('avoidedBusyMs needs one entry per sample');
	}
	const ordered = [...samples].sort((a, b) => a.start - b.start);
	return ordered.map((sample, i) => {
		const busy = Object.values(sample.busyMs).reduce((total, ms) => total + ms, 0);
		return {
			start: sample.start,
			seconds: sample.seconds,
			demand: { busyMs: busy / sample.seconds },
			avoided: { busyMs: (avoidedBusyMs[i] as number) / sample.seconds }
		};
	});
}
