/**
 * Response headers that carry cache tags, with the separator each vendor documents:
 * Cloudflare `Cache-Tag` takes commas, Fastly `Surrogate-Key` and Drupal `X-Drupal-Cache-Tags` take
 * spaces, Varnish `xkey` takes spaces or commas. A header sent twice reaches `Headers.get` joined
 * with a comma and a space, so the space-separated forms also split on that join.
 */
const SEPARATORS: Record<string, RegExp> = {
	'cache-tag': /\s*,\s*/,
	'surrogate-key': /,?\s+/,
	'x-drupal-cache-tags': /,?\s+/,
	xkey: /[\s,]+/
};

/** the tag headers {@link readTags} understands, lowercase */
export const TAG_HEADERS: readonly string[] = Object.keys(SEPARATORS);

/** every tag the response names across all four headers, in first-seen order, without repeats */
export function readTags(headers: Headers): string[] {
	const tags = new Set<string>();
	for (const [name, separator] of Object.entries(SEPARATORS)) {
		const value = headers.get(name);
		if (value === null) continue;
		for (const tag of value.trim().split(separator)) if (tag !== '') tags.add(tag);
	}
	return [...tags];
}

/** removes every tag header, so the browser never sees the site's cache vocabulary */
export function stripTags(headers: Headers): void {
	for (const name of TAG_HEADERS) headers.delete(name);
}

/** the tag a page with no tag header depends on */
export function pathTag(path: string): string {
	return `proxy:path:${path}`;
}
