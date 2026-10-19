/** what {@link trimCss} returns */
export type TrimResult = {
	/** the stylesheet with the provably unmatched style rules removed */
	css: string;
	/** style rules removed, nested ones included */
	removedRules: number;
	/** sorted tokens whose absence removed at least one rule: one per selector of each removed rule */
	missing: string[];
};

const NESTING = new Set(['media', 'supports', 'layer', 'container', 'scope']);
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

const isWord = (code: number) =>
	(code >= 48 && code <= 57) ||
	(code >= 65 && code <= 90) ||
	(code >= 97 && code <= 122) ||
	code === 45 ||
	code === 95;

const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c);

function skipComment(css: string, at: number): number {
	const end = css.indexOf('*/', at + 2);
	return end < 0 ? -1 : end + 2;
}

function skipString(css: string, at: number): number {
	const quote = css[at];
	for (let i = at + 1; i < css.length; i++) {
		const c = css[i];
		if (c === '\\') i++;
		else if (c === quote) return i + 1;
		else if (c === '\n') return -1;
	}
	return -1;
}

/** the index after the group that opens at `start` (`(`, `[` or `{`), or -1 when the text ends first */
function skipGroup(css: string, start: number): number {
	const stack: string[] = [];
	let i = start;
	while (i < css.length) {
		const c = css[i] as string;
		if (c === '\\') {
			i += 2;
		} else if (c === '/' && css[i + 1] === '*') {
			i = skipComment(css, i);
			if (i < 0) return -1;
		} else if (c === '"' || c === "'") {
			i = skipString(css, i);
			if (i < 0) return -1;
		} else if (c === '(' && /url$/i.test(css.slice(Math.max(0, i - 3), i)) && bare(css, i)) {
			let j = i + 1;
			while (j < css.length && css[j] !== ')') j += css[j] === '\\' ? 2 : 1;
			if (j >= css.length) return -1;
			i = j + 1;
			if (stack.length === 0) return i;
		} else if (c in OPENERS) {
			stack.push(OPENERS[c] as string);
			i++;
		} else if (c === ')' || c === ']' || c === '}') {
			if (stack.pop() !== c) return -1;
			i++;
			if (stack.length === 0) return i;
		} else {
			i++;
		}
	}
	return -1;
}

/** whether the `url(` at `open` holds an unquoted address */
function bare(css: string, open: number): boolean {
	let i = open + 1;
	while (i < css.length && /\s/.test(css[i] as string)) i++;
	return css[i] !== '"' && css[i] !== "'";
}

/** where a prelude ends: the index of its `{` or `;`, or -1 when the parser has lost its place */
function skipPrelude(css: string, start: number): number {
	let i = start;
	while (i < css.length) {
		const c = css[i] as string;
		if (c === '\\') {
			i += 2;
		} else if (c === '/' && css[i + 1] === '*') {
			i = skipComment(css, i);
			if (i < 0) return -1;
		} else if (c === '"' || c === "'") {
			i = skipString(css, i);
			if (i < 0) return -1;
		} else if (c === '(' || c === '[') {
			i = skipGroup(css, i);
			if (i < 0) return -1;
		} else if (c === '{' || c === ';') {
			return i;
		} else if (c === '}' || c === ')' || c === ']') {
			return -1;
		} else {
			i++;
		}
	}
	return -1;
}

function readIdent(text: string, start: number): { end: number; plain: boolean } {
	let i = start;
	let plain = true;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 92) {
			plain = false;
			i++;
			if (isHex(text[i])) {
				for (let n = 0; n < 6 && isHex(text[i]); n++) i++;
				if (/\s/.test(text[i] ?? '')) i++;
			} else {
				i++;
			}
		} else if (isWord(code)) {
			i++;
		} else if (code >= 0x80) {
			plain = false;
			i++;
		} else {
			break;
		}
	}
	return { end: i, plain };
}

function splitList(text: string): string[] {
	const parts: string[] = [];
	let from = 0;
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === '\\') {
			i += 2;
		} else if (c === '"' || c === "'") {
			const end = skipString(text, i);
			i = end < 0 ? text.length : end;
		} else if (c === '(' || c === '[') {
			const end = skipGroup(text, i);
			i = end < 0 ? text.length : end;
		} else {
			if (c === ',') {
				parts.push(text.slice(from, i));
				from = i + 1;
			}
			i++;
		}
	}
	parts.push(text.slice(from));
	return parts.map((part) => part.trim());
}

/**
 * The first class, id or type a selector needs that `tokens` lacks, or null when the selector may
 * match. Pseudo-classes and pseudo-elements are skipped with their arguments, so `:is`, `:where`,
 * `:not` and `:has` never prove anything. An attribute selector, `*`, `&`, `html`, `body`, an
 * escaped or non-ASCII identifier and a namespace prefix need nothing. Text the scanner does not
 * understand gives null.
 */
