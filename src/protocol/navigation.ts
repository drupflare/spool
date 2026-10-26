import { ProtocolError } from './errors.js';

/** how the model reads its history; every field is optional */
export type NavOptions = {
	/** 1 predicts from the last route pattern; 2 uses the last two and backs off to 1 */
	order?: 1 | 2;
	/** observations until a count has lost half its weight; `Infinity` turns decay off */
	halfLife?: number;
	/** pseudo-observations that pull each row toward its prior */
	alpha?: number;
	/** the two-pattern row weighs n / (n + backoff) against the one-pattern row, n being its observations */
	backoff?: number;
	/** counts per one-pattern context, as a population or a public corpus would give them */
	prior?: Record<string, Record<string, number>>;
	/** contexts kept in each table */
	maxContexts?: number;
	/** next routes kept per context */
	maxNext?: number;
};

/** a route with its probability and the effective observations behind its context */
export type NavPrediction = {
	/** the predicted next route pattern */
	route: string;
	/** probability that this route comes next, from 0 to 1 */
	p: number;
	/** effective observations behind the context */
	weight: number;
};

/** a route's count and the tick it was last touched; the weight decays from that tick */
type Count = { n: number; t: number };

type Row = { ctx: string[]; t: number; next: Map<string, Count> };

/** a row as JSON: its context, its last tick, then each next route with its count and tick */
export type RowEntry = [
	ctx: string[],
	t: number,
	next: Array<[route: string, n: number, t: number]>
];

/** the model as JSON; `one` holds one-pattern contexts, `two` two-pattern contexts */
export type NavSnapshot = {
	/** format version; always 1 */
	v: 1;
	/** observations the model had seen when it was saved */
	t: number;
	/** rows for one-route contexts */
	one: RowEntry[];
	/** rows for two-route contexts */
	two: RowEntry[];
};

const SNAPSHOT_KEYS = ['v', 't', 'one', 'two'];

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

const keyOf = (ctx: readonly string[]): string => JSON.stringify(ctx);

function range(ok: boolean, name: string): void {
	if (!ok) throw new RangeError(`nav option ${name} is out of range`);
}

