/** the attribute that marks the page runtime script, so it is never injected twice */
export const CLIENT_TAG_ATTR = 'data-spool-client';

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** the attribute for a worker mode; `auto` writes none, and a client that predates `always` reads it as `auto` */
function workerAttr(worker?: 'auto' | 'never' | 'always'): string {
	return worker === 'never' || worker === 'always' ? ` data-spool-worker="${worker}"` : '';
}

/**
 * the script tag for the page runtime; `integrity` makes it a cross-origin, SRI-checked load, and
 * `worker: 'never'` tells the page it must not ask for a worker, and `'always'` that it may ask on WebKit
 */
export function clientTag(options: {
	src: string;
	integrity?: string;
	worker?: 'auto' | 'never' | 'always';
}): string {
	const sri = options.integrity
		? ` integrity="${escapeAttr(options.integrity)}" crossorigin="anonymous"`
		: '';
	return `<script src="${escapeAttr(options.src)}"${sri}${workerAttr(options.worker)} defer ${CLIENT_TAG_ATTR}></script>`;
}

/** the attribute that marks the inline gate, which stands in for the script tag on a second-view page */
export const GATE_ATTR = 'data-spool-gate';

/**
 * the inline gate in place of `clientTag`: `source` is the built gate script, and the attributes
 * name the client it loads, with its integrity and worker mode. `held` lists the paths a click may
 * load the boot script for: a prefix such as `/courses/` for a page with no query string, or `?` and a
 * path for a list that answers a query string.
 */
export function gateTag(
	options: {
		src: string;
		integrity?: string;
		worker?: 'auto' | 'never' | 'always';
		held?: readonly string[];
		/** the worker script's lease in seconds; the gate counts views inside one lease period */
		lease?: number;
	},
	source: string
): string {
	const sri = options.integrity ? ` data-integrity="${escapeAttr(options.integrity)}"` : '';
	const held = options.held?.length ? ` data-held="${escapeAttr(options.held.join(' '))}"` : '';
	const lease = options.lease === undefined ? '' : ` data-lease="${options.lease}"`;
	return `<script ${GATE_ATTR} data-src="${escapeAttr(options.src)}"${sri}${workerAttr(options.worker)}${held}${lease}>${source}</script>`;
}

/**
 * Puts `tag` before `</head>`, else before `</body>`, else at the end. A page that already has
 * the runtime tag or the gate is returned unchanged, so the server and the worker can both call this.
 */
export function injectClientTag(html: string, tag: string): string {
	if (html.includes(CLIENT_TAG_ATTR) || html.includes(GATE_ATTR)) return html;
	for (const close of [/<\/head\s*>/i, /<\/body\s*>/i]) {
		const at = html.search(close);
		if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
	}
	return html + tag;
}
