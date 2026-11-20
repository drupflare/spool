import type { BundleDelta } from '../protocol/bundle.js';
import { BUNDLE_DELTA_PREFIX } from '../protocol/config.js';
import { HEADERS } from '../protocol/envelope.js';
import { writeFor, type ResourceWrite } from '../protocol/write.js';
import type { PackHead, PackStore } from '../sw/pack/store.js';
import { settleWrite } from '../sw/write.js';
import { holdCookie } from './bootstrap.js';

/** what `declaredFetch` takes; `origin` is the page's own origin */
export type DeclaredFetchOptions = {
	store: PackStore;
	/** the declared resource writes of the site, from the ring or the writes element */
	writes: readonly ResourceWrite[];
	origin: string;
	/** sends the request; default `fetch` */
	fetch?: typeof fetch;
	/** writes the held-version cookie; default sets `document.cookie` */
	cookie?: (value: string) => void;
};

/** the request function `spool.fetch` is: `fetch` for every request, settling declared writes */
export type SpoolFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` for a page without a worker. A request that matches a declared resource write in the ring
 * goes out with `Spool-Have` naming the held version, and its answer settles into the store the way the
 * worker settles it. Every other request is passed to `fetch` unchanged.
 */
/** the declared writes a writes element holds; anything but a JSON list reads as none */
export function parseWrites(text: string | null | undefined): ResourceWrite[] {
	if (!text) return [];
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? (value as ResourceWrite[]) : [];
	} catch {
		return [];
	}
}

export function declaredFetch(options: DeclaredFetchOptions): SpoolFetch {
	const send = options.fetch ?? fetch;
	const { store, writes, origin } = options;
	const fetchDelta = async (from: number, to: number): Promise<BundleDelta> => {
		const response = await send(`${origin}${BUNDLE_DELTA_PREFIX}${from}/${to}`, {
			credentials: 'same-origin'
		});
		if (!response.ok) throw new Error(`delta answered ${response.status}`);
		return (await response.json()) as BundleDelta;
	};
	return async (input, init) => {
		const target = new URL(input instanceof Request ? input.url : String(input), origin);
		const base = input instanceof Request ? input : undefined;
		const method = (init?.method ?? base?.method ?? 'GET').toUpperCase();
		const declared = writeFor(writes, method, target, origin);
		if (!declared) return send(input, init);
		const head = (await store.head()) as (PackHead & { partial?: boolean }) | undefined;
		const headers = new Headers(init?.headers ?? base?.headers);
		if (head && head.partial !== true) headers.set(HEADERS.have, String(head.version));
		const text = typeof init?.body === 'string' ? init.body : undefined;
		const response = await send(target.href, {
			...init,
			method,
			headers,
			body: text,
			cache: 'no-store',
			credentials: 'same-origin'
		});
		if (response.ok) {
			const body: unknown = text === undefined ? undefined : JSON.parse(text);
			await settleWrite(response, store, fetchDelta, declared.origin ?? origin, {
				write: declared,
				url: target,
				body,
				routes: await store.getRoutes()
			}).catch(() => undefined);
			const after = (await store.head()) as (PackHead & { partial?: boolean }) | undefined;
			if (after && after.partial !== true) holdCookie(options, after.version);
		}
		return response;
	};
}
