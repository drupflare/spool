import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, zstdCompressSync } from 'node:zlib';
import {
	buildTrimManifest,
	guardPage,
	pageAssets,
	trimKey,
	type Guard,
	type TrimManifest
} from '../../src/trim/index.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';
import { internalLinks, median, nodeResources, pickPages, spread } from './payload';
import { sameOrigin } from './repeat-nav';

const HELP = `Usage: bun scripts/measure/trim.ts [--machine NAME] [--experiment NAME] [--out DIR]
       [--force] [--dry-run] [--sites SUBSTRING[,SUBSTRING]] [--no-screenshots]

Walks the Drupal sites of measurements/payload/2026-10-19.json: the home page, then up to 8
internal pages chosen as payload.ts chooses them. Per page: CSS and JS coverage at load and after
scrolling, aggregate churn, markup bloat and transfer by class. Also prints the warm-internal table
of the repeat-nav requests reading.

--experiment trimmed trims each site's stylesheets against all its pages and scripts (the pages of
measurements/trim/2026-10-19.json) and checks the result: false removals against CDP rule
coverage (Oracle A), full-page pixels against the original CSS with a control (Oracle B),
leave-one-out, and brotli-5 bytes saved.`;

const PAGES_PER_SITE = 8;
const DELAY_MS = 250;
const SETTLE_MS = 1000;
const SCROLL_STEPS = 40;
const DICT_CAP = 1 << 20;
const PAYLOAD = join(MEASUREMENTS_DIR, 'payload', '2026-10-19.json');
const REQUESTS = join(MEASUREMENTS_DIR, 'repeat-nav', '2026-10-19-requests.json');
const CLASSES = new Set(['Document', 'Stylesheet', 'Script', 'Font', 'Image', 'Media']);

export type Span = readonly [start: number, end: number];
export type CountRange = { startOffset: number; endOffset: number; count: number };

/** `url` with the query replaced by its parameter names, values dropped, no fragment */
export function reduceQuery(url: string): string {
	const u = new URL(url);
	const names = [...u.searchParams.keys()];
	u.search = names.length > 0 ? `?${names.join('&')}` : '';
	u.hash = '';
	return u.href;
}

/** 1 at each UTF-16 unit inside the union of `spans` */
export function coverMask(length: number, spans: readonly Span[]): Uint8Array {
	const mask = new Uint8Array(length);
	for (const [start, end] of spans) mask.fill(1, Math.max(0, start), Math.min(length, end));
	return mask;
}

/** V8 block counts: a unit is used when the innermost range covering it ran */
export function blockMask(length: number, ranges: readonly CountRange[]): Uint8Array {
	const mask = new Uint8Array(length);
	const outerFirst = [...ranges].sort(
		(a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset
	);
	for (const r of outerFirst) {
		mask.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(length, r.endOffset));
	}
	return mask;
}

/** the units of `source` whose mask equals `covered`, runs joined in order */
export function maskedText(source: string, mask: Uint8Array, covered: boolean): string {
	const parts: string[] = [];
	let i = 0;
	while (i < mask.length) {
		if ((mask[i] === 1) !== covered) {
			i++;
			continue;
		}
		const start = i;
		while (i < mask.length && (mask[i] === 1) === covered) i++;
		parts.push(source.slice(start, i));
	}
	return parts.join('');
}

/** whether a URL was fetched on an earlier page of the site's run; the key is the full URL */
export function reuseOf(url: string, earlier: ReadonlySet<string>): 'new' | 'reused' {
	return earlier.has(url) ? 'reused' : 'new';
}

/** the report class of a CDP resource type */
export function classOf(type: string): string {
	return CLASSES.has(type) ? type : 'Other';
}

export function brotli5(input: string | Buffer): number {
	if (input.length === 0) return 0;
	return brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
}

/** zstd 3 size of `text` alone and with `dictionary` as a raw dictionary, as payload.ts does */
export function zstdWithDictionary(
	text: Buffer,
	dictionary: Buffer
): { alone: number; dict: number } {
	const params = { [constants.ZSTD_c_compressionLevel]: 3 };
	const alone = zstdCompressSync(text, { params }).length;
	if (dictionary.length === 0) return { alone, dict: alone };
	return { alone, dict: zstdCompressSync(text, { dictionary, params }).length };
}

/** the last DICT_CAP bytes of the texts fetched so far, the most recent content kept */
export function dictionaryOf(texts: ReadonlyMap<string, Buffer>): Buffer {
	const all = Buffer.concat([...texts.values()]);
	return all.length > DICT_CAP ? all.subarray(all.length - DICT_CAP) : all;
}

type BloatRule = {
	name: string;
	pieces: (html: string) => string[];
	strip: (html: string) => string;
};

const cut = (name: string, pattern: RegExp, replacement = ''): BloatRule => ({
	name,
	pieces: (html) => [...html.matchAll(pattern)].map((m) => m[0]),
	strip: (html) => html.replace(pattern, replacement)
});

const HEAD = /<head\b[\s\S]*?<\/head>/i;

const inHead = (name: string, pattern: RegExp): BloatRule => ({
	name,
	pieces: (html) => [...(HEAD.exec(html)?.[0] ?? '').matchAll(pattern)].map((m) => m[0]),
	strip: (html) => html.replace(HEAD, (head) => head.replace(pattern, ''))
});

