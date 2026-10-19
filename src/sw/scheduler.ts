import { DEFAULT_PRIOR } from '../protocol/provision.js';
import type { SyncResponse } from '../protocol/sync.js';
import type { Replica } from './replica.js';

/** what the scheduler needs from the outside world */
export type SchedulerDeps = {
	replica: Replica;
	/**
	 * asks the server for everything changed after `from`, or, given `need`, only the ids in it
	 * whose version moved past the held one; rejects when the network fails
	 */
	fetchSync(from: number, need?: Record<string, number>): Promise<SyncResponse>;
	/** called after each request the scheduler made, so queued work can ride the same network moment */
	onNetwork?(): void;
	/** what a sync costs and what showing stale content costs, in weighed bytes; see `ProvisionPrior` */
	policy?: SyncPolicy;
};

/** the numbers {@link syncBenefit} weighs */
export type SyncPolicy = {
	/** a dependency tag's change rate per day before any has been observed */
	changesPerDay: number;
	/** bytes one stale view costs, as the page a fresh sync would have saved */
	staleBytes: number;
	/** bytes one sync request costs */
	syncBytes: number;
};

const DAY = 86_400;

/** a policy that always finds a sync worth making only after enough time has passed */
export const DEFAULT_POLICY: SyncPolicy = {
	changesPerDay: DEFAULT_PRIOR.changesPerDay,
	staleBytes: DEFAULT_PRIOR.avoidedBytes,
	syncBytes: DEFAULT_PRIOR.requestBytes
};

/**
 * A change rate learned from exposure. Each tag a sync asked about was watched for `seconds`
 * and either changed or did not; the estimate is the Gamma posterior mean, which starts at the
 * prior rate and moves toward the observed one as exposure accumulates.
 */
export class ChangeRate {
	#changes: number;
	#seconds: number;

	/** the prior counts as one change seen over `1 / perDay` days */
	constructor(perDay: number) {
		this.#changes = 1;
		this.#seconds = DAY / perDay;
	}

	/** records `tags` watched for `seconds` each, of which `changed` did change */
	observe(tags: number, seconds: number, changed: number): void {
		this.#changes += changed;
		this.#seconds += tags * seconds;
	}

	/** changes per second per tag */
	perSecond(): number {
		return this.#changes / this.#seconds;
	}
}

/**
 * Expected benefit of syncing now, in weighed bytes: the chance something changed since the last
 * check times what a stale view costs, less what the sync costs. It grows with `ageSec` toward
 * `staleBytes - syncBytes`.
 */
export function syncBenefit(input: {
	ageSec: number;
	perSecond: number;
	tags: number;
	policy: SyncPolicy;
}): number {
	const chance = 1 - Math.exp(-input.perSecond * input.tags * Math.max(0, input.ageSec));
	return chance * input.policy.staleBytes - input.policy.syncBytes;
}

const keyOf = (need: Record<string, number> | undefined) =>
	need ? Object.entries(need).sort().join('|') : '*';

/**
 * Runs syncs for the whole origin. The worker is one instance for every tab, so it is the single
 * sync leader: a required sync, a background sync and a second tab's request join the one already
 * running when it covers them, and otherwise wait for it, so two syncs are never in flight at once.
 * A full sync covers any `need`. A deferred sync waits for a network moment that is happening
 * anyway and runs only when its expected benefit is positive.
 */
export class Scheduler {
	readonly #deps: SchedulerDeps;
	readonly #inflight = new Map<string, Promise<boolean>>();
	readonly #policy: SyncPolicy;
	#pending: Record<string, number> = {};
	#pendingAge = 0;
	/** the rate the benefit uses; moves as syncs report what changed */
	readonly rate: ChangeRate;

	constructor(deps: SchedulerDeps) {
		this.#deps = deps;
		this.#policy = deps.policy ?? DEFAULT_POLICY;
		this.rate = new ChangeRate(this.#policy.changesPerDay);
	}

	/**
	 * Syncs now, or joins the sync already running. Resolves true when the replica is current to
	 * the server for what was asked and false when the request failed. With nothing stored there is
	 * nothing to validate, so a full sync makes no request. `ageSec` is how long the asked-about ids
	 * went unchecked, which is the exposure the change rate learns from.
	 */
	sync(need?: Record<string, number>, ageSec?: number): Promise<boolean> {
		const full = this.#inflight.get('*');
		if (full) return full;
		const key = keyOf(need);
		const same = this.#inflight.get(key);
		if (same) return same;
		const before = [...this.#inflight.values()];
		const started = Promise.allSettled(before)
			.then(() => this.#run(need, ageSec))
			.finally(() => {
				if (this.#inflight.get(key) === started) this.#inflight.delete(key);
			});
		this.#inflight.set(key, started);
		return started;
	}

	/** a sync nobody waits on: the soft contract's single refresh after a local view */
	background(need?: Record<string, number>, ageSec?: number): Promise<void> {
		return this.sync(need, ageSec).then(
			() => undefined,
			() => undefined
		);
	}

	/**
	 * Queues a sync of `need` for the next network moment when {@link syncBenefit} is positive after
	 * `ageSec` without a check. Returns whether it was queued; a refused request is asked again on the
	 * next view, when the age is longer.
	 */
	defer(need: Record<string, number>, ageSec: number): boolean {
		const tags = Object.keys(need).length;
		if (tags === 0) return false;
		const benefit = syncBenefit({
			ageSec,
			perSecond: this.rate.perSecond(),
			tags,
			policy: this.#policy
		});
		if (benefit <= 0) return false;
		for (const [id, version] of Object.entries(need)) {
			this.#pending[id] = Math.min(version, this.#pending[id] ?? Infinity);
		}
		this.#pendingAge = Math.max(this.#pendingAge, ageSec);
		return true;
	}

	/** ids queued by {@link Scheduler.defer} */
	get pending(): string[] {
		return Object.keys(this.#pending).sort();
	}

	/** runs the queued syncs as one request; true when nothing was queued */
	drain(): Promise<boolean> {
		const need = this.#pending;
		if (Object.keys(need).length === 0) return Promise.resolve(true);
		const age = this.#pendingAge;
		this.#pending = {};
		this.#pendingAge = 0;
		return this.sync(need, age);
	}

	async #run(need?: Record<string, number>, ageSec?: number): Promise<boolean> {
		const { replica, fetchSync, onNetwork } = this.#deps;
		const from = replica.cursor;
		if (from === null && !need) return true;
		try {
			const response = await fetchSync(from ?? 0, need);
			if (need && ageSec !== undefined && !response.reset) {
				const asked = Object.keys(need);
				const moved = asked.filter((tag) => Object.hasOwn(response.changed, tag)).length;
				this.rate.observe(asked.length, ageSec, moved);
			}
			await replica.applySync(response);
			return true;
		} catch {
			return false;
		} finally {
			onNetwork?.();
		}
	}
}
