import { Elysia } from 'elysia';
import { page } from './routes';
import { spool } from './spool';

export const app = new Elysia()
	.onRequest(async ({ request }) => {
		const { pathname } = new URL(request.url);
		return pathname === '/spool-sw.js'
			? await spool.stub(request)
			: await spool.respond(request);
	})
	.get('/node/:id', ({ request }) => spool.decorate(request, page(request)));
