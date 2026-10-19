import { trimCss } from './css.js';
import {
	decodeEntities,
	isStylesheetLink,
	pageAssets,
	pageTokens,
	scriptTokens,
	tagsOf,
	type Attribute
} from './tokens.js';

/** the query parameter that asks the proxy for the full stylesheet */
export const TRIM_PARAM = 'spool-trim';

/** one trimmed stylesheet: what the origin must send for it to be served, and what it needs */
export type TrimEntry = {
	/** `sha256-<base64>` of the origin's bytes the entry was built from */
	source: string;
	/** the trimmed stylesheet */
	css: string;
	/** tokens whose absence removed a rule; a page that has one gets the full file */
	missing: string[];
	/** the same-origin script keys the tokens were built with */
	scripts: string[];
};

/** a manifest that {@link buildTrimManifest} writes and `spoolProxy` reads; plain JSON */
export type TrimManifest = {
	schema: 1;
	/** entries by {@link trimKey} */
	styles: Record<string, TrimEntry>;
};

/** a same-origin file the manifest is built from; `url` may be absolute or site-relative */
export type TrimFile = { url: string; text: string };

const BASE = 'http://spool-trim.invalid';

/**
 * A query string with the {@link TRIM_PARAM} parameter removed and every other parameter left
 * byte for byte, so the origin gets the URL the page named.
 */
export function stripTrimParam(search: string): string {
	if (!search.includes(TRIM_PARAM)) return search;
	const kept = search
		.slice(1)
		.split('&')
		.filter((piece) => piece.split('=')[0] !== TRIM_PARAM);
	return kept.length > 0 ? `?${kept.join('&')}` : '';
}

/** `pathname + search` of a URL with the {@link TRIM_PARAM} parameter dropped, the manifest key */
export function trimKey(url: string, base: string = BASE): string {
	const parsed = new URL(url, base);
	return parsed.pathname + stripTrimParam(parsed.search);
}

/** `sha256-<base64>` of `bytes` */
export async function sourceHash(bytes: Uint8Array | string): Promise<string> {
	const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
	return `sha256-${btoa(String.fromCharCode(...hash))}`;
}

/**
 * Trims every stylesheet against the union of the tokens of all `pages` and all `scripts`, so one
 * file keeps one URL for the whole site. A stylesheet that loses no rule gets no entry. `pages` is
 * HTML, `scripts` the same-origin JavaScript the pages load, `styles` the same-origin CSS.
 *
 * `foreignScripts` are scripts from other origins that the pages load, such as a widget that
 * builds markup. Their words widen the tokens, because a class such a script adds is in the DOM
 * whatever origin served it. The guard never looks at their URLs, so a vendor that starts adding a
 * new class after the crawl is not caught.
 */
export async function buildTrimManifest(input: {
	pages: readonly string[];
	scripts: readonly TrimFile[];
	styles: readonly TrimFile[];
	foreignScripts?: readonly TrimFile[];
}): Promise<TrimManifest> {
	const tokens = new Set<string>();
	for (const html of input.pages) for (const token of pageTokens(html)) tokens.add(token);
	for (const { text } of [...input.scripts, ...(input.foreignScripts ?? [])]) {
		for (const token of scriptTokens(text)) tokens.add(token);
	}
	const scripts = [...new Set(input.scripts.map((s) => trimKey(s.url)))].sort();
	const styles: Record<string, TrimEntry> = {};
	for (const style of input.styles) {
		const key = trimKey(style.url);
		if (key in styles) continue;
		const { css, removedRules, missing } = trimCss(style.text, tokens);
		if (removedRules === 0) continue;
		styles[key] = { source: await sourceHash(style.text), css, missing, scripts };
	}
	return { schema: 1, styles };
}

/** what {@link guardPage} decided for one page */
export type Guard = {
	/** the page, with the links of its trimmed stylesheets rewritten when the guard fired */
	html: string;
	fired: boolean;
	/** `token` when a stylesheet's missing token is on the page, `script` for an unseen script */
	reason?: 'token' | 'script';
	/** the manifest keys of the trimmed stylesheets the page links */
	files: string[];
};

const known = new WeakMap<TrimEntry, Set<string>>();

function scriptsOf(entry: TrimEntry): Set<string> {
	let set = known.get(entry);
	if (!set) known.set(entry, (set = new Set(entry.scripts)));
	return set;
}

function sameOriginKey(href: string, page: URL): string | null {
	let target: URL;
	try {
		target = new URL(href, page);
	} catch {
		return null;
	}
	return target.origin === page.origin ? trimKey(target.href) : null;
}

function withParam(raw: string): string {
	const hash = raw.indexOf('#');
	const head = hash < 0 ? raw : raw.slice(0, hash);
	const tail = hash < 0 ? '' : raw.slice(hash);
	const url = `${head}${head.includes('?') ? '&amp;' : '?'}${TRIM_PARAM}=0${tail}`;
	// the raw value is already in entity form, and may hold a quote from a single-quoted or bare attribute
	return url.replaceAll('"', '&quot;');
}

/**
 * Decides whether `html` may use the trimmed stylesheets it links. It may not when one of its
 * tokens is in a linked entry's `missing` set, or when it loads a same-origin script the manifest
 * was not built with. Then each link to a trimmed file gets `spool-trim=0`, which the proxy
 * answers with the full file. It cannot see a class a third-party script adds, or markup injected
 * after load from a page the manifest never covered.
 */
export function guardPage(html: string, manifest: TrimManifest, pageUrl: string): Guard {
	const page = new URL(pageUrl);
	const assets = pageAssets(html);
	const files = [
		...new Set(
			assets.styles
				.map((href) => sameOriginKey(href, page))
				.filter((key): key is string => key !== null && key in manifest.styles)
		)
	];
	if (files.length === 0) return { html, fired: false, files };
	const entries = files.map((key) => manifest.styles[key] as TrimEntry);
	// any case counts, as in trimCss, for a quirks-mode page
	const tokens = new Set([...pageTokens(html)].map((token) => token.toLowerCase()));
	let reason: Guard['reason'];
	if (entries.some((entry) => entry.missing.some((token) => tokens.has(token.toLowerCase())))) {
		reason = 'token';
	} else {
		const scripts = assets.scripts
			.map((src) => sameOriginKey(src, page))
			.filter((key): key is string => key !== null);
		if (entries.some((entry) => scripts.some((key) => !scriptsOf(entry).has(key)))) {
			reason = 'script';
		}
	}
	if (!reason) return { html, fired: false, files };
	let rewritten = '';
	let from = 0;
	for (const tag of tagsOf(html)) {
		if (!isStylesheetLink(tag)) continue;
		const href = tag.attributes.find((a) => a.name === 'href') as Attribute;
		const key = sameOriginKey(decodeEntities(href.value), page);
		if (key === null || !(key in manifest.styles)) continue;
		rewritten += `${html.slice(from, href.start)}href="${withParam(href.value)}"`;
		from = href.end;
	}
	return { html: rewritten + html.slice(from), fired: true, reason, files };
}
