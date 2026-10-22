import { ProtocolError } from '../protocol/errors.js';
import { tagsOf } from '../trim/tokens.js';
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
 * What `images.responsive` adds to an `<img>`: one `srcset` candidate per width, each the image's
 * own URL with `spool-w=<width>`, and `sizes` when the tag has none. `widths` is a fixed list, since
 * the proxy only answers a width from it; default 320, 480, 640, 960, 1280 and 1920. `sizes` defaults
 * to `100vw`, which asks for the widest candidate the screen can use, so name the real layout width
 * here for a site whose images fill less of the page.
 */
export type ResponsiveOptions = { widths?: readonly number[]; sizes?: string };

/** `ResponsiveOptions` with every default applied, the widths sorted and unique */
export type ResolvedResponsiveOptions = { widths: readonly number[]; sizes: string };

/** the query parameter that names a width; the proxy removes it before the request reaches the origin */
export const RESPONSIVE_PARAM = 'spool-w';

const DEFAULT_WIDTHS = [320, 480, 640, 960, 1280, 1920];
const MAX_WIDTH = 16384;

/** applies the defaults to `options` and refuses a width or a `sizes` it cannot use with a `ProtocolError` */
export function resolveResponsiveOptions(
	options: ResponsiveOptions = {}
): ResolvedResponsiveOptions {
	const widths = options.widths ?? DEFAULT_WIDTHS;
	if (
		widths.length === 0 ||
		!widths.every((w) => Number.isInteger(w) && w >= 1 && w <= MAX_WIDTH)
	) {
		throw new ProtocolError(
			'bad-route',
			`images responsive.widths must be a list of integers from 1 to ${MAX_WIDTH}`
		);
	}
	const sizes = (options.sizes ?? '100vw').trim();
	if (sizes === '' || /[\u0000-\u001f]/.test(sizes)) {
		throw new ProtocolError(
			'bad-route',
			'images responsive.sizes must be a non-empty single line'
		);
	}
	return { widths: [...new Set(widths)].sort((a, b) => a - b), sizes };
}

/**
 * The query string with every `spool-w` parameter removed, and the width the last one named when it
 * is one of `widths`. A value that is not a listed width is dropped without a width, so the request
 * is answered as if it had none.
 */
export function takeWidth(
	search: string,
	widths: readonly number[]
): { search: string; width?: number } {
	if (!search.includes(RESPONSIVE_PARAM)) return { search };
	const kept: string[] = [];
	let width: number | undefined;
	for (const piece of search.slice(1).split('&')) {
		const [name, value] = piece.split('=');
		if (name !== RESPONSIVE_PARAM) {
			kept.push(piece);
		} else if (
			value !== undefined &&
			/^\d{1,5}$/.test(value) &&
			widths.includes(Number(value))
		) {
			width = Number(value);
		}
	}
	const rest = kept.length > 0 ? `?${kept.join('&')}` : '';
	return width === undefined ? { search: rest } : { search: rest, width };
}

const escape = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Adds `srcset` (and `sizes`, when absent) to the `<img>` tags of `html` whose `src` is a
 * same-origin URL that `paths` matches, and says how many tags changed. A tag that has `srcset`,
 * `data-src` or `data-srcset`, sits inside `<picture>`, `<noscript>`, `<head>` or an HTML comment,
 * names no usable `src` (empty, a data URL, another origin, a path `paths` does not match, one that
 * already carries `spool-w`, or one with a space, comma, quote or fragment in it) is left alone. The
 * original `src` stays as the fallback. `pageUrl` resolves a relative `src`. Everything outside the
 * edited start tags stays byte for byte, and the edits are ASCII.
 */
export function rewriteResponsive(
	html: string,
	options: ResponsiveOptions,
	context: { pageUrl: string; paths: RegExp }
): { html: string; rewritten: number } {
	const { widths, sizes } = resolveResponsiveOptions(options);
	const page = new URL(context.pageUrl);
	const tags = tagsOf(html);
	const comments = commentRanges(html);
	const noscripts = noscriptRanges(html, tags);
	const pictures = elementRanges(html, tags, 'picture');
	const head = headRange(html, tags);
	const edits: Edit[] = [];
	for (const tag of tags) {
		if (tag.name !== 'img' || html[tag.end] !== '>') continue;
		if (within(comments, tag.start) || within(noscripts, tag.start)) continue;
		if (within(pictures, tag.start)) continue;
		if (head && tag.start >= head[0] && tag.start < head[1]) continue;
		if (find(tag, 'srcset') || find(tag, 'data-src') || find(tag, 'data-srcset')) continue;
		const src = (find(tag, 'src')?.value ?? '').trim();
		if (src === '' || /[\s,"'<>#]/.test(src)) continue;
		let target: URL;
		try {
			target = new URL(src.replace(/&amp;/gi, '&'), page);
		} catch {
			continue;
		}
		if (target.origin !== page.origin || target.searchParams.has(RESPONSIVE_PARAM)) continue;
		context.paths.lastIndex = 0;
		if (!context.paths.test(target.pathname)) continue;
		const joint = src.includes('?') ? '&amp;' : '?';
		const candidates = widths.map((w) => `${src}${joint}${RESPONSIVE_PARAM}=${w} ${w}w`);
		const added = [`srcset="${candidates.join(', ')}"`];
		if (!find(tag, 'sizes')) added.push(`sizes="${escape(sizes)}"`);
		edits.push(appendAttributes(html, tag, added));
	}
	return { html: applyEdits(html, edits), rewritten: edits.length };
}
