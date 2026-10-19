import { parseArgs } from 'node:util';
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from 'node:zlib';
import type { Draft } from './lib.ts';
import { isMain, localMachine, MEASUREMENTS_DIR, utcDate, writeMeasurement } from './lib.ts';
import { SITES } from './repeat-nav.ts';

const HELP = `Usage: bun scripts/measure/payload.ts [--site URL ...] [--pages N] [--machine NAME]
       [--experiment NAME] [--out DIR] [--force] [--dry-run]

Fetches the home page and up to N internal pages (default 20) of each Drupal site with plain GETs and
writes compressed sizes of the document, the shared shell, the unique part, the unique part under a
shared dictionary and, where JSON:API answers, the node's data.`;

const USER_AGENT = 'Mozilla/5.0 (compatible; spool-payload-measure/1.0)';
const DELAY_MS = 250;
const MAX_LINES = 9000;
const DICT_PAGES = 4;
const DICT_CAP = 1 << 20;
const NODE_LIST_REQUESTS = 6;

/** joules per transferred byte: 0.194 kWh/GB (SWD v4, L0) over decimal GB */
export const K_J_PER_B = (0.194 * 3.6e6) / 1e9;

/** the modelled origin request (L1, `ORIGIN_J.conventional` in `src/report/inputs.ts`) */
export const ORIGIN_REQUEST_J = 0.455;

/** compressed byte counts at the levels servers use, plus the best case of each codec */
export type Sizes = {
	raw: number;
	gzip6: number;
	gzip9: number;
	br5: number;
	br11: number;
	zstd3: number;
	zstd19: number;
};

export type DictSizes = { zstd3: number; zstd19: number };

export function sizes(input: string | Uint8Array): Sizes {
	const buf = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
	const br = (quality: number) =>
		brotliCompressSync(buf, {
			params: {
				[constants.BROTLI_PARAM_QUALITY]: quality,
				[constants.BROTLI_PARAM_SIZE_HINT]: buf.length
			}
		}).length;
	const zstd = (level: number) =>
		zstdCompressSync(buf, { params: { [constants.ZSTD_c_compressionLevel]: level } }).length;
	return {
		raw: buf.length,
		gzip6: gzipSync(buf, { level: 6 }).length,
		gzip9: gzipSync(buf, { level: 9 }).length,
		br5: br(5),
		br11: br(11),
		zstd3: zstd(3),
		zstd19: zstd(19)
	};
}

/** zstd with a raw dictionary: the RFC 9842 `dcz` case */
export function dictSizes(input: string, dictionary: string): DictSizes {
	const buf = Buffer.from(input);
	const dict = Buffer.from(dictionary);
	const zstd = (level: number) =>
		zstdCompressSync(buf, {
			dictionary: dict,
			params: { [constants.ZSTD_c_compressionLevel]: level }
		}).length;
	return { zstd3: zstd(3), zstd19: zstd(19) };
}

export const lines = (html: string): string[] => html.replace(/\r\n?/g, '\n').split('\n');

/** the longest common subsequence of two line lists, with equal ends trimmed first */
export function lcs(a: readonly string[], b: readonly string[]): string[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const head = a.slice(0, start);
	const tail = a.slice(endA);
	const x = a.slice(start, endA);
	const y = b.slice(start, endB);
	const n = x.length;
	const m = y.length;
	if (n === 0 || m === 0) return [...head, ...tail];
	const w = m + 1;
	const table = new Uint16Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * w + j] =
				x[i] === y[j]
					? (table[(i + 1) * w + j + 1] as number) + 1
					: Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
		}
	}
	const middle: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) {
			middle.push(x[i] as string);
			i++;
			j++;
		} else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) i++;
		else j++;
	}
	return [...head, ...middle, ...tail];
}

/**
 * The lines common to the pages, in order: the median-length page is cut down by each other page in
 * turn (iterated pairwise, so a heuristic for the optimum). A page that would cut the shell below
 * `keep` of its current length is a template outlier and is left out; its index is returned.
 */
export function deriveShell(
	pages: ReadonlyArray<readonly string[]>,
	keep = 0.6
): { shell: string[]; outliers: number[] } {
	if (pages.length === 0) return { shell: [], outliers: [] };
	const order = pages
		.map((_, i) => i)
		.sort((a, b) => (pages[a] as string[]).length - (pages[b] as string[]).length);
	const start = order[Math.floor(order.length / 2)] as number;
	let shell: string[] = [...(pages[start] as string[])];
	const outliers: number[] = [];
	pages.forEach((page, i) => {
		if (i === start) return;
		const next = lcs(shell, page);
		if (next.length >= keep * shell.length) shell = next;
		else outliers.push(i);
	});
	return { shell, outliers };
}

