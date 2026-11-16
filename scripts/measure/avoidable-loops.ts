import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { loadavg, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LOOP_WINDOW_S, type LoopSecond, type LoopWindow } from '../../src/report/loops.ts';
import { EXTRA_SITES } from './embed-markup.ts';
import { userAgent } from './first-view.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';
import { internalLinks } from './payload.ts';
import { originOf, redactPath, SITES } from './repeat-nav.ts';

const HELP = `Usage: bun scripts/measure/avoidable-loops.ts [--machine NAME] [--experiment NAME] [--out DIR]
       [--force] [--dry-run] [--sites SUBSTRING[,SUBSTRING]]

Loads the home page of each of the 60 public sites of the repeat-nav and embed-markup corpora, and
one inner page, in a fresh browser context per visit. Each visit has a 3 s settle, a 20 s visible
window with no input, then a 20 s hidden window (a second tab in front, the way cdp-hidden.ts makes
one). Per second: rAF callbacks, timer callbacks by delay, JS calls to fetch, XHR, sendBeacon,
WebSocket and EventSource, requests started by origin and type, advancing videos and running infinite
animations. Writes measurements/avoidable-loops/<date>.json. Classes are derived by src/report/loops.ts.`;

const SETTLE_MS = 3000;
const HIDDEN_SWITCH_MS = 500;
const DELAY_MS = 250;
const NAV_TIMEOUT_MS = 45_000;
const READ_TIMEOUT_MS = 4000;
const PROGRESS_MS = 5 * 60_000;
const INNER_CANDIDATES = 5;
const VIEWPORT = { width: 1280, height: 800 };

/** Counts a page's loops and calls from its first script onward. Top document only; no behaviour changes. */
const INIT = `(() => {
	if (window.top !== window) return;
	const counts = { raf: 0, lt100: 0, lt1s: 0, gte1s: 0, fetch: 0, xhr: 0, beacon: 0, websocket: 0, eventSource: 0 };
	const bucket = (delay) => { const ms = Number(delay) || 0; return ms < 100 ? 'lt100' : ms < 1000 ? 'lt1s' : 'gte1s'; };
	const raf = window.requestAnimationFrame;
	window.requestAnimationFrame = (cb) =>
		typeof cb !== 'function' ? raf.call(window, cb) : raf.call(window, (t) => { counts.raf++; return cb(t); });
	for (const name of ['setTimeout', 'setInterval']) {
		const native = window[name];
		window[name] = (cb, delay, ...args) => {
			if (typeof cb !== 'function') return native.call(window, cb, delay, ...args);
			const key = bucket(delay);
			return native.call(window, function (...a) { counts[key]++; return cb.apply(this, a); }, delay, ...args);
		};
	}
	const fetchNative = window.fetch;
	window.fetch = function (...a) { counts.fetch++; return fetchNative.apply(this, a); };
	const send = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.send = function (...a) { counts.xhr++; return send.apply(this, a); };
	const beacon = Navigator.prototype.sendBeacon;
	Navigator.prototype.sendBeacon = function (...a) { counts.beacon++; return beacon.apply(this, a); };
	window.WebSocket = new Proxy(window.WebSocket, { construct(t, a, nt) { counts.websocket++; return Reflect.construct(t, a, nt); } });
	window.EventSource = new Proxy(window.EventSource, { construct(t, a, nt) { counts.eventSource++; return Reflect.construct(t, a, nt); } });
	window.__spoolLoops = () => { const out = { ...counts }; for (const k of Object.keys(counts)) counts[k] = 0; return out; };
})();`;

/** Read once a second: visibility, the counts since the last read, running infinite animations, videos. */
const READ = `(() => {
	const loops = window.__spoolLoops ? window.__spoolLoops() : null;
	const infinite = document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity).length;
	const videos = [...document.querySelectorAll('video')].map((v) => ({ t: v.currentTime, p: v.paused }));
	return { visibility: document.visibilityState, loops, infinite, videos, discarded: document.wasDiscarded === true, href: location.href, ready: document.readyState };
})()`;

type Counts = {
	raf: number;
	lt100: number;
	lt1s: number;
	gte1s: number;
	fetch: number;
	xhr: number;
	beacon: number;
	websocket: number;
	eventSource: number;
};
type Video = { t: number; p: boolean };
type PageRead = {
	visibility: string;
	loops: Counts | null;
	infinite: number;
	videos: Video[];
	discarded: boolean;
	href: string;
	ready: string;
};

/** a page's own origin and the requests its windows started, counted as they arrive */
type Requests = {
	on: boolean;
	origin: string;
	same: Record<string, number>;
	cross: Record<string, number>;
};

