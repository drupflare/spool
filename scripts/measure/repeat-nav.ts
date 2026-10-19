import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { parseArgs } from 'node:util';
import {
	MEASUREMENTS_DIR,
	isMain,
	localMachine,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';

/** the sites the 2026-10-18 run visited: public university, government and demo sites */
export const SITES = [
	'https://demo.drupflare.com/',
	'https://www.asu.edu/',
	'https://www.yale.edu/',
	'https://www.colorado.edu/',
	'https://www.ox.ac.uk/',
	'https://www.berkeley.edu/',
	'https://www.cornell.edu/',
	'https://www.uiowa.edu/',
	'https://www.tufts.edu/',
	'https://www.unl.edu/',
	'https://www.georgetown.edu/',
	'https://www.mass.gov/',
	'https://www.ucdavis.edu/',
	'https://www.rutgers.edu/',
	'https://www.harvard.edu/',
	'https://www.mit.edu/'
];

type Seen = {
	url: string;
	type: string;
	bytes: number;
	fromCache: boolean;
	status: number;
	headers?: { cc: string | null; etag: boolean };
};

/** what the browser reports for one navigation: counts, bytes and main-thread time */
export type BrowserNav = {
	url: string;
	ok: true | string;
	wallMs: number;
	requests: number;
	networkRequests: number;
	networkSameOrigin: number;
	revalidations304: number;
	cacheHits: number;
	bytes: number;
	docUrl: string | null;
	docBytes: number | null;
	docStatus: number | null;
	taskMs: number;
	scriptMs: number;
	layoutMs: number;
	thirdPartyBytes: number;
	docHeaders: { cc: string | null; etag: boolean } | null;
	byType: Record<string, number>;
};

/** the origin a navigation's own requests count against: the document's, after any redirect */
export function pageOrigin(url: string, docUrl: string | undefined): string {
	return new URL(docUrl ?? url).origin;
}

/** whether `url` is on `origin` exactly; a prefix test would count `a.edu.cdn.net` as `a.edu` */
export function sameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/** the browser's own count of one navigation, from CDP Network and Performance events */
export async function measureNav(page: Page, cdp: CDPSession, url: string): Promise<BrowserNav> {
	const seen = new Map<string, Seen>();
	const onRequest = (e: { requestId: string; request: { url: string }; type?: string }) => {
		seen.set(e.requestId, {
			url: e.request.url,
			type: e.type ?? 'Other',
			bytes: 0,
			fromCache: false,
			status: 0
		});
	};
	const onResponse = (e: {
		requestId: string;
		type?: string;
		response: {
			status: number;
			fromDiskCache?: boolean;
			fromPrefetchCache?: boolean;
			headers: Record<string, string>;
		};
	}) => {
		const r = seen.get(e.requestId);
		if (!r) return;
		r.status = e.response.status;
		r.fromCache = r.fromCache || !!(e.response.fromDiskCache || e.response.fromPrefetchCache);
		if (e.type === 'Document') {
			const h = e.response.headers;
			r.headers = {
				cc: h['cache-control'] ?? h['Cache-Control'] ?? null,
				etag: !!(h['etag'] ?? h['ETag'])
			};
		}
	};
	const onCache = (e: { requestId: string }) => {
		const r = seen.get(e.requestId);
		if (r) r.fromCache = true;
	};
	const onFinished = (e: { requestId: string; encodedDataLength: number }) => {
		const r = seen.get(e.requestId);
		if (r) r.bytes = e.encodedDataLength;
	};
	cdp.on('Network.requestWillBeSent', onRequest);
	cdp.on('Network.responseReceived', onResponse);
	cdp.on('Network.requestServedFromCache', onCache);
	cdp.on('Network.loadingFinished', onFinished);
	const before = await cdp.send('Performance.getMetrics');
	const t0 = Date.now();
	let ok: true | string = true;
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
		await page.waitForTimeout(2500);
	} catch (error) {
		ok = String(error).slice(0, 120);
	}
	const wallMs = Date.now() - t0;
	const after = await cdp.send('Performance.getMetrics');
	cdp.off('Network.requestWillBeSent', onRequest);
	cdp.off('Network.responseReceived', onResponse);
	cdp.off('Network.requestServedFromCache', onCache);
	cdp.off('Network.loadingFinished', onFinished);
	const metric = (m: typeof before, name: string) =>
		m.metrics.find((x) => x.name === name)?.value ?? 0;
	// a renderer swap resets the counters; the new renderer's absolute value is then the delta
	const delta = (name: string) => {
		const d = metric(after, name) - metric(before, name);
		return Math.round((d >= 0 ? d : metric(after, name)) * 1000);
	};
	const all = [...seen.values()].filter((r) => !r.url.startsWith('data:'));
	const network = all.filter((r) => !r.fromCache);
	const doc = all.find((r) => r.type === 'Document');
	// a redirect re-sends the document under its id, so `doc.url` is where the page landed
	const origin = pageOrigin(url, doc?.url);
	const byType: Record<string, number> = {};
	for (const r of network) byType[r.type] = (byType[r.type] ?? 0) + r.bytes;
	return {
		url,
		ok,
		wallMs,
		requests: all.length,
		networkRequests: network.length,
		networkSameOrigin: network.filter((r) => sameOrigin(r.url, origin)).length,
		revalidations304: network.filter((r) => r.status === 304).length,
		cacheHits: all.length - network.length,
		bytes: network.reduce((s, r) => s + r.bytes, 0),
		docUrl: doc?.url ?? null,
		docBytes: doc?.bytes ?? null,
		docStatus: doc?.status ?? null,
		taskMs: delta('TaskDuration'),
		scriptMs: delta('ScriptDuration'),
		layoutMs: delta('LayoutDuration'),
		thirdPartyBytes: network
			.filter((r) => !sameOrigin(r.url, origin))
			.reduce((s, r) => s + r.bytes, 0),
		docHeaders: doc?.headers ?? null,
		byType
	};
}

