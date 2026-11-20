import type { Sink } from '../server/sink.js';

/** why spool will not keep a response on the device, from the proxy or `decorate` */
export type Decline =
	| 'method'
	| 'query'
	| 'authorization'
	| 'cookie'
	| 'status'
	| 'type'
	| 'set-cookie'
	| 'private'
	| 'no-store'
	| 'vary'
	| 'tags'
	| 'size'
	| 'charset';

/** what the verdict reads; `principal` is a route the caller declared for a signed-in visitor */
export type Candidate = {
	method: string;
	/** the search part of the page URL, empty when there is none */
	search: string;
	/** the headers of the request the visitor made */
	requestHeaders: Headers;
	response: Response;
	/** the tags the response named, before any default */
	tags: readonly string[];
	/** a `data` route answers any content type, a page must be HTML */
	data: boolean;
	principal: boolean;
};

/** the limits the verdict applies */
export type Gate = {
	publicCookies: ReadonlySet<string>;
	maxTags: number;
	maxBytes: number;
};

/**
 * `Vary` members that do not change the body once cookies are checked by name. The four `next-router`
 * and `rsc` names are the request headers Next uses to choose its RSC payload over the document; a
 * response to a request without them is the same HTML for every visitor, and a payload response is
 * not HTML, so `decorate` never keeps it.
 */
const STABLE_VARY = new Set([
	'accept-encoding',
	'cookie',
	'rsc',
	'next-router-state-tree',
	'next-router-prefetch',
	'next-router-segment-prefetch'
]);

/** the cookie names a `Cookie` header carries */
export function cookieNames(header: string | null): string[] {
	if (!header) return [];
	return header
		.split(';')
		.map((part) => part.split('=')[0]?.trim() ?? '')
		.filter((name) => name !== '');
}

/** whether a response sets a cookie whose name is not on the allowlist */
export function setsPrivateCookie(headers: Headers, publicCookies: ReadonlySet<string>): boolean {
	return headers
		.getSetCookie()
		.some((line) => !publicCookies.has(line.split('=')[0]?.trim() ?? ''));
}

const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8']);

/** the lowercase `charset` a `Content-Type` value names, or null */
export function headerCharset(contentType: string | null): string | null {
	const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '');
	return match ? (match[1] as string).toLowerCase() : null;
}

/**
 * The lowercase charset an HTML response declares, from its `Content-Type` or else a `<meta>` in
 * its first 1024 bytes, or null when it declares none.
 */
export function htmlCharset(headers: Headers, bytes: Uint8Array): string | null {
	const header = headerCharset(headers.get('content-type'));
	if (header) return header;
	const head = String.fromCharCode(...bytes.subarray(0, 1024));
	const meta = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head);
	return meta ? (meta[1] as string).toLowerCase() : null;
}

/** whether `charset` is UTF-8; a page that declares none is read as UTF-8 */
export function isUtf8(charset: string | null): boolean {
	return charset === null || UTF8_LABELS.has(charset);
}

/** the lowercase directive names of a `Cache-Control` value; a `private="x"` counts as `private` */
function directives(value: string | null): Set<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((part) => (part.split('=')[0] ?? '').trim().toLowerCase())
			.filter((name) => name !== '')
	);
}

/**
 * The first reason a response's own headers keep it from being kept: a `Set-Cookie` off the
 * allowlist, `private` unless `principal`, `no-store`, or a `Vary` other than encoding or cookies.
 * `decorate` runs it for a public route with an empty allowlist, so any cookie declines there.
 */
export function responseDecline(
	headers: Headers,
	publicCookies: ReadonlySet<string>,
	principal: boolean
): Decline | null {
	if (setsPrivateCookie(headers, publicCookies)) return 'set-cookie';
	const control = directives(headers.get('cache-control'));
	if (!principal && control.has('private')) return 'private';
	if (control.has('no-store')) return 'no-store';
	const vary = (headers.get('vary') ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== '');
	if (vary.some((name) => !STABLE_VARY.has(name))) return 'vary';
	return null;
}

/**
 * The first reason the response may not be answered locally, or `null` when it may. Everything
 * here declines: a request with a cookie outside the allowlist or an `Authorization` header, a
 * query string, a non-200, a body that is not HTML, a page whose `Content-Type` names a charset
 * other than UTF-8, a `Set-Cookie` off the allowlist, `private`, `no-store`, a `Vary`
 * that is not about encoding or cookies, and more tags than the gate allows. A `principal` route
 * stands for a visitor the caller's `identity` resolves, so the cookie, `Authorization` and
 * `private` rules do not apply to it.
 */
export function decline(input: Candidate, gate: Gate): Decline | null {
	const { response, principal } = input;
	if (input.method !== 'GET' && input.method !== 'HEAD') return 'method';
	if (input.search !== '') return 'query';
	if (!principal) {
		if (input.requestHeaders.has('authorization')) return 'authorization';
		const cookies = cookieNames(input.requestHeaders.get('cookie'));
		if (cookies.some((name) => !gate.publicCookies.has(name))) return 'cookie';
	}
	if (response.status !== 200) return 'status';
	const type = (response.headers.get('content-type') ?? '').toLowerCase();
	if (!input.data && !type.includes('text/html')) return 'type';
	// the stored copy is UTF-8 text, so a page in another charset would come back garbled
	if (!input.data && !isUtf8(headerCharset(type))) return 'charset';
	const why = responseDecline(response.headers, gate.publicCookies, principal);
	if (why) return why;
	if (input.tags.length > gate.maxTags) return 'tags';
	const length = Number(response.headers.get('content-length'));
	if (Number.isFinite(length) && length > gate.maxBytes) return 'size';
	return null;
}

/** where a declined response is written to the sink, as JSON `{ kind: 'decline', reason, route, source }` */
export const DECLINE_PATH = '/.spool/decline';

/**
 * Which check declined: `gate` is `decorate`'s check of an in-process response, `navigation` the
 * proxy's check of the page a visitor asked for, `artifact` the proxy's check of the copy it fetches
 * for `/.spool/artifact`. The proxy declines one page at both when a worker asks for its artifact.
 */
export type DeclineSource = 'gate' | 'navigation' | 'artifact';

/**
 * Writes one decline event to `sink` and waits for it, as `/.spool/beacon` does. `route` is the
 * declared route pattern, never the request path, so the event carries no id from a URL. A sink that
 * throws or rejects never breaks the response. Does nothing without a sink.
 */
export async function recordDecline(
	sink: Sink | undefined,
	reason: Decline,
	route: string,
	source: DeclineSource
): Promise<void> {
	if (!sink) return;
	try {
		await sink.write([
			{
				path: DECLINE_PATH,
				body: JSON.stringify({ kind: 'decline', reason, route, source }),
				contentType: 'application/json',
				at: Date.now()
			}
		]);
	} catch {
		// a failing sink never breaks a page
	}
}