export const BLOAT_RULES: readonly BloatRule[] = [
	cut(
		'drupal-settings-json',
		/<script\b[^>]*data-drupal-selector=["']drupal-settings-json["'][\s\S]*?<\/script>/gi
	),
	inHead('head-meta-link', /<(?:meta|link)\b[^>]*>/gi),
	cut('data-drupal-attributes', /\sdata-drupal-[\w-]+(?:="[^"]*")?/gi),
	cut('data-history-node-id', /\sdata-history-node-id(?:="[^"]*")?/gi),
	cut('html-comments', /<!--[\s\S]*?-->/g),
	cut('inline-svg', /<svg\b[\s\S]*?<\/svg>/gi),
	cut(
		'inline-script',
		/<script\b(?![^>]*\ssrc\s*=)(?![^>]*drupal-settings-json)[^>]*>[\s\S]*?<\/script>/gi
	),
	cut('inline-style', /<style\b[^>]*>[\s\S]*?<\/style>/gi),
	cut('whitespace-runs', /\s{2,}/g, ' ')
];

export type BloatClass = { count: number; raw: number; br5Alone: number; br5Marginal: number };

/**
 * Bytes of each markup class. `br5Marginal` is the brotli-5 size of the document minus the size
 * of the document with that class removed; classes overlap, so the marginals do not sum.
 */
export function markupBloat(html: string): {
	raw: number;
	br5: number;
	classes: Record<string, BloatClass>;
} {
	const br5 = brotli5(html);
	const classes: Record<string, BloatClass> = {};
	for (const rule of BLOAT_RULES) {
		const pieces = rule.pieces(html);
		classes[rule.name] = {
			count: pieces.length,
			raw: pieces.reduce((sum, p) => sum + Buffer.byteLength(p), 0),
			br5Alone: brotli5(pieces.join('\n')),
			br5Marginal: br5 - brotli5(rule.strip(html))
		};
	}
	return { raw: Buffer.byteLength(html), br5, classes };
}

export type SettingsKey = { key: string; bytes: number; hash: string };
export type Settings = {
	raw: number;
	keysBytes: number;
	varyingBytes: number;
	keys: SettingsKey[];
};

const SETTINGS =
	/<script\b[^>]*data-drupal-selector=["']drupal-settings-json["'][^>]*>([\s\S]*?)<\/script>/i;

/** the top-level keys of the drupal-settings-json script; null without a parseable script */
export function settingsOf(html: string): Settings | null {
	const m = SETTINGS.exec(html);
	if (!m) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(m[1] ?? '');
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const keys = Object.entries(parsed).map(([key, value]) => {
		const json = JSON.stringify(value);
		return {
			key,
			bytes: Buffer.byteLength(json),
			hash: createHash('sha256').update(json).digest('hex').slice(0, 16)
		};
	});
	return {
		raw: Buffer.byteLength(m[1] ?? ''),
		keysBytes: keys.reduce((sum, k) => sum + k.bytes, 0),
		varyingBytes: 0,
		keys
	};
}

/**
 * Per page, the bytes of settings keys that differ between the site's pages: a key varies when
 * its value hash differs across pages or it is missing from some page.
 */
export function settingsVariation(
	pages: ReadonlyArray<readonly SettingsKey[]>
): Array<{ bytes: number; varyingBytes: number }> {
	const hashes = new Map<string, Set<string>>();
	const present = new Map<string, number>();
	for (const page of pages) {
		for (const { key, hash } of page) {
			const set = hashes.get(key) ?? new Set<string>();
			set.add(hash);
			hashes.set(key, set);
			present.set(key, (present.get(key) ?? 0) + 1);
		}
	}
	const varies = (key: string) =>
		(hashes.get(key)?.size ?? 0) > 1 || (present.get(key) ?? 0) < pages.length;
	return pages.map((page) => {
		let bytes = 0;
		let varyingBytes = 0;
		for (const k of page) {
			bytes += k.bytes;
			if (varies(k.key)) varyingBytes += k.bytes;
		}
		return { bytes, varyingBytes };
	});
}

export type WarmNav = {
	kind: string;
	docBytes?: number | null;
	revalidations304?: number;
	cacheHits?: number;
	thirdPartyBytes?: number;
	byType?: Record<string, number>;
};

/**
 * Per site, over its warm-internal navs of the requests reading: median document bytes, totals of
 * 304s, cache hits and third-party bytes, and network bytes by resource type (all origins).
 */
export function warmInternalTable(
	rows: ReadonlyArray<{ site: string; navs: readonly WarmNav[] }>,
	sites: ReadonlySet<string>
) {
	return rows
		.filter((r) => sites.has(r.site))
		.map((r) => {
			const navs = r.navs.filter((n) => n.kind === 'warm-internal');
			const byType: Record<string, number> = {};
			for (const nav of navs) {
				for (const [type, bytes] of Object.entries(nav.byType ?? {})) {
					byType[type] = (byType[type] ?? 0) + bytes;
				}
			}
			const docBytes = navs.flatMap((n) => (n.docBytes == null ? [] : [n.docBytes]));
			return {
				site: r.site,
				navs: navs.length,
				docBytesMedian: median(docBytes),
				revalidations304: sum(navs.map((n) => n.revalidations304 ?? 0)),
				cacheHits: sum(navs.map((n) => n.cacheHits ?? 0)),
				thirdPartyBytes: sum(navs.map((n) => n.thirdPartyBytes ?? 0)),
				byType
			};
		});
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

type Req = { url: string; type: string; status: number; cached: boolean; bytes: number | null };

type FileRow = {
	url: string;
	kind: 'css' | 'js';
	origin: 'same' | 'third';
	reuse: 'new' | 'reused';
	raw: number;
	usedLoad: number;
	usedScroll: number;
	unusedLoadBr5: number;
	transfer: number | null;
};

type Markup = ReturnType<typeof markupBloat> & { settings: Settings | null };

export type PageRow = {
	url: string;
	kind: 'home' | 'internal';
	ok: true | string;
	status: number | null;
	files: FileRow[];
	skipped: number;
	unfinished: number;
	buckets: Record<string, number>;
	newAgg: {
		files: number;
		transfer: number;
		raw: number;
		br5: number;
		zstdAlone: number;
		zstdDict: number;
	};
	markup: Markup | null;
};

export type SiteRow = {
	site: string;
	generator: string | null;
	jsonapi: boolean;
	pages: PageRow[];
	error?: string;
};

type Ctx = {
	page: Page;
	cdp: CDPSession;
	origin: string;
	earlier: Set<string>;
	texts: Map<string, Buffer>;
};

type ScriptCov = { scriptId: string; url: string; functions: Array<{ ranges: CountRange[] }> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMPTY_NEW = { files: 0, transfer: 0, raw: 0, br5: 0, zstdAlone: 0, zstdDict: 0 };

function fileRow(
	kind: FileRow['kind'],
	url: string,
	text: string,
	loadMask: Uint8Array,
	scrollMask: Uint8Array,
	pageOrigin: string,
	earlier: ReadonlySet<string>,
	transfer: number | null
): FileRow {
	return {
		url: reduceQuery(url),
		kind,
		origin: sameOrigin(url, pageOrigin) ? 'same' : 'third',
		reuse: reuseOf(url, earlier),
		raw: Buffer.byteLength(text),
		usedLoad: Buffer.byteLength(maskedText(text, loadMask, true)),
		usedScroll: Buffer.byteLength(maskedText(text, scrollMask, true)),
		unusedLoadBr5: brotli5(maskedText(text, loadMask, false)),
		transfer
	};
}

function transferOf(reqs: ReadonlyMap<string, Req>, url: string): number | null {
	const r = [...reqs.values()].find((x) => x.url === url);
	if (!r) return null;
	return r.bytes ?? (r.cached ? 0 : null);
}

async function takeCss(cdp: CDPSession, used: Map<string, Span[]>) {
	const { coverage } = (await cdp.send('CSS.takeCoverageDelta')) as {
		coverage: Array<{
			styleSheetId: string;
			startOffset: number;
			endOffset: number;
			used: boolean;
		}>;
	};
	for (const c of coverage) {
		if (!c.used) continue;
		const list = used.get(c.styleSheetId) ?? [];
		list.push([c.startOffset, c.endOffset]);
		used.set(c.styleSheetId, list);
	}
}

async function takeJs(cdp: CDPSession): Promise<ScriptCov[]> {
	const { result } = (await cdp.send('Profiler.takePreciseCoverage')) as { result: ScriptCov[] };
	return result;
}

async function cssText(cdp: CDPSession, styleSheetId: string): Promise<string | null> {
	try {
		return ((await cdp.send('CSS.getStyleSheetText', { styleSheetId })) as { text: string })
			.text;
	} catch {
		return null;
	}
}

async function scriptText(cdp: CDPSession, scriptId: string): Promise<string | null> {
	try {
		return (
			(await cdp.send('Debugger.getScriptSource', { scriptId })) as {
				scriptSource: string;
			}
		).scriptSource;
	} catch {
		return null;
	}
}

async function markupOf(cdp: CDPSession, requestId: string | undefined): Promise<Markup | null> {
	if (!requestId) return null;
	try {
		const body = (await cdp.send('Network.getResponseBody', { requestId })) as {
			body: string;
			base64Encoded: boolean;
		};
		const html = body.base64Encoded
			? Buffer.from(body.body, 'base64').toString('utf8')
			: body.body;
		return { ...markupBloat(html), settings: settingsOf(html) };
	} catch {
		return null;
	}
}

async function scrollToEnd(page: Page) {
	await page.evaluate(async (steps) => {
		for (let i = 0; i < steps; i++) {
			const before = window.scrollY;
			window.scrollBy(0, window.innerHeight);
			await new Promise((r) => setTimeout(r, 200));
			if (window.scrollY === before) break;
		}
	}, SCROLL_STEPS);
	await sleep(SETTLE_MS);
}

async function visit(ctx: Ctx, url: string, kind: PageRow['kind']): Promise<PageRow> {
	const { page, cdp } = ctx;
	await sleep(DELAY_MS);
	const reqs = new Map<string, Req>();
	const sheets = new Map<string, string>();
	const cssUsed = new Map<string, Span[]>();
	const onRequest = (e: { requestId: string; request: { url: string }; type?: string }) => {
		reqs.set(e.requestId, {
			url: e.request.url,
			type: e.type ?? 'Other',
			status: 0,
			cached: false,
			bytes: null
		});
	};
	const onResponse = (e: { requestId: string; response: { status: number } }) => {
		const r = reqs.get(e.requestId);
		if (r) r.status = e.response.status;
	};
	const onCached = (e: { requestId: string }) => {
		const r = reqs.get(e.requestId);
		if (r) r.cached = true;
	};
	const onFinished = (e: { requestId: string; encodedDataLength: number }) => {
		const r = reqs.get(e.requestId);
		if (r) r.bytes = e.encodedDataLength;
	};
	const onSheet = (e: { header: { styleSheetId: string; sourceURL: string } }) => {
		if (e.header.sourceURL) sheets.set(e.header.styleSheetId, e.header.sourceURL);
	};
	cdp.on('Network.requestWillBeSent', onRequest);
	cdp.on('Network.responseReceived', onResponse);
	cdp.on('Network.requestServedFromCache', onCached);
	cdp.on('Network.loadingFinished', onFinished);
	cdp.on('CSS.styleSheetAdded', onSheet);
	await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
	await cdp.send('CSS.startRuleUsageTracking');
	const finish = async () => {
		cdp.off('Network.requestWillBeSent', onRequest);
		cdp.off('Network.responseReceived', onResponse);
		cdp.off('Network.requestServedFromCache', onCached);
		cdp.off('Network.loadingFinished', onFinished);
		cdp.off('CSS.styleSheetAdded', onSheet);
		await cdp.send('CSS.stopRuleUsageTracking');
		await cdp.send('Profiler.stopPreciseCoverage');
	};
	let ok: true | string = true;
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
	} catch (error) {
		ok = String(error).slice(0, 160);
	}
	if (ok !== true) {
		await finish();
		return {
			url,
			kind,
			ok,
			status: null,
			files: [],
			skipped: 0,
			unfinished: 0,
			buckets: {},
			newAgg: EMPTY_NEW,
			markup: null
		};
	}

	const docId = [...reqs].find(([, r]) => r.type === 'Document')?.[0];
	const doc = docId ? reqs.get(docId) : undefined;
	const pageOrigin = doc ? new URL(doc.url).origin : ctx.origin;
	await takeCss(cdp, cssUsed);
	const jsAtLoad = await takeJs(cdp);
	const cssAtLoad = structuredClone(cssUsed);
	await scrollToEnd(page);
	await takeCss(cdp, cssUsed);
	const jsAtScroll = await takeJs(cdp);

	const earlierBefore = new Set(ctx.earlier);
	const all: Array<{ url: string; text: string; row: FileRow }> = [];
	let skipped = 0;
	for (const [id, sheetUrl] of sheets) {
		const text = await cssText(cdp, id);
		if (text === null) {
			skipped++;
			continue;
		}
		all.push({
			url: sheetUrl,
			text,
			row: fileRow(
				'css',
				sheetUrl,
				text,
				coverMask(text.length, cssAtLoad.get(id) ?? []),
				coverMask(text.length, cssUsed.get(id) ?? []),
				pageOrigin,
				earlierBefore,
				transferOf(reqs, sheetUrl)
			)
		});
	}
	for (const script of jsAtScroll) {
		if (!script.url) continue;
		const text = await scriptText(cdp, script.scriptId);
		if (text === null) {
			skipped++;
			continue;
		}
		const atLoad = jsAtLoad.find((s) => s.scriptId === script.scriptId);
		const loadMask = blockMask(
			text.length,
			(atLoad?.functions ?? []).flatMap((f) => f.ranges)
		);
		// takePreciseCoverage resets its counts, so the scroll read is a delta to add to the load read
		const scrollMask = blockMask(
			text.length,
			script.functions.flatMap((f) => f.ranges)
		);
		for (let i = 0; i < scrollMask.length; i++) scrollMask[i] = scrollMask[i]! | loadMask[i]!;
		all.push({
			url: script.url,
			text,
			row: fileRow(
				'js',
				script.url,
				text,
				loadMask,
				scrollMask,
				pageOrigin,
				earlierBefore,
				transferOf(reqs, script.url)
			)
		});
	}

	const dictionary = dictionaryOf(ctx.texts);
	const newAgg = { ...EMPTY_NEW };
	for (const { text, row } of all) {
		if (row.origin !== 'same' || row.reuse !== 'new') continue;
		const z = zstdWithDictionary(Buffer.from(text), dictionary);
		newAgg.files++;
		newAgg.transfer += row.transfer ?? 0;
		newAgg.raw += row.raw;
		newAgg.br5 += brotli5(text);
		newAgg.zstdAlone += z.alone;
		newAgg.zstdDict += z.dict;
	}
	for (const { url: fullUrl, text, row } of all) {
		if (row.origin === 'same') ctx.texts.set(fullUrl, Buffer.from(text));
	}

	const buckets: Record<string, number> = {};
	let unfinished = 0;
	for (const r of reqs.values()) {
		if (r.url.startsWith('data:')) continue;
		const bytes = r.bytes ?? (r.cached ? 0 : null);
		if (bytes === null) {
			unfinished++;
			continue;
		}
		const origin = sameOrigin(r.url, pageOrigin) ? 'same' : 'third';
		const key = `${origin}|${classOf(r.type)}|${reuseOf(r.url, earlierBefore)}`;
		buckets[key] = (buckets[key] ?? 0) + bytes;
	}
	for (const r of reqs.values()) ctx.earlier.add(r.url);

	const markup = await markupOf(cdp, docId);
	await finish();
	return {
		url,
		kind,
		ok,
		status: doc?.status ?? null,
		files: all.map((a) => a.row),
		skipped,
		unfinished,
		buckets,
		newAgg,
		markup
	};
}

/** one site: the home page, then the internal pages payload.ts would choose, in one context */
export async function walkSite(context: BrowserContext, site: string): Promise<SiteRow> {
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send('Network.enable');
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	await cdp.send('Profiler.enable');
	await cdp.send('Debugger.enable');
	const origin = new URL(site).origin;
	const ctx: Ctx = { page, cdp, origin, earlier: new Set(), texts: new Map() };
	const pages: PageRow[] = [];
	try {
		const nodes = await nodeResources(origin, []);
		const aliases = new Set((nodes ?? []).flatMap((n) => (n.alias ? [n.alias] : [])));
		pages.push(await visit(ctx, site, 'home'));
		const home = pages[0] as PageRow;
		const html = await page.content();
		const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(
			html
		)?.[1];
		if (home.ok === true) {
			for (const path of pickPages(internalLinks(html, site), aliases, PAGES_PER_SITE)) {
				pages.push(await visit(ctx, `${origin}${path}`, 'internal'));
			}
		}
		const variation = settingsVariation(pages.map((p) => p.markup?.settings?.keys ?? []));
		pages.forEach((p, i) => {
			if (p.markup?.settings)
				p.markup.settings.varyingBytes = variation[i]?.varyingBytes ?? 0;
		});
		await page.close();
		return { site, generator: generator ?? null, jsonapi: nodes !== null, pages };
	} catch (error) {
		await page.close().catch(() => undefined);
		return { site, generator: null, jsonapi: false, pages, error: String(error).slice(0, 200) };
	}
}

const shareOf = (
	files: readonly FileRow[],
	kind: FileRow['kind'],
	field: 'usedLoad' | 'usedScroll'
) => {
	const same = files.filter((f) => f.origin === 'same' && f.kind === kind);
	const total = sum(same.map((f) => f.raw));
	return total > 0 ? sum(same.map((f) => f[field])) / total : null;
};

/** per-site and pooled medians over the pages that loaded */
export function summarise(rows: readonly SiteRow[]) {
	const stat = (xs: Array<number | null>) => spread(xs.filter((x): x is number => x !== null));
	const okPages = (r: SiteRow) => r.pages.filter((p) => p.ok === true);
	const block = (pages: PageRow[]) => {
		const internal = pages.filter((p) => p.kind === 'internal');
		const sameFiles = (files: FileRow[]) => files.filter((f) => f.origin === 'same');
		return {
			pages: pages.length,
			cssUsedLoad: stat(pages.map((p) => shareOf(p.files, 'css', 'usedLoad'))),
			cssUsedScroll: stat(pages.map((p) => shareOf(p.files, 'css', 'usedScroll'))),
			jsUsedLoad: stat(pages.map((p) => shareOf(p.files, 'js', 'usedLoad'))),
			jsUsedScroll: stat(pages.map((p) => shareOf(p.files, 'js', 'usedScroll'))),
			unusedRawPerPage: stat(
				pages.map((p) => sum(sameFiles(p.files).map((f) => f.raw - f.usedLoad)))
			),
			unusedBr5PerPage: stat(
				pages.map((p) => sum(sameFiles(p.files).map((f) => f.unusedLoadBr5)))
			),
			thirdPartyRawPerPage: stat(
				pages.map((p) => sum(p.files.filter((f) => f.origin === 'third').map((f) => f.raw)))
			),
			thirdPartyUsedLoadPerPage: stat(
				pages.map((p) =>
					sum(p.files.filter((f) => f.origin === 'third').map((f) => f.usedLoad))
				)
			),
			newAggTransferPerInternal: stat(internal.map((p) => p.newAgg.transfer)),
			newAggRepeatedShare: stat(
				internal.map((p) =>
					p.newAgg.zstdAlone > 0 ? 1 - p.newAgg.zstdDict / p.newAgg.zstdAlone : null
				)
			),
			settingsRaw: stat(pages.map((p) => p.markup?.settings?.raw ?? null)),
			settingsVaryingShare: stat(
				pages.map((p) => {
					const s = p.markup?.settings;
					return s && s.keysBytes > 0 ? s.varyingBytes / s.keysBytes : null;
				})
			),
			bloatBr5Marginal: Object.fromEntries(
				BLOAT_RULES.map((rule) => [
					rule.name,
					stat(pages.map((p) => p.markup?.classes[rule.name]?.br5Marginal ?? null))
				])
			)
		};
	};
	return {
		sites: rows.map((r) => ({ site: r.site, ...block(okPages(r)) })),
		pooled: block(rows.flatMap(okPages))
	};
}

// #region trimmed experiment

const TRIM_READING = join(MEASUREMENTS_DIR, 'trim', '2026-10-19.json');
const SHOT_STEP_MS = 120;
const SHOT_SETTLE_MS = 600;
const SITE_CONCURRENCY = 3;

/** the text of each rule CDP marked used, from the span the rule occupies in the sheet */
export function usedRuleTexts(text: string, spans: readonly Span[]): string[] {
	const rules = new Set<string>();
	for (const [start, end] of spans) {
		const rule = text.slice(start, end).trim();
		if (rule !== '') rules.add(rule);
	}
	return [...rules];
}

/** the used rules that the trimmed sheet no longer holds: Oracle A's false removals */
export function missingRules(trimmed: string, used: readonly string[]): string[] {
	return used.filter((rule) => !trimmed.includes(rule));
}

/** the selector list of a rule, cut to 160 characters for the report */
export function selectorOf(rule: string): string {
	const open = rule.indexOf('{');
	return rule
		.slice(0, open < 0 ? 160 : open)
		.trim()
		.slice(0, 160);
}

export type FileSize = { raw: number; br5: number; trimmedRaw: number; trimmedBr5: number };

/**
 * Bytes a page saves, counting only the stylesheets that were new to the visit: pages are in visit
 * order, home first. A page the guard fired for gets the full file under another URL, which saves
 * nothing and leaves the trimmed URL unseen.
 */
export function savings(
	pages: ReadonlyArray<{ styles: readonly string[]; guarded: boolean }>,
	sizes: ReadonlyMap<string, FileSize>
) {
	const seen = new Set<string>();
	return pages.map((page) => {
		let files = 0;
		let br5New = 0;
		let br5Saved = 0;
		let rawSaved = 0;
		for (const key of new Set(page.styles)) {
			const size = sizes.get(key);
			const visited = page.guarded ? `${key}|full` : key;
			if (!size || seen.has(visited)) continue;
			seen.add(visited);
			files++;
			br5New += size.br5;
			if (!page.guarded) {
				br5Saved += size.br5 - size.trimmedBr5;
				rawSaved += size.raw - size.trimmedRaw;
			}
		}
		return { newStyleFiles: files, br5New, br5Saved, rawSaved };
	});
}

type PageData = {
	url: string;
	kind: PageRow['kind'];
	/** the HTML the origin sent, which is what the proxy sees */
	html: string;
	/** the DOM at load and after one scroll, which holds markup that scripts added or removed */
	rendered: string[];
	styles: string[];
	scripts: string[];
	foreign: string[];
	used: Map<string, string[]>;
	cdpDiffers: string[];
};

type Assets = {
	styles: Map<string, string>;
	scripts: Map<string, string>;
	foreign: Map<string, string>;
};

/** the same-origin stylesheet and script URLs a page links, by manifest key */
function linked(html: string, url: string) {
	const origin = new URL(url).origin;
	const keys = (list: readonly string[]) => {
		const out = new Map<string, string>();
		for (const href of list) {
			let target: URL;
			try {
				target = new URL(href, url);
			} catch {
				continue;
			}
			if (target.origin === origin) out.set(trimKey(target.href), target.href);
		}
		return out;
	};
	const assets = pageAssets(html);
	return { styles: keys(assets.styles), scripts: keys(assets.scripts) };
}

async function fetchText(context: BrowserContext, url: string): Promise<string | null> {
	try {
		const response = await context.request.get(url, {
			timeout: 30_000,
			failOnStatusCode: false
		});
		return response.ok() ? await response.text() : null;
	} catch {
		return null;
	}
}

/** CDP rule usage for one page at load and after scrolling, as rule texts by stylesheet key */
async function ruleCoverage(
	context: BrowserContext,
	url: string,
	fetched: ReadonlyMap<string, string>
): Promise<{
	used: Map<string, string[]>;
	cdpDiffers: string[];
	foreign: Map<string, string>;
	rendered: string[];
}> {
	const page = await context.newPage();
	const foreign = new Map<string, string>();
	const reads: Array<Promise<void>> = [];
	const origin = new URL(url).origin;
	page.on('response', (response) => {
		if (response.request().resourceType() !== 'script' || response.url().startsWith(origin))
			return;
		reads.push(
			response
				.text()
				.then((text) => void foreign.set(response.url(), text))
				.catch(() => undefined)
		);
	});
	const cdp = await context.newCDPSession(page);
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	const sheets = new Map<string, string>();
	cdp.on('CSS.styleSheetAdded', (e: { header: { styleSheetId: string; sourceURL: string } }) => {
		if (e.header.sourceURL) sheets.set(e.header.styleSheetId, e.header.sourceURL);
	});
	const spans = new Map<string, Span[]>();
	await cdp.send('CSS.startRuleUsageTracking');
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
		await takeCss(cdp, spans);
		const atLoad = await page.content();
		await scrollToEnd(page);
		await takeCss(cdp, spans);
		const rendered = [atLoad, await page.content()];
		const used = new Map<string, string[]>();
		const cdpDiffers: string[] = [];
		for (const [id, source] of sheets) {
			const key = trimKey(source);
			const text = fetched.get(key);
			if (text === undefined) continue;
			const cdpText = await cssText(cdp, id);
			if (cdpText === null) continue;
			if (cdpText !== text) cdpDiffers.push(key);
			const rules = usedRuleTexts(cdpText, spans.get(id) ?? []);
			used.set(key, [...new Set([...(used.get(key) ?? []), ...rules])]);
		}
		await Promise.all(reads);
		return { used, cdpDiffers, foreign, rendered };
	} finally {
		await page.close();
	}
}

async function collectSite(context: BrowserContext, urls: readonly string[]) {
	const assets: Assets = { styles: new Map(), scripts: new Map(), foreign: new Map() };
	const pages: PageData[] = [];
	const failed: string[] = [];
	const origin = new URL(urls[0] as string).origin;
	for (const [i, url] of urls.entries()) {
		await sleep(DELAY_MS);
		const html = await fetchText(context, url);
		if (html === null) {
			failed.push(`${url}: no HTML`);
			continue;
		}
		const found = linked(html, url);
		for (const [kind, map, target] of [
			['styles', found.styles, assets.styles],
			['scripts', found.scripts, assets.scripts]
		] as const) {
			for (const [key, href] of map) {
				if (target.has(key)) continue;
				const text = await fetchText(context, href);
				if (text === null) failed.push(`${href}: no ${kind}`);
				else target.set(key, text);
			}
		}
		try {
			const { used, cdpDiffers, foreign, rendered } = await ruleCoverage(
				context,
				url,
				assets.styles
			);
			for (const [href, text] of foreign) assets.foreign.set(href, text);
			pages.push({
				url,
				kind: i === 0 ? 'home' : 'internal',
				html,
				rendered,
				styles: [...found.styles.keys()].filter((k) => assets.styles.has(k)),
				scripts: [...found.scripts.keys()].filter((k) => assets.scripts.has(k)),
				foreign: [...foreign.keys()],
				used,
				cdpDiffers
			});
		} catch (error) {
			failed.push(`${url}: ${String(error).slice(0, 160)}`);
		}
	}
	return { origin, assets, pages, failed };
}

const manifestOf = (pages: readonly PageData[], assets: Assets) =>
	buildTrimManifest({
		pages: pages.flatMap((p) => [p.html, ...p.rendered]),
		scripts: [...new Set(pages.flatMap((p) => p.scripts))].map((key) => ({
			url: key,
			text: assets.scripts.get(key) as string
		})),
		foreignScripts: [...new Set(pages.flatMap((p) => p.foreign))].map((href) => ({
			url: href,
			text: assets.foreign.get(href) as string
		})),
		styles: [...new Set(pages.flatMap((p) => p.styles))].map((key) => ({
			url: key,
			text: assets.styles.get(key) as string
		}))
	});

/** Oracle A for one page: the used rules of its trimmed stylesheets that the trimmed text lost */
function oracleA(page: PageData, manifest: TrimManifest) {
	let used = 0;
	const lost: Array<{ file: string; selector: string }> = [];
	for (const key of page.styles) {
		const entry = manifest.styles[key];
		const rules = page.used.get(key) ?? [];
		used += rules.length;
		if (!entry) continue;
		for (const rule of missingRules(entry.css, rules))
			lost.push({ file: key, selector: selectorOf(rule) });
	}
	return { used, falseRemovals: lost.length, lost };
}

async function leaveOneOut(pages: readonly PageData[], index: number, assets: Assets) {
	const page = pages[index] as PageData;
	const rest = pages.filter((_, i) => i !== index);
	const manifest = await manifestOf(rest, assets);
	const guard: Guard = guardPage(page.html, manifest, page.url);
	const linkedTrimmed = page.styles.filter((key) => key in manifest.styles).length;
	return {
		trimmedFiles: linkedTrimmed,
		guardFired: guard.fired,
		reason: guard.reason ?? null,
		oracleA: guard.fired || linkedTrimmed === 0 ? null : oracleA(page, manifest)
	};
}

type PixelDiff =
	| { width: number; heightA: number; heightB: number; compared: number; differing: number }
	| { error: string };

async function scrollThrough(page: Page) {
	await page.evaluate(
		async ([steps, step]) => {
			for (let i = 0; i < steps; i++) {
				const before = window.scrollY;
				window.scrollBy(0, window.innerHeight);
				await new Promise((r) => setTimeout(r, step));
				if (window.scrollY === before) break;
			}
			window.scrollTo(0, 0);
		},
		[SCROLL_STEPS, SHOT_STEP_MS] as const
	);
	await sleep(SHOT_SETTLE_MS);
}

/** a full-page PNG of `url`; stylesheets in `trimmed` are answered with the trimmed text */
async function shoot(
	context: BrowserContext,
	url: string,
	trimmed: ReadonlyMap<string, string>
): Promise<{ png: Buffer; fulfilled: number } | string> {
	const page = await context.newPage();
	let fulfilled = 0;
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.route(
			(target) => trimmed.has(trimKey(target.href)) && target.origin === new URL(url).origin,
			(route) => {
				const css = trimmed.get(trimKey(route.request().url()));
				if (css === undefined || route.request().method() !== 'GET')
					return route.continue();
				fulfilled++;
				return route.fulfill({
					status: 200,
					contentType: 'text/css; charset=utf-8',
					body: css
				});
			}
		);
		await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
		await sleep(300);
		await scrollThrough(page);
		const png = await page.screenshot({
			fullPage: true,
			animations: 'disabled',
			caret: 'hide'
		});
		return { png, fulfilled };
	} catch (error) {
		return String(error).slice(0, 160);
	} finally {
		await page.close();
	}
}

/** differing pixels of two PNGs, compared on a canvas in the browser, strip by strip */
async function diffPng(page: Page, a: Buffer, b: Buffer): Promise<PixelDiff> {
	try {
		return await page.evaluate(
			async ([left, right]) => {
				const decode = async (base64: string) =>
					createImageBitmap(
						await (await fetch(`data:image/png;base64,${base64}`)).blob()
					);
				const [x, y] = await Promise.all([decode(left as string), decode(right as string)]);
				const width = Math.min(x.width, y.width);
				const height = Math.min(x.height, y.height);
				const rows = 256;
				const ca = new OffscreenCanvas(width, rows);
				const cb = new OffscreenCanvas(width, rows);
				const ga = ca.getContext('2d') as OffscreenCanvasRenderingContext2D;
				const gb = cb.getContext('2d') as OffscreenCanvasRenderingContext2D;
				let differing = 0;
				for (let top = 0; top < height; top += rows) {
					const h = Math.min(rows, height - top);
					ga.clearRect(0, 0, width, rows);
					gb.clearRect(0, 0, width, rows);
					ga.drawImage(x, 0, top, width, h, 0, 0, width, h);
					gb.drawImage(y, 0, top, width, h, 0, 0, width, h);
					const da = ga.getImageData(0, 0, width, h).data;
					const db = gb.getImageData(0, 0, width, h).data;
					for (let i = 0; i < da.length; i += 4) {
						if (
							da[i] !== db[i] ||
							da[i + 1] !== db[i + 1] ||
							da[i + 2] !== db[i + 2] ||
							da[i + 3] !== db[i + 3]
						) {
							differing++;
						}
					}
				}
				return {
					width,
					heightA: x.height,
					heightB: y.height,
					compared: width * height,
					differing
				};
			},
			[a.toString('base64'), b.toString('base64')] as const
		);
	} catch (error) {
		return { error: String(error).slice(0, 160) };
	}
}

async function oracleB(
	context: BrowserContext,
	diffPage: Page,
	page: PageData,
	manifest: TrimManifest
) {
	const none = new Map<string, string>();
	const trimmed = new Map(
		Object.entries(manifest.styles).map(([key, entry]) => [key, entry.css] as const)
	);
	const first = await shoot(context, page.url, none);
	const control = await shoot(context, page.url, none);
	const arm = await shoot(context, page.url, trimmed);
	for (const [name, shot] of [
		['original', first],
		['control', control],
		['trimmed', arm]
	] as const) {
		if (typeof shot === 'string') return { error: `${name}: ${shot}` };
	}
	const png = (shot: Awaited<ReturnType<typeof shoot>>) => (shot as { png: Buffer }).png;
	return {
		fulfilled: (arm as { fulfilled: number }).fulfilled,
		control: await diffPng(diffPage, png(first), png(control)),
		trimmed: await diffPng(diffPage, png(first), png(arm))
	};
}

export type TrimmedPage = {
	url: string;
	kind: PageRow['kind'];
	htmlBytes: number;
	styles: string[];
	scripts: string[];
	cdpDiffers: string[];
	guard: { fired: boolean; reason: string | null; trimmedFiles: number };
	oracleA: ReturnType<typeof oracleA>;
	oracleB: Awaited<ReturnType<typeof oracleB>> | null;
	leaveOneOut: Awaited<ReturnType<typeof leaveOneOut>> | null;
	saved: ReturnType<typeof savings>[number];
};

export type TrimmedSite = {
	site: string;
	failed: string[];
	files: Array<{ key: string; trimmed: boolean; missing: number } & FileSize>;
	scripts: Array<{ key: string; raw: number }>;
	pages: TrimmedPage[];
};

async function walkTrimmedSite(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	site: string,
	urls: readonly string[],
	shots: boolean
): Promise<TrimmedSite> {
	const version = browser.version();
	const context = await browser.newContext({
		userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 spool-trim-measure/1.0`
	});
	try {
		const { assets, pages, failed } = await collectSite(context, urls);
		const manifest = await manifestOf(pages, assets);
		const sizes = new Map<string, FileSize>();
		const files: TrimmedSite['files'] = [];
		for (const [key, text] of assets.styles) {
			const entry = manifest.styles[key];
			const size: FileSize = {
				raw: Buffer.byteLength(text),
				br5: brotli5(text),
				trimmedRaw: Buffer.byteLength(entry?.css ?? text),
				trimmedBr5: brotli5(entry?.css ?? text)
			};
			sizes.set(key, size);
			files.push({
				key,
				trimmed: entry !== undefined,
				missing: entry?.missing.length ?? 0,
				...size
			});
		}
		const guards = pages.map((p) => guardPage(p.html, manifest, p.url));
		const saved = savings(
			pages.map((p, i) => ({ styles: p.styles, guarded: guards[i]?.fired ?? false })),
			sizes
		);
		const diffPage = await context.newPage();
		await diffPage.goto('about:blank');
		const rows: TrimmedPage[] = [];
		for (const [i, page] of pages.entries()) {
			const guard = guards[i] as Guard;
			const trimmedFiles = page.styles.filter((key) => key in manifest.styles).length;
			rows.push({
				url: page.url,
				kind: page.kind,
				htmlBytes: Buffer.byteLength(page.html),
				styles: page.styles,
				scripts: page.scripts,
				cdpDiffers: page.cdpDiffers,
				guard: { fired: guard.fired, reason: guard.reason ?? null, trimmedFiles },
				oracleA: oracleA(page, manifest),
				oracleB:
					shots && trimmedFiles > 0
						? await oracleB(context, diffPage, page, manifest)
						: null,
				leaveOneOut: page.kind === 'internal' ? await leaveOneOut(pages, i, assets) : null,
				saved: saved[i] as TrimmedPage['saved']
			});
		}
		return {
			site,
			failed,
			files,
			scripts: [...assets.scripts].map(([key, text]) => ({
				key,
				raw: Buffer.byteLength(text)
			})),
			pages: rows
		};
	} finally {
		await context.close();
	}
}

/** the page URLs of each site in the first trim reading, home first, the ones that loaded */
function readingPages(sites: readonly string[]): Map<string, string[]> {
	const reading = JSON.parse(readFileSync(TRIM_READING, 'utf8')) as {
		rows: Array<{ site: string; pages: Array<{ url: string; ok: true | string }> }>;
	};
	return new Map(
		reading.rows
			.filter((r) => sites.includes(r.site))
			.map((r) => [r.site, r.pages.filter((p) => p.ok === true).map((p) => p.url)] as const)
	);
}

async function runTrimmed(sites: string[], shots: boolean): Promise<TrimmedSite[]> {
	const urls = readingPages(sites);
	const browser = await chromium.launch();
	const results = new Map<string, TrimmedSite>();
	const queue = [...sites];
	const worker = async () => {
		for (let site = queue.shift(); site !== undefined; site = queue.shift()) {
			const pages = urls.get(site) ?? [];
			if (pages.length === 0) continue;
			results.set(site, await walkTrimmedSite(browser, site, pages, shots));
			console.error(`done ${site}`);
		}
	};
	await Promise.all(Array.from({ length: SITE_CONCURRENCY }, worker));
	await browser.close();
	return sites.flatMap((site) => results.get(site) ?? []);
}

// #endregion

function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false },
			sites: { type: 'string' },
			'no-screenshots': { type: 'boolean', default: false }
		}
	});
	return {
		machine: values.machine,
		experiment: values.experiment,
		sites: values.sites?.split(','),
		noScreenshots: values['no-screenshots'] as boolean,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

/** the Drupal sites of the payload reading: every site it kept */
function drupalSites(): string[] {
	const payload = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as { rows: Array<{ site: string }> };
	return payload.rows.map((r) => r.site);
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	const sites = drupalSites();
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(
			JSON.stringify(
				{ rig: 'trim', date: utcDate(), sites, pages: PAGES_PER_SITE, out: args.out },
				null,
				2
			)
		);
	} else if (args.experiment === 'trimmed') {
		const chosen = args.sites
			? sites.filter((s) => args.sites?.some((part) => s.includes(part)))
			: sites;
		const rows = await runTrimmed(chosen, !args.noScreenshots);
		const browser = await chromium.launch();
		const version = browser.version();
		await browser.close();
		const draft: Draft = {
			rig: 'trim',
			date: utcDate(),
			layer: 'L1',
			question:
				'what a stylesheet trimmed against a whole site removes by mistake, whether the trimmed pages render the same, whether a page the crawl missed is safe, and how many bytes the trim saves on a first view',
			instrument:
				'Chromium CDP CSS.takeCoverageDelta and CSS.getStyleSheetText; Playwright full-page screenshots with page.route answering the trimmed text, compared pixel by pixel on a canvas; Node zlib brotli 5; src/trim buildTrimManifest and guardPage',
			machine: localMachine(args.machine),
			software: {
				browser: `Chromium ${version}, Playwright bundled build`,
				runtime: `Bun ${process.versions.bun}`,
				node: process.versions.node
			},
			method: {
				pages: 'the pages that loaded in measurements/trim/2026-10-19.json, home first, then the internal pages in that order',
				fetch: 'HTML, stylesheets and scripts through the context request API with the same user agent; stylesheets and scripts are the same-origin files each page links',
				manifest:
					'buildTrimManifest over every page, every linked same-origin script and every linked same-origin stylesheet of the site',
				'oracle A':
					'a rule is used when CDP CSS rule usage marks it used at load or after the scroll; it is a false removal when its text is not in the trimmed stylesheet',
				'oracle B': `three full-page screenshots per page at 1280 px width with reduced motion and animations disabled, after scrolling to the bottom in ${SHOT_STEP_MS} ms steps and back: original, original again (the control) and trimmed; trimmed stylesheets are answered through page.route; differing pixels counted over the common area on a canvas, any channel`,
				'leave-one-out':
					'per internal page, a manifest built from the other pages, their scripts and their stylesheets; the guard is run on the left-out page, and Oracle A when it does not fire',
				saved: 'brotli-5 of each stylesheet before and after; a page counts only the stylesheets new to the visit, home first',
				'site concurrency': `${SITE_CONCURRENCY} sites at once, one context per site, ${DELAY_MS} ms between page visits of a site`
			},
			exclusions: rows.flatMap((r) => r.failed.map((f) => `${r.site}: ${f}`)),
			rows: rows as unknown as Record<string, unknown>[]
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	} else {
		const browser = await chromium.launch();
		const version = browser.version();
		const rows: SiteRow[] = [];
		for (const site of sites) {
			const context = await browser.newContext({
				userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 spool-trim-measure/1.0`
			});
			rows.push(await walkSite(context, site));
			await context.close();
			console.error(site);
		}
		await browser.close();
		const reading = JSON.parse(readFileSync(REQUESTS, 'utf8')) as {
			rows: Array<{ site: string; navs: WarmNav[] }>;
		};
		console.error(JSON.stringify(summarise(rows), null, 2));
		console.error(JSON.stringify(warmInternalTable(reading.rows, new Set(sites)), null, 2));
		const draft: Draft = {
			rig: 'trim',
			date: utcDate(),
			layer: 'L1',
			question:
				'how much of the CSS and JS a Drupal page loads is used at load and after scrolling, how much of a new same-site aggregate repeats bytes the site already served, and how much of the document is markup a local copy would not need to resend',
			instrument:
				'Chromium CDP CSS.takeCoverageDelta, Profiler.takePreciseCoverage, CSS.getStyleSheetText, Debugger.getScriptSource, Network.loadingFinished encodedDataLength; Node zlib brotli 5 and zstd 3 (raw dictionary)',
			machine: localMachine(args.machine),
			software: {
				browser: `Chromium ${version}, Playwright bundled build`,
				runtime: `Bun ${process.versions.bun}`,
				node: process.versions.node
			},
			method: {
				'pages per site': `home plus up to ${PAGES_PER_SITE} internal pages`,
				'page choice':
					'payload.ts: links from the rendered home page, pages with a JSON:API alias first, the rest spread evenly',
				order: 'home first, then the internal pages in choice order, one context and one page per site',
				coverage:
					'CSS: CDP rule usage (takeCoverageDelta) at load and after scrolling, bytes of the rules used; JS: Profiler precise block coverage at load and after scrolling, bytes of the innermost range that ran, the scroll read (a delta, since each take resets the counts) added to the load read; same-origin and third-party files kept apart',
				'coverage key': 'file URL with its query replaced by the parameter names',
				scroll: `scroll one viewport at a time, up to ${SCROLL_STEPS} steps, stop when the page stops moving, wait ${SETTLE_MS} ms, then read the used bytes again`,
				'unused bytes':
					'raw bytes outside the used ranges at load, and brotli-5 of that unused text alone',
				churn: 'a file is reused when its full URL was requested on an earlier page of the site; new same-origin CSS and JS files are compressed alone and with a zstd 3 raw dictionary of the same-origin CSS and JS texts of earlier pages (last 1 MiB)',
				'repeated share':
					'1 - (zstd 3 with dictionary) / (zstd 3 alone), summed over the new files of a page; brotli-5 is reported alone because Node brotli takes no dictionary',
				markup: 'document bytes; each class is the piece list (count, raw bytes, brotli-5 of the pieces together) and the marginal brotli-5 saving of removing it from the document',
				settings:
					'top-level keys of drupal-settings-json; a key varies when its value hash differs across the site pages or it is absent from some page',
				transfer:
					'encodedDataLength per finished request, bucketed by same or third origin, resource type and new or reused URL; requests still open at the end are counted as unfinished',
				'request delay': `${DELAY_MS} ms between page visits; the JSON:API probe uses the payload.ts delay`,
				'warm-internal table':
					'from the repeat-nav requests reading; byType and thirdPartyBytes are all origins, same-origin by type is not in that reading'
			},
			exclusions: rows.flatMap((r) => [
				...(r.error ? [`${r.site}: ${r.error}`] : []),
				...r.pages
					.filter((p) => p.ok !== true)
					.map((p) => `${r.site} ${p.url}: ${String(p.ok)}`)
			]),
			rows: rows as unknown as Record<string, unknown>[]
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	}
}