/** same-origin links worth visiting from a page: no files, no home, no repeats, resolved absolute */
export async function internalLinks(page: Page, origin: string): Promise<string[]> {
	return page.evaluate((origin) => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const a of document.querySelectorAll('a[href]')) {
			let href: string;
			try {
				href = new URL(a.getAttribute('href') ?? '', location.href).href.split(
					'#'
				)[0] as string;
			} catch {
				continue;
			}
			if (!href.startsWith(origin) || href === `${origin}/` || seen.has(href)) continue;
			if (/\.(pdf|jpg|png|docx?|xlsx?|zip)$/i.test(href)) continue;
			seen.add(href);
			out.push(href);
		}
		return out;
	}, origin);
}

/** what the page's markup says about its platform, from the live document */
export async function platformOf(page: Page): Promise<{
	generator: string | null;
	drupal: boolean;
	wordpress: boolean;
	swRegistered: boolean;
}> {
	const html = await page.content();
	return {
		generator: /<meta[^>]+name="generator"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? null,
		drupal: /drupal-settings-json|Drupal\.settings|\/sites\/default\/files|data-drupal/i.test(
			html
		),
		wordpress: /wp-content|wp-includes/i.test(html),
		swRegistered: await page.evaluate(
			async () =>
				!!(navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()))
		)
	};
}

/** one site's walk: cold home, up to `links` internal pages, then home again */
export async function walkSite(
	context: BrowserContext,
	site: string,
	options: {
		links?: number;
		after?: (kind: string, nav: BrowserNav) => Promise<Record<string, unknown>>;
	} = {}
): Promise<Record<string, unknown>> {
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('Performance.enable');
	const row: Record<string, unknown> = { site, navs: [] };
	const navs = row.navs as Array<Record<string, unknown>>;
	const record = async (kind: string, url: string) => {
		const nav = await measureNav(page, cdp, url);
		navs.push({ kind, ...nav, ...(await options.after?.(kind, nav)) });
	};
	try {
		await record('cold-home', site);
		Object.assign(row, await platformOf(page));
		const links = await internalLinks(page, new URL(site).origin);
		for (const link of links.slice(0, options.links ?? 6)) await record('warm-internal', link);
		await record('warm-home-repeat', site);
	} catch (error) {
		row.error = String(error).slice(0, 200);
	}
	await page.close();
	return row;
}

export const HELP = `usage: bun scripts/measure/repeat-nav.ts [--site URL ...] [--machine NAME] [--experiment NAME] [--out DIR] [--force] [--dry-run]
Walks each site (cold home, internal pages, home again) in Chromium and writes
measurements/repeat-nav/<date>[-<experiment>].json. Defaults to the 16 sites of the first run.`;

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			site: { type: 'string', multiple: true },
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false }
		}
	});
	return {
		sites: values.site?.length ? values.site : SITES,
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(
			JSON.stringify(
				{ rig: 'repeat-nav', date: utcDate(), sites: args.sites, out: args.out },
				null,
				2
			)
		);
	} else {
		const browser = await chromium.launch();
		const rows: Array<Record<string, unknown>> = [];
		for (const site of args.sites) {
			const context = await browser.newContext();
			rows.push(await walkSite(context, site));
			await context.close();
			console.error(site);
		}
		const version = browser.version();
		await browser.close();
		const draft: Draft = {
			rig: 'repeat-nav',
			date: utcDate(),
			layer: 'L1',
			question:
				'bytes and requests of a cold home view, warm internal views and a warm home repeat on public university, government and demo sites',
			instrument:
				'Chrome DevTools Protocol Network and Performance domains (encodedDataLength, fromDiskCache, fromServiceWorker)',
			machine: localMachine(args.machine),
			software: { browser: `Chromium ${version}, Playwright bundled build` },
			method: {
				'views per site': 6,
				order: 'cold home, up to 6 internal links, home repeat',
				network: 'the local network, no emulation',
				sites: args.sites.length
			},
			exclusions: [],
			rows
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	}
}