export type PageRow = {
	kind: 'page';
	site: string;
	page: string;
	pageKind: 'home' | 'internal';
	attempts: 1 | 2;
	ok: true | string;
	docStatus: number | null;
	visible: LoopWindow | null;
	hidden: LoopWindow | null;
};

/** `https://site/` plus the first path segment, token-like segments redacted; never a query or a full path */
export function pageLabel(url: string): string {
	try {
		const u = new URL(url);
		return `${u.origin}/${redactPath(u.pathname).split('/')[1] ?? ''}`;
	} catch {
		return '';
	}
}

/** an error message with every URL in it cut to its {@link pageLabel} */
export function redactUrls(text: string): string {
	return text.replace(/https?:\/\/[^\s'")]+/g, (url) => pageLabel(url)).slice(0, 160);
}

/** the corpus: the repeat-nav sites and the embed-markup extras, once each, filtered by substring */
export function corpus(filter: string[] | null): string[] {
	const all = [...new Set([...SITES, ...EXTRA_SITES])];
	return all.filter((site) => !filter || filter.some((part) => site.includes(part)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await sleep(50);
	}
	return true;
}

type Listener = (params: Record<string, unknown>) => void;

/** the subset of the Chrome DevTools Protocol this rig uses, over one WebSocket */
class Cdp {
	private next = 0;
	private waiting = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (e: Error) => void }
	>();
	private listeners = new Map<string, Listener[]>();
	private socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: Record<string, unknown>;
				sessionId?: string;
			};
			if (message.id !== undefined) {
				const call = this.waiting.get(message.id);
				this.waiting.delete(message.id);
				if (message.error) call?.reject(new Error(message.error.message));
				else call?.resolve(message.result);
				return;
			}
			if (!message.method) return;
			for (const fn of this.listeners.get(`${message.sessionId ?? ''} ${message.method}`) ??
				[]) {
				fn(message.params ?? {});
			}
		};
	}

	static connect(url: string): Promise<Cdp> {
		const socket = new WebSocket(url);
		return new Promise((resolve, reject) => {
			socket.onopen = () => resolve(new Cdp(socket));
			socket.onerror = () => reject(new Error('the debugging socket did not open'));
		});
	}

	send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.socket.send(
				JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })
			);
		});
	}

	on(sessionId: string, method: string, fn: Listener): void {
		const key = `${sessionId} ${method}`;
		this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn]);
	}

	close(): void {
		this.socket.close();
	}
}

