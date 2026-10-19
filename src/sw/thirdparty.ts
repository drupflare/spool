/** name of the Cache that holds third-party files; not versioned, since a versioned URL outlives a release */
export const THIRD_CACHE = 'spool-third';

/** how a held file is kept: `immutable` is never checked again, `revalidate` at a network moment once old */
export type VersionClass = 'immutable' | 'revalidate';

/** response headers the worker adds to a held copy */
export const THIRD_HEADERS = { class: 'x-spool-class', fetched: 'x-spool-fetched' } as const;

const YEAR = 31_536_000;

const STRONG = [/[._-][0-9a-f]{8,}(?=[._-]|$)/i, /[@/_-]v?\d+\.\d+\.\d+/, /\/v\d+(?:\/|$)/];

const WEAK = /[?&](?:v|ver|version|hash|h|rev)=[^&]+/i;

/**
 * Whether a cross-origin file is safe to answer from a copy, and how. A hash in the file name, a
 * semantic version, a `/v12/` path segment, or an origin that marks the file `immutable` or
 * `max-age` of a year or more means the URL names the bytes: `immutable`. A version in the query,
 * or a match for one of the site's own patterns, is a weaker claim: `revalidate`. Anything else is
 * null and goes to the network every time.
 */
export function versionClass(
	url: URL,
	headers: Headers,
	extra: readonly string[] = []
): VersionClass | null {
	if (STRONG.some((pattern) => pattern.test(url.pathname))) return 'immutable';
	const control = headers.get('cache-control') ?? '';
	if (/(?:^|,)\s*immutable\b/i.test(control)) return 'immutable';
	const age = /max-age=(\d+)/i.exec(control);
	if (age !== null && Number(age[1]) >= YEAR) return 'immutable';
	if (WEAK.test(url.search)) return 'revalidate';
	for (const source of extra) {
		try {
			if (new RegExp(source).test(url.href)) return 'revalidate';
		} catch {
			continue;
		}
	}
	return null;
}
