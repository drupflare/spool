import type { Measurement, Row } from './measurement.js';
import { attributionalJoules } from './model.js';
import { classifyOrigin, type OriginClass } from './thirdparty.js';

/** a median with the range it came from and how many readings that is */
export type Spread = { median: number; min: number; max: number; n: number };

/** a window is dropped when the other containers on the host used more CPU than this, per second */
export const CONTAMINATION_MS_PER_S = 100;

/** the median of a non-empty list */
export function median(values: readonly number[]): number {
	if (values.length === 0) throw new RangeError('no values');
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** {@link median}, minimum, maximum and count of a non-empty list */
export function spread(values: readonly number[]): Spread {
	return {
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
		n: values.length
	};
}

/** the `p` quantile (0 to 1) by linear interpolation between the nearest ranks */
export function quantile(values: readonly number[], p: number): number {
	if (values.length === 0) throw new RangeError('no values');
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * p;
	const low = Math.floor(at);
	const high = Math.ceil(at);
	return (
		(sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (at - low)
	);
}

/** a least-squares line `y = intercept + slope * x` and its coefficient of determination */
export type Fit = { intercept: number; slope: number; r2: number };

/** ordinary least squares over at least two points with distinct x */
export function linearFit(points: ReadonlyArray<readonly [number, number]>): Fit {
	const n = points.length;
	const mx = points.reduce((s, [x]) => s + x, 0) / n;
	const my = points.reduce((s, [, y]) => s + y, 0) / n;
	const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
	if (n < 2 || sxx === 0) throw new RangeError('a fit needs two distinct x values');
	const slope = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx;
	const intercept = my - slope * mx;
	const residual = points.reduce((s, [x, y]) => s + (y - (intercept + slope * x)) ** 2, 0);
	const total = points.reduce((s, [, y]) => s + (y - my) ** 2, 0);
	return { intercept, slope, r2: total === 0 ? 1 : 1 - residual / total };
}

const num = (row: Row, key: string): number | undefined =>
	typeof row[key] === 'number' ? (row[key] as number) : undefined;

const str = (row: Row, key: string): string => String(row[key] ?? '');

/** whether other containers used more than `limit` ms of CPU per second over the window of `row` */
export function isContaminated(row: Row, limit = CONTAMINATION_MS_PER_S): boolean {
	const other = num(row, 'otherCpuMs') ?? num(row, 'otherContainersCpuMs') ?? 0;
	return !(other / ((num(row, 'elapsedMs') as number) / 1000) <= limit);
}

const sumValues = (value: unknown): number | undefined =>
	typeof value === 'object' && value !== null
		? Object.values(value as Record<string, number>).reduce((s, v) => s + v, 0)
		: undefined;

/** what one operation (a navigation or a request) costs on one arm of a RAPL run */
export type OpFigures = {
	windows: number;
	/** package joules per operation above that round's idle draw */
	joules: Spread;
	/** median milliseconds per operation */
	ms: number;
	/** median requests that reached the origin per operation, when the rig counted them */
	originRequests?: number;
	/** median origin CPU milliseconds per operation */
	originCpuMs?: number;
	/** median server and client CPU milliseconds per operation (closed-loop request rigs) */
	serverCpuMs?: number;
	clientCpuMs?: number;
	/** the above-idle joules split by the server's share of server and client CPU */
	serverJoules?: Spread;
};

/** the idle draw and every arm of a RAPL run with the idle subtracted */
export type RaplRun = { idleWatts: Spread; dropped: number; arms: Record<string, OpFigures> };

/**
 * Joules per operation above idle for every arm of a RAPL run: each window's energy less the idle
 * draw of its own round times its length, over its operations. A round without an idle window
 * uses the median idle draw. Windows over the contamination limit are dropped, idle ones included.
 */
export function raplRun(
	rows: readonly Row[],
	options: { idleArm?: string; contamination?: number } = {}
): RaplRun {
	const idleArm = options.idleArm ?? 'idle';
	const limit = options.contamination ?? CONTAMINATION_MS_PER_S;
	const seconds = (row: Row) => (num(row, 'elapsedMs') as number) / 1000;
	const kept = rows.filter((row) => !isContaminated(row, limit));
	const idle = new Map<number, number>();
	for (const row of kept) {
		if (str(row, 'arm') === idleArm) {
			idle.set(num(row, 'round') as number, (num(row, 'pkgJ') as number) / seconds(row));
		}
	}
	const idleWatts = spread([...idle.values()]);
	const arms: Record<string, Row[]> = {};
	for (const row of kept) {
		if (str(row, 'arm') !== idleArm) (arms[str(row, 'arm')] ??= []).push(row);
	}
	const figures: Record<string, OpFigures> = {};
	for (const [arm, windows] of Object.entries(arms)) {
		const per = windows.map((row) => {
			const ops = (num(row, 'navs') ?? num(row, 'n')) as number;
			const watts = idle.get(num(row, 'round') as number) ?? idleWatts.median;
			const above = (num(row, 'pkgJ') as number) - watts * seconds(row);
			const origin = num(row, 'originReqs') ?? sumValues(row.originHits);
			const server = num(row, 'serverCpuMs');
			const client = num(row, 'clientCpuMs');
			return {
				joules: above / ops,
				ms: (seconds(row) * 1000) / ops,
				origin: origin === undefined ? undefined : origin / ops,
				originCpu:
					num(row, 'originCpuMs') === undefined
						? undefined
						: (num(row, 'originCpuMs') as number) / ops,
				server: server === undefined ? undefined : server / ops,
				client: client === undefined ? undefined : client / ops,
				serverJ:
					server === undefined || client === undefined
						? undefined
						: (above * server) / (server + client) / ops
			};
		});
		const defined = (pick: (p: (typeof per)[number]) => number | undefined) =>
			per.map(pick).filter((v): v is number => v !== undefined);
		const origin = defined((p) => p.origin);
		const originCpu = defined((p) => p.originCpu);
		const server = defined((p) => p.server);
		const client = defined((p) => p.client);
		const serverJ = defined((p) => p.serverJ);
		figures[arm] = {
			windows: per.length,
			joules: spread(per.map((p) => p.joules)),
			ms: median(per.map((p) => p.ms)),
			...(origin.length > 0 && { originRequests: median(origin) }),
			...(originCpu.length > 0 && { originCpuMs: median(originCpu) }),
			...(server.length > 0 && { serverCpuMs: median(server) }),
			...(client.length > 0 && { clientCpuMs: median(client) }),
			...(serverJ.length > 0 && { serverJoules: spread(serverJ) })
		};
	}
	return { idleWatts, dropped: rows.length - kept.length, arms: figures };
}

/** joules per operation `a` costs over `b`, from the medians of the two arms */
export function saving(a: { joules: Spread }, b: { joules: Spread }): number {
	return a.joules.median - b.joules.median;
}

/** one arm of an idle-activity-tabs reading, per minute and net of its floor */
export type TabsArm = {
	/** kept windows that had a floor to net against */
	windows: number;
	/** the round's idle draw, or for the three-tab polling arms the quiet window of the same round */
	floor: 'idle' | 'tabs-3-quiet';
	/** package joules per minute above the floor */
	joulesPerMinute: Spread;
	/** origin requests per minute in the window */
	pingsPerMinute: Spread;
};

/** the figures of an idle-activity-tabs reading; `ratio` holds arm medians, when both arms exist */
export type TabsFigures = {
	idleWatts: Spread | null;
	dropped: number;
	/** windows of a three-tab polling arm with no kept tabs-3-quiet window in their round */
	unmatched: number;
	arms: Record<string, TabsArm>;
	ratio: { poll3ToLeader?: number; poll3ToPoll1?: number };
};

const THREE_TAB_ARMS: readonly string[] = ['tabs-3-poll', 'tabs-3-leader'];

/**
 * Joules per minute above the idle draw of each kept window of an idle-activity-tabs run, per arm.
 * A window is dropped over the contamination limit. The idle draw is the median of the kept idle
 * windows of its round. The two three-tab polling arms are netted against the tabs-3-quiet window
 * of the same round, and a window whose round has none is left out. The one-tab and hidden arms
 * are not netted against a quiet arm: the rig has no quiet arm for them.
 */
export function tabsFigures(rows: readonly Row[]): TabsFigures {
	const seconds = (row: Row) => (num(row, 'elapsedMs') as number) / 1000;
	const kept = rows.filter((row) => !isContaminated(row));
	const dropped = rows.length - kept.length;
	const watts = (row: Row) => (num(row, 'pkgJ') as number) / seconds(row);
	const idleByRound = new Map<number, number[]>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'idle') continue;
		const round = num(row, 'round') as number;
		idleByRound.set(round, [...(idleByRound.get(round) ?? []), watts(row)]);
	}
	const idleRound = new Map([...idleByRound].map(([round, w]) => [round, median(w)]));
	if (idleRound.size === 0) {
		return { idleWatts: null, dropped, unmatched: 0, arms: {}, ratio: {} };
	}
	const idleWatts = spread([...idleRound.values()]);
	const perMinute = (row: Row) =>
		(watts(row) - (idleRound.get(num(row, 'round') as number) ?? idleWatts.median)) * 60;
	const pingsPerMinute = (row: Row) => ((num(row, 'originPings') as number) / seconds(row)) * 60;
	const floor = new Map<number, number>();
	const byArm: Record<string, Row[]> = {};
	for (const row of kept) {
		const arm = str(row, 'arm');
		if (arm === 'tabs-3-quiet') floor.set(num(row, 'round') as number, perMinute(row));
		if (arm !== 'idle') (byArm[arm] ??= []).push(row);
	}
	let unmatched = 0;
	const arms: Record<string, TabsArm> = {};
	for (const [arm, windows] of Object.entries(byArm)) {
		const threeTab = THREE_TAB_ARMS.includes(arm);
		const net = windows.flatMap((row) => {
			const base = threeTab ? floor.get(num(row, 'round') as number) : 0;
			if (base === undefined) {
				unmatched++;
				return [];
			}
			return [{ joules: perMinute(row) - base, pings: pingsPerMinute(row) }];
		});
		if (net.length === 0) continue;
		arms[arm] = {
			windows: net.length,
			floor: threeTab ? 'tabs-3-quiet' : 'idle',
			joulesPerMinute: spread(net.map((n) => n.joules)),
			pingsPerMinute: spread(net.map((n) => n.pings))
		};
	}
	const poll3 = arms['tabs-3-poll']?.joulesPerMinute.median;
	const leader = arms['tabs-3-leader']?.joulesPerMinute.median;
	const poll1 = arms['tabs-1-poll']?.joulesPerMinute.median;
	return {
		idleWatts,
		dropped,
		unmatched,
		arms,
		ratio: {
			...(poll3 !== undefined && leader !== undefined && { poll3ToLeader: poll3 / leader }),
			...(poll3 !== undefined && poll1 !== undefined && { poll3ToPoll1: poll3 / poll1 })
		}
	};
}

