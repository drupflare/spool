/** the attribute that marks the page runtime script, so it is never injected twice */
export const CLIENT_TAG_ATTR = 'data-spool-client';

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** the script tag for the page runtime; `integrity` makes it a cross-origin, SRI-checked load */
export function clientTag(options: { src: string; integrity?: string }): string {
	const sri = options.integrity
		? ` integrity="${escapeAttr(options.integrity)}" crossorigin="anonymous"`
		: '';
	return `<script src="${escapeAttr(options.src)}"${sri} defer ${CLIENT_TAG_ATTR}></script>`;
}

/**
 * Puts `tag` before `</head>`, else before `</body>`, else at the end. A page that already has
 * the runtime tag is returned unchanged, so the server and the worker can both call this.
 */
export function injectClientTag(html: string, tag: string): string {
	if (html.includes(CLIENT_TAG_ATTR)) return html;
	for (const close of [/<\/head\s*>/i, /<\/body\s*>/i]) {
		const at = html.search(close);
		if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
	}
	return html + tag;
}
