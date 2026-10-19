import type { Route } from '../../src/protocol/index';
import { createSpool, memorySink, type SpoolOptions } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { createRuntime, type Runtime } from '../../src/sw/runtime';
import { memoryStorage, type ReplicaStorage } from '../../src/sw/storage';
import { fakeCaches, nav, ORIGIN } from './helpers';

export const HTML = { 'content-type': 'text/html; charset=utf-8' };

export type RigOptions = {
	routes: Route[];
	/** the network render; return a 404 for a path the app does not know */
	app(request: Request): Response | Promise<Response>;
	spool?: Partial<SpoolOptions>;
	storage?: ReplicaStorage;
	random?: () => number;
	userAgent?: string;
};

/** a server and a worker runtime wired through one logged fetch, on a clock the test moves */
export function rig(options: RigOptions) {
	const store = memoryStore();
	const sink = memorySink();
	const spool = createSpool({
		routes: options.routes,
		store,
		sink,
		beacons: ['/cdn-cgi/rum'],
		...options.spool
	});
	/** `METHOD /path` for every request the worker or the page sent to the server */
	const log: string[] = [];
	/** the same with the query string */
	const urls: string[] = [];
	const artifacts: Array<{ text: string; url: string }> = [];
	const syncs: unknown[] = [];
	let online = true;

	const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as string, init);
		const url = new URL(request.url);
		log.push(`${request.method} ${url.pathname}`);
		urls.push(`${request.method} ${url.pathname}${url.search}`);
		if (!online) throw new TypeError('offline');
		const response = await spool.handle(request, options.app);
		if (url.pathname === '/.spool/artifact') {
			artifacts.push({ text: await response.clone().text(), url: url.search });
		}
		if (url.pathname === '/.spool/sync') syncs.push(await response.clone().json());
		return response;
	};

	let t = 1_700_000_000_000;
	const caches = fakeCaches();
	const storage = options.storage ?? memoryStorage();
	const make = (over: Partial<Parameters<typeof createRuntime>[0]> = {}): Runtime =>
		createRuntime({
			config: spool.config,
			storage,
			fetch: fetchImpl,
			caches,
			origin: ORIGIN,
			now: () => t,
			random: options.random,
			userAgent: options.userAgent,
			...over
		});
	const runtime = make();

	async function drive(request: Request, target = runtime): Promise<Response> {
		const waited: Promise<unknown>[] = [];
		const pending = target.handle(request, (p) => void waited.push(p));
		if (!pending) throw new Error('request was ignored');
		const response = await pending;
		await Promise.all(waited);
		return response;
	}

	return {
		spool,
		sink,
		store,
		log,
		urls,
		artifacts,
		syncs,
		runtime,
		storage,
		caches,
		make,
		drive,
		visit: async (path: string, target = runtime) => (await drive(nav(path), target)).text(),
		advance: (seconds: number) => void (t += seconds * 1000),
		/** the test clock, epoch milliseconds */
		t: () => t,
		offline: (value: boolean) => void (online = !value),
		/** clears the request logs so the next assertion sees only what follows */
		reset: () => {
			log.length = 0;
			urls.length = 0;
			artifacts.length = 0;
			syncs.length = 0;
		}
	};
}
