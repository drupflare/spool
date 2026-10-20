import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** how a page's `fetch` of one small asset is answered, one arm per path a request can take */
export const SW_ARMS = ['http-cache', 'sw-cache', 'sw-pass', 'revalidate', 'network-200'] as const;

export type SwArm = (typeof SW_ARMS)[number];

export const ASSET_BYTES = 4096;

/** the asset each arm fetches, which fixes the headers it is served with */
export const ARM_ASSET: Record<SwArm, string> = {
	'http-cache': '/asset/immutable',
	'sw-cache': '/asset/immutable',
	'sw-pass': '/asset/immutable',
	revalidate: '/asset/revalidate',
	'network-200': '/asset/nostore'
};

/** the arms whose requests never leave the browser run longer windows than the ones that hit the origin */
export const requestsFor = (arm: SwArm, base: number) =>
	arm === 'revalidate' || arm === 'network-200' ? Math.round(base / 4) : base;

/** the worker for a service-worker arm: counts every fetch event, and `sw-cache` answers the asset from CacheStorage */
export function swSource(arm: 'sw-cache' | 'sw-pass'): string {
	return `
let events = 0;
self.addEventListener('install', (e) => e.waitUntil(${
		arm === 'sw-cache'
			? `caches.open('v').then((c) => c.add('${ARM_ASSET[arm]}')).then(() => self.skipWaiting())`
			: 'self.skipWaiting()'
	}));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => e.ports[0].postMessage(events));
self.addEventListener('fetch', (e) => {
	events++;${
		arm === 'sw-cache'
			? `
	if (new URL(e.request.url).pathname === '${ARM_ASSET[arm]}') e.respondWith(caches.match(e.request));`
			: ''
	}
});
`;
}

/** an origin that serves the same 4,096 bytes under three header sets and counts hits per path */
export function startSwOrigin(port: number) {
	const body = Buffer.alloc(ASSET_BYTES, 0x61);
	const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
	const hits: Record<string, number> = {};
	let notModified = 0;
	return createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		if (path === '/__stats') {
			const cpu = process.cpuUsage();
			res.writeHead(200, { 'content-type': 'application/json' });
			return void res.end(
				JSON.stringify({ hits, notModified, cpuUs: cpu.user + cpu.system })
			);
		}
		hits[path] = (hits[path] ?? 0) + 1;
		if (path === '/') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			return void res.end('<!doctype html><title>sw-request</title>');
		}
		if (path === '/sw-cache.js' || path === '/sw-pass.js') {
			res.writeHead(200, {
				'content-type': 'text/javascript',
				'cache-control': 'max-age=86400'
			});
			return void res.end(swSource(path.slice(1, -3) as 'sw-cache' | 'sw-pass'));
		}
		const headers: Record<string, string | number> = {
			'content-type': 'image/png',
			'content-length': ASSET_BYTES
		};
		if (path === '/asset/immutable') {
			headers['cache-control'] = 'public, max-age=31536000, immutable';
		} else if (path === '/asset/revalidate') {
			headers['cache-control'] = 'max-age=0, must-revalidate';
			headers.etag = etag;
			if (req.headers['if-none-match'] === etag) {
				notModified++;
				delete headers['content-length'];
				res.writeHead(304, headers);
				return void res.end();
			}
		} else if (path === '/asset/nostore') {
			headers['cache-control'] = 'no-store';
		} else {
			res.writeHead(404);
			return void res.end();
		}
		res.writeHead(200, headers);
		res.end(body);
	}).listen(port, '127.0.0.1');
}

if (process.argv[1]?.endsWith('rapl-sw.ts')) {
	startSwOrigin(Number(process.env.PORT ?? 8951));
	console.log('origin up sw-request');
}
