import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
	DICTIONARY_ARMS,
	DOCUMENT_BYTES,
	FIRST_VIEW_SHARE,
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
	activityFigures,
	addLevers,
	attributionalJoules,
	bandwidthUsd,
	capacityMWh,
	classifyOrigin,
	coverageFigures,
	crawlLevers,
	dataCentreJoules,
	deviceCpuFigures,
	dictionaryArms,
	egressUsd,
	freeTierCeiling,
	inferenceFigures,
	joulesPerView,
	joulesPerViewWithOrigin,
	lazyUnscrolled,
	ledgerJoules,
	ledgerMWh,
	leverStats,
	median,
	monthlyGb,
	onWireFigures,
	parseMeasurementText,
	peakCut,
	perMillionViewsUsd,
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
	trimFigures,
	trimLevers,
	viewsChannelMWh,
	windowCounts,
	zeroNetworkFigures,
	type ByteSplit,
	type DictionaryArm,
	type Fit,
	type Measurement,
	type OpFigures,
	type OriginClass,
	type Quartiles,
	type Spread,
	type WindowCount
} from '../src/report/index';
import { isMain } from './measure/lib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** the scale every table uses: yearly views, an L3 choice that names no institution */
export const SCALE_VIEWS = 100e6;

const J_PER_MWH = 3.6e9;
const J_PER_KWH = 3.6e6;

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

/**
 * The latest reading of a rig, narrowed to files ending in `-<experiment>` when given, or to the
 * plain `<date>.json` readings when `experiment` is `null`.
 */
