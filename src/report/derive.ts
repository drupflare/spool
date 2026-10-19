import type { Measurement, Row } from './measurement.js';

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
	const other = (row: Row) => num(row, 'otherCpuMs') ?? num(row, 'otherContainersCpuMs') ?? 0;
	const kept = rows.filter((row) => other(row) / seconds(row) <= limit);
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
function loaded(nav: Row): boolean {
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
