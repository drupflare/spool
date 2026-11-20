import { reactRouterPages } from '@drupflare/spool/react-router';
import { createRequestHandler } from 'react-router';
import routes from './app/routes';
import * as build from './build/server/index.js';
import config from './react-router.config';
import { spool } from './server/spool';

const port = Number(process.env['PORT'] ?? 4750);
const handler = createRequestHandler(build, 'production');
const pages = reactRouterPages(routes, config);
const clientDir = new URL('./build/client', import.meta.url).pathname;

// the request log the browser test reads; assets and the log itself are not logged
const hits: string[] = [];

await spool.publish(new URL(`http://127.0.0.1:${port}/`));

Bun.serve({
	port,
	hostname: '127.0.0.1',
	async fetch(request) {
		const { pathname, searchParams } = new URL(request.url);
		if (pathname === '/api/hits') {
			const out = [...hits];
			if (searchParams.has('reset')) hits.length = 0;
			return Response.json(out);
		}
		if (pathname.startsWith('/assets/')) {
			const file = Bun.file(`${clientDir}${pathname}`);
			if (await file.exists()) return new Response(file);
		}
		if (pathname === '/api/pages') return Response.json(pages);
		hits.push(pathname);
		return spool.handle(request, (req) => handler(req));
	}
});