/** the per-request cost of a locally served model, above the model-resident idle draw */
export type InferenceFigures = {
	rounds: number;
	cpuJoules: Spread;
	gpuJoules: Spread;
	totalJoules: Spread;
	/** seconds per request, over every request of every kept round */
	latencyS: Spread;
	outputTokens: number;
	/** CPU milliseconds the ollama container used per request */
	ollamaCpuMs: number;
	/** the origin's own CPU milliseconds per request */
	originCpuMs: number;
	/** watts a resident model adds to an idle machine */
	keepWarmCpuWatts: Spread;
	keepWarmGpuWatts: Spread;
	/** package joules per request of a cached copy of the same response, above the loaded idle draw */
	cacheHitJoules: Spread;
};

/**
 * {@link InferenceFigures} from the rows of an inference run. A round needs its unloaded and
 * loaded idle windows and its recompute window; rounds over the contamination limit are dropped.
 */
export function inferenceFigures(measurement: Measurement): InferenceFigures {
	const cacheOps = Number(measurement.method['requests per cache window']);
	const byRound = new Map<number, Record<string, Row>>();
	for (const row of measurement.rows) {
		const round = num(row, 'round') as number;
		const arms = byRound.get(round) ?? {};
		arms[str(row, 'arm')] = row;
		byRound.set(round, arms);
	}
	const s = (row: Row) => (num(row, 'elapsedMs') as number) / 1000;
	const cpuOf = (row: Row) => (num(row, 'otherCpuMs') ?? 0) / s(row);
	const cpu: number[] = [];
	const gpu: number[] = [];
	const latency: number[] = [];
	const tokens: number[] = [];
	const ollama: number[] = [];
	const origin: number[] = [];
	const warmCpu: number[] = [];
	const warmGpu: number[] = [];
	const cache: number[] = [];
	for (const arms of byRound.values()) {
		const unloaded = arms['idle-unloaded'];
		const loaded = arms['idle-loaded'];
		const run = arms['ai-recompute'];
		if (!unloaded || !loaded || !run) continue;
		if ([unloaded, loaded, run].some((row) => cpuOf(row) > CONTAMINATION_MS_PER_S)) continue;
		const calls = num(run, 'aiCalls') as number;
		const loadedWatts = (num(loaded, 'pkgJ') as number) / s(loaded);
		const loadedGpuWatts = (num(loaded, 'gpuJ') as number) / s(loaded);
		cpu.push(((num(run, 'pkgJ') as number) - loadedWatts * s(run)) / calls);
		gpu.push(((num(run, 'gpuJ') as number) - loadedGpuWatts * s(run)) / calls);
		latency.push(...(run.latMs as number[]).map((ms) => ms / 1000));
		tokens.push((num(run, 'aiOutTokens') as number) / calls);
		ollama.push((num(run, 'ollamaCpuMs') as number) / calls);
		origin.push((num(run, 'serverCpuMs') as number) / calls);
		warmCpu.push(loadedWatts - (num(unloaded, 'pkgJ') as number) / s(unloaded));
		warmGpu.push(loadedGpuWatts - (num(unloaded, 'gpuJ') as number) / s(unloaded));
		const hit = arms['ai-cache'];
		if (hit && Number.isFinite(cacheOps)) {
			cache.push(((num(hit, 'pkgJ') as number) - loadedWatts * s(hit)) / cacheOps);
		}
	}
	return {
		rounds: cpu.length,
		cpuJoules: spread(cpu),
		gpuJoules: spread(gpu),
		totalJoules: spread(cpu.map((v, i) => v + (gpu[i] as number))),
		latencyS: spread(latency),
		outputTokens: median(tokens),
		ollamaCpuMs: median(ollama),
		originCpuMs: median(origin),
		keepWarmCpuWatts: spread(warmCpu),
		keepWarmGpuWatts: spread(warmGpu),
		cacheHitJoules: cache.length > 0 ? spread(cache) : { median: NaN, min: NaN, max: NaN, n: 0 }
	};
}

/** one request-rate condition of the power-state sweep */
export type PowerCondition = {
	cond: string;
	route: string;
	mode: string;
	/** median requests per second the windows actually saw */
	rate: number;
	/** watts above the idle median */
	aboveWatts: Spread;
	/** millijoules per request above the idle median */
	mjPerRequest: Spread;
};

/** the sweep of one `set` of a power-state file: idle, every condition and the fitted lines */
export type PowerSweep = {
	idleWatts: Spread;
	conditions: PowerCondition[];
	/** keyed `<route>-<mode>`, plus `cms-steady-low` for rates up to 200 per second */
	fits: Record<string, Fit>;
};

