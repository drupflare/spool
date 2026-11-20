import { toNodeListener } from '@drupflare/spool/node';
import { vuePages } from '@drupflare/spool/vue';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryRouter } from '../src/routes.ts';
import { appSpool } from './spool.ts';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const spool = appSpool(readFileSync(join(dist, 'index.html'), 'utf8'));
const pages = vuePages(memoryRouter());
const hits: string[] = [];
const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml'
};

/** the built file at `pathname`, or the app shell for a path with no file (a single-page app) */
async function staticResponse(pathname: string): Promise<Response> {
	const name = decodeURIComponent(pathname).slice(1);
	const file = join(dist, name);
	const isFile =
		name !== '' && file.startsWith(dist) && existsSync(file) && statSync(file).isFile();
	const path = isFile ? file : join(dist, 'index.html');
	const headers: Record<string, string> = {
		'content-type': TYPES[extname(path)] ?? 'application/octet-stream'
	};
	if (isFile && name.startsWith('assets/')) {
		headers['cache-control'] = 'public, max-age=31536000, immutable';
	}
	return new Response(await readFile(path), { headers });
}

async function handle(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/api/pages') return Response.json(pages);
	if (url.pathname === '/api/hits') {
		const seen = [...hits];
		if (url.searchParams.has('reset')) hits.length = 0;
		return Response.json(seen);
	}
	hits.push(url.pathname);
	if (url.pathname === '/spool-sw.js' && request.method === 'GET') return spool.stub(request);
	const answer = await spool.respond(request);
	if (answer) return answer;
	const response = await staticResponse(url.pathname);
	if (
		request.method === 'GET' &&
		(response.headers.get('content-type') ?? '').startsWith('text/html')
	) {
		return spool.decorate(request, response);
	}
	return response;
}

createServer(toNodeListener(handle)).listen(Number(process.env.PORT ?? 4721), '127.0.0.1');
