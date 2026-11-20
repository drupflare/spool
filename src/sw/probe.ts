/** what the worker's own fetch found in the disk cache: a hit, or a miss (any error is a miss) */
export type CacheProbe = 'hit' | 'miss';

/** a fetch that read from disk sends no body bytes over the wire, so its timing entry shows zero */
export function timingHit(entry: { encodedBodySize: number } | undefined): CacheProbe {
	return entry !== undefined && entry.encodedBodySize === 0 ? 'hit' : 'miss';
}

/** subresources are forwarded only after a hit; until the probe answers the browser keeps them */
export function shouldForward(probe: CacheProbe | undefined): boolean {
	return probe === 'hit';
}

/** the timing entry the worker's last fetch of `url` left in its own performance timeline */
export function resourceTiming(url: string): { encodedBodySize: number } | undefined {
	return performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming | undefined;
}

/** fetches an asset with `only-if-cached` and reads its timing; a rejected fetch is a miss */
export async function probeCache(
	url: string,
	fetcher: (input: string, init: RequestInit) => Promise<Response>,
	timing: (url: string) => { encodedBodySize: number } | undefined
): Promise<CacheProbe> {
	try {
		const response = await fetcher(url, { cache: 'only-if-cached', mode: 'same-origin' });
		await response.arrayBuffer();
		if (!response.ok) return 'miss';
		return timingHit(timing(url));
	} catch {
		return 'miss';
	}
}