/** {@link PowerSweep} for the rows with the given `set`, `sweep` or `timer` */
export function powerSweep(rows: readonly Row[], set: 'sweep' | 'timer'): PowerSweep {
	const mine = rows.filter((row) => row.set === set);
	const idle = spread(
		mine.filter((r) => str(r, 'cond') === 'idle').map((r) => num(r, 'pkgW') as number)
	);
	const groups = new Map<string, Row[]>();
	for (const row of mine) {
		if (str(row, 'cond').startsWith('idle')) continue;
		const list = groups.get(str(row, 'cond')) ?? [];
		list.push(row);
		groups.set(str(row, 'cond'), list);
	}
	const conditions = [...groups].map(([cond, list]) => {
		const first = list[0] as Row;
		const mj = list
			.filter((r) => (num(r, 'reqs') as number) > 0)
			.map(
				(r) =>
					(1000 * ((num(r, 'pkgW') as number) - idle.median)) /
					((num(r, 'reqs') as number) / (num(r, 'elapsedS') as number))
			);
		return {
			cond,
			route: str(first, 'route'),
			mode: str(first, 'mode'),
			rate: median(
				list.map((r) => (num(r, 'reqs') as number) / (num(r, 'elapsedS') as number))
			),
			aboveWatts: spread(list.map((r) => (num(r, 'pkgW') as number) - idle.median)),
			mjPerRequest: spread(mj)
		};
	});
	const fits: Record<string, Fit> = {};
	for (const route of ['cms', 'null', 'ana']) {
		for (const mode of ['steady', 'bursty']) {
			const points = mine
				.filter((r) => str(r, 'route') === route && str(r, 'mode') === mode)
				.map(
					(r) =>
						[
							num(r, 'rate') as number,
							(num(r, 'pkgW') as number) - idle.median
						] as const
				);
			if (new Set(points.map(([x]) => x)).size < 2) continue;
			fits[`${route}-${mode}`] = linearFit(points);
			if (route === 'cms') {
				const low = points.filter(([x]) => x <= 200);
				if (new Set(low.map(([x]) => x)).size >= 2)
					fits[`${route}-${mode}-low`] = linearFit(low);
			}
		}
	}
	return { idleWatts: idle, conditions, fits };
}

/** a phone run's per-view cost of each arm, above the idle window of the same round */
export type PhoneRun = {
	/** windows dropped because a tick read charging, and their rounds' idle windows if they were idle */
	dropped: number;
	arms: Record<
		string,
		{ windows: number; joules: Spread; viewsPerWindow: number; secondsPerView: number }
	>;
	/** the idle windows' energy per window and the length they ran, to show the noise floor */
	idle: { joules: Spread; seconds: number };
};

/** {@link PhoneRun} from iPhone rows: `energy_j` over the window, charging windows excluded */
export function phoneRun(rows: readonly Row[]): PhoneRun {
	const clean = rows.filter((r) => !(r.charging as boolean[]).some(Boolean));
	const idle = new Map<number, Row>();
	for (const row of clean)
		if (str(row, 'arm') === 'idle') idle.set(num(row, 'round') as number, row);
	const watts = (r: Row) => (num(r, 'energy_j') as number) / (num(r, 'seconds') as number);
	const arms: PhoneRun['arms'] = {};
	const names = [...new Set(clean.map((r) => str(r, 'arm')))].filter((a) => a !== 'idle');
	for (const arm of names) {
		const per = clean
			.filter((r) => str(r, 'arm') === arm && idle.has(num(r, 'round') as number))
			.map((r) => {
				const base = idle.get(num(r, 'round') as number) as Row;
				const seconds = num(r, 'seconds') as number;
				const navs = num(r, 'navs') as number;
				return {
					joules: ((num(r, 'energy_j') as number) - watts(base) * seconds) / navs,
					navs,
					seconds: seconds / navs
				};
			});
		if (per.length === 0) continue;
		arms[arm] = {
			windows: per.length,
			joules: spread(per.map((p) => p.joules)),
			viewsPerWindow: median(per.map((p) => p.navs)),
			secondsPerView: median(per.map((p) => p.seconds))
		};
	}
	const idleRows = [...idle.values()];
	return {
		dropped: rows.length - clean.length,
		arms,
		idle: {
			joules: spread(idleRows.map((r) => num(r, 'energy_j') as number)),
			seconds: median(idleRows.map((r) => num(r, 'seconds') as number))
		}
	};
}

/** one arm of one server runtime, per view and above the idle window of the same round */
export type RuntimeArm = {
	windows: number;
	joules: Spread;
	/** bytes on the overlay interface (`tailscale0`) */
	overlayBytes: Spread;
	/** bytes on the physical interface, overlay framing included */
	wireBytes: Spread;
	/** requests that reached the origin, the app's own and `/.spool/*` together */
	originRequests: Spread;
};

/**
 * A runtimes reading by runtime and arm. Rows with a `discarded` reason are dropped, and so is
 * a round whose idle window was.
 */
export function runtimeRun(rows: readonly Row[]): Record<string, Record<string, RuntimeArm>> {
	const clean = rows.filter((r) => r.discarded === null || r.discarded === undefined);
	const key = (r: Row) => `${str(r, 'runtime')}/${num(r, 'round')}`;
	const idle = new Map(clean.filter((r) => str(r, 'arm') === 'idle').map((r) => [key(r), r]));
	const rate = (r: Row, field: string) =>
		(num(r, field) as number) / (num(r, 'windowS') as number);
	const requests = (r: Row) =>
		['originNet', 'originSpool'].reduce(
			(s, f) => s + ((r[f] as { requests?: number } | undefined)?.requests ?? 0),
			0
		);
	const out: Record<string, Record<string, RuntimeArm>> = {};
	const groups = new Map<string, Row[]>();
	for (const row of clean) {
		if (str(row, 'arm') === 'idle' || !idle.has(key(row))) continue;
		const group = `${str(row, 'runtime')}/${str(row, 'arm')}`;
		groups.set(group, [...(groups.get(group) ?? []), row]);
	}
	for (const [group, list] of groups) {
		const [runtime = '', arm = ''] = group.split('/');
		const above = (r: Row, fields: string[]) => {
			const base = idle.get(key(r)) as Row;
			const seconds = num(r, 'windowS') as number;
			const sum = (x: Row) => fields.reduce((s, f) => s + rate(x, f), 0);
			return ((sum(r) - sum(base)) * seconds) / (num(r, 'views') as number);
		};
		(out[runtime] ??= {})[arm] = {
			windows: list.length,
			joules: spread(list.map((r) => above(r, ['pkgJ']))),
			overlayBytes: spread(list.map((r) => above(r, ['tailscaleRxB', 'tailscaleTxB']))),
			wireBytes: spread(list.map((r) => above(r, ['wlanRxB', 'wlanTxB']))),
			originRequests: spread(list.map((r) => requests(r) / (num(r, 'views') as number)))
		};
	}
	return out;
}

/** one kind of navigation across the sites of a repeat-navigation run */
export type NavFigures = {
	navs: number;
	sites: number;
	medianBytes: number;
	meanBytes: number;
	p75Bytes: number;
	medianRequests: number;
	medianDocBytes: number;
	medianThirdPartyBytes: number;
};

/** a navigation that loaded the site's page; a 4xx or 5xx document is a block page, not the site */
export function loaded(nav: Row): boolean {
	return nav.ok === true && (num(nav, 'docStatus') ?? 200) < 400;
}

/** bytes and request counts by navigation kind, over the navigations that loaded */
export function repeatNavFigures(rows: readonly Row[]): Record<string, NavFigures> {
	const kinds = new Map<string, Array<{ site: string; nav: Row }>>();
	for (const row of rows) {
		for (const nav of (row.navs as Row[] | undefined) ?? []) {
			if (!loaded(nav)) continue;
			const list = kinds.get(str(nav, 'kind')) ?? [];
			list.push({ site: str(row, 'site'), nav });
			kinds.set(str(nav, 'kind'), list);
		}
	}
	const out: Record<string, NavFigures> = {};
	for (const [kind, list] of kinds) {
		const bytes = list.map(({ nav }) => num(nav, 'bytes') as number);
		out[kind] = {
			navs: list.length,
			sites: new Set(list.map((l) => l.site)).size,
			medianBytes: median(bytes),
			meanBytes: bytes.reduce((s, b) => s + b, 0) / bytes.length,
			p75Bytes: quantile(bytes, 0.75),
			medianRequests: median(list.map(({ nav }) => num(nav, 'networkRequests') as number)),
			medianDocBytes: median(list.map(({ nav }) => num(nav, 'docBytes') ?? 0)),
			medianThirdPartyBytes: median(list.map(({ nav }) => num(nav, 'thirdPartyBytes') ?? 0))
		};
	}
	return out;
}

