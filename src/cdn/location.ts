/** the host in front of the `drupflare-cdn` bucket */
export const CDN_ORIGIN = 'https://cdn.drupflare.com';

/** the key prefix under which every spool build is published */
export const CDN_PREFIX = 'spool';

/** the bucket prefix of one release; its keys are never overwritten */
export function releasePrefix(version: string): string {
	return `${CDN_PREFIX}/${encodeURIComponent(version)}`;
}

/**
 * The URL a release's page runtime is served from. `createSpool` puts it in the script tag when
 * `cdn` names only an integrity hash, so the tag, the bucket key and `build:cdn` share one path.
 */
export function cdnClientUrl(version: string): string {
	return `${CDN_ORIGIN}/${releasePrefix(version)}/client.js`;
}

/**
 * The URL a release's worker core is served from, for the `importScripts` line of the stub when
 * `cdn.worker` is set. `hash` is the core's `shellHash`, so the URL names the exact bytes and a
 * changed core is a new URL.
 */
export function cdnWorkerUrl(version: string, hash: string): string {
	return `${CDN_ORIGIN}/${releasePrefix(version)}/spool-sw.js?h=${hash}`;
}