/** a headed Chromium with a debugging port, launched the way cdp-hidden.ts launches it */
export async function launch(exe: string): Promise<{ cdp: Cdp; child: ChildProcess }> {
	const dir = mkdtempSync(join(tmpdir(), 'spool-loops-'));
	const child = spawn(
		exe,
		[
			'--remote-debugging-port=0',
			`--user-data-dir=${dir}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--no-sandbox',
			'--disable-gpu',
			'--disable-dev-shm-usage',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	let exited = false;
	child.on('exit', () => (exited = true));
	let endpoint = '';
	for (let i = 0; i < 100 && !endpoint; i++) {
		if (exited) throw new Error('the browser exited before it opened a debugging port');
		try {
			const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
			if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
		} catch {
			await sleep(100);
		}
	}
	if (!endpoint) {
		child.kill();
		throw new Error('the browser did not report a debugging port in 10 s');
	}
	return { cdp: await Cdp.connect(endpoint), child };
}

async function pageRead(cdp: Cdp, session: string): Promise<PageRead | null> {
	try {
		const out = await Promise.race([
			cdp.send<{ result?: { value?: PageRead }; exceptionDetails?: unknown }>(
				'Runtime.evaluate',
				{ expression: READ, returnByValue: true },
				session
			),
			sleep(READ_TIMEOUT_MS).then(() => null)
		]);
		return out && !out.exceptionDetails ? (out.result?.value ?? null) : null;
	} catch {
		return null;
	}
}

/** the requests counted since the last call, and the counter reset */
function takeRequests(acc: Requests): {
	same: Record<string, number>;
	cross: Record<string, number>;
} {
	const out = { same: acc.same, cross: acc.cross };
	acc.same = {};
	acc.cross = {};
	return out;
}

const EMPTY_COUNTS: Counts = {
	raf: 0,
	lt100: 0,
	lt1s: 0,
	gte1s: 0,
	fetch: 0,
	xhr: 0,
	beacon: 0,
	websocket: 0,
	eventSource: 0
};

/** one window of LOOP_WINDOW_S seconds, each second read from the page as the second ends */
async function sampleWindow(
	cdp: Cdp,
	session: string,
	acc: Requests,
	front: string | null
): Promise<LoopWindow> {
	acc.on = true;
	const first = await pageRead(cdp, session);
	takeRequests(acc);
	let before = first?.videos ?? [];
	const firstHref = first?.href ?? '';
	const seconds: LoopSecond[] = [];
	const start = Date.now();
	for (let i = 1; i <= LOOP_WINDOW_S; i++) {
		await sleep(start + i * 1000 - Date.now());
		if (front !== null)
			await cdp.send('Target.activateTarget', { targetId: front }).catch(() => undefined);
		const read = await pageRead(cdp, session);
		const requests = takeRequests(acc);
		const counts = read?.loops ?? EMPTY_COUNTS;
		const videos = read?.videos ?? [];
		const videoAdvancing = videos.filter((v, j) => {
			const prior = before[j];
			return prior !== undefined && !prior.p && !v.p && v.t > prior.t;
		}).length;
		seconds.push({
			visibility: read?.visibility ?? 'unread',
			raf: counts.raf,
			timers: { lt100: counts.lt100, lt1s: counts.lt1s, gte1s: counts.gte1s },
			calls: {
				fetch: counts.fetch,
				xhr: counts.xhr,
				beacon: counts.beacon,
				websocket: counts.websocket,
				eventSource: counts.eventSource
			},
			requests,
			videoAdvancing,
			infiniteAnimations: read?.infinite ?? 0,
			state: {
				discarded: read?.discarded ?? false,
				ready: read?.ready ?? 'unread',
				moved: (read?.href ?? firstHref) !== firstHref
			}
		});
		before = videos;
	}
	acc.on = false;
	return { seconds };
}

/** one visit in a fresh browser context: load, settle, visible window, second tab in front, hidden window */
export async function measure(
	cdp: Cdp,
	context: string,
	url: string
): Promise<{ docStatus: number | null; visible: LoopWindow; hidden: LoopWindow; landed: string }> {
	const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
		url: 'about:blank',
		browserContextId: context,
		newWindow: true,
		...VIEWPORT
	});
	await cdp.send('Target.activateTarget', { targetId });
	const { sessionId: session } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
		targetId,
		flatten: true
	});
	const acc: Requests = { on: false, origin: '', same: {}, cross: {} };
	const state = { mainFrame: '', docStatus: null as number | null, loads: new Set<string>() };
	await cdp.send('Page.enable', {}, session);
	await cdp.send('Network.enable', {}, session);
	await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, session);
	await cdp.send(
		'Emulation.setDeviceMetricsOverride',
		{ ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
		session
	);
	await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT }, session);
	const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>(
		'Page.getFrameTree',
		{},
		session
	);
	state.mainFrame = tree.frameTree.frame.id;
	cdp.on(session, 'Network.requestWillBeSent', (params) => {
		if (!acc.on) return;
		const request = params.request as { url: string };
		if (/^(data|blob):/.test(request.url)) return;
		const bucket = originOf(request.url) === acc.origin ? acc.same : acc.cross;
		const type = String(params.type ?? 'Other');
		bucket[type] = (bucket[type] ?? 0) + 1;
	});
	cdp.on(session, 'Network.responseReceived', (params) => {
		if (params.type === 'Document' && params.frameId === state.mainFrame) {
			state.docStatus = (params.response as { status: number }).status;
		}
	});
	cdp.on(session, 'Page.lifecycleEvent', (params) => {
		if (params.name === 'load' && params.frameId === state.mainFrame) {
			state.loads.add(String(params.loaderId));
		}
	});
	const nav = await cdp.send<{ loaderId?: string; errorText?: string }>(
		'Page.navigate',
		{ url },
		session
	);
	if (nav.errorText) throw new Error(nav.errorText);
	const loaded = await waitUntil(() => state.loads.has(String(nav.loaderId)), NAV_TIMEOUT_MS);
	if (!loaded) throw new Error('load timeout');
	if (state.docStatus !== null && state.docStatus >= 400)
		throw new Error(`HTTP ${state.docStatus}`);
	const landed = (
		await cdp.send<{ result: { value: string } }>(
			'Runtime.evaluate',
			{ expression: 'location.href', returnByValue: true },
			session
		)
	).result.value;
	acc.origin = originOf(landed);
	await sleep(SETTLE_MS);
	const visible = await sampleWindow(cdp, session, acc, targetId);
	const tab = await cdp.send<{ targetId: string }>('Target.createTarget', {
		url: 'about:blank',
		browserContextId: context,
		newWindow: false
	});
	await cdp.send('Target.activateTarget', { targetId: tab.targetId });
	await sleep(HIDDEN_SWITCH_MS);
	const hidden = await sampleWindow(cdp, session, acc, null);
	return { docStatus: state.docStatus, visible, hidden, landed };
}

/** one attempt at a URL; a failure becomes an error row, never a throw */
async function attempt(
	cdp: Cdp,
	site: string,
	url: string,
	pageKind: PageRow['pageKind'],
	tries: 1 | 2
): Promise<PageRow> {
	const { browserContextId } = await cdp.send<{ browserContextId: string }>(
		'Target.createBrowserContext',
		{}
	);
	try {
		const done = await measure(cdp, browserContextId, url);
		return {
			kind: 'page',
			site: originOf(site),
			page: pageLabel(done.landed),
			pageKind,
			attempts: tries,
			ok: true,
			docStatus: done.docStatus,
			visible: done.visible,
			hidden: done.hidden
		};
	} catch (error) {
		return {
			kind: 'page',
			site: originOf(site),
			page: pageLabel(url),
			pageKind,
			attempts: tries,
			ok: redactUrls(String(error)),
			docStatus: null,
			visible: null,
			hidden: null
		};
	} finally {
		await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => undefined);
	}
}

/** a page with one retry on failure; never a second retry */
async function visitPage(
	cdp: Cdp,
	site: string,
	url: string,
	pageKind: PageRow['pageKind']
): Promise<PageRow> {
	await sleep(DELAY_MS);
	const first = await attempt(cdp, site, url, pageKind, 1);
	if (first.ok === true) return first;
	return attempt(cdp, site, url, pageKind, 2);
}

/** the home page, then the first of the first five internal links that loads; a home page that fails stops the walk */
async function walkSite(
	cdp: Cdp,
	ua: string,
	site: string,
	count: { attempted: number; failed: number }
): Promise<PageRow[]> {
	const rows: PageRow[] = [];
	const home = await visitPage(cdp, site, site, 'home');
	rows.push(home);
	count.attempted += home.attempts;
	count.failed += home.ok === true ? 0 : 1;
	if (home.ok !== true) return rows;
	let html = '';
	try {
		const res = await fetch(site, {
			headers: { 'user-agent': ua },
			redirect: 'follow',
			signal: AbortSignal.timeout(30_000)
		});
		html = res.ok ? await res.text() : '';
	} catch {
		html = '';
	}
	const candidates = internalLinks(html, site)
		.slice(0, INNER_CANDIDATES)
		.map((path) => new URL(path, site).href);
	for (const url of candidates) {
		const inner = await visitPage(cdp, site, url, 'internal');
		rows.push(inner);
		count.attempted += inner.attempts;
		count.failed += inner.ok === true ? 0 : 1;
		if (inner.ok === true) break;
	}
	return rows;
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false },
			sites: { type: 'string' }
		}
	});
	return {
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean,
		sites: values.sites?.split(',') ?? null
	};
}

/** what a dry run prints: the corpus and the file a real run writes */
export function plan(args: ReturnType<typeof parse>) {
	const sites = corpus(args.sites);
	return {
		rig: 'avoidable-loops',
		date: utcDate(),
		sites: sites.length,
		plannedPages: sites.length * 2,
		windows: { settleMs: SETTLE_MS, seconds: LOOP_WINDOW_S, hiddenSwitchMs: HIDDEN_SWITCH_MS },
		output: `measurements/avoidable-loops/${utcDate()}${args.experiment ? `-${args.experiment}` : ''}.json`
	};
}

async function run(args: ReturnType<typeof parse>): Promise<void> {
	const sites = corpus(args.sites);
	const { cdp, child } = await launch(chromium.executablePath());
	const { product } = await cdp.send<{ product: string }>('Browser.getVersion');
	const ua = userAgent(product.replace(/^[^/]+\//, ''));
	const count = { attempted: 0, failed: 0 };
	const started = Date.now();
	const uptimeStart = uptime();
	const loadStart = loadavg();
	const progress = setInterval(() => {
		const minutes = (Date.now() - started) / 60_000;
		console.error(
			`progress: ${count.attempted} page visits of ${sites.length * 2} planned, ${(count.attempted / minutes).toFixed(1)} a minute, ${count.failed} failed, ${minutes.toFixed(1)} min`
		);
	}, PROGRESS_MS);
	const rows: PageRow[] = [];
	try {
		for (const site of sites) {
			rows.push(...(await walkSite(cdp, ua, site, count)));
			console.error(`done ${site}`);
		}
	} finally {
		clearInterval(progress);
		cdp.close();
		child.kill();
	}
	const uptimeEnd = uptime();
	const loadEnd = loadavg();
	const draft: Draft = {
		rig: 'avoidable-loops',
		date: utcDate(),
		layer: 'L1',
		question:
			'how many fresh page loads of 60 public sites carry a loop that runs while the page is visible or hidden: a frame loop, a timer loop, a request every few seconds, a video that plays with no input, or an infinite CSS animation; the raw per-second counts behind each',
		instrument: `Chromium ${product} (the build @playwright/test bundles), driven over the Chrome DevTools Protocol with the launch of scripts/measure/cdp-hidden.ts; the page-side counters are installed before the first script and read once a second; the Network domain counts requests started in each window`,
		machine: localMachine(args.machine),
		software: {
			browser: `${product}, bundled with @playwright/test, driven over raw CDP`,
			runtime: `Bun ${process.versions.bun}`
		},
		method: {
			sites: sites.length,
			pages: 'the home page of each site, then the first of the first five internal links that loads (the rule of first-view.ts); the links come from the server HTML of the home page, fetched once with a plain GET',
			context:
				'a fresh browser context per visit: no cookies, no storage, no service worker registered by spool; viewport 1280 by 800; one window at a time, visits in sequence',
			windows: {
				settleMs: SETTLE_MS,
				seconds: LOOP_WINDOW_S,
				visible: 'no input',
				hidden: 'a second tab created and activated in the same window (Target.createTarget with newWindow false, Target.activateTarget), the mechanism of cdp-hidden.ts'
			},
			seconds:
				'each second is the interval between two reads of the page; the first read of a window discards the counts before it',
			validity:
				'a window counts when the page reported the expected visibility in at least 18 of its 20 seconds; otherwise the classes that need it are null',
			thresholds: {
				visibleFrameCallbacksPerS: 20,
				hiddenFrameCallbacksPerS: 1,
				timerDelayFloorMs: 1000,
				neededSeconds: 15,
				pollRequests: 3
			},
			classes: {
				'visible-frame-loop':
					'rAF callbacks at least 20 a second on at least 15 of the 20 visible seconds',
				'hidden-frame-loop':
					'rAF callbacks at least 1 a second on at least 15 of the 20 hidden seconds',
				'hidden-timer-loop':
					'timer callbacks, registered at 1000 ms or more, at least 1 a second on at least 15 of the 20 hidden seconds; timers under 1000 ms are left out, because a hidden tab clamps them to 1 Hz',
				poll: 'at least 3 requests started during the 20 visible seconds, any type, origin or frame',
				autoplay:
					'a visible second in which a top-document video advanced and was not paused',
				'css-animation': 'a visible second with a running animation of infinite iterations',
				any: 'at least one of the six classes above; null when none holds and one is unmeasured',
				'hidden-timer-any':
					'a separate class: timer callbacks of any delay, at least 1 a second on at least 15 of the 20 hidden seconds; includes the browser clamp'
			},
			retry: 'a visit that fails, or whose document answers 400 or more, is retried once in a fresh context; a second failure is recorded',
			unit: 'a share of pages loaded fresh (one visit each), not a share of page views and not weighted by traffic',
			javascript:
				'counts of rAF, timers, fetch, XHR, sendBeacon, WebSocket and EventSource calls are for the top document only; requests cover every frame',
			storage:
				'the site is an origin; a page is its origin and first path segment; no query, fragment, request URL or response body is stored',
			pacing: `${DELAY_MS} ms after each visit, one browser`,
			uptime: {
				startS: uptimeStart,
				endS: uptimeEnd,
				loadavgStart: loadStart,
				loadavgEnd: loadEnd
			}
		},
		exclusions: [
			...rows
				.filter((r) => r.ok !== true)
				.map(
					(r) =>
						`${r.site} ${r.page} (${r.pageKind}, ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}): ${String(r.ok)}`
				),
			...sites
				.filter(
					(site) =>
						!rows.some((r) => r.site === originOf(site) && r.pageKind === 'internal')
				)
				.map((site) => `${originOf(site)}: no inner page loaded`),
			'a window whose page reported the expected visibility in fewer than 18 of 20 seconds is kept; the derivation leaves the classes that need it out'
		],
		rows: rows as unknown as Record<string, unknown>[]
	};
	console.log(
		writeMeasurement(args.out, draft, { experiment: args.experiment, overwrite: args.force })
	);
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(JSON.stringify(plan(args), null, 2));
	} else {
		await run(args);
	}
}