/**
 * Each site's repeat view of its home page: every byte it moved, and the bytes of its document
 * request, the only request a default local view replaces (0 when the browser's cache answered it).
 */
export function repeatBytesBySite(
	rows: readonly Row[]
): Map<string, { bytes: number; document: number }> {
	const out = new Map<string, { bytes: number; document: number }>();
	for (const row of rows) {
		for (const nav of (row.navs as Row[] | undefined) ?? []) {
			if (loaded(nav) && str(nav, 'kind') === 'warm-home-repeat') {
				out.set(str(row, 'site'), {
					bytes: num(nav, 'bytes') as number,
					document: num(nav, 'docBytes') ?? 0
				});
			}
		}
	}
	return out;
}

/** resource types a site's own static files arrive as; every other same-origin type is dynamic */
const STATIC_TYPES: ReadonlySet<string> = new Set([
	'Script',
	'Stylesheet',
	'Font',
	'Image',
	'Media'
]);

/** the network bytes of one home-page repeat view, split by what they were */
export type ByteSplit = {
	/** the page's own document request */
	document: number;
	/** same-origin Script, Stylesheet, Font, Image and Media */
	sameOriginStatic: number;
	/** every other same-origin request: XHR, Fetch, Ping, EventSource, Other, further documents */
	sameOriginDynamic: number;
	/** bytes from other origins, by the class `classifyOrigin` gives their host */
	thirdParty: Partial<Record<OriginClass, number>>;
	thirdPartyTotal: number;
	/** the same third-party bytes by host */
	thirdPartyHosts: Record<string, number>;
	total: number;
};

/**
 * Splits a repeat view's network bytes from its per-request records: requests the browser cache
 * answered carry no bytes and are skipped. The document is the first Document request, the one
 * `docBytes` counts. Same-origin is the recorded field, an exact origin match.
 */
export function splitRequestBytes(requests: ReadonlyArray<Row>): ByteSplit {
	const split: ByteSplit = {
		document: 0,
		sameOriginStatic: 0,
		sameOriginDynamic: 0,
		thirdParty: {},
		thirdPartyTotal: 0,
		thirdPartyHosts: {},
		total: 0
	};
	let seenDocument = false;
	for (const request of requests) {
		const isDocument = str(request, 'type') === 'Document' && !seenDocument;
		if (isDocument) seenDocument = true;
		if (request.fromCache === true) continue;
		const bytes = num(request, 'bytes') ?? 0;
		split.total += bytes;
		if (isDocument) split.document += bytes;
		else if (request.sameOrigin === true) {
			if (STATIC_TYPES.has(str(request, 'type'))) split.sameOriginStatic += bytes;
			else split.sameOriginDynamic += bytes;
		} else {
			const { class: kind } = classifyOrigin(str(request, 'url'));
			split.thirdParty[kind] = (split.thirdParty[kind] ?? 0) + bytes;
			split.thirdPartyTotal += bytes;
			const host = str(request, 'host');
			split.thirdPartyHosts[host] = (split.thirdPartyHosts[host] ?? 0) + bytes;
		}
	}
	return split;
}

/** {@link splitRequestBytes} for each site's loaded home-page repeat view that carries request records */
export function repeatSplitBySite(rows: readonly Row[]): Map<string, ByteSplit> {
	const out = new Map<string, ByteSplit>();
	for (const row of rows) {
		for (const nav of (row.navs as Row[] | undefined) ?? []) {
			if (
				loaded(nav) &&
				str(nav, 'kind') === 'warm-home-repeat' &&
				Array.isArray(nav.requestList)
			) {
				out.set(str(row, 'site'), splitRequestBytes(nav.requestList as Row[]));
			}
		}
	}
	return out;
}

/** one registration setting in one engine of a zero-network run */
export type ZeroNetworkFigures = {
	arm: string;
	engine: string;
	views: number;
	/** views that reached the origin at all */
	viewsWithHits: number;
	/** requests that reached the origin, by path */
	hits: Record<string, number>;
};

/** server hits per service-worker navigation, by registration setting and engine */
export function zeroNetworkFigures(rows: readonly Row[]): ZeroNetworkFigures[] {
	return rows.map((row) => {
		const views = (row.rows as Row[]) ?? [];
		const hits: Record<string, number> = {};
		let viewsWithHits = 0;
		for (const view of views) {
			const paths = (view.serverHits as string[]) ?? [];
			if (paths.length > 0) viewsWithHits += 1;
			for (const path of paths) hits[path] = (hits[path] ?? 0) + 1;
		}
		return {
			arm: str(row, 'arm'),
			engine: str(row, 'engine'),
			views: views.length,
			viewsWithHits,
			hits
		};
	});
}

/** CPU milliseconds and wall milliseconds per navigation, by arm, from a device-cpu run */
export function deviceCpuFigures(
	measurement: Measurement
): Record<string, { runs: number; cpuMs: Spread; wallMs: number; serverHits: number }> {
	const navs = Number(measurement.method['navigations per run']);
	const arms: Record<string, Row[]> = {};
	for (const row of measurement.rows) (arms[str(row, 'arm')] ??= []).push(row);
	return Object.fromEntries(
		Object.entries(arms).map(([arm, runs]) => [
			arm,
			{
				runs: runs.length,
				cpuMs: spread(runs.map((r) => ((num(r, 'cpuS') as number) * 1000) / navs)),
				wallMs: median(runs.map((r) => num(r, 'wallMsPerNav') as number)),
				serverHits: median(runs.map((r) => num(r, 'serverHitsPerNav') as number))
			}
		])
	);
}

/** the browser's count and the proxy's count of one kind of navigation, side by side */
export type WireFigures = {
	navs: number;
	browserRequests: number;
	wireRequests: number;
	browserBytes: number;
	wireResponseBytes: number;
	/** navigations on which the two request counts were equal */
	equal: number;
	/** share of the proxy's requests that went to a host other than the page's own */
	thirdPartyShare: number;
	/** median proxy requests to other hosts per navigation */
	thirdPartyRequests: number;
};

/** medians by navigation kind from an on-wire run: rows carry a `wire` summary beside the browser's counts */
export function onWireFigures(rows: readonly Row[]): Record<string, WireFigures> {
	const kinds = new Map<string, Row[]>();
	for (const row of rows) {
		for (const nav of (row.navs as Row[] | undefined) ?? []) {
			if (nav.ok !== true || typeof nav.wire !== 'object' || nav.wire === null) continue;
			const list = kinds.get(str(nav, 'kind')) ?? [];
			list.push(nav);
			kinds.set(str(nav, 'kind'), list);
		}
	}
	const out: Record<string, WireFigures> = {};
	for (const [kind, navs] of kinds) {
		const wire = (nav: Row) => nav.wire as Row;
		const requests = navs.reduce((s, n) => s + (num(wire(n), 'requests') as number), 0);
		const third = navs.reduce((s, n) => s + (num(wire(n), 'thirdParty') as number), 0);
		out[kind] = {
			navs: navs.length,
			browserRequests: median(navs.map((n) => num(n, 'networkRequests') as number)),
			wireRequests: median(navs.map((n) => num(wire(n), 'requests') as number)),
			browserBytes: median(navs.map((n) => num(n, 'bytes') as number)),
			wireResponseBytes: median(navs.map((n) => num(wire(n), 'responseBytes') as number)),
			equal: navs.filter((n) => n.networkRequests === wire(n).requests).length,
			thirdPartyShare: requests === 0 ? 0 : third / requests,
			thirdPartyRequests: median(navs.map((n) => num(wire(n), 'thirdParty') as number))
		};
	}
	return out;
}

/** the least-squares coefficients of `y` on the columns of `X`, with the residual standard error */
export type LeastSquares = { coef: number[]; rss: number; residualSe: number; n: number };

