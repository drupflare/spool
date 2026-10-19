import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
	DOCUMENT_BYTES,
	FREE_TIER_VIEWS,
	HOSTS,
	MOBILE_SHARE,
	MODELLED_VIEW,
	ORIGIN_J,
	PANTHEON_OVERAGE,
	PRICES_READ,
	PUE,
	RADIO_J,
	SERVER_WATTS,
	SWD_V4,
	TIERS,
	attributionalJoules,
	bandwidthUsd,
	capacityMWh,
	classifyOrigin,
	dataCentreJoules,
	deviceCpuFigures,
	egressUsd,
	freeTierCeiling,
	inferenceFigures,
	joulesPerView,
	joulesPerViewWithOrigin,
	median,
	monthlyGb,
	onWireFigures,
	parseMeasurementText,
	peakCut,
	phoneRun,
	powerSweep,
	raplRun,
	repeatBytesBySite,
	repeatNavFigures,
	repeatSplitBySite,
	requestUsd,
	runtimeRun,
	saving,
	serverYearMWh,
	serversAfter,
	spread,
	viewsChannelMWh,
	zeroNetworkFigures,
	type ByteSplit,
	type Fit,
	type Measurement,
	type OpFigures,
	type OriginClass,
	type Spread
} from '../src/report/index';
import { isMain } from './measure/lib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** the scale every table uses: yearly views, an L3 choice that names no institution */
export const SCALE_VIEWS = 100e6;

const J_PER_MWH = 3.6e9;

/** the readings by path under `measurements/`, each validated */
export type Readings = Map<string, Measurement>;

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? walk(join(dir, e.name))
			: e.name.endsWith('.json')
				? [join(dir, e.name)]
				: []
	);
}

/** every reading under `<root>/measurements`, validated, keyed by its path below that folder */
export function loadReadings(root: string = ROOT): Readings {
	const base = join(root, 'measurements');
	const out: Readings = new Map();
	for (const path of walk(base).sort()) {
		const name = relative(base, path).split('\\').join('/');
		out.set(name, parseMeasurementText(readFileSync(path, 'utf8'), name));
	}
	return out;
}

