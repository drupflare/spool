import { stripInline } from './inline.js';

/** what to blank out before comparing; each pattern is replaced wherever it matches */
export type NormaliseOptions = { ignore?: readonly RegExp[] };

const IGNORED = '\u0000';

/**
 * Reduces markup to what two renders of the same page must share: comments and the inline
 * artifact element removed, runs of whitespace collapsed to one space, whitespace between tags
 * dropped, and every `ignore` match blanked (a per-render nonce, say). It does not reorder
 * attributes or fix tag soup.
 */
export function normalise(html: string, options: NormaliseOptions = {}): string {
	let out = stripInline(html).replace(/<!--[\s\S]*?-->/g, '');
	for (const pattern of options.ignore ?? []) {
		const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
		out = out.replace(new RegExp(pattern.source, flags), IGNORED);
	}
	return out.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

/** the verdict of {@link equivalent}; a mismatch names where the two first differ */
export type Equivalence = { equal: true } | { equal: false; at: number; reason: string };

/** whether two renders match after {@link normalise}; the reason quotes 80 characters of each */
export function equivalent(a: string, b: string, options: NormaliseOptions = {}): Equivalence {
	const left = normalise(a, options);
	const right = normalise(b, options);
	if (left === right) return { equal: true };
	let at = 0;
	while (at < left.length && left[at] === right[at]) at++;
	return {
		at,
		equal: false,
		reason: `diverges at ${at}: ${JSON.stringify(left.slice(at, at + 80))} vs ${JSON.stringify(right.slice(at, at + 80))}`
	};
}