/** ordinary least squares by the normal equations; `X` rows must each hold every column */
export function leastSquares(
	X: ReadonlyArray<readonly number[]>,
	y: readonly number[]
): LeastSquares {
	const n = X.length;
	const p = X[0]?.length ?? 0;
	if (p === 0 || n <= p) throw new RangeError('a fit needs more points than coefficients');
	const a = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
	for (let i = 0; i < n; i++) {
		const row = X[i] as readonly number[];
		for (let r = 0; r < p; r++) {
			for (let c = 0; c < p; c++) {
				const ar = a[r] as number[];
				ar[c] = (ar[c] as number) + (row[r] as number) * (row[c] as number);
			}
			const last = a[r] as number[];
			last[p] = (last[p] as number) + (row[r] as number) * (y[i] as number);
		}
	}
	for (let col = 0; col < p; col++) {
		let pivot = col;
		for (let r = col + 1; r < p; r++) {
			if (
				Math.abs((a[r] as number[])[col] as number) >
				Math.abs((a[pivot] as number[])[col] as number)
			)
				pivot = r;
		}
		[a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
		const head = a[col] as number[];
		if (Math.abs(head[col] as number) < 1e-12)
			throw new RangeError('the columns are collinear');
		for (let r = 0; r < p; r++) {
			if (r === col) continue;
			const row = a[r] as number[];
			const factor = (row[col] as number) / (head[col] as number);
			for (let c = col; c <= p; c++)
				row[c] = (row[c] as number) - factor * (head[c] as number);
		}
	}
	const coef = a.map((row, i) => (row[p] as number) / (row[i] as number));
	let rss = 0;
	for (let i = 0; i < n; i++) {
		const fitted = coef.reduce(
			(s, b, j) => s + b * ((X[i] as readonly number[])[j] as number),
			0
		);
		rss += ((y[i] as number) - fitted) ** 2;
	}
	return { coef, rss, residualSe: Math.sqrt(rss / (n - p)), n };
}

/** a page of the first-view corpus as the run's `method` lists it */
export type FirstViewPageInfo = {
	id: string;
	site: string;
	wireBytes: number;
	classBytes: Record<string, number>;
	facade: boolean;
	requests?: number;
};

/** the first-view figures of one run, every value over the pages it measured */
export type FirstViewFigures = {
	rounds: number;
	pages: number;
	sites: number;
	wireBytes: number;
	/** windows over the contamination limit, dropped before any figure */
	dropped: number;
	idleWatts: Spread;
	/** metered joules per first view, per page's median over rounds, above idle */
	joules: { mean: number; median: number };
	/** SWD v4 attributional joules of each page's wire bytes */
	attributional: { mean: number; median: number };
	ratio: {
		/** mean over pages of metered over attributional */
		mean: number;
		median: number;
		/** metered mean over attributional mean */
		ofMeans: number;
		/** the mean ratio of each site's pages, lowest and highest */
		siteMin: number;
		siteMax: number;
		sites: number;
	};
	/** least-squares fit of metered joules per page on the class bytes, in joules per MB */
	fit: {
		n: number;
		intercept: number;
		image: number;
		script: number;
		other: number;
		residualSe: number;
		/** each term's share of the metered joules over the pages */
		shares: { intercept: number; image: number; script: number; other: number };
	};
	/** the facade arm on pages whose iframes it changes; null when no page has one */
	facade: {
		pages: number;
		savedJ: { mean: number; median: number };
		savedBytes: { mean: number; median: number };
		savedShare: number;
	} | null;
	missedPages: string[];
};

/** the key of the null route in a `drupal-render` reading: arm, URL class and phase */
export const DRUPAL_NULL_KEY = 'null/null/steady';

/** header values an arm's responses carried, counted */
export type DrupalCacheCounts = { page: Record<string, number>; dynamic: Record<string, number> };

/** one arm, URL class and phase of a `drupal-render` reading, per request */
export type DrupalArmFigures = {
	rounds: number;
	/** joules per request above the round's idle draw, over the rounds */
	gross: Spread;
	/** the same less the null route of that round; null when no round pairs with it */
	net: Spread | null;
	status: Record<string, number>;
	cache: DrupalCacheCounts;
};

export type DrupalRenderFigures = {
	rounds: number;
	/** windows over the contamination limit, dropped before any figure */
	dropped: number;
	/** the idle draw of each round: the mean of its kept idle windows */
	idleWatts: Spread;
	arms: Record<string, DrupalArmFigures>;
};

const counts = (value: unknown): Record<string, number> =>
	typeof value === 'object' && value !== null ? (value as Record<string, number>) : {};

const addCounts = (into: Record<string, number>, from: Record<string, number>) => {
	for (const [key, n] of Object.entries(from)) into[key] = (into[key] ?? 0) + n;
};

/**
 * Joules per request of a `drupal-render` reading. A window's energy less its round's idle draw
 * times its length, over its requests. Each round pairs an arm's window with the null route's
 * window of the same round, so the net figure is paired per round, not a difference of medians.
 */
export function drupalRenderFigures(rows: readonly Row[]): DrupalRenderFigures {
	const kept = rows.filter((row) => !isContaminated(row));
	const dropped = rows.length - kept.length;
	const seconds = (row: Row) => (num(row, 'elapsedMs') as number) / 1000;
	const idleByRound = new Map<number, number[]>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'idle') continue;
		const round = num(row, 'round') as number;
		idleByRound.set(round, [
			...(idleByRound.get(round) ?? []),
			(num(row, 'pkgJ') as number) / seconds(row)
		]);
	}
	const idle = new Map([...idleByRound].map(([round, w]) => [round, mean(w)]));
	const idleWatts = spread([...idle.values()]);
	type Cell = {
		joules: Map<number, number[]>;
		status: Record<string, number>;
		cache: DrupalCacheCounts;
	};
	const cells = new Map<string, Cell>();
	for (const row of kept) {
		const arm = str(row, 'arm');
		if (arm === 'idle') continue;
		const key = `${arm}/${str(row, 'url')}/${str(row, 'phase')}`;
		const round = num(row, 'round') as number;
		const watts = idle.get(round) ?? idleWatts.median;
		const n = num(row, 'n') as number;
		const cell = cells.get(key) ?? {
			joules: new Map(),
			status: {},
			cache: { page: {}, dynamic: {} }
		};
		cell.joules.set(round, [
			...(cell.joules.get(round) ?? []),
			((num(row, 'pkgJ') as number) - watts * seconds(row)) / n
		]);
		addCounts(cell.status, counts(row.status));
		addCounts(cell.cache.page, counts(row.pageCache));
		addCounts(cell.cache.dynamic, counts(row.dynamicCache));
		cells.set(key, cell);
	}
	const perRound = (cell: Cell) => new Map([...cell.joules].map(([r, js]) => [r, mean(js)]));
	const nullCell = cells.get(DRUPAL_NULL_KEY);
	const nullRounds = nullCell ? perRound(nullCell) : new Map<number, number>();
	const arms: Record<string, DrupalArmFigures> = {};
	for (const [key, cell] of cells) {
		const rounds = perRound(cell);
		const paired = [...rounds]
			.filter(([round]) => nullRounds.has(round))
			.map(([round, g]) => g - (nullRounds.get(round) as number));
		arms[key] = {
			rounds: rounds.size,
			gross: spread([...rounds.values()]),
			net: key === DRUPAL_NULL_KEY || paired.length === 0 ? null : spread(paired),
			status: cell.status,
			cache: cell.cache
		};
	}
	return {
		rounds: new Set(kept.map((row) => num(row, 'round'))).size,
		dropped,
		idleWatts,
		arms
	};
}

const MB = 1e6;

/** the mean of a non-empty list */
const mean = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) / values.length;

/**
 * The first-view figures of a `rapl first-view` reading. A window's joules are its package energy
 * less the idle draw of its round times its length, over its navigations. Each page's figure is the
 * median over the rounds of its original arm; the facade arm is compared with the same page's
 * original arm. The fit is ordinary least squares of each page's joules on its image, script and
 * other bytes, so its coefficients and shares are indicative at this many pages.
 */
