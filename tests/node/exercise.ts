import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { decodeEnvelope, parseSyncResponse } from '../../src/protocol/index';
import { spool } from './readme/spool';
import { store } from './readme/store';

const servers: Server[] = [];

/** starts a `node:http` server on a free port and returns its base URL; stop them all with {@link closeServers} */
export async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function closeServers(): Promise<void> {
	await Promise.all(
		servers.splice(0).map(
			(s) =>
				new Promise<void>((resolve) => {
					s.closeAllConnections();
					s.close(() => resolve());
				})
		)
	);
}

export type Fetcher = (path: string) => Promise<Response>;

/** the README fixtures' contract: a tagged page with its envelope, the worker script, an artifact and a sync */
export async function exercise(get: Fetcher): Promise<void> {
	const page = await get('/node/1');
	expect(await page.text()).toContain('<h1>Node 1</h1>');
	expect(page.headers.get('content-type')).toContain('text/html');
	const envelope = decodeEnvelope(page.headers);
	expect(envelope.artifact?.id).toBe('/node/1');
	expect(envelope.artifact?.deps).toEqual(['node:1']);

	const tagged = await (await get('/node/2')).text();
	expect(tagged).toContain('data-spool-client');

	const worker = await get('/spool-sw.js');
	expect(worker.headers.get('cache-control')).toBe('max-age=86400');
	expect(await worker.text()).toContain('__SPOOL_CONFIG__');

	const artifact = await get('/.spool/artifact?path=/node/1');
	expect(artifact.status).toBe(200);

	const from = await store.cursor();
	await spool.invalidate(['node:1']);
	const sync = parseSyncResponse(await (await get(`/.spool/sync?from=${from}`)).json());
	expect(sync.changed).toEqual({ 'node:1': from + 1 });
}

export const overHttp =
	(base: string): Fetcher =>
	(path) =>
		fetch(`${base}${path}`);

export const overFetch =
	(handler: (request: Request) => Response | Promise<Response>): Fetcher =>
	async (path) =>
		handler(new Request(`https://site.test${path}`));