/** orders reading names by date, a same-day experiment after the plain reading ("-" sorts before ".") */
export function byReading(a: string, b: string): number {
	const key = (n: string) => n.replace(/\.json$/, '');
	return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** the latest reading of a rig, narrowed to files ending in `-<experiment>` when given */
export function latest(readings: Readings, rig: string, experiment?: string): Measurement {
	const names = [...readings.keys()]
		.filter((n) => n.startsWith(`${rig}/`))
		.filter((n) => !experiment || n.endsWith(`-${experiment}.json`))
		.sort(byReading);
	const name = names[names.length - 1];
	if (!name)
		throw new Error(
			`no ${rig}${experiment ? ` ${experiment}` : ''} reading under measurements/`
		);
	return readings.get(name) as Measurement;
}

// #region formatting

/** `value` with `digits` decimals and thousands separators */
export const fixed = (value: number, digits = 0): string =>
	value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** three significant figures, in plain decimal notation */
export function sig(value: number, figures = 3): string {
	if (value === 0) return '0';
	const digits = Math.max(0, figures - 1 - Math.floor(Math.log10(Math.abs(value))));
	return fixed(value, Math.min(digits, 6));
}

/** `median (min to max)` at three significant figures */
export const range = (s: Spread, f: (v: number) => string = sig): string =>
	`${f(s.median)} (${f(s.min)} to ${f(s.max)})`;

/** a markdown table; `right` columns align right */
export function table(headers: string[], rows: string[][], right: number[] = []): string {
	const head = `| ${headers.join(' | ')} |`;
	const rule = `| ${headers.map((_, i) => (right.includes(i) ? '---:' : '---')).join(' | ')} |`;
	return [head, rule, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const tierName = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const pct = (z: number) => `${Math.round(z * 100)}%`;

/** dollars: cents under ten, whole dollars above */
const usd = (n: number): string => (n === 0 ? '$0' : `$${fixed(n, n < 10 ? 2 : 0)}`);

/** a list price at the precision vendors print it */
const price = (n: number): string => (n === 0 ? '$0' : `$${fixed(n, n < 0.1 ? 3 : 2)}`);

// #endregion

/** the numbers the page prints, by placeholder name */
export type Figures = { values: Record<string, string>; tables: Record<string, string> };

const arm = (run: { arms: Record<string, OpFigures> }, name: string): OpFigures => {
	const found = run.arms[name];
	if (!found) throw new Error(`the reading has no ${name} arm`);
	return found;
};

const fitText = (fit: Fit | undefined, what: string): string => {
	if (!fit) throw new Error(`no fit for ${what}`);
	return `${fixed(fit.intercept, 2)} W plus ${fixed(fit.slope * 1000, 1)} mJ per request (R2 ${fixed(fit.r2, 3)})`;
};

/** every derived figure and table, computed from the readings and `src/report` */
export function buildFigures(readings: Readings): Figures {
	const v: Record<string, string> = {};
	const t: Record<string, string> = {};

	// #region inputs and the headline
	const bytes = DOCUMENT_BYTES.value;
	v.swdTotal = fixed(SWD_V4.network.value + SWD_V4.datacentre.value + SWD_V4.device.value, 3);
	v.headlineJ = fixed(joulesPerView(), 1);
	v.dataCentreJ = fixed(dataCentreJoules(bytes), 1);
	v.networkJ = fixed(attributionalJoules(bytes, SWD_V4.network.value), 1);
	v.serverYear = fixed(serverYearMWh(), 2);
	v.serverWatts = fixed(SERVER_WATTS.value);
	v.pue = fixed(PUE.value, 2);
	v.freeTierViews = fixed(FREE_TIER_VIEWS.value);
	v.revisitBytesInput = fixed(bytes);
	t.headline = table(
		['term', 'basis', 'joules', 'label'],
		[
			[
				'Network',
				`SWD v4 ${SWD_V4.network.value} kWh/GB over ${fixed(bytes)} B`,
				fixed(attributionalJoules(bytes, SWD_V4.network.value), 1),
				'L2'
			],
			[
				'Data centre',
				`SWD v4 ${SWD_V4.datacentre.value} kWh/GB over the same bytes`,
				fixed(dataCentreJoules(bytes), 1),
				'L2'
			],
			[
				'Device',
				`SWD v4 ${SWD_V4.device.value} kWh/GB over the same bytes`,
				fixed(attributionalJoules(bytes, SWD_V4.device.value), 1),
				'L2'
			],
			[
				'Origin request',
				`a conventional origin, ${ORIGIN_J.conventional.source}`,
				fixed(ORIGIN_J.conventional.value, 3),
				'L1'
			],
			[
				'Radio wake',
				`${fixed(RADIO_J.attributed.value)} J on ${pct(MOBILE_SHARE.value)} of views (phones), until a phone reading attributes a wake; ${fixed(RADIO_J.central.value)} J was the earlier scenario value`,
				fixed(MOBILE_SHARE.value * RADIO_J.attributed.value, 2),
				'L1'
			],
			['Total', 'the sum of the rows', fixed(joulesPerView(), 1), 'L2']
		],
		[2]
	);
	// #endregion

	// #region repeat views
	const lastNav = repeatNavFigures(latest(readings, 'repeat-nav').rows);
	const repeatLast = lastNav['warm-home-repeat'];
	if (!repeatLast)
		throw new Error('the repeat-navigation reading has no warm-home-repeat navigations');
	v.revisitRequests = fixed(repeatLast.medianRequests);
	v.revisitSites = fixed(repeatLast.sites);
	const navReadings = [...readings.keys()]
		.filter((k) => k.startsWith('repeat-nav/'))
		.sort(byReading);
	const bySite = navReadings.map((k) => repeatBytesBySite(readings.get(k)?.rows ?? []));
	const pooled = median(bySite.flatMap((m) => [...m.values()].map((s) => s.document)));
	if (pooled !== bytes) {
		throw new Error(
			`DOCUMENT_BYTES is ${bytes} B but the pooled repeat-view document median is ${pooled} B; update src/report/inputs.ts`
		);
	}
	v.revisitViews = fixed(bySite.reduce((n, m) => n + m.size, 0));
	v.revisitReadings = fixed(navReadings.length);
	const blocked = new Set(
		navReadings.flatMap((k) =>
			(readings.get(k)?.rows ?? [])
				.filter((row) =>
					((row.navs as Array<Record<string, unknown>> | undefined) ?? []).some(
						(nav) =>
							nav.kind === 'warm-home-repeat' &&
							typeof nav.docStatus === 'number' &&
							nav.docStatus >= 400
					)
				)
				.map((row) => new URL(String(row.site)).hostname)
		)
	);
	v.blockedSites = [...blocked].sort().join(', ') || 'none';
	v.revisitWholeMedian = fixed(
		median(bySite.flatMap((m) => [...m.values()].map((s) => s.bytes)))
	);
	const sites = [...new Set(bySite.flatMap((m) => [...m.keys()]))];
	const lastOf = (site: string) =>
		[...bySite]
			.reverse()
			.find((m) => m.has(site))
			?.get(site) ?? { bytes: 0, document: 0 };
	sites.sort((a, b) => lastOf(a).document - lastOf(b).document);
	t['bytes-by-site'] = table(
		[
			'site',
			...navReadings.map(
				(k) => `document bytes, ${k.slice('repeat-nav/'.length, -'.json'.length)}`
			),
			'whole view bytes, latest reading',
			'J per local view'
		],
		sites.map((site) => {
			const last = lastOf(site);
			return [
				new URL(site).hostname,
				...bySite.map((m) =>
					m.has(site) ? fixed(m.get(site)?.document ?? 0) : 'not read'
				),
				fixed(last.bytes),
				// a document the browser's cache answered leaves no request for a local view to replace
				last.document === 0
					? '0.0'
					: fixed(joulesPerView({ ...MODELLED_VIEW, bytes: last.document }), 1)
			];
		}),
		bySite.map((_, i) => i + 1).concat(bySite.length + 1, bySite.length + 2)
	);
	const splitReading = latest(readings, 'repeat-nav', 'requests');
	const splits = repeatSplitBySite(splitReading.rows);
	const splitSites = splitReading.rows.map((row) => String(row.site));
	const unreadReason = (site: string) => {
		const row = splitReading.rows.find((r) => String(r.site) === site);
		const nav = ((row?.navs as Array<Record<string, unknown>> | undefined) ?? []).find(
			(n) => n.kind === 'warm-home-repeat'
		);
		if (row?.error) return `error: ${String(row.error)}`;
		if (nav && typeof nav.docStatus === 'number' && nav.docStatus >= 400)
			return `blocked, HTTP ${nav.docStatus}`;
		return nav ? 'home page did not load' : 'no repeat view';
	};
	const shipsToday = (s: ByteSplit) => {
		const moved = s.document + s.sameOriginStatic;
		return moved === 0 ? 0 : joulesPerView({ ...MODELLED_VIEW, bytes: moved });
	};
	const split = [...splits.values()];
	const pool = (pick: (s: ByteSplit) => number) => split.reduce((n, s) => n + pick(s), 0);
	const total = pool((s) => s.total);
	const share = (n: number) => `${fixed((100 * n) / total, 1)}%`;
	v.splitSites = fixed(split.length);
	v.splitSitesAll = fixed(splitSites.length);
	v.splitTotalBytes = fixed(total);
	v.splitDocumentShare = share(pool((s) => s.document));
	v.splitStaticShare = share(pool((s) => s.sameOriginStatic));
	v.splitDynamicShare = share(pool((s) => s.sameOriginDynamic));
	v.splitThirdShare = share(pool((s) => s.thirdPartyTotal));
	const classBytes = (kind: OriginClass) => pool((s) => s.thirdParty[kind] ?? 0);
	const topTwo = [...split].sort((a, b) => b.total - a.total).slice(0, 2);
	v.splitTopTwoShare = share(topTwo.reduce((n, s) => n + s.total, 0));
	v.splitUnknownShare = `${fixed((100 * classBytes('unknown')) / pool((s) => s.thirdPartyTotal), 1)}%`;
	v.splitAdsBytes = fixed(classBytes('ads'));
	v.splitAdsSites = fixed(split.filter((s) => (s.thirdParty.ads ?? 0) > 0).length);
	v.splitAnalyticsBytes = fixed(classBytes('analytics'));
	v.splitStaticMedian = `${fixed(100 * median(split.filter((s) => s.total > 0).map((s) => s.sameOriginStatic / s.total)), 1)}%`;
	v.shipsTodayMedianJ = fixed(median(split.map(shipsToday)), 1);
	v.shipsTodayMaxJ = fixed(Math.max(...split.map(shipsToday)), 1);
	t['split-by-site'] = table(
		[
			'site',
			'document B',
			'same-origin static B',
			'same-origin dynamic B',
			'third-party B',
			'whole view B',
			'J a local view removes, document only (headline basis)',
			'J a local view removes on the site as it ships today, including the cache-header fix'
		],
		splitSites.map((site) => {
			const s = splits.get(site);
			const host = new URL(site).hostname;
			return s
				? [
						host,
						fixed(s.document),
						fixed(s.sameOriginStatic),
						fixed(s.sameOriginDynamic),
						fixed(s.thirdPartyTotal),
						fixed(s.total),
						s.document === 0
							? '0.0'
							: fixed(joulesPerView({ ...MODELLED_VIEW, bytes: s.document }), 1),
						fixed(shipsToday(s), 1)
					]
				: [host, unreadReason(site), '', '', '', '', '', ''];
		}),
		[1, 2, 3, 4, 5, 6, 7]
	);
	const parts: Array<[string, (s: ByteSplit) => number]> = [
		['Document', (s) => s.document],
		['Same-origin static (Script, Stylesheet, Font, Image, Media)', (s) => s.sameOriginStatic],
		['Same-origin dynamic (XHR, Fetch, Ping, Other and the rest)', (s) => s.sameOriginDynamic],
		['Third-party', (s) => s.thirdPartyTotal],
		['Whole repeat view', (s) => s.total]
	];
	t['split-pooled'] = table(
		['class', 'bytes over all sites', 'pooled share of bytes', 'median share of a site'],
		parts.map(([label, pick]) => [
			label,
			fixed(pool(pick)),
			share(pool(pick)),
			`${fixed(100 * median(split.filter((s) => s.total > 0).map((s) => pick(s) / s.total)), 1)}%`
		]),
		[1, 2, 3]
	);
	const hosts = new Map<string, number>();
	for (const s of split)
		for (const [host, n] of Object.entries(s.thirdPartyHosts))
			hosts.set(host, (hosts.get(host) ?? 0) + n);
	t['third-party-hosts'] = table(
		['host', 'class', 'bytes over all sites', 'sites'],
		[...hosts]
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, 10)
			.map(([host, n]) => [
				host,
				classifyOrigin(`https://${host}/`).class,
				fixed(n),
				fixed(split.filter((s) => (s.thirdPartyHosts[host] ?? 0) > 0).length)
			]),
		[2, 3]
	);
	const classes = [
		...new Set(split.flatMap((s) => Object.keys(s.thirdParty) as OriginClass[]))
	].sort(
		(a, b) =>
			pool((s) => s.thirdParty[b] ?? 0) - pool((s) => s.thirdParty[a] ?? 0) ||
			(a < b ? -1 : 1)
	);
	t['third-party-classes'] = table(
		['class', 'total bytes', 'median bytes per site', 'sites with any'],
		classes.map((kind) => [
			kind,
			fixed(pool((s) => s.thirdParty[kind] ?? 0)),
			fixed(median(split.map((s) => s.thirdParty[kind] ?? 0))),
			fixed(split.filter((s) => (s.thirdParty[kind] ?? 0) > 0).length)
		]),
		[1, 2, 3]
	);
	const kinds: Array<[string, string]> = [
		['cold-home', 'Cold home page'],
		['warm-internal', 'Warm internal page'],
		['warm-home-repeat', 'Home page again']
	];
	t['repeat-nav'] = table(
		[
			'navigation',
			'navigations',
			'sites',
			'median bytes',
			'mean bytes',
			'75th percentile bytes',
			'median network requests',
			'median document bytes'
		],
		kinds.flatMap(([k, label]) => {
			const f = lastNav[k];
			return f
				? [
						[
							label,
							fixed(f.navs),
							fixed(f.sites),
							fixed(f.medianBytes),
							fixed(f.meanBytes),
							fixed(f.p75Bytes),
							fixed(f.medianRequests, 1),
							fixed(f.medianDocBytes)
						]
					]
				: [];
		}),
		[1, 2, 3, 4, 5, 6, 7]
	);
	// #endregion

	// #region on the wire
	const wire = onWireFigures(latest(readings, 'on-wire').rows);
	t['on-wire'] = table(
		[
			'navigation',
			'navigations',
			'browser network requests',
			'proxy requests',
			'equal counts',
			'browser bytes',
			'proxy response bytes',
			'proxy requests to other hosts'
		],
		kinds.flatMap(([k, label]) => {
			const f = wire[k];
			return f
				? [
						[
							label,
							fixed(f.navs),
							fixed(f.browserRequests, 1),
							fixed(f.wireRequests, 1),
							`${f.equal} of ${f.navs}`,
							fixed(f.browserBytes),
							fixed(f.wireResponseBytes),
							pct(f.thirdPartyShare)
						]
					]
				: [];
		}),
		[1, 2, 3, 5, 6, 7]
	);
	t['third-party'] = table(
		[
			'navigation',
			'median proxy requests to other hosts',
			'share of proxy requests',
			'median bytes from other origins (direct run)'
		],
		kinds.flatMap(([k, label]) => {
			const w = wire[k];
			const f = lastNav[k];
			return w && f
				? [
						[
							label,
							fixed(w.thirdPartyRequests, 1),
							pct(w.thirdPartyShare),
							fixed(f.medianThirdPartyBytes)
						]
					]
				: [];
		}),
		[1, 2, 3]
	);
	t['zero-network'] = table(
		['registration', 'engine', 'navigations', 'reached the origin', 'paths that did'],
		zeroNetworkFigures(latest(readings, 'zero-network').rows).map((f) => [
			f.arm,
			f.engine,
			fixed(f.views),
			fixed(f.viewsWithHits),
			Object.entries(f.hits)
				.map(([p, n]) => `\`${p}\` x ${n}`)
				.join(', ') || 'none'
		]),
		[2, 3]
	);
	// #endregion

	// #region desktop views
	const views = raplRun(latest(readings, 'rapl', 'views').rows);
	const net = arm(views, 'network');
	const spool = arm(views, 'spool');
	const shipping = arm(views, 'shipping');
	const saved = saving(net, spool);
	v.desktopSaving = fixed(saved, 2);
	v.desktopRounds = fixed(net.windows);
	v.shippingSaving = fixed(saving(shipping, spool), 2);
	const cell = (f: OpFigures) => [
		range(f.joules),
		fixed(f.ms, 1),
		fixed(f.originRequests ?? 0, 2),
		fixed(f.originCpuMs ?? 0, 2),
		fixed(f.windows)
	];
	t['desktop-views'] = table(
		[
			'arm',
			'J per navigation above idle',
			'ms per navigation',
			'origin requests per navigation',
			'origin CPU ms per navigation',
			'rounds'
		],
		[
			['Optimized HTTP caching', ...cell(net)],
			['Spool local view', ...cell(spool)],
			['Demo shipping headers', ...cell(shipping)],
			[
				'Idle package draw (W)',
				range(views.idleWatts, (x) => fixed(x, 2)),
				'',
				'',
				'',
				fixed(views.idleWatts.n)
			]
		],
		[1, 2, 3, 4, 5]
	);
	// #endregion

	// #region phone views
	const burst = phoneRun(latest(readings, 'iphone', 'burst').rows);
	const phoneNet = burst.arms.network;
	const phoneSpool = burst.arms.spool;
	if (!phoneNet || !phoneSpool) throw new Error('the burst reading lacks an arm');
	const phoneProj = phoneRun(latest(readings, 'iphone', 'projection').rows);
	const pj = (k: string) => {
		const found = phoneProj.arms[k];
		if (!found) throw new Error(`the phone projection reading lacks ${k}`);
		return found;
	};
	const phoneSaved = saving(pj('net-baked'), pj('spool-baked'));
	v.phoneSaving = fixed(phoneSaved, 3);
	v.phoneRounds = fixed(pj('net-baked').windows);
	v.phoneSavingBurst = fixed(saving(phoneNet, phoneSpool), 3);
	v.phoneBurstRounds = fixed(phoneNet.windows);
	const phoneRow = (label: string, a: typeof phoneNet) => [
		label,
		range(a.joules),
		fixed(a.viewsPerWindow),
		fixed(a.secondsPerView, 3),
		fixed(a.windows)
	];
	t['phone-views'] = table(
		['arm', 'J per view above idle', 'views per window', 'seconds per view', 'rounds'],
		[
			phoneRow('Network', phoneNet),
			phoneRow('Spool local view', phoneSpool),
			[
				'Idle window (J)',
				range(burst.idle.joules, (x) => fixed(x, 1)),
				'',
				'',
				fixed(burst.idle.joules.n)
			]
		],
		[1, 2, 3, 4]
	);
	const paced = phoneRun(latest(readings, 'iphone', 'paced').rows);
	const pacedViews = Math.max(...Object.values(paced.arms).map((a) => a.viewsPerWindow));
	v.pacedIdleRange = fixed(paced.idle.joules.max - paced.idle.joules.min, 1);
	v.pacedViews = fixed(pacedViews);
	v.pacedSignal = fixed(pacedViews * phoneSaved, 1);
	v.pacedSeconds = fixed(paced.idle.seconds);
	const cellBurst = phoneRun(latest(readings, 'iphone', 'burst-cellular').rows);
	const cellPaced = phoneRun(latest(readings, 'iphone', 'paced-cellular').rows);
	const cellArm = (run: typeof cellBurst, k: string) => {
		const found = run.arms[k];
		if (!found) throw new Error(`a cellular phone reading lacks ${k}`);
		return found;
	};
	v.cellBurstSaving = fixed(
		saving(cellArm(cellBurst, 'network'), cellArm(cellBurst, 'spool')),
		3
	);
	v.cellPacedSaving = fixed(
		saving(cellArm(cellPaced, 'network'), cellArm(cellPaced, 'spool')),
		2
	);
	v.cellPacedSeconds = fixed(
		Number(latest(readings, 'iphone', 'paced-cellular').method['pace s'])
	);
	t['phone-cellular'] = table(
		['reading', 'arm', 'J per view above idle', 'views per window', 'rounds'],
		(
			[
				['Back to back', cellBurst],
				[`One view every ${v.cellPacedSeconds} s`, cellPaced]
			] as const
		).flatMap(([label, run]) =>
			(['network', 'spool'] as const).map((k) => {
				const a = cellArm(run, k);
				return [
					label,
					k === 'network' ? 'Network' : 'Spool local view',
					range(a.joules),
					fixed(a.viewsPerWindow),
					fixed(a.windows)
				];
			})
		),
		[2, 3, 4]
	);
	const radio = phoneRun(latest(readings, 'iphone', 'radio-cellular').rows);
	const request = cellArm(radio, 'request');
	const script = cellArm(radio, 'script');
	v.radioRequest = range(request.joules);
	v.radioScript = range(script.joules);
	v.radioDifference = fixed(saving(request, script), 2);
	v.radioRounds = fixed(request.windows);
	v.radioSeconds = fixed(request.secondsPerView);
	// #endregion

	// #region server runtimes
	const runtimesReading = latest(readings, 'rapl', 'runtimes');
	const runtimes = runtimeRun(runtimesReading.rows);
	const perWindow = Number(runtimesReading.method['views per window']);
	const ARMS: Array<[string, string]> = [
		['network', 'Network view'],
		['spool', 'Spool local view'],
		['curl', 'Bare HTML request (curl)']
	];
	t.runtimes = table(
		[
			'runtime',
			'arm',
			'server J per view above idle',
			'overlay bytes per view',
			'wire bytes per view',
			'origin requests per view',
			'windows'
		],
		Object.entries(runtimes).flatMap(([runtime, arms]) =>
			ARMS.filter(([k]) => arms[k]).map(([k, label]) => {
				const a = arms[k] as (typeof arms)[string];
				return [
					runtime,
					label,
					range(a.joules),
					fixed(a.overlayBytes.median),
					fixed(a.wireBytes.median),
					`${fixed(a.originRequests.median, 2)} (max ${fixed(a.originRequests.max, 2)})`,
					fixed(a.windows)
				];
			})
		),
		[2, 3, 4, 5, 6]
	);
	const spoolArms = Object.values(runtimes).flatMap((arms) => (arms.spool ? [arms.spool] : []));
	v.runtimeFlushRequests = fixed(
		Math.max(...spoolArms.map((a) => a.originRequests.max * perWindow))
	);
	v.runtimeViews = fixed(perWindow);
	const medianJ = (k: string) =>
		Object.values(runtimes).flatMap((arms) => (arms[k] ? [arms[k].joules.median] : []));
	v.runtimeNetworkLow = fixed(Math.min(...medianJ('network')), 2);
	v.runtimeNetworkHigh = fixed(Math.max(...medianJ('network')), 2);
	v.runtimeLocalHigh = fixed(Math.max(...medianJ('spool')), 2);
	v.runtimeCount = fixed(Object.keys(runtimes).length);
	// #endregion

	// #region origin term
	const server = raplRun(latest(readings, 'rapl', 'compute-server').rows);
	v.computeRounds = fixed(arm(server, 'null').windows);
	const pages = raplRun(latest(readings, 'rapl', 'compute-browser').rows);
	const origins: Array<[string, number, string]> = [
		['Modelled origin request (the headline)', ORIGIN_J.conventional.value, 'L1, modelled'],
		['Cache hit', arm(server, 'cms-cache-200').joules.median, 'L1'],
		['CMS render', arm(server, 'cms-recompute-200').joules.median, 'L1'],
		['Analytics page', arm(server, 'ana-recompute-200').joules.median, 'L1']
	];
	const inf = inferenceFigures(latest(readings, 'rapl', 'inference'));
	origins.push(['Local 8B model request', inf.totalJoules.median, 'L1, GPU sampled']);
	t['origin-term'] = table(
		['workload', 'origin J per request', 'label', 'J per local view'],
		origins.map(([name, j, label], i) => [
			name,
			sig(j),
			label,
			i === 0
				? `${fixed(joulesPerView(), 1)} (headline)`
				: fixed(joulesPerViewWithOrigin(j), 1)
		]),
		[1, 3]
	);
	const nullArm = arm(server, 'null');
	const cmsHit = arm(server, 'cms-cache-200');
	const anaHit = arm(server, 'ana-cache-200');
	const cmsRun = arm(server, 'cms-recompute-200');
	const anaRun = arm(server, 'ana-recompute-200');
	v.cmsRenderRatio = fixed(cmsRun.joules.median / cmsHit.joules.median);
	v.analyticsRatio = fixed(anaRun.joules.median / anaHit.joules.median / 1000, 1);
	v.mjPerCpuMs = `${fixed((anaRun.joules.median / (anaRun.serverCpuMs as number)) * 1000, 1)} to ${fixed((cmsRun.joules.median / (cmsRun.serverCpuMs as number)) * 1000, 1)}`;
	const labels: Array<[string, string]> = [
		['null', 'Null route (204)'],
		['cms-recompute-200', 'CMS recompute, 200'],
		['cms-recompute-304', 'CMS recompute, conditional 304'],
		['cms-cache-200', 'CMS server cache, 200'],
		['cms-cache-304', 'CMS server cache, conditional 304'],
		['ana-recompute-200', 'Analytics recompute, 200'],
		['ana-recompute-304', 'Analytics recompute, conditional 304'],
		['ana-cache-200', 'Analytics server cache, 200'],
		['ana-cache-304', 'Analytics server cache, conditional 304']
	];
	t['compute-server'] = table(
		[
			'arm',
			'J per request above idle',
			'server CPU ms',
			'client CPU ms',
			'server-attributed J (L2)'
		],
		labels.map(([k, label]) => {
			const f = arm(server, k);
			return [
				label,
				range(f.joules),
				sig(f.serverCpuMs ?? 0),
				sig(f.clientCpuMs ?? 0),
				range(f.serverJoules ?? f.joules)
			];
		}),
		[1, 2, 3, 4]
	);
	const pageRow = (label: string, kind: 'cms' | 'ana') => {
		const a = arm(pages, `${kind}-recompute`);
		const b = arm(pages, `${kind}-cache`);
		const c = arm(pages, `${kind}-spool`);
		return [
			label,
			range(a.joules),
			range(b.joules),
			range(c.joules),
			sig(saving(a, c)),
			sig(saving(b, c)),
			fixed(a.originCpuMs ?? 0, 1)
		];
	};
	t['compute-pages'] = table(
		[
			'page',
			'recompute (a)',
			'optimized server cache (b)',
			'spool local view (c)',
			'(a) less (c)',
			'(b) less (c)',
			'origin CPU ms per navigation, recompute'
		],
		[pageRow('CMS render', 'cms'), pageRow('Analytics page', 'ana')],
		[1, 2, 3, 4, 5, 6]
	);
	v.cmsIncrement = fixed(saving(arm(pages, 'cms-cache'), arm(pages, 'cms-spool')), 2);
	v.anaIncrement = fixed(saving(arm(pages, 'ana-cache'), arm(pages, 'ana-spool')), 2);
	void nullArm;
	// #endregion

	// #region projection
	const projMeasurement = latest(readings, 'rapl', 'projection');
	const proj = raplRun(projMeasurement.rows);
	const projRows: Array<[string, string]> = [
		['proj-srv-recompute', 'Server computes every navigation'],
		['proj-srv-cache', 'Server cache, same page'],
		['proj-cli-network', 'Projection, records from the HTTP cache, page over the network'],
		['proj-cli-spool', 'Projection, service worker serves page and records'],
		['cms-spool', 'Static local page, no computation']
	];
	t['projection-desktop'] = table(
		[
			'arm',
			'J per navigation above idle',
			'ms per navigation',
			'origin requests per navigation'
		],
		projRows.map(([k, label]) => {
			const f = arm(proj, k);
			return [label, range(f.joules), fixed(f.ms, 1), fixed(f.originRequests ?? 0, 2)];
		}),
		[1, 2, 3]
	);
	const removed = saving(arm(proj, 'proj-srv-recompute'), arm(proj, 'proj-srv-cache'));
	v.projectionRelocationSw = fixed(
		saving(arm(proj, 'proj-cli-spool'), arm(proj, 'cms-spool')),
		2
	);
	v.projectionRelocationNet = fixed(
		saving(arm(proj, 'proj-cli-network'), arm(proj, 'proj-srv-cache')),
		2
	);
	v.projectionServerRemoved = fixed(removed, 2);
	const recordBytes = Number(projMeasurement.method['records bytes']);
	v.recordsMb = fixed(recordBytes / 1e6, 2);
	v.recordsRepay = fixed(Math.round(attributionalJoules(recordBytes) / removed / 10) * 10);
	t['projection-phone'] = table(
		['arm', 'J per view above idle', 'views per window', 'rounds'],
		(
			[
				['net-baked', 'Network fetch of the computed page'],
				['spool-baked', 'Local render of the same page'],
				['spool-proj', 'Local render plus on-device aggregation'],
				['net-proj', 'Network page plus aggregation']
			] as const
		).map(([k, label]) => [
			label,
			range(pj(k).joules),
			fixed(pj(k).viewsPerWindow),
			fixed(pj(k).windows)
		]),
		[1, 2, 3]
	);
	v.phoneProjectionRelocation = fixed(saving(pj('spool-proj'), pj('spool-baked')), 3);
	v.recordRows = fixed(Number(latest(readings, 'iphone', 'projection').method['record rows']));
	// #endregion

	// #region inference
	v.inferenceRounds = fixed(inf.rounds);
	v.inferenceTokens = fixed(inf.outputTokens);
	v.keepWarmWatts = fixed(inf.keepWarmCpuWatts.median + inf.keepWarmGpuWatts.median, 1);
	t.inference = table(
		['quantity', 'median (range)'],
		[
			['CPU package J per request', range(inf.cpuJoules)],
			['GPU board J per request (L1-sampled)', range(inf.gpuJoules)],
			['Total J per request', range(inf.totalJoules)],
			['Latency per request (s)', range(inf.latencyS)],
			['Ollama container CPU per request (ms)', fixed(inf.ollamaCpuMs)],
			['Origin CPU per request (ms)', fixed(inf.originCpuMs, 2)],
			['Resident model, CPU package (W)', range(inf.keepWarmCpuWatts, (x) => fixed(x, 2))],
			['Resident model, GPU board (W)', range(inf.keepWarmGpuWatts, (x) => fixed(x, 2))],
			['Cached copy of the response, J per hit', range(inf.cacheHitJoules)]
		],
		[1]
	);
	// #endregion

	// #region operations
	const kwhPerMillion = (j: number) => fixed((j * 1e6) / 3.6e6, (j * 1e6) / 3.6e6 < 10 ? 2 : 0);
	t.operations = table(
		['avoided operation', 'J per operation (L1)', 'kWh per million operations (L2)'],
		[
			['A CMS render', sig(cmsRun.joules.median), kwhPerMillion(cmsRun.joules.median)],
			['An analytics page', sig(anaRun.joules.median), kwhPerMillion(anaRun.joules.median)],
			[
				'A local 8B model request',
				sig(inf.totalJoules.median),
				kwhPerMillion(inf.totalJoules.median)
			],
			[
				'The transaction alone, against a server cache (CMS page, desktop)',
				v.cmsIncrement as string,
				kwhPerMillion(Number(v.cmsIncrement))
			]
		],
		[1, 2]
	);
	v.analyticsCeiling = sig((SCALE_VIEWS * anaRun.joules.median) / J_PER_MWH);
	v.cmsCeiling = sig((SCALE_VIEWS * cmsRun.joules.median) / 3.6e6);
	// #endregion

	// #region power state
	const power = latest(readings, 'rapl', 'power-state');
	const sweep = powerSweep(power.rows, 'sweep');
	const timer = powerSweep(power.rows, 'timer');
	const cond = (s: typeof sweep, name: string) => {
		const found = s.conditions.find((c) => c.cond === name);
		if (!found) throw new Error(`the power-state reading lacks ${name}`);
		return found;
	};
	t['power-state'] = table(
		[
			'requests per second',
			'steady W above idle',
			'steady mJ per request',
			'bursty W above idle',
			'bursty mJ per request'
		],
		[5, 20, 50, 100, 200, 500, 1000].map((rate) => {
			const s = cond(sweep, `cms-steady-${rate}`);
			const b = cond(sweep, `cms-bursty-${rate}`);
			return [
				fixed(rate),
				range(s.aboveWatts, (x) => fixed(x, 2)),
				range(s.mjPerRequest, (x) => fixed(x, 1)),
				range(b.aboveWatts, (x) => fixed(x, 2)),
				range(b.mjPerRequest, (x) => fixed(x, 1))
			];
		}),
		[0, 1, 2, 3, 4]
	);
	v.fitSteadyLow = fitText(sweep.fits['cms-steady-low'], 'cms-steady-low');
	v.fitBursty = fitText(sweep.fits['cms-bursty'], 'cms-bursty');
	const wake = cond(timer, 'timer-steady-50').mjPerRequest.median;
	const work = cmsRun.joules.median * 1000;
	const high = cond(sweep, 'cms-steady-50').mjPerRequest.median;
	v.timerWake = fixed(wake, 1);
	v.workMj = fixed(work, 1);
	v.wakeLow = fixed(work + wake);
	v.wakeHigh = fixed(high);
	v.powerStateMwh = sig((SCALE_VIEWS * 3 * (high / 1000)) / J_PER_MWH, 2);
	// #endregion

	// #region tiers
	const tiers = Object.entries(TIERS);
	t['views-channel'] = table(
		[
			'tier',
			'Z_annual',
			`attributional, ${fixed(joulesPerView(), 0)} J`,
			`measured desktop, ${v.desktopSaving} J`,
			`measured phone, ${v.phoneSaving} J`
		],
		tiers.map(([k, z]) => [
			tierName(k),
			pct(z),
			`${sig(viewsChannelMWh(SCALE_VIEWS, z))} MWh`,
			`${sig(viewsChannelMWh(SCALE_VIEWS, z, saved))} MWh`,
			`${sig(viewsChannelMWh(SCALE_VIEWS, z, phoneSaved))} MWh`
		]),
		[1, 2, 3, 4]
	);
	t['free-tier'] = table(
		['tier', 'Z_annual', 'views a month on the free plan'],
		tiers.map(([k, z]) => [
			tierName(k),
			pct(z),
			`${fixed(freeTierCeiling(z) / 1e6, 2)}M (from ${fixed(FREE_TIER_VIEWS.value / 1e6, 2)}M)`
		]),
		[1, 2]
	);
	const fleets = [10, 20, 50, 100];
	t.capacity = table(
		['tier', 'peak work cut', ...fleets.map((n) => `${n} servers sized by throughput`)],
		tiers.map(([k, z]) => {
			const cut = peakCut(z);
			return [
				tierName(k),
				pct(cut),
				...fleets.map(
					(n) => `${n - serversAfter(n, cut)} retired, ${sig(capacityMWh(n, cut))} MWh`
				)
			];
		}),
		[1, 2, 3, 4, 5]
	);
	// #endregion

	// #region bandwidth and requests
	const unitOf = (u: string) => u.replace('USD/', '');
	const gbMoved = (host: (typeof HOSTS)[number], views: number) =>
		(views * bytes) / host.bytesPerUnit;
	v.pricesRead = PRICES_READ;
	v.scaleViews = `${fixed(SCALE_VIEWS / 1e6)} million`;
	v.documentKb = fixed(bytes / 1000, 1);
	v.gbPerMillion = fixed((1e6 * bytes) / 1e9, 1);
	v.pantheonOverage = `$${fixed(PANTHEON_OVERAGE.value)}`;
	const topViews = SCALE_VIEWS * TIERS.transformative;
	const costs = HOSTS.map((h) => bandwidthUsd(1e6, h));
	v.perMillionLow = usd(Math.min(...costs));
	v.perMillionHigh = usd(Math.max(...costs));
	v.topWorkedHigh = usd(Math.max(...HOSTS.map((h) => bandwidthUsd(topViews, h))));
	v.topWorkedLow = usd(Math.min(...HOSTS.map((h) => bandwidthUsd(topViews, h))));
	t['host-prices'] = table(
		[
			'host',
			'tier the price is taken from',
			'egress price',
			'free egress a month',
			'request price',
			'label',
			`vendor page, read ${PRICES_READ}`
		],
		HOSTS.map((h) => [
			h.name,
			h.tier,
			`${price(h.egress.value)} per ${unitOf(h.egress.unit)}`,
			h.freeAllowance
				? `${fixed(h.freeAllowance.value)} ${unitOf(h.freeAllowance.unit).replace('/month', '')}`
				: 'no egress charge',
			h.requests ? `${usd(h.requests.value)} per million` : 'not read',
			h.requests ? `${h.egress.layer}, requests ${h.requests.layer}` : h.egress.layer,
			h.page
		])
	);
	t['bandwidth-per-million'] = table(
		['host', 'bytes no longer moved', 'egress', 'requests', 'total'],
		HOSTS.map((h) => [
			h.name,
			`${fixed(gbMoved(h, 1e6), 1)} ${unitOf(h.egress.unit)}`,
			usd(egressUsd(1e6, h)),
			h.requests ? usd(requestUsd(1e6, h)) : 'not read',
			usd(bandwidthUsd(1e6, h))
		]),
		[1, 2, 3, 4]
	);
	t['bandwidth-worked'] = table(
		[
			'host',
			...Object.entries(TIERS).map(
				([k, z]) => `${tierName(k)}, ${fixed((SCALE_VIEWS * z) / 1e6)}M local views`
			)
		],
		HOSTS.map((h) => [
			h.name,
			...Object.values(TIERS).map((z) => `${usd(bandwidthUsd(SCALE_VIEWS * z, h))} a year`)
		]),
		[1, 2, 3]
	);
	t['monthly-gb'] = table(
		[
			'tier',
			'local views a year',
			'local views a month, requests no longer sent',
			'bytes no longer moved, GB a month'
		],
		Object.entries(TIERS).map(([k, z]) => [
			tierName(k),
			`${fixed((SCALE_VIEWS * z) / 1e6)} million`,
			`${fixed((SCALE_VIEWS * z) / 12 / 1e6, 1)} million`,
			fixed(monthlyGb(SCALE_VIEWS * z))
		]),
		[1, 2, 3]
	);
	// #endregion

	void spread;
	void deviceCpuFigures;
	return { values: v, tables: t };
}

/** the page text with every `{{value:name}}` and `{{table:name}}` replaced; an unknown name throws */
export function render(template: string, figures: Figures): string {
	return template.replace(
		/\{\{(value|table):([A-Za-z0-9-]+)\}\}/g,
		(_, kind: 'value' | 'table', name: string) => {
			const found = (kind === 'value' ? figures.values : figures.tables)[name];
			if (found === undefined)
				throw new Error(`the page uses {{${kind}:${name}}} and no figure has that name`);
			return found;
		}
	);
}

/** placeholders in `template` that no figure matches, and figures the template never uses */
export function unusedFigures(template: string, figures: Figures): string[] {
	const used = new Set(
		[...template.matchAll(/\{\{(value|table):([A-Za-z0-9-]+)\}\}/g)].map(
			(m) => `${m[1]}:${m[2]}`
		)
	);
	return [
		...Object.keys(figures.values).map((n) => `value:${n}`),
		...Object.keys(figures.tables).map((n) => `table:${n}`)
	].filter((n) => !used.has(n));
}

/** the formatted `docs/impact.md` for the repository at `root` */
export async function buildImpact(root: string = ROOT): Promise<string> {
	const template = readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const text = render(template, buildFigures(loadReadings(root)));
	const config = (await resolveConfig(join(root, 'docs/impact.md'))) ?? {};
	return format(text, { ...config, filepath: join(root, 'docs/impact.md'), parser: 'markdown' });
}

if (isMain(import.meta.url)) {
	const target = join(ROOT, 'docs/impact.md');
	const built = await buildImpact();
	if (process.argv.includes('--check')) {
		const current = readFileSync(target, 'utf8');
		if (current !== built) {
			console.error('docs/impact.md differs from the readings; run: bun run impact');
			process.exit(1);
		}
		console.log('docs/impact.md matches the readings');
	} else {
		writeFileSync(target, built);
		console.log('docs/impact.md written');
	}
}
