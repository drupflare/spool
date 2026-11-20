import { Elysia } from 'elysia';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const app = new Elysia()
	.onRequest(async ({ request }) => {
		const { pathname } = new URL(request.url);
		return pathname === '/spool-sw.js'
			? await spool.stub(request)
			: await spool.respond(request);
	})
	.get('/', ({ request }) => spool.decorate(request, page(request)))
	.get('/courses', ({ request }) => spool.decorate(request, page(request)))
	.get('/courses/:id', ({ request }) => spool.decorate(request, page(request)))
	.get('/ping', ({ request }) => page(request));

if (import.meta.main) app.listen(3000);
