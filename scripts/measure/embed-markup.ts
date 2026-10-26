import { parseArgs } from 'node:util';
import { commentRanges, noscriptRanges, within } from '../../src/media/html.ts';
import { attr, decodeEntities, tagsOf, type Tag } from '../../src/trim/tokens.ts';
import type { Draft } from './lib.ts';
import { isMain, localMachine, MEASUREMENTS_DIR, utcDate, writeMeasurement } from './lib.ts';
import { internalLinks, pickPages } from './payload.ts';
import { redactPath, SITES } from './repeat-nav.ts';

const HELP = `Usage: bun scripts/measure/embed-markup.ts [--sites SUBSTRING[,..]] [--pages N]
       [--machine NAME] [--experiment NAME] [--out DIR] [--force] [--dry-run]

Fetches each site's home page and up to N internal pages (default 4) with plain GETs and writes the
embed markup of each page: iframes, videos, provider scripts, and provider names found in inline
scripts and data attributes. Server-rendered HTML only; no browser runs.`;

const USER_AGENT = 'spool-measurement/0.3 (+https://github.com/drupflare/spool)';
const DELAY_MS = 250;
const TIMEOUT_MS = 20_000;
const SITE_CONCURRENCY = 2;

/** picked by the rig author, not sampled: a convenience set */
export const EXTRA_SITES = [
	'https://www.stanford.edu/',
	'https://www.princeton.edu/',
	'https://www.columbia.edu/',
	'https://www.upenn.edu/',
	'https://www.duke.edu/',
	'https://www.northwestern.edu/',
	'https://www.uchicago.edu/',
	'https://www.jhu.edu/',
	'https://www.caltech.edu/',
	'https://www.vanderbilt.edu/',
	'https://www.emory.edu/',
	'https://www.rice.edu/',
	'https://www.ucla.edu/',
	'https://www.umich.edu/',
	'https://www.wisc.edu/',
	'https://www.cmu.edu/',
	'https://www.ku.edu/',
	'https://www.iastate.edu/',
	'https://www.colostate.edu/',
	'https://www.oregonstate.edu/',
	'https://www.wsu.edu/',
	'https://www.utah.edu/',
	'https://www.arizona.edu/',
	'https://www.unm.edu/',
	'https://www.uga.edu/',
	'https://www.lsu.edu/',
	'https://www.uky.edu/',
	'https://www.umd.edu/',
	'https://www.umass.edu/',
	'https://www.ufl.edu/',
	'https://www.austincc.edu/',
	'https://www.montgomerycollege.edu/',
	'https://www.pima.edu/',
	'https://www.miracosta.edu/',
	'https://www.foothill.edu/',
	'https://www.ccsf.edu/',
	'https://www.williams.edu/',
	'https://www.amherst.edu/',
	'https://www.swarthmore.edu/',
	'https://www.pomona.edu/',
	'https://www.carleton.edu/',
	'https://www.grinnell.edu/',
	'https://www.oberlin.edu/',
	'https://www.middlebury.edu/'
];

/** embed providers looked for in script hosts, inline script text and data attributes */
export const PROVIDERS = [
	'kaltura',
	'wistia',
	'brightcove',
	'vidyard',
	'jwplayer',
	'jwpcdn',
	'panopto',
	'yuja',
	'mediasite',
	'ensemble',
	'vimeo',
	'youtube',
	'ytimg',
	'soundcloud',
	'spotify',
	'twitter',
	'platform.twitter',
	'facebook',
	'instagram',
	'tiktok',
	'tagboard',
	'juicer',
	'curator',
	'elfsight',
	'google.com/maps',
	'maps.googleapis',
	'concept3d',
	'datawrapper',
	'flourish',
	'tableau',
	'powerbi',
	'calendly',
	'typeform',
	'livestream',
	'ustream',
	'twitch',
	'zoom.us'
];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// longest name first, so platform.twitter is one match and not a twitter match too
const ALTERNATION = [...PROVIDERS]
	.sort((a, b) => b.length - a.length)
	.map(escapeRe)
	.join('|');
