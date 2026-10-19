import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, createServer as createNet, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNodeListener } from '../../src/node/listener';
import { spoolProxy, type SpoolProxy } from '../../src/proxy/index';
import { memoryStore } from '../../src/stores/index';

/** seconds a page may go without validation; short so a test can cross it */
export const BOUND = 3;
export const SECRET = 'purge-secret';

export type Kind = 'node' | 'php';

export type ProxyFixture = {
	/** the proxy, which is what a browser talks to */
	front: string;
	/** paths the proxy received, in order */
	proxyHits: string[];
	/** paths the proxy asked the origin for, in order */
	originHits: string[];
	proxy: SpoolProxy;
	/** the path of page `id` on this origin */
	pathOf(id: number): string;
	/** a tag every page on this origin carries */
	sharedTag: string;
	/** changes the text of page `id` at the origin; nothing is purged */
	edit(id: number, note: string): void;
	/** what a CMS hook or Drupal's purge module does */
	purge(tags: string[]): Promise<Response>;
	stop(): Promise<void>;
};

const PHP_CANDIDATES = [
	process.env['PHP_BIN'],
	'php',
	'/opt/homebrew/bin/php',
	'/usr/local/bin/php'
];

function findPhp(): string {
	for (const candidate of PHP_CANDIDATES) {
		if (candidate && spawnSync(candidate, ['--version']).status === 0) return candidate;
	}
	throw new Error(
		'php is required for tests/browser/proxy.pw.ts and was not found; install php-cli, or set PHP_BIN (it is preinstalled on GitHub ubuntu runners)'
	);
}

async function freePort(): Promise<number> {
	const server = createNet();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function accepting(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = connect(port, '127.0.0.1');
			socket.once('connect', () => (socket.destroy(), resolve(true)));
			socket.once('error', () => resolve(false));
		});
		if (open) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`nothing listened on ${port}`);
}

const page = (prefix: string, id: number, note: string) => {
	const nav = [1, 2, 3].map((n) => `<a href="${prefix}/${n}">${prefix}/${n}</a>`).join(' ');
	return `<!doctype html><html><head><meta charset="utf-8"><title>Page ${id}</title><link rel="stylesheet" href="/site.css"></head><body><nav>${nav}</nav><main><h1>Page ${id}</h1><p id="note">${note}</p></main></body></html>`;
};

/** a plain `node:http` origin that has never heard of spool; page ids 1 to 3 under `/n/` */
async function nodeOrigin() {
	const notes = new Map<number, string>();
	const server: Server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const id = /^\/n\/(\d+)$/.exec(path)?.[1];
		if (path === '/site.css') {
			res.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'public, max-age=31536000'
			});
			return res.end('main{max-width:60ch}');
		}
		if (path === '/login') {
			res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'SESS=abc; Path=/' });
			return res.end(
				'<!doctype html><html><head><title>login</title></head><body><h1>login</h1></body></html>'
			);
		}
		if (!id) {
			res.writeHead(404);
			return res.end('not found');
		}
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'max-age=0, public',
			'cache-tag': `node:${id},menu`
		});
		res.end(page('/n', Number(id), notes.get(Number(id)) ?? 'original'));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		pathOf: (id: number) => `/n/${id}`,
		edit: (id: number, note: string) => void notes.set(id, note),
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

/** `php -S` running `tests/fixtures/php/origin.php`, which sends `X-Drupal-Cache-Tags` */
async function phpOrigin() {
	const dir = mkdtempSync(join(tmpdir(), 'spool-php-'));
	const port = await freePort();
	const child: ChildProcess = spawn(
		findPhp(),
		['-S', `127.0.0.1:${port}`, join(import.meta.dirname, '../fixtures/php/origin.php')],
		{ env: { ...process.env, SPOOL_PHP_DIR: dir }, stdio: 'ignore' }
	);
	await accepting(port);
	return {
		url: `http://127.0.0.1:${port}`,
		pathOf: (id: number) => `/p/${id}`,
		edit: (id: number, note: string) => writeFileSync(join(dir, `note-${id}`), note),
		stop: async () => {
			child.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

/** a proxy in front of an unmodified origin; the pages are soft-bound at {@link BOUND} seconds */
export async function startProxy(kind: Kind): Promise<ProxyFixture> {
	const origin = kind === 'node' ? await nodeOrigin() : await phpOrigin();
	const prefix = kind === 'node' ? '/n' : '/p';
	const proxyHits: string[] = [];
	const originHits: string[] = [];
	const proxy = spoolProxy({
		origin: origin.url,
		spool: { store: memoryStore() },
		routes: [{ pattern: `${prefix}/:id`, freshness: { maxStale: BOUND, mode: 'hard' } }],
		purgeSecret: SECRET,
		fetch: (request) => {
			originHits.push(new URL(request.url).pathname);
			return fetch(request);
		}
	});
	const server: Server = createServer(
		(req, res) =>
			void toNodeListener((request) => {
				proxyHits.push(new URL(request.url).pathname);
				return proxy(request);
			})(req, res)
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const front = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		front,
		proxyHits,
		originHits,
		proxy,
		sharedTag: kind === 'node' ? 'menu' : 'config:system.menu.main',
		pathOf: origin.pathOf,
		edit: origin.edit,
		purge: (tags) =>
			fetch(`${front}/.spool/purge`, {
				method: 'POST',
				headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
				body: JSON.stringify({ tags })
			}),
		stop: async () => {
			await new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
			await origin.stop();
		}
	};
}