export function firstViewFigures(measurement: Measurement): FirstViewFigures {
	const pages = measurement.method['corpus pages'] as FirstViewPageInfo[];
	const kept = measurement.rows.filter((r) => !isContaminated(r));
	const dropped = measurement.rows.length - kept.length;
	const idle = new Map<number, number>();
	for (const row of kept) {
		if (str(row, 'arm') === 'idle') {
			const seconds = (num(row, 'elapsedMs') as number) / 1000;
			idle.set(num(row, 'round') as number, (num(row, 'pkgJ') as number) / seconds);
		}
	}
	const idleWatts = spread([...idle.values()]);
	type Cell = { joules: number[]; bytes: number[]; missed: number };
	const cells = new Map<string, { original: Cell; facade: Cell }>();
	for (const row of kept) {
		const arm = str(row, 'arm');
		if (arm !== 'original' && arm !== 'facade') continue;
		const page = str(row, 'page');
		const entry = cells.get(page) ?? {
			original: { joules: [], bytes: [], missed: 0 },
			facade: { joules: [], bytes: [], missed: 0 }
		};
		const cell = entry[arm];
		const seconds = (num(row, 'elapsedMs') as number) / 1000;
		const navs = num(row, 'navs') as number;
		const watts = idle.get(num(row, 'round') as number) ?? idleWatts.median;
		cell.joules.push(((num(row, 'pkgJ') as number) - watts * seconds) / navs);
		cell.bytes.push((num(row, 'servedTotal') as number) / navs);
		cell.missed += num(row, 'missed') ?? 0;
		cells.set(page, entry);
	}
	const measured = pages
		.filter((p) => cells.get(p.id)?.original.joules.length)
		.map((p) => {
			const cell = cells.get(p.id) as { original: Cell; facade: Cell };
			const joules = median(cell.original.joules);
			const attributional = attributionalJoules(p.wireBytes);
			const image = p.classBytes.image ?? 0;
			const script = p.classBytes.script ?? 0;
			const facade = cell.facade.joules.length > 0 ? cell.facade : null;
			return {
				page: p,
				joules,
				attributional,
				ratio: joules / attributional,
				image,
				script,
				other: p.wireBytes - image - script,
				bytes: median(cell.original.bytes),
				missed: cell.original.missed + cell.facade.missed,
				facade: facade && {
					joules: median(facade.joules),
					bytes: median(facade.bytes)
				}
			};
		});
	const bySite = new Map<string, number[]>();
	for (const m of measured)
		bySite.set(m.page.site, [...(bySite.get(m.page.site) ?? []), m.ratio]);
	const siteMeans = [...bySite.values()].map((ratios) => mean(ratios));
	const fit = leastSquares(
		measured.map((m) => [1, m.image / MB, m.script / MB, m.other / MB]),
		measured.map((m) => m.joules)
	);
	const sumJ = measured.reduce((s, m) => s + m.joules, 0);
	const sumMb = (pick: (m: (typeof measured)[number]) => number) =>
		measured.reduce((s, m) => s + pick(m) / MB, 0);
	const withFacade = measured.filter((m) => m.facade !== null);
	const savedJ = withFacade.map((m) => m.joules - (m.facade as { joules: number }).joules);
	const savedBytes = withFacade.map((m) => m.bytes - (m.facade as { bytes: number }).bytes);
	const meanJ = mean(measured.map((m) => m.joules));
	const meanAttr = mean(measured.map((m) => m.attributional));
	return {
		rounds: new Set(
			kept.filter((r) => str(r, 'arm') === 'original').map((r) => num(r, 'round'))
		).size,
		pages: measured.length,
		sites: bySite.size,
		wireBytes: measured.reduce((s, m) => s + m.page.wireBytes, 0),
		dropped,
		idleWatts,
		joules: { mean: meanJ, median: median(measured.map((m) => m.joules)) },
		attributional: {
			mean: meanAttr,
			median: median(measured.map((m) => m.attributional))
		},
		ratio: {
			mean: mean(measured.map((m) => m.ratio)),
			median: median(measured.map((m) => m.ratio)),
			ofMeans: meanJ / meanAttr,
			siteMin: Math.min(...siteMeans),
			siteMax: Math.max(...siteMeans),
			sites: bySite.size
		},
		fit: {
			n: fit.n,
			intercept: fit.coef[0] as number,
			image: fit.coef[1] as number,
			script: fit.coef[2] as number,
			other: fit.coef[3] as number,
			residualSe: fit.residualSe,
			shares: {
				intercept: ((fit.coef[0] as number) * fit.n) / sumJ,
				image: ((fit.coef[1] as number) * sumMb((m) => m.image)) / sumJ,
				script: ((fit.coef[2] as number) * sumMb((m) => m.script)) / sumJ,
				other: ((fit.coef[3] as number) * sumMb((m) => m.other)) / sumJ
			}
		},
		facade:
			withFacade.length === 0
				? null
				: {
						pages: withFacade.length,
						savedJ: { mean: mean(savedJ), median: median(savedJ) },
						savedBytes: { mean: mean(savedBytes), median: median(savedBytes) },
						savedShare: mean(withFacade.map((m, i) => (savedJ[i] as number) / m.joules))
					},
		missedPages: measured.filter((m) => m.missed > 0).map((m) => m.page.id)
	};
}

/** one file count at one emulated delay of a chunk-split run, per navigation */
export type ChunkArmFigures = {
	chunks: number;
	rttMs: number;
	/** windows of this arm, one per round */
	rounds: number;
	/** joules above the round's idle draw per navigation, median and range over rounds */
	joules: Spread;
	/** requests the origin counted per navigation */
	requests: number;
	/** wire bytes the origin sent per navigation */
	bytes: number;
	/** bytes above the one-file arm of the same delay, per navigation */
	bytePenalty: number;
	/** SWD v4 joules of the byte penalty (L2, attributional) */
	penaltyJ: number;
	/** ScriptDuration and TaskDuration in ms per navigation */
	scriptMs: number;
	taskMs: number;
	/** origin CPU milliseconds per navigation */
	originCpuMs: number;
	/** navigations that failed or timed out, summed over the windows */
	navErrors: number;
};

/** the line of one delay's file counts: joules on requests, with intervals over rounds */
export type ChunkFit = {
	rttMs: number;
	/** rounds every file count of this delay measured: the bootstrap's sample */
	rounds: number;
	/** joules per navigation for each extra request */
	slope: Estimate;
	/** joules per navigation at zero requests */
	intercept: Estimate;
	/** ScriptDuration in ms per extra request */
	scriptSlope: Estimate;
	/** TaskDuration in ms per extra request */
	taskSlope: Estimate;
	/** extra requests that cost one joule (1 / slope); null when the slope's interval reaches zero */
	requestsPerJoule: Estimate | null;
};

export type ChunkSplitFigures = {
	/** windows over the contamination limit, dropped before any figure */
	dropped: number;
	idleWatts: Spread;
	arms: ChunkArmFigures[];
	/** one fit per delay that measured at least two rounds of every file count */
	fits: ChunkFit[];
};

type ChunkPoint = {
	joules: number;
	requests: number;
	bytes: number;
	scriptMs: number;
	taskMs: number;
	cpuMs: number;
	navErrors: number;
};

type ChunkGroup = { chunks: number; rttMs: number; points: Map<number, ChunkPoint> };

/**
 * The device cost of splitting one page's scripts. A window's joules are its package energy less the
 * idle draw of its round, over its navigations, as in `firstViewFigures`. Each file count's figure is
 * the median over rounds. The fit is a least-squares line of joules on requests across the file
 * counts of one delay; its intervals come from a bootstrap over rounds with a fixed seed. Byte
 * penalties are against the one-file arm of the same delay.
 */