const PROVIDER_FIRST = new RegExp(ALTERNATION, 'i');
const PROVIDER_ALL = new RegExp(ALTERNATION, 'gi');

const IFRAME_ATTRS = [
	'width',
	'height',
	'title',
	'loading',
	'sandbox',
	'allow',
	'allowfullscreen',
	'srcdoc',
	'class'
] as const;
const HERO = /hero|ambient|background|bg|loop|banner/i;
const ID_SEGMENT = /^(?:\d+|(?=.*\d)[A-Za-z0-9_-]{6,})$/;
const QUERY_NAME = /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,39}$/;
const BASE = 'https://page.invalid';

/** `pathname` with each id-like segment replaced by `:id` */
export function pathShape(pathname: string): string {
	return pathname
		.split('/')
		.map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
		.join('/');
}

/**
 * The host, path shape and query parameter names of a URL. A parameter counts only when it has an
 * `=`, so a bare token (which may be a value) is never recorded.
 */
export function addressOf(raw: string): { host: string; path: string | null; params: string[] } {
	let url: URL;
	try {
		url = new URL(decodeEntities(raw).trim(), BASE);
	} catch {
		return { host: '(invalid)', path: null, params: [] };
	}
	if (!/^https?:$/.test(url.protocol)) {
		return { host: `(${url.protocol.slice(0, -1)})`, path: null, params: [] };
	}
	const host = url.hostname === 'page.invalid' ? '(relative)' : url.hostname.toLowerCase();
	const params = new Set<string>();
	for (const pair of url.search.slice(1).split('&')) {
		const eq = pair.indexOf('=');
		if (eq < 1) continue;
		const name = pair.slice(0, eq);
		if (QUERY_NAME.test(name)) params.add(name);
	}
	return { host, path: pathShape(url.pathname), params: [...params].sort() };
}

export type IframeFact = {
	host: string;
	path: string | null;
	params: string[];
	attrs: string[];
	hero: boolean;
};

export type VideoFact = {
	autoplay: boolean;
	muted: boolean;
	loop: boolean;
	controls: boolean;
	preload: boolean;
	poster: boolean;
	srcHost: string | null;
	sourceHosts: string[];
};

export type ScriptFact = { host: string; provider: string };

export type PageFacts = {
	iframes: IframeFact[];
	videos: VideoFact[];
	scripts: ScriptFact[];
	inline: Record<string, number>;
	data: Record<string, number>;
	noscriptIframes: number;
	commentIframes: number;
};

const has = (tag: Tag, name: string) => tag.attributes.some((a) => a.name === name);

function countInto(into: Record<string, number>, text: string): void {
	for (const [name] of text.toLowerCase().matchAll(PROVIDER_ALL)) {
		into[name] = (into[name] ?? 0) + 1;
	}
}

function iframeOf(tag: Tag): IframeFact {
	const src = attr(tag, 'src');
	const address = src === undefined ? { host: '(none)', path: null, params: [] } : addressOf(src);
	return {
		host: address.host,
		path: address.path,
		params: address.params,
		attrs: IFRAME_ATTRS.filter((name) => has(tag, name)),
		hero: HERO.test(attr(tag, 'class') ?? '') || HERO.test(attr(tag, 'id') ?? '')
	};
}

/** a video's flags, its `src` host and the host of each `<source>` before its end tag */
function videoOf(html: string, tags: readonly Tag[], at: number): VideoFact {
	const tag = tags[at] as Tag;
	const close = html.indexOf('</video', tag.end);
	const nextVideo = tags.find((t, j) => j > at && t.name === 'video')?.start ?? html.length;
	const limit = Math.min(close < 0 ? html.length : close, nextVideo);
	const sourceHosts = tags
		.filter((t) => t.name === 'source' && t.start > tag.end && t.start < limit)
		.flatMap((t) => {
			const src = attr(t, 'src');
			return src === undefined ? [] : [addressOf(src).host];
		});
	const src = attr(tag, 'src');
	return {
		autoplay: has(tag, 'autoplay'),
		muted: has(tag, 'muted'),
		loop: has(tag, 'loop'),
		controls: has(tag, 'controls'),
		preload: has(tag, 'preload'),
		poster: has(tag, 'poster'),
		srcHost: src === undefined ? null : addressOf(src).host,
		sourceHosts
	};
}

