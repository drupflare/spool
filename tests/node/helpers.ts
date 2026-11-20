import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
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

/** the object with every method call logged by name, so a test sees each read and write it makes */
export function tapped<T extends object>(target: T, calls: string[]): T {
	return new Proxy(target, {
		get(obj, key) {
			const value: unknown = Reflect.get(obj, key);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				calls.push(String(key));
				return Reflect.apply(value, obj, args);
			};
		}
	});
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

// idbStorage builds its key ranges from the global, which a worker has and node does not
Object.assign(globalThis, { IDBKeyRange });

/** a fresh in-memory IndexedDB */
export const freshIndexedDB = () => new IDBFactory();