export function latest(readings: Readings, rig: string, experiment?: string | null): Measurement {
	const names = [...readings.keys()]
		.filter((n) => n.startsWith(`${rig}/`))
		.filter((n) =>
			experiment === null
				? /\/\d{4}-\d{2}-\d{2}\.json$/.test(n)
				: !experiment || n.endsWith(`-${experiment}.json`)
		)
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

	// #region worker request cost
	const swReading = latest(readings, 'rapl', 'sw-request');
	const sw = raplRun(swReading.rows);
	const swMj = (k: string) => arm(sw, k).joules.median * 1000;
	const mj = (s: Spread): Spread => ({
		...s,
		median: s.median * 1000,
		min: s.min * 1000,
		max: s.max * 1000
	});
	v.swRounds = fixed(arm(sw, 'http-cache').windows);
	v.swRequests = fixed(Number(swReading.method['requests per window']));
	v.swExtra = fixed(swMj('sw-cache') - swMj('http-cache'), 1);
	v.swExtraPct = fixed(((swMj('sw-cache') - swMj('http-cache')) / swMj('http-cache')) * 100);
	v.swVs304 = fixed(swMj('revalidate') - swMj('sw-cache'), 1);
	v.swPassExtra = fixed(swMj('sw-pass') - swMj('http-cache'), 1);
	v.swBreakEven = fixed(
		((swMj('sw-cache') - swMj('http-cache')) / (swMj('revalidate') - swMj('http-cache'))) * 100
	);
	const swLabels: Array<[string, string]> = [
		['http-cache', 'Browser cache (immutable, no worker)'],
		['sw-cache', 'Worker answers from CacheStorage'],
		['sw-pass', 'Worker receives the event and answers nothing'],
		['revalidate', 'Conditional request, 304'],
		['network-200', 'Full 200, no-store']
	];
	t['sw-request'] = table(
		[
			'arm',
			'mJ per request above idle',
			'microseconds per request',
			'origin requests per request'
		],
		swLabels.map(([k, label]) => {
			const f = arm(sw, k);
			return [label, range(mj(f.joules)), fixed(f.ms * 1000), fixed(f.originRequests ?? 0)];
		}),
		[1, 2, 3]
	);
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

	// #region asset trimming
	{
		const trimRun = trimFigures(latest(readings, 'trim', 'trimmed').rows);
		const coverage = coverageFigures(latest(readings, 'trim', null).rows);
		const iqr = (q: Quartiles | null, f: (n: number) => string = sig) =>
			q ? `${f(q.median)} (${f(q.p25)} to ${f(q.p75)})` : 'none';
		const kb = (n: number) => `${fixed(n / 1000, 1)} KB`;
		const host = (site: string) => new URL(site).host;
		const share = (z: number) => `${fixed(z * 100)}%`;
		const firstBytes = trimRun.first.bytes;
		const firstJoules = trimRun.first.joules;
		const kwhPerMillion = (joules: number) => (joules * 1e6) / J_PER_KWH;
		const shares = [
			['low', FIRST_VIEW_SHARE.low.value],
			['central', FIRST_VIEW_SHARE.central.value],
			['high', FIRST_VIEW_SHARE.high.value]
		] as const;
		v.trimSites = fixed(trimRun.sites.length);
		v.trimPages = fixed(trimRun.rules.pages);
		v.trimFiles = fixed(trimRun.files.count);
		v.trimFilesTrimmed = fixed(trimRun.files.trimmed);
		v.trimFirstBytes = kb(firstBytes.median);
		v.trimFirstJoules = sig(firstJoules.median);
		v.trimFirstMeanBytes = kb(firstBytes.mean);
		v.trimFirstMeanJoules = sig(firstJoules.mean);
		v.trimShareLow = share(FIRST_VIEW_SHARE.low.value);
		v.trimShareHigh = share(FIRST_VIEW_SHARE.high.value);
		const checks = {
			rulesUsed: fixed(trimRun.rules.used),
			falseRemovals: fixed(trimRun.rules.falseRemovals),
			renderPages: fixed(trimRun.render.pages),
			renderErrors: fixed(trimRun.render.errors),
			identical: fixed(trimRun.render.identical),
			controlIdentical: fixed(trimRun.render.controlIdentical),
			trimmedOnly: fixed(trimRun.render.trimmedOnly),
			maxPixels: fixed(trimRun.render.maxTrimmed),
			maxControl: fixed(trimRun.render.maxControl),
			looPages: fixed(trimRun.leaveOneOut.pages),
			looFired: fixed(trimRun.leaveOneOut.guardFired),
			looUnguarded: fixed(trimRun.leaveOneOut.unguarded),
			looRules: fixed(trimRun.leaveOneOut.unguardedRules),
			looFalse: fixed(trimRun.leaveOneOut.falseRemovals),
			looFalsePages: fixed(trimRun.leaveOneOut.pagesWithFalseRemovals)
		};
		v.trimCoveragePages = fixed(coverage.pages);
		v.trimJsLoad = share(coverage.jsLoad?.median ?? 0);
		v.trimJsScroll = share(coverage.jsScroll?.median ?? 0);
		v.trimCssLoad = share(coverage.cssLoad?.median ?? 0);
		t['trim-savings'] = table(
			[
				'site',
				'home page, cold: bytes saved',
				'home page, cold: joules',
				'internal pages',
				'first view: bytes saved, median (quartiles)',
				'first view: joules, median (quartiles)',
				'stylesheet bytes removed'
			],
			[
				...trimRun.sites.map((s) => [
					host(s.site),
					s.cold ? kb(s.cold.bytes.median) : 'none',
					s.cold ? sig(s.cold.joules.median) : 'none',
					s.first ? fixed(s.first.bytes.n) : '0',
					s.first ? iqr(s.first.bytes, kb) : 'none',
					s.first ? iqr(s.first.joules) : 'none',
					share(s.fileShare)
				]),
				[
					'**Pooled**',
					iqr(trimRun.cold.bytes, kb),
					iqr(trimRun.cold.joules),
					fixed(firstBytes.n),
					iqr(firstBytes, kb),
					iqr(firstJoules),
					share(1 - trimRun.files.trimmedBr5 / trimRun.files.br5)
				]
			],
			[1, 2, 3, 4, 5, 6]
		);
		t['trim-million'] = table(
			[
				'views counted',
				'bytes saved per view (mean)',
				'joules per view (mean)',
				'joules per million views',
				'kWh per million views',
				'label'
			],
			[
				[
					'cold view of a home page, over the network',
					kb(trimRun.cold.bytes.mean),
					sig(trimRun.cold.joules.mean),
					`${sig(trimRun.cold.joules.mean)} million`,
					sig(kwhPerMillion(trimRun.cold.joules.mean)),
					'L2'
				],
				[
					'first view of an unseen internal page, over the network',
					kb(firstBytes.mean),
					sig(firstJoules.mean),
					`${sig(firstJoules.mean)} million`,
					sig(kwhPerMillion(firstJoules.mean)),
					'L2'
				],
				...shares.map(([name, z]) => [
					`all views, ${share(z)} of them first views of an unseen internal page (${name})`,
					kb(firstBytes.mean * z),
					sig(firstJoules.mean * z),
					`${sig(firstJoules.mean * z)} million`,
					sig(kwhPerMillion(firstJoules.mean * z)),
					'L3'
				])
			],
			[1, 2, 3, 4]
		);
		t['trim-prices'] = table(
			[
				'host',
				'egress price',
				'per million first views',
				...shares.map(([name, z]) => `per million views, ${share(z)} first views (${name})`)
			],
			HOSTS.map((h) => [
				h.name,
				`${price(h.egress.value)} per ${unitOf(h.egress.unit)}`,
				usd(perMillionViewsUsd(firstBytes.mean, 1, h)),
				...shares.map(([, z]) => usd(perMillionViewsUsd(firstBytes.mean, z, h)))
			]),
			[1, 2, 3, 4, 5]
		);
		t['trim-checks'] = table(
			['check', 'what it counts', 'result'],
			[
				[
					'Oracle A, false removals',
					`rules CDP marked used at load or after a scroll, over ${v.trimPages} pages, that the trimmed text lost`,
					`${checks.falseRemovals} of ${checks.rulesUsed} rule uses`
				],
				[
					'Oracle B, render',
					`full-page screenshots of ${checks.renderPages} pages (${checks.renderErrors} failed): the trimmed CSS against the original, and the original against itself as a control`,
					`identical to the pixel on ${checks.identical} pages, and ${checks.controlIdentical} for the control; most differing pixels ${checks.maxPixels} trimmed and ${checks.maxControl} control; trimmed differs and control does not on ${checks.trimmedOnly}`
				],
				[
					'Leave-one-out, guard',
					`internal pages, each against a manifest built without it, where the guard fired`,
					`${checks.looFired} of ${checks.looPages}`
				],
				[
					'Leave-one-out, Oracle A',
					`rules used on the ${checks.looUnguarded} pages the guard let through, that the trimmed text lost`,
					`${checks.looFalse} of ${checks.looRules}, on ${checks.looFalsePages} pages`
				]
			]
		);
		t['trim-coverage'] = table(
			[
				'same-origin files',
				'used at load, median (quartiles)',
				'used after one scroll, median (quartiles)'
			],
			[
				['CSS', iqr(coverage.cssLoad, share), iqr(coverage.cssScroll, share)],
				['JavaScript', iqr(coverage.jsLoad, share), iqr(coverage.jsScroll, share)]
			],
			[1, 2]
		);
	}
	// #endregion

	// #region savings ledger
	{
		const crawl = latest(readings, 'image-crawl', null);
		const crawlLeversList = crawlLevers(crawl.rows);
		const drupalLevers = trimLevers(
			latest(readings, 'trim', 'trimmed').rows,
			latest(readings, 'trim', null).rows
		);
		const lazy = lazyUnscrolled(crawl.rows);
		const kb = (n: number) => `${fixed(n / 1000, 1)} KB`;
		const both = (n: number) => `${kb(n)} (${sig(ledgerJoules(n))} J)`;
		const labels: Record<string, string> = {
			'images-format': 'WebP at native size under the 2560 px ceiling (images)',
			'images-resize': 'Resize to the rendered width, Chromium with hints (images)',
			'video-preload': 'Video preload none, for videos that do not autoplay (video)',
			'video-defer': 'Video autoplay deferred (video, option)',
			embeds: 'YouTube and Vimeo facade, pages with no CSP (embeds, option)',
			'css-trim': 'Trimmed stylesheets (trim, option)',
			'aggregate-dictionary':
				'New aggregates against the text of earlier pages, a ceiling (dictionary)'
		};
		const corpusName = { crawl: 'image-crawl, 16 sites', trim: 'trim, 10 Drupal sites' };
		const rows = [...crawlLeversList, ...drupalLevers].map((l) => {
			const s = leverStats(l.sites, l.bytes);
			return { lever: l, stats: s };
		});
		t['ledger-levers'] = table(
			[
				'Lever',
				'Corpus',
				'Pages with a saving',
				'Median page',
				'Median of pages that save',
				'Median site',
				'Mean'
			],
			rows.map(({ lever, stats }) => [
				labels[lever.id] ?? lever.id,
				corpusName[lever.corpus],
				stats
					? `${fixed((stats.withSaving / stats.pages) * 100)}% of ${stats.pages}`
					: 'none',
				stats ? both(stats.medianPage) : 'none',
				stats?.medianEligible != null ? both(stats.medianEligible) : 'none',
				stats ? both(stats.medianSite) : 'none',
				stats ? both(stats.mean) : 'none'
			]),
			[]
		);
		const built = (lv: typeof crawlLeversList) =>
			addLevers(lv.filter((l) => l.status !== 'max'));
		const maximum = (lv: typeof crawlLeversList) => addLevers(lv);
		const corpora = [
			{
				name: corpusName.crawl,
				today: built(crawlLeversList),
				max: maximum(crawlLeversList)
			},
			{ name: corpusName.trim, today: built(drupalLevers), max: maximum(drupalLevers) }
		];
		const statOf = (
			c: (typeof corpora)[number],
			which: 'medianPage' | 'medianSite' | 'mean'
		) => {
			const today = c.today && leverStats(c.today.sites, c.today.bytes);
			const max = c.max && leverStats(c.max.sites, c.max.bytes);
			return { today: today ? today[which] : 0, max: max ? max[which] : 0 };
		};
		const names = {
			medianPage: 'Median page',
			medianSite: 'Median site',
			mean: 'Mean'
		} as const;
		t['ledger-first-view'] = table(
			['Corpus', 'Figure', 'Built levers', 'With the dictionary ceiling'],
			corpora.flatMap((c) =>
				(['medianPage', 'medianSite', 'mean'] as const).map((which) => {
					const s = statOf(c, which);
					return [c.name, names[which], both(s.today), both(s.max)];
				})
			)
		);
		const shares = [
			['Low', FIRST_VIEW_SHARE.low.value],
			['Central', FIRST_VIEW_SHARE.central.value],
			['High', FIRST_VIEW_SHARE.high.value]
		] as const;
		const mwh = (bytes: number, views: number, share: number) =>
			sig(ledgerMWh(ledgerJoules(bytes), views, share));
		t['ledger-mwh'] = table(
			[
				'Corpus',
				'First-view share (L3)',
				'Figure',
				'Built, 100 million views (MWh)',
				'Ceiling, 100 million views (MWh)',
				'Built, 420 million views (MWh)',
				'Ceiling, 420 million views (MWh)'
			],
			corpora.flatMap((c) =>
				shares.flatMap(([tier, share]) =>
					(['medianPage', 'medianSite', 'mean'] as const).map((which) => {
						const s = statOf(c, which);
						return [
							c.name,
							`${tier}, ${fixed(share * 100)}%`,
							names[which],
							mwh(s.today, 100e6, share),
							mwh(s.max, 100e6, share),
							mwh(s.today, 420e6, share),
							mwh(s.max, 420e6, share)
						];
					})
				)
			),
			[3, 4, 5, 6]
		);
		const whole = Number(v.revisitWholeMedian.replace(/,/g, ''));
		t['ledger-repeat'] = table(
			[
				'Local share of views',
				'Repeat-view ceiling, 100 million views (MWh)',
				'Repeat-view ceiling, 420 million views (MWh)'
			],
			Object.entries(TIERS).map(([name, z]) => [
				`${tierName(name)}, ${fixed(z * 100)}%`,
				mwh(whole, 100e6, z),
				mwh(whole, 420e6, z)
			]),
			[1, 2]
		);
		const total = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
		v.ledgerCrawlSites = fixed(new Set(crawlLeversList[0]?.sites).size);
		v.ledgerCrawlPages = fixed(crawlLeversList[0]?.sites.length ?? 0);
		v.ledgerTrimSites = fixed(new Set(drupalLevers[0]?.sites).size);
		v.ledgerTrimPages = fixed(drupalLevers[0]?.sites.length ?? 0);
		v.ledgerWholeKb = kb(whole);
		v.ledgerWholeJ = sig(ledgerJoules(whole));
		const lazyRuns: Array<{
			label: string;
			skip: number | null;
			rows: ReturnType<typeof latest>['rows'];
		}> = [
			{ label: 'skip 2, first rule', skip: null, rows: crawl.rows },
			...[2, 3, 4].map((skip) => ({
				label: `skip ${skip}`,
				skip,
				rows: latest(readings, 'image-crawl', `lazy-skip${skip}`).rows
			}))
		];
		const profiles = ['desktop', 'phone'] as const;
		t['ledger-lazy'] = table(
			[
				'Rule',
				'Profile',
				'Pages loaded twice',
				'Median page before the first scroll, as sent',
				'With the rewrite',
				'Pages that loaded less',
				'Median of those pages',
				'Pages with an image as the largest element',
				'Rewrite put lazy on that element'
			],
			lazyRuns.flatMap((run) =>
				profiles.map((profile) => {
					const pair = lazyUnscrolled(run.rows, profile);
					const stats = leverStats(pair.sites, pair.bytes);
					return [
						run.label,
						profile === 'phone' ? 'Pixel 7' : 'Desktop, 1440 px',
						fixed(pair.pairs),
						kb(median(pair.baseLoad)),
						kb(median(pair.lazyLoad)),
						`${fixed(((stats?.withSaving ?? 0) / Math.max(1, pair.pairs)) * 100)}%`,
						stats?.medianEligible != null ? kb(stats.medianEligible) : 'none',
						fixed(pair.lcpImagePages),
						fixed(pair.lcpLazyPages)
					];
				})
			),
			[2, 3, 4, 5, 6, 7, 8]
		);
		const tested = lazyRuns.flatMap((run) =>
			run.skip === null
				? []
				: [
						{
							skip: run.skip,
							desktop: lazyUnscrolled(run.rows, 'desktop'),
							phone: lazyUnscrolled(run.rows, 'phone')
						}
					]
		);
		const safe = tested.find((r) => r.desktop.lcpLazyPages === 0 && r.phone.lcpLazyPages === 0);
		const residual = (r: (typeof tested)[number]) =>
			`${r.desktop.lcpLazyPages} of ${r.desktop.lcpImagePages} desktop pages and ${r.phone.lcpLazyPages} of ${r.phone.lcpImagePages} Pixel 7 pages`;
		const lowest = [...tested].sort(
			(a, b) =>
				a.desktop.lcpLazyPages +
				a.phone.lcpLazyPages -
				(b.desktop.lcpLazyPages + b.phone.lcpLazyPages)
		)[0];
		v.lazyVerdict = safe
			? `Skip ${safe.skip} is the lowest value tested with no such page on either profile (${residual(safe)} had an image as the largest element).`
			: `No value of skip tested reached zero on both profiles. Skip ${lowest?.skip} left the fewest, ${lowest ? residual(lowest) : 'none'} with the largest element made lazy, and skip 2 left ${tested[0] ? residual(tested[0]) : 'none'}.`;
		const dict = dictionaryArms(latest(readings, 'dictionary-size', null).rows);
		const armLabels: Record<DictionaryArm, string> = {
			oracle: 'Oracle: the best earlier file of the same kind',
			browser: 'Browser: the latest earlier file of the same directory',
			serverVisit: 'Server base, used once the visit has fetched it',
			serverHeld: 'Server base held from an earlier visit, chosen with the page measured',
			serverOut: 'Server base held from an earlier visit, chosen without the page measured'
		};
		const share = (x: number) => `${fixed(x * 100, 1)}%`;
		t['ledger-dictionary'] = table(
			[
				'Dictionary choice',
				'Coding',
				'Median site, share of brotli 11 bytes saved',
				'All files',
				'Median internal page',
				'Internal pages saving over 5%'
			],
			DICTIONARY_ARMS.flatMap((arm) =>
				(['zstd', 'br'] as const).map((codec) => {
					const s = dict.arms[arm][codec];
					return [
						armLabels[arm],
						codec === 'zstd' ? 'dcz (zstd 19)' : 'dcb (brotli 11)',
						share(s.medianSite),
						share(s.pooled),
						kb(s.medianPageBytes),
						`${s.pagesOver5} of ${s.pages}`
					];
				})
			),
			[2, 3, 4, 5]
		);
		v.dictFiles = fixed(dict.files);
		v.dictSites = fixed(dict.sites);
		v.dictBrowser = share(dict.arms.browser.zstd.medianSite);
		v.dictVisit = share(dict.arms.serverVisit.zstd.medianSite);
		v.dictOut = share(dict.arms.serverOut.zstd.medianSite);
		v.dictHeld = share(dict.arms.serverHeld.zstd.medianSite);
		v.dictOracle = share(dict.arms.oracle.zstd.medianSite);
		void lazy;
	}
	// #endregion

	// #region metered readings
	{
		const scale = (s: Spread, k: number): Spread => ({
			...s,
			median: s.median * k,
			min: s.min * k,
			max: s.max * k
		});
		const windows = (c: WindowCount | undefined): string =>
			c === undefined
				? 'none'
				: `${c.kept} kept, ${c.dropped} dropped${c.idleControl > 0 ? `, ${c.idleControl} more by the idle control` : ''}`;
		const total = (counts: Record<string, WindowCount>, names: string[]): WindowCount =>
			names.reduce<WindowCount>(
				(sum, name) => ({
					kept: sum.kept + (counts[name]?.kept ?? 0),
					dropped: sum.dropped + (counts[name]?.dropped ?? 0),
					idleControl: sum.idleControl + (counts[name]?.idleControl ?? 0)
				}),
				{ kept: 0, dropped: 0, idleControl: 0 }
			);
		const rows: string[][] = [];
		const add = (quantity: string, armName: string, value: string, windowsText: string) =>
			rows.push([quantity, armName, value, windowsText, 'L1']);
		const ratio = (a: number, b: number) => fixed(a / b, 2);

		const viewsReading = latest(readings, 'rapl', 'views');
		add(
			'J saved per local view against optimized HTTP caching',
			'paisley-park desktop, Chromium',
			`${v.desktopSaving} (difference of the arm medians)`,
			windows(total(windowCounts(viewsReading.rows), ['network', 'spool']))
		);
		add(
			'J saved per local view against optimized HTTP caching',
			'iPhone 14 Pro, Wi-Fi, whole-phone counter',
			`${v.phoneSaving} (difference of the arm medians)`,
			`${v.phoneRounds} rounds`
		);

		const decodeReading = latest(readings, 'rapl', 'image-decode');
		const decode = raplRun(decodeReading.rows);
		const decodeCounts = windowCounts(decodeReading.rows);
		const decodeLabel: Record<string, string> = {
			bitmap: '`createImageBitmap`',
			img: '`<img>` at its CSS width'
		};
		for (const method of ['bitmap', 'img']) {
			for (const variant of ['original', 'native', 'resized']) {
				const name = `${method}-${variant}`;
				add(
					'mJ per image decoded above idle',
					`${decodeLabel[method]}, ${variant === 'original' ? 'original JPEG or PNG' : variant === 'native' ? 'WebP at native size' : 'WebP resized to the rendered width'}`,
					range(mj(arm(decode, name).joules), (x) => fixed(x, 1)),
					windows(decodeCounts[name])
				);
			}
		}
		const decodeJ = (name: string) => arm(decode, name).joules.median;
		v.decodeBitmapNative = ratio(decodeJ('bitmap-native'), decodeJ('bitmap-original'));
		v.decodeBitmapResized = ratio(decodeJ('bitmap-resized'), decodeJ('bitmap-original'));
		v.decodeImgNative = ratio(decodeJ('img-native'), decodeJ('img-original'));
		v.decodeImgResized = ratio(decodeJ('img-resized'), decodeJ('img-original'));
		v.decodeImages = fixed(Number(decodeReading.method.images));
		v.decodeRounds = fixed(arm(decode, 'bitmap-original').windows);
		v.decodeImgMs = fixed(arm(decode, 'img-original').ms, 1);
		v.decodeBitmapMs = fixed(arm(decode, 'bitmap-original').ms, 1);
		const against = (name: string) => {
			const a = arm(decode, name).joules;
			const o = arm(decode, 'img-original').joules;
			return a.max < o.min
				? 'below every original window'
				: a.min > o.max
					? 'above every original window'
					: 'its range overlaps the original';
		};
		v.decodeImgNativeText = against('img-native');
		v.decodeImgResizedText = against('img-resized');
		const dropped = (counts: Record<string, WindowCount>) =>
			Object.values(counts).reduce((sum, c) => sum + c.dropped, 0);
		v.decodeDropped = fixed(dropped(decodeCounts));

		const encodeReading = latest(readings, 'rapl', 'image-encode');
		const encode = raplRun(encodeReading.rows);
		const encodeCounts = windowCounts(encodeReading.rows);
		const encodeLabel: Record<string, string> = {
			'warm-native': 'tinyimg 1.1.1, module loaded, native size',
			'warm-resized': 'tinyimg 1.1.1, module loaded, rendered width',
			'cold-native': 'tinyimg 1.1.1, fresh Node process per pass, native size'
		};
		const encodeRow = (name: string) =>
			encodeReading.rows.find((r) => r.arm === name) as Record<string, number>;
		for (const name of ['warm-native', 'warm-resized', 'cold-native']) {
			add(
				'J per conversion to WebP above idle',
				encodeLabel[name] as string,
				range(arm(encode, name).joules, (x) => fixed(x, 2)),
				windows(encodeCounts[name])
			);
		}
		for (const name of ['warm-native', 'warm-resized', 'cold-native']) {
			const r = encodeRow(name);
			add(
				'J per MB of input above idle',
				encodeLabel[name] as string,
				range(
					scale(
						arm(encode, name).joules,
						(r.n as number) / ((r.bytesIn as number) / 1e6)
					),
					(x) => fixed(x, 2)
				),
				windows(encodeCounts[name])
			);
		}
		const encodeJ = (name: string) => arm(encode, name).joules.median;
		v.encodeWarm = fixed(encodeJ('warm-native'), 2);
		v.encodeWarmMs = fixed(arm(encode, 'warm-native').ms);
		v.encodeCold = fixed(encodeJ('cold-native'), 2);
		v.encodeColdOver = fixed(
			((encodeJ('cold-native') - encodeJ('warm-native')) / encodeJ('warm-native')) * 100
		);
		v.encodeResized = fixed(encodeJ('warm-resized'), 2);
		v.encodeImages = fixed(Number(encodeReading.method.images));
		v.encodePerMb = fixed(
			(encodeJ('warm-native') * (encodeRow('warm-native').n as number)) /
				((encodeRow('warm-native').bytesIn as number) / 1e6),
			2
		);
		v.encodeRounds = fixed(arm(encode, 'warm-native').windows);
		v.encodeDropped = fixed(dropped(encodeCounts));

		const activityReading = latest(readings, 'rapl', 'idle-activity');
		const activity = activityFigures(activityReading.rows);
		const activityLabel: Record<string, string> = {
			quiet: 'a quiet visible page',
			poll: 'a page polling a local endpoint once a second',
			raf: 'a requestAnimationFrame loop moving one box'
		};
		const none = 'no reading: every window was dropped';
		if (activity.idleWatts)
			add(
				'package W, no browser running',
				'idle windows of the kept rounds (median per round, then over rounds)',
				range(activity.idleWatts, (x) => fixed(x, 1)),
				windows(activity.counts.idle)
			);
		for (const name of ['quiet', 'poll', 'raf']) {
			const a = activity.arms[name];
			add(
				'package W',
				activityLabel[name] as string,
				a ? range(a.watts, (x) => fixed(x, 1)) : none,
				windows(activity.counts[name])
			);
		}
		for (const name of ['quiet', 'poll', 'raf']) {
			const a = activity.arms[name];
			add(
				'W above the idle of the same round',
				activityLabel[name] as string,
				a ? range(a.extraWatts, (x) => fixed(x, 2)) : none,
				windows(activity.counts[name])
			);
		}
		const extra = (name: string) => activity.arms[name]?.extraWatts.median;
		v.activityPoll =
			extra('poll') === undefined ? 'no reading' : fixed(extra('poll') as number, 2);
		v.activityRaf =
			extra('raf') === undefined ? 'no reading' : fixed(extra('raf') as number, 1);
		v.activityRafMinute =
			extra('raf') === undefined ? 'no reading' : fixed((extra('raf') as number) * 60);
		const activityRounds = Number(activityReading.method.rounds);
		const noisy = activity.noisyRounds.map((r) => r + 1).join(' and ') || 'none';
		const idleWindows = activityReading.rows
			.filter((r) => r.arm === 'idle')
			.map((r) => (r.pkgJ as number) / ((r.elapsedMs as number) / 1000));
		const idleDropped = activity.counts.idle?.dropped ?? 0;

		const quietExtra = activity.arms.quiet?.extraWatts.median;
		v.activityQuietExtra = quietExtra === undefined ? 'no reading' : fixed(quietExtra, 2);
		v.activityRoundsText = `Of ${activityRounds} rounds, ${activityRounds - activity.noisyRounds.length} are kept: in round${activity.noisyRounds.length === 1 ? '' : 's'} ${noisy} (numbered from 1) the three idle windows of the round disagreed by more than 25%. Across the ${idleWindows.length} idle windows of the run the draw ran from ${fixed(Math.min(...idleWindows), 1)} W to ${fixed(Math.max(...idleWindows), 1)} W, and the CPU rule dropped ${idleDropped} of them: other containers' CPU stayed near 15 ms a second throughout. The cause is not established. A second project's build container ran on the box during this run, and the rule could not see a container that started or stopped inside a window. Each activity figure therefore rests on ${activity.arms.poll?.windows ?? 0} windows, one per kept round, and should be re-run on a quiet box before it is quoted beyond this page.`;

		const dictReading = latest(readings, 'rapl', 'dictionary-load');
		const probe = dictReading.rows.find((r) => r.arm === 'negotiation') as Record<
			string,
			unknown
		>;
		const dictWindows = dictReading.rows.filter((r) => r.arm !== 'negotiation');
		const dictRun = raplRun(dictWindows);
		const dictCounts = windowCounts(dictWindows);
		v.dictLoadDropped = fixed(dropped(dictCounts));
		const chromium = String(probe.chromium);
		if (probe.negotiated !== true) {
			v.dictLoadText = `Chromium ${chromium} did not negotiate compression dictionary transport on the box: the origin saw ${probe.withDictionaryHeader} requests with Available-Dictionary and served ${probe.dczServed} dcz responses, so no energy windows were run. That is the reading.`;
		} else {
			const plain = arm(dictRun, 'plain');
			const dict = arm(dictRun, 'dictionary');
			const brotliBytes = probe.targetBrotliBytes as number;
			const dczBytes = probe.targetDczBytes as number;
			for (const [name, f] of [
				['plain', plain],
				['dictionary', dict]
			] as const) {
				add(
					'mJ per page load above idle (one aggregate file)',
					name === 'plain'
						? `brotli 11, ${fixed(brotliBytes)} B on the wire`
						: `dcz against a stored dictionary, ${fixed(dczBytes)} B on the wire`,
					range(mj(f.joules), (x) => fixed(x, 1)),
					windows(dictCounts[name])
				);
			}
			const lower = (1 - dict.joules.median / plain.joules.median) * 100;
			v.dictLoadText = `Chromium ${chromium} negotiates compression dictionary transport on the box: the page's request for the target carried Available-Dictionary, its Accept-Encoding listed dcb and dcz, and the origin answered dcz. The pair is two JavaScript aggregates of one Drupal site, a dictionary of ${fixed(probe.dictBytes as number)} B and a target of ${fixed(probe.targetBytes as number)} B. The target is ${fixed(brotliBytes)} B on the wire as brotli 11 and ${fixed(dczBytes)} B as dcz, ${fixed((1 - dczBytes / brotliBytes) * 100)}% fewer. A page load that fetched the target cost ${fixed(plain.joules.median * 1000, 1)} mJ above idle as brotli and ${fixed(dict.joules.median * 1000, 1)} mJ as dcz, ${fixed(lower)}% lower over ${fixed(dict.windows)} rounds of ${dictReading.method['loads per window']} loads (the dcz arm's range ${dict.joules.max < plain.joules.min ? 'sits below' : 'overlaps'} the brotli arm's). The figure counts the browser's decode and the loopback transfer. It leaves out the network, and the server's encode, which this origin did once at start-up. The pair comes from the churned JavaScript aggregates, where the delta is large, so its byte saving sits above the ${v.dictHeld} that the dictionary-size reading gives at the median site for a base the visitor already holds. One pair in one browser shows that dcz decode costs no more than brotli decode here. It says nothing about how many visitors hold a dictionary.`;
		}

		t['ledger-metered'] = table(
			['Quantity', 'Arm', 'Median (min to max)', 'Windows', 'Layer'],
			rows,
			[2]
		);
	}
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