/**
 * The embed facts of one HTML document. Markup inside a `<noscript>` or an HTML comment is not
 * counted, because a visitor whose script runs never renders it; the iframes skipped that way are
 * counted apart. Scripts with a relative `src` have no host and are not recorded.
 */
export function parsePage(html: string): PageFacts {
	const tags = tagsOf(html);
	const comments = commentRanges(html);
	const noscripts = noscriptRanges(html, tags);
	const facts: PageFacts = {
		iframes: [],
		videos: [],
		scripts: [],
		inline: {},
		data: {},
		noscriptIframes: 0,
		commentIframes: 0
	};
	tags.forEach((tag, at) => {
		if (within(noscripts, tag.start)) {
			if (tag.name === 'iframe') facts.noscriptIframes++;
			return;
		}
		if (within(comments, tag.start)) {
			if (tag.name === 'iframe') facts.commentIframes++;
			return;
		}
		for (const a of tag.attributes) {
			if (a.name.startsWith('data-')) countInto(facts.data, decodeEntities(a.value));
		}
		if (tag.name === 'iframe') facts.iframes.push(iframeOf(tag));
		else if (tag.name === 'video') facts.videos.push(videoOf(html, tags, at));
		else if (tag.name === 'script') {
			const src = attr(tag, 'src');
			if (src === undefined) {
				countInto(facts.inline, tag.body ?? '');
				return;
			}
			const { host, path } = addressOf(src);
			if (host.startsWith('(')) return;
			const hit = PROVIDER_FIRST.exec(`${host}${path ?? ''}`);
			if (hit) facts.scripts.push({ host, provider: hit[0].toLowerCase() });
		}
	});
	return facts;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Fetched = { status: number; type: string; body: string; url: string };

async function get(url: string): Promise<Fetched> {
	try {
		const res = await fetch(url, {
			headers: {
				'user-agent': USER_AGENT,
				'accept-encoding': 'identity',
				accept: 'text/html,*/*'
			},
			redirect: 'follow',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		const body = await res.text();
		return {
			status: res.status,
			type: res.headers.get('content-type') ?? '',
			body,
			url: res.url
		};
	} finally {
		await sleep(DELAY_MS);
	}
}

/** the error's name and network code; never its message, which can carry a URL */
function reasonOf(error: unknown): string {
	const e = error as { name?: string; cause?: { code?: string } };
	return [e.name ?? 'Error', e.cause?.code].filter(Boolean).join(' ');
}

/** the host with a leading `www.` dropped, so `www.x.edu` and `x.edu` are one site */
const bareHost = (url: string) => new URL(url).hostname.replace(/^www\./, '');

export type SiteRows = { rows: Record<string, unknown>[]; exclusions: string[] };

export async function measureSite(site: string, pages: number): Promise<SiteRows> {
	let home: Fetched;
	try {
		home = await get(site);
	} catch (error) {
		return { rows: [], exclusions: [`${site}: home page ${reasonOf(error)}`] };
	}
	if (home.status !== 200 || !/html/.test(home.type)) {
		const type = home.type || 'no content type';
		return { rows: [], exclusions: [`${site}: home page HTTP ${home.status} ${type}`] };
	}
	if (bareHost(home.url) !== bareHost(site)) {
		return { rows: [], exclusions: [`${site}: home page redirected off the site`] };
	}
	const origin = new URL(home.url).origin;
	const exclusions: string[] = [];
	const chosen = pickPages(internalLinks(home.body, home.url), new Set(), pages);
	const docs: Array<{ path: string; html: string }> = [{ path: '/', html: home.body }];
	for (const path of chosen) {
		const label = `${origin}${redactPath(path)}`;
		let res: Fetched;
		try {
			res = await get(`${origin}${path}`);
		} catch (error) {
			exclusions.push(`${label}: ${reasonOf(error)}`);
			continue;
		}
		if (res.status !== 200 || !/html/.test(res.type)) {
			exclusions.push(`${label}: HTTP ${res.status}`);
			continue;
		}
		if (bareHost(res.url) !== bareHost(site)) {
			exclusions.push(`${label}: redirected off the site`);
			continue;
		}
		docs.push({ path, html: res.body });
	}
	const rows = docs.map((doc) => ({
		site,
		page: redactPath(doc.path),
		home: doc.path === '/',
		...parsePage(doc.html)
	}));
	return { rows, exclusions };
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			sites: { type: 'string' },
			pages: { type: 'string', default: '4' },
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false }
		}
	});
	const all = [...SITES, ...EXTRA_SITES];
	const wanted = (values.sites ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const sites = wanted.length ? all.filter((s) => wanted.some((w) => s.includes(w))) : all;
	const pages = Number(values.pages);
	if (!Number.isInteger(pages) || pages < 0) throw new Error('--pages must be a whole number');
	if (sites.length === 0) throw new Error(`--sites matched no site: ${values.sites}`);
	return {
		sites,
		pages,
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

/** runs `fn` over `items` with at most `width` in flight, returning results in input order */
async function mapPool<T, R>(
	items: readonly T[],
	width: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: width }, lane));
	return out;
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'embed-markup',
					date: utcDate(),
					sites: args.sites,
					pages: args.pages,
					out: args.out
				},
				null,
				2
			)
		);
	} else {
		const results = await mapPool(args.sites, SITE_CONCURRENCY, async (site) => {
			const result = await measureSite(site, args.pages);
			console.error(site, result.rows.length ? `${result.rows.length} pages` : 'failed');
			return result;
		});
		const rows = results.flatMap((r) => r.rows);
		const exclusions = results.flatMap((r) => r.exclusions);
		const loaded = results.filter((r) => r.rows.length > 0).length;
		const draft: Draft = {
			rig: 'embed-markup',
			date: utcDate(),
			layer: 'L1',
			question:
				'which embed classes appear in the server-rendered markup of higher-ed home and internal pages, how often, and in what shape',
			instrument:
				'plain HTTPS GETs, read with the tag tokenizer of src/trim/tokens.ts (no browser, no script execution)',
			machine: localMachine(args.machine),
			software: { runtime: `Bun ${process.versions.bun}`, node: process.versions.node },
			method: {
				'sites listed': args.sites.length,
				'sites loaded': loaded,
				'site list':
					'the sites of repeat-nav plus EXTRA_SITES (44 picked by the rig author, not sampled); a convenience set',
				'pages per site': `home plus up to ${args.pages} internal links, spread evenly over the links`,
				'page choice':
					'internal links of the home page: same host, no query or fragment, no asset or account path',
				'host rule':
					'a page that lands off the site (www. ignored) is excluded; the rig follows no link off the site',
				requests: `GET with fetch, redirects followed, ${TIMEOUT_MS / 1000} s timeout, ${DELAY_MS} ms after each request, ${SITE_CONCURRENCY} sites at a time`,
				'user agent': USER_AGENT,
				iframe: 'host; path with id-like segments as :id; sorted query parameter names, only where the parameter has an =; presence of width, height, title, loading, sandbox, allow, allowfullscreen, srcdoc and class; hero when the class or id matches /hero|ambient|background|bg|loop|banner/i',
				video: 'presence of autoplay, muted, loop, controls, preload and poster; host of src and of each source src inside the element',
				script: 'host and provider name for each absolute or protocol-relative src; a relative src has no host and is not recorded',
				'inline and data':
					'occurrences of each provider name in inline script text and in data-* attribute values; counts only',
				'provider match':
					'scripts: the first listed name found in host plus path; inline and data: every occurrence, longest name first',
				ignored:
					'markup inside a noscript or an HTML comment; iframes skipped that way are counted in noscriptIframes and commentIframes',
				'never recorded':
					'full URLs, query values, ids, titles, page text and script bodies',
				limit: 'server-rendered markup only; an embed that a script injects after load is not seen'
			},
			exclusions,
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