export function chunkSplitFigures(measurement: Measurement): ChunkSplitFigures {
	const kept = measurement.rows.filter((row) => !isContaminated(row));
	const dropped = measurement.rows.length - kept.length;
	const seconds = (row: Row) => (num(row, 'elapsedMs') as number) / 1000;
	const idleByRound = new Map<number, number[]>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'idle') continue;
		const round = num(row, 'round') as number;
		idleByRound.set(round, [
			...(idleByRound.get(round) ?? []),
			(num(row, 'pkgJ') as number) / seconds(row)
		]);
	}
	const idle = new Map([...idleByRound].map(([round, w]) => [round, mean(w)]));
	const idleWatts = spread([...idle.values()]);
	const groups = new Map<string, ChunkGroup>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'chunks') continue;
		const round = num(row, 'round') as number;
		const navs = num(row, 'navs') as number;
		const chunks = num(row, 'chunks') as number;
		const rttMs = num(row, 'rttMs') as number;
		const watts = idle.get(round) ?? idleWatts.median;
		const metrics = row.navMetrics as Array<{
			before: Record<string, number>;
			after: Record<string, number>;
		}>;
		const perNav = (key: string) =>
			metrics.reduce(
				(s, m) => s + ((m.after[key] as number) - (m.before[key] as number)),
				0
			) / navs;
		const key = `${rttMs}/${chunks}`;
		const group = groups.get(key) ?? { chunks, rttMs, points: new Map<number, ChunkPoint>() };
		group.points.set(round, {
			joules: ((num(row, 'pkgJ') as number) - watts * seconds(row)) / navs,
			requests: (num(row, 'requests') as number) / navs,
			bytes: (num(row, 'servedTotal') as number) / navs,
			scriptMs: perNav('ScriptDuration') * 1000,
			taskMs: perNav('TaskDuration') * 1000,
			cpuMs: (num(row, 'originCpuMs') as number) / navs,
			navErrors: num(row, 'navErrors') ?? 0
		});
		groups.set(key, group);
	}
	const delays = [...new Set([...groups.values()].map((g) => g.rttMs))].sort((a, b) => a - b);
	const arms: ChunkArmFigures[] = [];
	const fits: ChunkFit[] = [];
	for (const rttMs of delays) {
		const group = [...groups.values()]
			.filter((g) => g.rttMs === rttMs)
			.sort((a, b) => a.chunks - b.chunks);
		const values = (g: ChunkGroup, pick: (p: ChunkPoint) => number) =>
			[...g.points.values()].map(pick);
		const one = group.find((g) => g.chunks === 1);
		const baseBytes = one ? median(values(one, (p) => p.bytes)) : NaN;
		for (const g of group) {
			const bytes = median(values(g, (p) => p.bytes));
			const bytePenalty = bytes - baseBytes;
			arms.push({
				chunks: g.chunks,
				rttMs,
				rounds: g.points.size,
				joules: spread(values(g, (p) => p.joules)),
				requests: median(values(g, (p) => p.requests)),
				bytes,
				bytePenalty,
				penaltyJ: attributionalJoules(bytePenalty),
				scriptMs: median(values(g, (p) => p.scriptMs)),
				taskMs: median(values(g, (p) => p.taskMs)),
				originCpuMs: median(values(g, (p) => p.cpuMs)),
				navErrors: values(g, (p) => p.navErrors).reduce((s, v) => s + v, 0)
			});
		}
		const first = group[0];
		const common = [...(first?.points.keys() ?? [])]
			.filter((round) => group.every((g) => g.points.has(round)))
			.sort((a, b) => a - b);
		if (group.length >= 2 && common.length >= 2) fits.push(chunkFit(rttMs, group, common));
	}
	return { dropped, idleWatts, arms, fits };
}

/** the line of one delay's file counts and its bootstrap over the rounds every count measured */
function chunkFit(rttMs: number, group: ChunkGroup[], rounds: number[]): ChunkFit {
	const line = (rs: readonly number[], field: 'joules' | 'scriptMs' | 'taskMs') =>
		linearFit(
			group.map((g) => {
				const at = (r: number) => g.points.get(r) as ChunkPoint;
				return [
					median(rs.map((r) => at(r).requests)),
					median(rs.map((r) => at(r)[field]))
				] as const;
			})
		);
	const point = {
		joules: line(rounds, 'joules'),
		script: line(rounds, 'scriptMs'),
		task: line(rounds, 'taskMs')
	};
	const draw = lcg(BOOTSTRAP_SEED);
	const reps: number[][] = [];
	for (let b = 0; b < BOOTSTRAP_REPLICATES; b++) {
		const sample = Array.from(
			{ length: rounds.length },
			() => rounds[Math.floor(draw() * rounds.length)] as number
		);
		const joules = line(sample, 'joules');
		reps.push([
			joules.slope,
			joules.intercept,
			line(sample, 'scriptMs').slope,
			line(sample, 'taskMs').slope
		]);
	}
	const interval = (value: number, column: number[]): Estimate => ({
		value,
		low: nearestRank(column, 0.025),
		high: nearestRank(column, 0.975)
	});
	const slope = interval(
		point.joules.slope,
		reps.map((r) => r[0] as number)
	);
	return {
		rttMs,
		rounds: rounds.length,
		slope,
		intercept: interval(
			point.joules.intercept,
			reps.map((r) => r[1] as number)
		),
		scriptSlope: interval(
			point.script.slope,
			reps.map((r) => r[2] as number)
		),
		taskSlope: interval(
			point.task.slope,
			reps.map((r) => r[3] as number)
		),
		requestsPerJoule:
			slope.low > 0
				? {
						value: 1 / point.joules.slope,
						low: 1 / slope.high,
						high: 1 / slope.low
					}
				: null
	};
}

/** the repeat-view figures of a `first-view-warm` reading, against the cold views of `first-view` */
export type WarmFigures = {
	rounds: number;
	/** pages measured in both readings */
	pages: number;
	/** windows over the contamination limit in the repeat reading, dropped before any figure */
	dropped: number;
	/** metered joules per repeat view, per page's median over rounds, above idle */
	joules: { mean: number; median: number };
	/** metered joules per cold first view of the same pages, from the cold reading */
	coldJoules: { mean: number; median: number };
	/** per page, repeat over cold; mean and median over the pages */
	ratio: { mean: number; median: number };
	/** median over pages of each term's share of TaskDuration, pooled over a page's navigations */
	taskShare: { script: number; layout: number; recalc: number };
	/** pages whose repeat navigation fetched more than half the bytes its cold view fetched */
	refetch: { pages: number; share: number };
};

type WarmNav = { before: Record<string, number>; after: Record<string, number> };

type ArmCell = { joules: number[]; bytes: number[]; rounds: Set<number> };

/** one arm's windows by page: joules above the round's idle draw, and bytes, per navigation */
function armCells(rows: readonly Row[], arm: string) {
	const kept = rows.filter((row) => !isContaminated(row));
	const idle = new Map<number, number>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'idle') continue;
		const seconds = (num(row, 'elapsedMs') as number) / 1000;
		idle.set(num(row, 'round') as number, (num(row, 'pkgJ') as number) / seconds);
	}
	const idleWatts = median([...idle.values()]);
	const cells = new Map<string, ArmCell>();
	for (const row of kept) {
		if (str(row, 'arm') !== arm) continue;
		const page = str(row, 'page');
		const round = num(row, 'round') as number;
		const seconds = (num(row, 'elapsedMs') as number) / 1000;
		const navs = num(row, 'navs') as number;
		const watts = idle.get(round) ?? idleWatts;
		const cell = cells.get(page) ?? { joules: [], bytes: [], rounds: new Set<number>() };
		cell.joules.push(((num(row, 'pkgJ') as number) - watts * seconds) / navs);
		cell.bytes.push((num(row, 'servedTotal') as number) / navs);
		cell.rounds.add(round);
		cells.set(page, cell);
	}
	const dropped = rows.filter((row) => str(row, 'arm') === arm && isContaminated(row)).length;
	return { cells, dropped };
}

/**
 * The repeat-view figures of a `first-view-warm` reading. A window's joules are its package energy
 * less the idle draw of its round, over its navigations, as in `firstViewFigures`; the cold figure
 * of each page is taken the same way from the cold reading. A page counts when both readings measured
 * it. The term shares divide each page's summed script, layout and style time by its summed task
 * time; the three terms are reported on their own because they may overlap.
 */
