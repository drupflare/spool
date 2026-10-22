import { ProtocolError } from '../protocol/errors.js';
import { tagsOf, type Tag } from '../trim/tokens.js';
import {
	appendAttributes,
	applyEdits,
	commentRanges,
	elementRanges,
	find,
	headRange,
	noscriptRanges,
	within,
	type Edit
} from './html.js';

/**
 * What `images.lazy` does to `<img>` and `<iframe>` start tags. `skip` is how many `<img>` tags at
 * the top of the page keep loading at once, since the first images are the likeliest to be in the
 * first viewport; default 2. `iframes` adds `loading="lazy"` to `<iframe>` tags too; default false.
 */
export type LazyOptions = { skip?: number; iframes?: boolean };

/** `LazyOptions` with every default applied */
export type ResolvedLazyOptions = Required<LazyOptions>;

/** applies the defaults to `options` and refuses a `skip` that is not a whole number of 0 or more */
export function resolveLazyOptions(options: LazyOptions = {}): ResolvedLazyOptions {
	const skip = options.skip ?? 2;
	if (!Number.isInteger(skip) || skip < 0) {
		throw new ProtocolError(
			'bad-route',
			'images lazy.skip must be a whole number of 0 or more'
		);
	}
	return { skip, iframes: options.iframes === true };
}

/** a tag that says it loads some other way: its own `loading` or `fetchpriority`, or a lazy-loading library's data attribute */
function opted(tag: Tag): boolean {
	if (find(tag, 'loading') || find(tag, 'fetchpriority')) return true;
	return tag.attributes.some(
		(a) => a.name === 'data-src' || a.name === 'data-srcset' || a.name.startsWith('data-lazy')
	);
}

/** the `href` of every `<link rel="preload" as="image">` in `tags` */
function preloaded(tags: readonly Tag[]): Set<string> {
	const hrefs = new Set<string>();
	for (const tag of tags) {
		if (tag.name !== 'link') continue;
		const rel = (find(tag, 'rel')?.value ?? '').toLowerCase().split(/\s+/);
		const as = (find(tag, 'as')?.value ?? '').trim().toLowerCase();
		const href = find(tag, 'href')?.value.trim();
		if (rel.includes('preload') && as === 'image' && href) hrefs.add(href);
	}
	return hrefs;
}

/**
 * Adds `loading="lazy"` and `decoding="async"` to the `<img>` tags of `html` after the first
 * `skip`, and `loading="lazy"` to `<iframe>` tags with `iframes`, and says how many tags changed.
 * Tags inside `<head>`, `<noscript>` or an HTML comment are neither counted nor edited. A tag that
 * has `loading`, `fetchpriority`, `data-src`, `data-srcset` or a `data-lazy*` attribute, that sits
 * inside a `<header>`, or whose `src` a `<link rel="preload" as="image">` names, is counted toward
 * `skip` and left alone. A tag that already has `decoding` keeps it. Everything outside the edited
 * start tags stays byte for byte, and the edits are ASCII.
 */
export function rewriteLazy(
	html: string,
	options: LazyOptions = {}
): { html: string; rewritten: number } {
	const { skip, iframes } = resolveLazyOptions(options);
	const tags = tagsOf(html);
	const comments = commentRanges(html);
	const noscripts = noscriptRanges(html, tags);
	const head = headRange(html, tags);
	const headers = elementRanges(html, tags, 'header');
	const preloads = preloaded(tags);
	const edits: Edit[] = [];
	let seen = 0;
	let rewritten = 0;
	for (const tag of tags) {
		if (tag.name !== 'img' && !(iframes && tag.name === 'iframe')) continue;
		if (html[tag.end] !== '>') continue;
		if (within(comments, tag.start) || within(noscripts, tag.start)) continue;
		if (head && tag.start >= head[0] && tag.start < head[1]) continue;
		if (tag.name === 'img' && seen++ < skip) continue;
		if (opted(tag) || within(headers, tag.start)) continue;
		if (tag.name === 'img' && preloads.has((find(tag, 'src')?.value ?? '').trim())) continue;
		const added = ['loading="lazy"'];
		if (tag.name === 'img' && !find(tag, 'decoding')) added.push('decoding="async"');
		edits.push(appendAttributes(html, tag, added));
		rewritten++;
	}
	return { html: applyEdits(html, edits), rewritten };
}
