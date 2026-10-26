/** the opening tag of the element that carries a page's own artifact */
export const INLINE_OPEN = '<script type="application/spool+json" data-spool-artifact>';

const INLINE_CLOSE = '</script>';

const UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/** `json` with every character that could end or confuse a script element written as a `\u` escape */
export function escapeInline(json: string): string {
	return json.replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** the script element that carries `text`, which must already be escaped */
export function inlineElement(text: string): string {
	return `${INLINE_OPEN}${text}${INLINE_CLOSE}`;
}

/**
 * `html` with the element placed before the last `</body>`, or at the end when the page has none.
 */
export function placeInline(html: string, element: string): string {
	let at = -1;
	for (const match of html.matchAll(/<\/body\s*>/gi)) at = match.index;
	return at < 0 ? html + element : html.slice(0, at) + element + html.slice(at);
}

/** the text of the last inline element in `html`, or null when there is none */
export function readInline(html: string): string | null {
	const open = html.lastIndexOf(INLINE_OPEN);
	if (open < 0) return null;
	const from = open + INLINE_OPEN.length;
	const close = html.indexOf(INLINE_CLOSE, from);
	return close < 0 ? null : html.slice(from, close);
}

/** `html` without any inline element, which is data and no part of the page */
export function stripInline(html: string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const open = html.indexOf(INLINE_OPEN, at);
		const close = open < 0 ? -1 : html.indexOf(INLINE_CLOSE, open + INLINE_OPEN.length);
		if (close < 0) return out + html.slice(at);
		out += html.slice(at, open);
		at = close + INLINE_CLOSE.length;
	}
}