export function warmFigures(warm: Measurement, cold: Measurement): WarmFigures {
	const repeat = armCells(warm.rows, 'warm');
	const first = armCells(cold.rows, 'original');
	const shared = [...repeat.cells.keys()].filter((page) => first.cells.has(page)).sort();
	const warmMedian = (page: string) => median((repeat.cells.get(page) as ArmCell).joules);
	const coldMedian = (page: string) => median((first.cells.get(page) as ArmCell).joules);
	const joules = shared.map(warmMedian);
	const coldJoules = shared.map(coldMedian);
	const ratio = shared.map((page) => warmMedian(page) / coldMedian(page));
	const tasks = new Map<string, Record<string, number>>();
	for (const row of warm.rows) {
		if (str(row, 'arm') !== 'warm' || isContaminated(row)) continue;
		const page = str(row, 'page');
		const sums = tasks.get(page) ?? {
			ScriptDuration: 0,
			LayoutDuration: 0,
			RecalcStyleDuration: 0,
			TaskDuration: 0
		};
		for (const nav of row.warmMetrics as WarmNav[]) {
			for (const key of Object.keys(sums)) {
				const step = (nav.after[key] as number) - (nav.before[key] as number);
				sums[key] = (sums[key] as number) + step;
			}
		}
		tasks.set(page, sums);
	}
	const share = (term: string) =>
		median(
			shared.map((page) => {
				const sums = tasks.get(page) as Record<string, number>;
				return (sums[term] as number) / (sums.TaskDuration as number);
			})
		);
	const refetched = shared.filter((page) => {
		const repeatBytes = median((repeat.cells.get(page) as ArmCell).bytes);
		return repeatBytes > 0.5 * median((first.cells.get(page) as ArmCell).bytes);
	}).length;
	return {
		rounds: new Set([...repeat.cells.values()].flatMap((c) => [...c.rounds])).size,
		pages: shared.length,
		dropped: repeat.dropped,
		joules: { mean: mean(joules), median: median(joules) },
		coldJoules: { mean: mean(coldJoules), median: median(coldJoules) },
		ratio: { mean: mean(ratio), median: median(ratio) },
		taskShare: {
			script: share('ScriptDuration'),
			layout: share('LayoutDuration'),
			recalc: share('RecalcStyleDuration')
		},
		refetch: { pages: refetched, share: refetched / shared.length }
	};
}

/** a coefficient with its 95% bootstrap interval, the 2.5th and 97.5th percentiles of the resamples */
export type Estimate = { value: number; low: number; high: number };

/** a least-squares fit over pages with each coefficient's interval; null when it is not estimable */
export type FitFigures = {
	pages: number;
	/** resamples that fit; a resample with collinear columns has no unique fit and is dropped */
	replicates: number;
	residualSe: number;
	r2: number;
	coef: Record<string, Estimate>;
};

export type FirstViewFit = {
	pages: number;
	/** median over pages of the metered joules per first view, above idle */
	joulesMedian: number;
	/** Pearson correlation of each page's joules with its total wire MB */
	corrTotalMb: number;
	/** intercept, image, script and other MB */
	classFit: FitFigures | null;
	/** intercept and total MB */
	bytesFit: FitFigures | null;
	/** intercept, total MB and requests */
	requestFit: FitFigures | null;
	/** intercept, image, script, other MB and requests */
	classRequestFit: FitFigures | null;
};

const BOOTSTRAP_SEED = 12345;
const BOOTSTRAP_REPLICATES = 2000;

/** a 32-bit linear congruential generator, so one seed gives the same draws on every run */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

/** the nearest-rank value of a sample at `p`: index floor(p * n) of the sorted values */
function nearestRank(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

/**
 * A least-squares fit over pages, with each coefficient's interval from a bootstrap over pages:
 * resamples with replacement from a fixed seed, dropped when collinear. Null when there are no more
 * pages than coefficients, or when no resample fits.
 */
function bootstrapFit(X: number[][], y: number[], names: readonly string[]): FitFigures | null {
	const n = y.length;
	if (n <= names.length) return null;
	const fit = leastSquares(X, y);
	const mean = y.reduce((s, v) => s + v, 0) / n;
	const tss = y.reduce((s, v) => s + (v - mean) ** 2, 0);
	const draw = lcg(BOOTSTRAP_SEED);
	const reps: number[][] = [];
	for (let b = 0; b < BOOTSTRAP_REPLICATES; b++) {
		const idx = Array.from({ length: n }, () => Math.floor(draw() * n));
		try {
			const sample = leastSquares(
				idx.map((i) => X[i] as number[]),
				idx.map((i) => y[i] as number)
			);
			reps.push(sample.coef);
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
		}
	}
	if (reps.length === 0) return null;
	return {
		pages: n,
		replicates: reps.length,
		residualSe: fit.residualSe,
		r2: 1 - fit.rss / tss,
		coef: Object.fromEntries(
			names.map((name, k) => {
				const column = reps.map((r) => r[k] as number);
				return [
					name,
					{
						value: fit.coef[k] as number,
						low: nearestRank(column, 0.025),
						high: nearestRank(column, 0.975)
					}
				];
			})
		)
	};
}

/** Pearson correlation of two equal-length lists */
function pearson(a: readonly number[], b: readonly number[]): number {
	const n = a.length;
	const ma = a.reduce((s, v) => s + v, 0) / n;
	const mb = b.reduce((s, v) => s + v, 0) / n;
	let cov = 0;
	let va = 0;
	let vb = 0;
	a.forEach((x, i) => {
		const dx = x - ma;
		const dy = (b[i] as number) - mb;
		cov += dx * dy;
		va += dx * dx;
		vb += dy * dy;
	});
	return cov / Math.sqrt(va * vb);
}

/** the pages of a first-view reading with an original arm: the joules `firstViewFigures` uses, and the class bytes in MB */
function firstViewPages(measurement: Measurement) {
	const pages = measurement.method['corpus pages'] as FirstViewPageInfo[];
	const kept = measurement.rows.filter((r) => !isContaminated(r));
	const idle = new Map<number, number>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'idle') continue;
		const seconds = (num(row, 'elapsedMs') as number) / 1000;
		idle.set(num(row, 'round') as number, (num(row, 'pkgJ') as number) / seconds);
	}
	const idleWatts = median([...idle.values()]);
	const joules = new Map<string, number[]>();
	for (const row of kept) {
		if (str(row, 'arm') !== 'original') continue;
		const page = str(row, 'page');
		const seconds = (num(row, 'elapsedMs') as number) / 1000;
		const navs = num(row, 'navs') as number;
		const watts = idle.get(num(row, 'round') as number) ?? idleWatts;
		const value = ((num(row, 'pkgJ') as number) - watts * seconds) / navs;
		joules.set(page, [...(joules.get(page) ?? []), value]);
	}
	return pages
		.filter((p) => joules.has(p.id))
		.map((p) => {
			const image = p.classBytes.image ?? 0;
			const script = p.classBytes.script ?? 0;
			return {
				site: p.site,
				joules: median(joules.get(p.id) as number[]),
				image: image / MB,
				script: script / MB,
				other: (p.wireBytes - image - script) / MB,
				total: p.wireBytes / MB,
				requests: p.requests
			};
		});
}

/**
 * The class, bytes and request fits of a `first-view` reading, each with bootstrap intervals over
 * pages. `without` lists hosts whose pages are left out, for a sensitivity check. The request fits
 * need a request count on every page and are null otherwise.
 */
export function firstViewFit(
	measurement: Measurement,
	without: readonly string[] = []
): FirstViewFit {
	const pages = firstViewPages(measurement).filter((p) => !without.includes(p.site));
	const y = pages.map((p) => p.joules);
	const withRequests = pages.every((p) => p.requests !== undefined);
	const requests = (p: (typeof pages)[number]) => p.requests as number;
	return {
		pages: pages.length,
		joulesMedian: median(y),
		corrTotalMb: pearson(
			y,
			pages.map((p) => p.total)
		),
		classFit: bootstrapFit(
			pages.map((p) => [1, p.image, p.script, p.other]),
			y,
			['intercept', 'image', 'script', 'other']
		),
		bytesFit: bootstrapFit(
			pages.map((p) => [1, p.total]),
			y,
			['intercept', 'total']
		),
		requestFit: withRequests
			? bootstrapFit(
					pages.map((p) => [1, p.total, requests(p)]),
					y,
					['intercept', 'total', 'requests']
				)
			: null,
		classRequestFit: withRequests
			? bootstrapFit(
					pages.map((p) => [1, p.image, p.script, p.other, requests(p)]),
					y,
					['intercept', 'image', 'script', 'other', 'requests']
				)
			: null
	};
}