/**
 * The page minus the shell: lines outside the shell in order, with `@n` standing for each run of n
 * shell lines. Throws when the shell is not a subsequence of the page.
 */
export function uniquePart(
	page: readonly string[],
	shell: readonly string[]
): { text: string; gaps: number; uniqueLines: number } {
	const out: string[] = [];
	let k = 0;
	let run = 0;
	let gaps = 0;
	let uniqueLines = 0;
	for (const line of page) {
		if (k < shell.length && line === shell[k]) {
			k++;
			run++;
			continue;
		}
		if (run > 0) {
			out.push(`@${run}`);
			gaps++;
			run = 0;
		}
		out.push(line);
		uniqueLines++;
	}
	if (k < shell.length) throw new Error('the shell is not a subsequence of the page');
	if (run > 0) {
		out.push(`@${run}`);
		gaps++;
	}
	return { text: out.join('\n'), gaps, uniqueLines };
}

/** the middle value of a list (mean of the two middle values for an even count), null when empty */
export function median(values: readonly number[]): number | null {
	return quantile(values, 0.5);
}

/** linear-interpolated quantile, null when empty */
export function quantile(values: readonly number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/** median with the quartiles and the extremes */
export function spread(values: readonly number[]) {
	return {
		n: values.length,
		min: quantile(values, 0),
		p25: quantile(values, 0.25),
		median: median(values),
		p75: quantile(values, 0.75),
		max: quantile(values, 1)
	};
}

/**
 * The use probability above which sending an entry of `entryBytes` instead of waiting for a
 * `docBytes` document pays: `k * entry / (k * doc + origin)`. A result of 1 or more never pays.
 */
export function breakEven(entryBytes: number, docBytes: number): number {
	return (K_J_PER_B * entryBytes) / (K_J_PER_B * docBytes + ORIGIN_REQUEST_J);
}

const SKIP_EXT =
	/\.(?:pdf|jpe?g|png|gif|svg|webp|ico|css|js|json|xml|zip|docx?|xlsx?|pptx?|mp[34]|mov|txt|rss)$/i;
const SKIP_PATH =
	/^\/(?:user|admin|node\/add|core|sites|themes|modules|libraries|cdn-cgi|search|jsonapi|rest|cas|saml|login|logout|sso)(?:\/|$)/i;

/** internal page paths linked from `html`, no query or fragment, in order of first appearance */
export function internalLinks(html: string, base: string): string[] {
	const root = new URL(base);
	const seen = new Set<string>(['/']);
	const out: string[] = [];
	for (const match of html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi)) {
		let url: URL;
		try {
			url = new URL(match[1] as string, root);
		} catch {
			continue;
		}
		if (!/^https?:$/.test(url.protocol) || url.host !== root.host) continue;
		const path = url.pathname;
		if (SKIP_EXT.test(path) || SKIP_PATH.test(path) || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

/** `count` items spread evenly over the list, in order */
export function evenly<T>(items: readonly T[], count: number): T[] {
	if (items.length <= count) return [...items];
	return Array.from(
		{ length: count },
		(_, i) => items[Math.floor((i * items.length) / count)] as T
	);
}

/** pages chosen from the links: those with a known node alias first, the rest spread evenly */
export function pickPages(links: readonly string[], aliases: ReadonlySet<string>, count: number) {
	const known = links.filter((l) => aliases.has(l));
	const rest = links.filter((l) => !aliases.has(l));
	const first = known.slice(0, count);
	return [...first, ...evenly(rest, count - first.length)];
}

/** whether live markup or headers say the site runs Drupal */
export function isDrupal(html: string, headers: Headers | Record<string, string>): boolean {
	const get = (name: string) => (headers instanceof Headers ? headers.get(name) : headers[name]);
	return (
		/drupal-settings-json|Drupal\.settings|\/sites\/default\/files|data-drupal|<meta[^>]+name=["']generator["'][^>]+content=["']Drupal/i.test(
			html
		) ||
		/drupal/i.test(get('x-generator') ?? '') ||
		get('x-drupal-cache') != null ||
		get('x-drupal-dynamic-cache') != null
	);
}

type JsonApiResource = {
	attributes?: Record<string, unknown>;
};

const textOf = (value: unknown): unknown => {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const v = value as Record<string, unknown>;
		if ('processed' in v || 'value' in v) return v.processed ?? v.value;
	}
	return value;
};

const empty = (value: unknown): boolean =>
	value == null ||
	value === '' ||
	(Array.isArray(value) && value.length === 0) ||
	(typeof value === 'object' && Object.keys(value as object).length === 0);

/**
 * The attributes a template would print: title, dates, alias, body and every non-empty `field_*`,
 * with text fields reduced to their processed text. References (media, terms) are relationships and
 * stay out, so the result is a lower bound on what a template needs.
 */
export function renderFields(resource: JsonApiResource): Record<string, unknown> {
	const a = resource.attributes ?? {};
	const out: Record<string, unknown> = {};
	for (const key of ['title', 'created', 'changed']) if (!empty(a[key])) out[key] = a[key];
	const alias = (a.path as { alias?: string } | undefined)?.alias;
	if (alias) out.alias = alias;
	if (!empty(a.body)) out.body = textOf(a.body);
	for (const [key, value] of Object.entries(a)) {
		if (!key.startsWith('field_')) continue;
		const v = Array.isArray(value) ? value.map(textOf) : textOf(value);
		if (!empty(v)) out[key] = v;
	}
	return out;
}

/** bundle names from a JSON:API index document (`node--article` becomes `article`) */
export function nodeBundles(index: { links?: Record<string, unknown> }): string[] {
	return Object.keys(index.links ?? {})
		.filter((k) => k.startsWith('node--'))
		.map((k) => k.slice('node--'.length));
}

export type PageRow = {
	path: string;
	document: Sizes;
	unique: Sizes;
	uniqueLines: number;
	gaps: number;
	outlier: boolean;
	documentDict: DictSizes;
	uniqueDict: DictSizes;
	json?: { raw: Sizes; rendered: Sizes };
};

export type SiteRow = {
	site: string;
	drupal: string;
	jsonapi: boolean;
	shellLines: number;
	shell: Sizes;
	home: PageRow;
	pages: PageRow[];
	nodeSample?: Array<{ raw: Sizes; rendered: Sizes }>;
	excluded: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fetched = { status: number; type: string; body: string; url: string; headers: Headers };

async function get(url: string): Promise<Fetched> {
	const res = await fetch(url, {
		headers: {
			'user-agent': USER_AGENT,
			'accept-encoding': 'identity',
			accept: 'text/html,*/*'
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(30_000)
	});
	const body = await res.text();
	await sleep(DELAY_MS);
	return {
		status: res.status,
		type: res.headers.get('content-type') ?? '',
		body,
		url: res.url,
		headers: res.headers
	};
}

export async function nodeResources(origin: string, excluded: string[]) {
	const resources: Array<{ alias: string | null; resource: JsonApiResource }> = [];
	const index = await getJson(`${origin}/jsonapi`);
	if (!index) return null;
	let budget = NODE_LIST_REQUESTS;
	for (const bundle of nodeBundles(index)) {
		let next: string | null = `${origin}/jsonapi/node/${bundle}?page%5Blimit%5D=50`;
		while (next && budget > 0) {
			budget--;
			const page = await getJson(next);
			if (!page) {
				excluded.push(`jsonapi node/${bundle}: no JSON answer`);
				break;
			}
			for (const resource of page.data ?? []) {
				resources.push({
					alias:
						(resource.attributes?.path as { alias?: string } | undefined)?.alias ??
						null,
					resource
				});
			}
			next = (page.links?.next?.href as string | undefined) ?? null;
		}
		if (budget <= 0) break;
	}
	return resources;
}

async function getJson(url: string): Promise<any | null> {
	const res = await get(url);
	if (res.status !== 200 || !/json/.test(res.type)) return null;
	try {
		return JSON.parse(res.body);
	} catch {
		return null;
	}
}

function dictionaryFor(texts: readonly string[], index: number): string {
	const others = texts.filter((_, i) => i !== index);
	let dict = '';
	for (const t of evenly(others, DICT_PAGES)) {
		if (dict.length + t.length > DICT_CAP) break;
		dict += t;
	}
	return dict || (others[0] ?? '').slice(0, DICT_CAP);
}

export async function measureSite(site: string, pages: number): Promise<SiteRow | string> {
	const excluded: string[] = [];
	const home = await get(site);
	if (home.status !== 200 || !/html/.test(home.type)) {
		return `${site}: HTTP ${home.status} ${home.type || 'no content type'}`;
	}
	if (!isDrupal(home.body, home.headers)) return `${site}: no Drupal markup in the home page`;
	const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(home.body);
	const origin = new URL(home.url).origin;
	const nodes = await nodeResources(origin, excluded);
	const aliases = new Set((nodes ?? []).flatMap((n) => (n.alias ? [n.alias] : [])));
	const chosen = pickPages(internalLinks(home.body, home.url), aliases, pages);

	const docs: Array<{ path: string; html: string }> = [{ path: '/', html: home.body }];
	for (const path of chosen) {
		const res = await get(`${origin}${path}`);
		if (res.status !== 200 || !/html/.test(res.type)) {
			excluded.push(`${path}: HTTP ${res.status}`);
			continue;
		}
		const split = lines(res.body);
		if (split.length > MAX_LINES) {
			excluded.push(`${path}: ${split.length} lines, over the ${MAX_LINES} line limit`);
			continue;
		}
		docs.push({ path, html: res.body });
	}
	if (docs.length < 3) return `${site}: only ${docs.length} pages fetched`;
	const split = docs.map((d) => lines(d.html));
	const { shell, outliers } = deriveShell(split);
	const texts = docs.map((d) => d.html);
	const byAlias = new Map((nodes ?? []).map((n) => [n.alias, n.resource] as const));

	const rows = docs.map((doc, i): PageRow => {
		const outlier = outliers.includes(i);
		const part = outlier
			? { text: texts[i] as string, gaps: 0, uniqueLines: (split[i] as string[]).length }
			: uniquePart(split[i] as string[], shell);
		const dict = dictionaryFor(texts, i);
		const resource = byAlias.get(doc.path);
		return {
			path: doc.path,
			document: sizes(doc.html),
			unique: sizes(part.text),
			uniqueLines: part.uniqueLines,
			gaps: part.gaps,
			outlier,
			documentDict: dictSizes(doc.html, dict),
			uniqueDict: dictSizes(part.text, dict),
			...(resource
				? {
						json: {
							raw: sizes(JSON.stringify(resource)),
							rendered: sizes(JSON.stringify(renderFields(resource)))
						}
					}
				: {})
		};
	});
	const matched = new Set(docs.map((d) => d.path));
	const sample = (nodes ?? [])
		.filter((n) => !n.alias || !matched.has(n.alias))
		.slice(0, 30)
		.map((n) => ({
			raw: sizes(JSON.stringify(n.resource)),
			rendered: sizes(JSON.stringify(renderFields(n.resource)))
		}));
	return {
		site,
		drupal: generator?.[1] ?? 'markup only',
		jsonapi: nodes !== null,
		shellLines: shell.length,
		shell: sizes(shell.join('\n')),
		home: rows[0] as PageRow,
		pages: rows.slice(1),
		...(nodes ? { nodeSample: sample } : {}),
		excluded
	};
}

function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			site: { type: 'string', multiple: true },
			pages: { type: 'string', default: '20' },
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
		pages: Number(values.pages),
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

export { parse };

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'payload',
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
		const rows: SiteRow[] = [];
		const exclusions: string[] = [];
		for (const site of args.sites) {
			const result = await measureSite(site, args.pages);
			if (typeof result === 'string') exclusions.push(result);
			else {
				rows.push(result);
				for (const e of result.excluded) exclusions.push(`${site} ${e}`);
			}
			console.error(
				site,
				typeof result === 'string' ? result : `${result.pages.length + 1} pages`
			);
		}
		const draft: Draft = {
			rig: 'payload',
			date: utcDate(),
			layer: 'L1',
			question:
				'how many compressed bytes a page is once the markup shared across a site is counted once, and what the unique part and a node record weigh',
			instrument:
				'plain HTTPS GETs, then Node zlib gzip, brotli and zstd (zstd with a raw dictionary for the RFC 9842 case)',
			machine: localMachine(args.machine),
			software: { runtime: `Bun ${process.versions.bun}`, node: process.versions.node },
			method: {
				'pages per site': `home plus up to ${args.pages} internal links`,
				'page choice':
					'links from the home page without query strings, pages with a known JSON:API alias first, the rest spread evenly',
				shell: 'lines common to the fetched pages: the median-length page cut down by each other page in turn (longest common subsequence); a page that would cut the shell below 60% of its length is an outlier, left out of the shell and counted whole as its unique part',
				'unique part':
					'the page lines outside the shell, with an @n line for each run of n shell lines',
				dictionary: `zstd raw dictionary of up to ${DICT_PAGES} other pages of the site, capped at ${DICT_CAP} B`,
				'json rendered':
					'title, dates, alias, body and non-empty field_* attributes; references excluded',
				'json pairing':
					'a node pairs with a page when its path alias equals the page path; other nodes go to nodeSample',
				'sizes unit': 'bytes; gzip 6 and 9, brotli 5 and 11, zstd 3 and 19',
				'k J per B': K_J_PER_B,
				'origin request J': ORIGIN_REQUEST_J
			},
			exclusions,
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
