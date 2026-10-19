import { IDBFactory } from 'fake-indexeddb';
import { type Artifact, type SyncResponse } from '../../src/protocol/index';
import type { CachesLike } from '../../src/sw/runtime';

export const ORIGIN = 'https://site.test';

/** a template artifact; fields override the defaults */
export function artifact(over: Partial<Artifact> & { id?: string } = {}): Artifact {
	return {
		protocol: 1,
		id: '/node/1',
		scope: 'public',
		strategy: 'template',
		deps: ['node:1'],
		vector: 1,
		body: { data: { id: '1' } },
		...over
	} as Artifact;
}

/** a sync response; fields override the defaults */
export function syncOf(over: Partial<SyncResponse> = {}): SyncResponse {
	return { protocol: 1, cursor: 0, changed: {}, dropped: [], reset: false, ...over };
}

/** a Request whose mode is `navigate`, which the Request constructor will not accept */
export function nav(url: string, init: RequestInit = {}): Request {
	const request = new Request(new URL(url, ORIGIN), init);
	Object.defineProperty(request, 'mode', { value: 'navigate' });
	return request;
}

/** a Request as a page script would make it */
export function sub(url: string, init: RequestInit = {}): Request {
	const request = new Request(new URL(url, ORIGIN), init);
	Object.defineProperty(request, 'mode', { value: 'cors' });
	return request;
}

/** CacheStorage in a Map, keyed by URL */
export function fakeCaches(): CachesLike & { names(): string[] } {
	const stores = new Map<string, Map<string, Response>>();
	return {
		open: async (name) => {
			const store = stores.get(name) ?? new Map<string, Response>();
			stores.set(name, store);
			return {
				match: async (request) => store.get(request.url)?.clone(),
				put: async (request, response) => void store.set(request.url, response),
				keys: async () => [...store.keys()].map((url) => new Request(url)),
				delete: async (request) => store.delete(request.url)
			};
		},
		keys: async () => [...stores.keys()],
		delete: async (name) => stores.delete(name),
		names: () => [...stores.keys()]
	};
}

/** a fresh in-memory IndexedDB */
export const freshIndexedDB = () => new IDBFactory();