function refuse(what: string): never {
	throw new ProtocolError('bad-nav', `nav snapshot ${what}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRoute(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

function isTick(v: unknown, max: number): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
}

function entryOf(row: Row): RowEntry {
	const next = [...row.next].map(([route, c]): [string, number, number] => [route, c.n, c.t]);
	return [[...row.ctx], row.t, next];
}

function dropOldest(table: Map<string, Row>): void {
	let oldest = '';
	let oldestT = Infinity;
	for (const [key, row] of table) {
		if (row.t < oldestT) {
			oldest = key;
			oldestT = row.t;
		}
	}
	table.delete(oldest);
}

function restore(table: Map<string, Row>, entries: unknown[], size: 1 | 2, tick: number): void {
	for (const item of entries) {
		if (!Array.isArray(item) || item.length !== 3) refuse('has a malformed row');
		const [ctx, t, next] = item;
		if (!Array.isArray(ctx) || ctx.length !== size || !ctx.every(isRoute)) {
			refuse('has a malformed context');
		}
		if (!isTick(t, tick) || t === 0) refuse('has a row touched outside the model');
		if (!Array.isArray(next)) refuse('has a malformed row');
		const key = keyOf(ctx);
		if (table.has(key)) refuse('repeats a context');
		const row: Row = { ctx, t, next: new Map() };
		for (const pair of next) {
			if (!Array.isArray(pair) || pair.length !== 3) refuse('has a malformed route');
			const [route, n, touch] = pair;
			if (!isRoute(route) || row.next.has(route)) refuse('has a malformed route');
			if (typeof n !== 'number') refuse('has a count that is not a number');
			if (n < 0) refuse('has a negative count');
			if (!isTick(touch, tick) || touch === 0)
				refuse('has a route touched outside the model');
			row.next.set(route, { n, t: touch });
		}
		table.set(key, row);
	}
}

/**
 * Predicts the next route pattern from the ones before it. Counts decay by half every `halfLife`
 * observations, and a route the model has never seen (in counts or prior) is never predicted.
 */
export class NavModel {
	readonly #order: 1 | 2;
	readonly #halfLife: number;
	readonly #alpha: number;
	readonly #backoff: number;
	readonly #prior: Record<string, Record<string, number>>;
	readonly #maxContexts: number;
	readonly #maxNext: number;
	readonly #one = new Map<string, Row>();
	readonly #two = new Map<string, Row>();
	#tick = 0;

	constructor(options: NavOptions = {}) {
		const order = options.order ?? 1;
		const halfLife = options.halfLife ?? 200;
		const alpha = options.alpha ?? 1;
		const backoff = options.backoff ?? 5;
		const prior = options.prior ?? {};
		const maxContexts = options.maxContexts ?? 64;
		const maxNext = options.maxNext ?? 16;
		range(order === 1 || order === 2, 'order');
		range(halfLife > 0, 'halfLife');
		range(alpha >= 0 && Number.isFinite(alpha), 'alpha');
		range(backoff >= 0 && Number.isFinite(backoff), 'backoff');
		range(Number.isSafeInteger(maxContexts) && maxContexts >= 1, 'maxContexts');
		range(Number.isSafeInteger(maxNext) && maxNext >= 1, 'maxNext');
		for (const row of Object.values(prior)) {
			for (const n of Object.values(row)) range(n >= 0 && Number.isFinite(n), 'prior');
		}
		this.#order = order;
		this.#halfLife = halfLife;
		this.#alpha = alpha;
		this.#backoff = backoff;
		this.#prior = prior;
		this.#maxContexts = maxContexts;
		this.#maxNext = maxNext;
	}

	/** records that `route` came after `context`, newest route last; an empty context is a no-op */
	observe(context: readonly string[], route: string): void {
		if (context.length === 0) return;
		this.#tick += 1;
		this.#touch(this.#one, context.slice(-1), route);
		if (this.#order === 2 && context.length >= 2) {
			this.#touch(this.#two, context.slice(-2), route);
		}
	}

	/** the likely next routes, most probable first; routes with no probability are left out */
	predict(context: readonly string[]): NavPrediction[] {
		if (context.length === 0) return [];
		const last = context[context.length - 1] ?? '';
		const one = this.#one.get(keyOf(context.slice(-1)));
		const two =
			this.#order === 2 && context.length >= 2
				? this.#two.get(keyOf(context.slice(-2)))
				: undefined;
		const prior = Object.hasOwn(this.#prior, last) ? this.#prior[last] : undefined;
		const p1 = this.#distribution(one, prior);
		// the prior's counts are evidence about the mean, so they count toward the weight
		const priorMass = prior ? Object.values(prior).reduce((sum, n) => sum + n, 0) : 0;
		const w1 = (one ? this.#rowWeight(one) : 0) + priorMass;
		const p2 = this.#distribution(two);
		const w2 = two ? this.#rowWeight(two) : 0;
		const lambda = w2 === 0 ? 0 : w2 / (w2 + this.#backoff);
		const weight = lambda * w2 + (1 - lambda) * w1;
		const out: NavPrediction[] = [];
		for (const route of new Set([...p1.keys(), ...p2.keys()])) {
			const p = lambda * (p2.get(route) ?? 0) + (1 - lambda) * (p1.get(route) ?? 0);
			if (p > 0) out.push({ route, p, weight });
		}
		return out.sort(
			(a, b) => b.p - a.p || (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)
		);
	}

	/** the model as a snapshot that fromJSON restores */
	toJSON(): NavSnapshot {
		return {
			v: 1,
			t: this.#tick,
			one: [...this.#one.values()].map(entryOf),
			two: [...this.#two.values()].map(entryOf)
		};
	}

	/** restores a model from toJSON output; throws bad-nav on a malformed snapshot */
	static fromJSON(snapshot: unknown, options?: NavOptions): NavModel {
		if (!isRecord(snapshot)) refuse('is not an object');
		if (snapshot.v !== 1) refuse('has an unknown version');
		if (Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.includes(key))) {
			refuse('has an unknown field');
		}
		const { t, one, two } = snapshot;
		if (!isTick(t, Number.MAX_SAFE_INTEGER)) refuse('has a bad tick');
		if (!Array.isArray(one) || !Array.isArray(two)) refuse('has a table that is not a list');
		const model = new NavModel(options);
		if (model.#order === 1 && two.length > 0) refuse('has two-pattern contexts for order 1');
		model.#tick = t;
		restore(model.#one, one, 1, t);
		restore(model.#two, two, 2, t);
		return model;
	}

	#touch(table: Map<string, Row>, ctx: string[], route: string): void {
		const key = keyOf(ctx);
		let row = table.get(key);
		if (!row) {
			if (table.size >= this.#maxContexts) dropOldest(table);
			row = { ctx, t: this.#tick, next: new Map() };
			table.set(key, row);
		}
		row.t = this.#tick;
		const prev = row.next.get(route);
		row.next.set(route, { n: round3((prev ? this.#weigh(prev) : 0) + 1), t: this.#tick });
		if (row.next.size > this.#maxNext) this.#dropWeakest(row.next);
	}

	#dropWeakest(next: Map<string, Count>): void {
		let weakest = '';
		let weakestW = Infinity;
		for (const [route, count] of next) {
			const w = this.#weigh(count);
			if (w < weakestW || (w === weakestW && route < weakest)) {
				weakest = route;
				weakestW = w;
			}
		}
		next.delete(weakest);
	}

	#weigh(count: Count): number {
		return count.n * 0.5 ** ((this.#tick - count.t) / this.#halfLife);
	}

	#rowWeight(row: Row): number {
		let total = 0;
		for (const count of row.next.values()) total += this.#weigh(count);
		return total;
	}

	#distribution(row?: Row, prior?: Record<string, number>): Map<string, number> {
		const out = new Map<string, number>();
		const denom = (row ? this.#rowWeight(row) : 0) + this.#alpha;
		if (denom <= 0) return out;
		const priorTotal = prior ? Object.values(prior).reduce((sum, n) => sum + n, 0) : 0;
		const routes = new Set([...(row?.next.keys() ?? []), ...Object.keys(prior ?? {})]);
		for (const route of routes) {
			const count = row?.next.get(route);
			const shared = prior && Object.hasOwn(prior, route) ? (prior[route] ?? 0) : 0;
			const share = priorTotal > 0 ? shared / priorTotal : 0;
			out.set(route, ((count ? this.#weigh(count) : 0) + this.#alpha * share) / denom);
		}
		return out;
	}
}

/** a Wilson score lower bound for a proportion `p` over `weight` effective observations */
export function lowerBound(p: number, weight: number, z = 1.28): number {
	if (!(p >= 0 && p <= 1) || !(weight > 0) || !Number.isFinite(weight)) return 0;
	const z2 = z * z;
	const centre = p + z2 / (2 * weight);
	const margin = z * Math.sqrt((p * (1 - p)) / weight + z2 / (4 * weight * weight));
	const bound = (centre - margin) / (1 + z2 / weight);
	return Math.min(p, Math.max(0, bound));
}

/** joules: `avoided` is what a hit keeps off the wire, the rest is what it costs */
export type NetInput = {
	/** probability the candidate is used, from 0 to 1 */
	p: number;
	/** effective observations behind p */
	weight: number;
	/** joules a hit keeps off the wire */
	avoided: number;
	/** joules to provision the candidate, paid whether or not it is used */
	provision: number;
	/** joules to render the candidate, paid whether or not it is used; default 0 */
	render?: number;
	/** joules to keep the candidate current, paid whether or not it is used; default 0 */
	maintain?: number;
	/** joules of model work the decision costs, paid whether or not it is used; default 0 */
	model?: number;
};

/** expected joules of acting on a candidate, with its probability taken at the lower bound */
export function expectedNet(input: NetInput, z?: number): number {
	return (
		lowerBound(input.p, input.weight, z) * input.avoided -
		input.provision -
		(input.render ?? 0) -
		(input.maintain ?? 0) -
		(input.model ?? 0)
	);
}

export function shouldAct(input: NetInput, z?: number): boolean {
	return expectedNet(input, z) > 0;
}