function firstMissing(
	selector: string,
	tokens: ReadonlySet<string>,
	lower: ReadonlySet<string>
): string | null {
	let found: string | null = null;
	let compound = true;
	// a quirks-mode page matches classes and ids in any ASCII case, so any case keeps a rule
	const need = (token: string) => {
		if (found === null && !tokens.has(token) && !lower.has(token.toLowerCase())) found = token;
	};
	let i = 0;
	while (i < selector.length) {
		const c = selector[i] as string;
		if (/\s/.test(c) || c === '>' || c === '+' || c === '~') {
			compound = true;
			i++;
		} else if (c === '*' || c === '&') {
			compound = false;
			i++;
		} else if (c === '.' || c === '#') {
			const { end, plain } = readIdent(selector, i + 1);
			if (end === i + 1) return null;
			if (plain) need(selector.slice(i + 1, end));
			compound = false;
			i = end;
		} else if (c === '[') {
			const end = skipGroup(selector, i);
			if (end < 0) return null;
			compound = false;
			i = end;
		} else if (c === ':') {
			i += selector[i + 1] === ':' ? 2 : 1;
			i = readIdent(selector, i).end;
			if (selector[i] === '(') {
				const end = skipGroup(selector, i);
				if (end < 0) return null;
				i = end;
			}
			compound = false;
		} else if (isWord(c.charCodeAt(0)) || c === '\\' || c.charCodeAt(0) >= 0x80) {
			const { end, plain } = readIdent(selector, i);
			const name = selector.slice(i, end).toLowerCase();
			if (compound && plain && name !== 'html' && name !== 'body') need(name);
			compound = false;
			i = end;
		} else {
			return null;
		}
	}
	return found;
}

type Walk = {
	tokens: ReadonlySet<string>;
	lower: ReadonlySet<string>;
	missing: Set<string>;
	removed: number;
};

function trimSheet(css: string, walk: Walk): string {
	let out = '';
	let i = 0;
	while (i < css.length) {
		const c = css[i] as string;
		if (/\s/.test(c)) {
			out += c;
			i++;
			continue;
		}
		if (c === '/' && css[i + 1] === '*') {
			const end = skipComment(css, i);
			if (end < 0) return out + css.slice(i);
			out += css.slice(i, end);
			i = end;
			continue;
		}
		const open = skipPrelude(css, i);
		if (open < 0) return out + css.slice(i);
		const prelude = css.slice(i, open);
		if (css[open] === ';') {
			if (c !== '@') return out + css.slice(i);
			out += css.slice(i, open + 1);
			i = open + 1;
			continue;
		}
		const end = skipGroup(css, open);
		if (end < 0) return out + css.slice(i);
		if (c === '@') {
			const name = /^@([a-zA-Z-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
			out += NESTING.has(name)
				? `${css.slice(i, open + 1)}${trimSheet(css.slice(open + 1, end - 1), walk)}}`
				: css.slice(i, end);
		} else {
			const selectors = splitList(prelude.replace(/\/\*[\s\S]*?\*\//g, ' '));
			const gaps = selectors.map((s) =>
				s === '' ? null : firstMissing(s, walk.tokens, walk.lower)
			);
			if (gaps.every((gap) => gap !== null)) {
				walk.removed++;
				for (const gap of gaps) walk.missing.add(gap as string);
				out = out.trimEnd();
			} else {
				out += css.slice(i, end);
			}
		}
		i = end;
	}
	return out;
}

/**
 * Removes the style rules that no page of a site can match, keeping everything else byte for byte.
 *
 * It borrows PurgeCSS's content rule: the default extractor "considers every word of a file as a
 * selector" (purgecss.com/extractors, web page read 2026-10-19), so a word that appears anywhere
 * keeps the rules that name it. It differs on purpose. PurgeCSS needs a `safelist` for what the
 * content never spells out, and this function has none: a rule stays whenever the scanner cannot
 * prove it unmatched, and tokens come from every page and script of the site, not from one build.
 *
 * - A style rule is removed when every selector of its list needs a class, id or type token that
 *   `tokens` lacks. One selector that may match keeps the rule.
 * - Type names compare in lowercase, and a class or id present in any ASCII case keeps a rule,
 *   since a quirks-mode page matches them that way. `html`, `body`, `*`, `&`, attribute selectors, escaped and
 *   non-ASCII identifiers and namespaced selectors never count against a rule.
 * - Pseudo-classes and pseudo-elements are ignored with their arguments, so `.a:hover` needs `a`,
 *   and anything inside `:is`, `:where`, `:not` and `:has` is never examined.
 * - `@media`, `@supports`, `@layer`, `@container` and `@scope` are walked into and their shells
 *   stay, even when emptied, because an empty `@layer` still orders layers. Every other at-rule
 *   (`@font-face`, `@keyframes`, `@import`, `@property`, `@page`, `@charset`, `@namespace`,
 *   `@counter-style`) is kept whole.
 * - Rules are only removed, never reordered or rewritten, so the cascade of what remains is
 *   unchanged. Whitespace before a removed rule goes with it.
 * - When the scanner meets an unterminated comment, string or block, an unmatched closing bracket
 *   or a stray declaration, it keeps the rest of the file as it was.
 *
 * `missing` holds one absent token for each selector of each removed rule. A page whose tokens
 * contain none of them cannot match any removed rule.
 */
export function trimCss(css: string, tokens: ReadonlySet<string>): TrimResult {
	const lower = new Set([...tokens].map((token) => token.toLowerCase()));
	const walk: Walk = { tokens, lower, missing: new Set(), removed: 0 };
	const trimmed = trimSheet(css, walk);
	return { css: trimmed, removedRules: walk.removed, missing: [...walk.missing].sort() };
}
