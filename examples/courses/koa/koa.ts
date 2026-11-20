import { toRequest, writeResponse } from '@drupflare/spool/node';
import Koa from 'koa';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const app = new Koa();

app.use(async (ctx, next) => {
	const request = toRequest(ctx.req, ctx.res);
	const response =
		ctx.path === '/spool-sw.js' ? await spool.stub(request) : await spool.respond(request);
	if (!response) return next();
	ctx.respond = false;
	await writeResponse(ctx.res, response);
});
app.use(async (ctx, next) => {
	if (ctx.path !== '/' && !ctx.path.startsWith('/courses')) return next();
	const request = toRequest(ctx.req, ctx.res);
	ctx.respond = false;
	await writeResponse(ctx.res, await spool.decorate(request, page(request)));
});
app.use((ctx) => {
	if (ctx.path !== '/ping') return;
	ctx.set('content-type', 'text/plain');
	ctx.body = 'pong';
});

if (import.meta.main) app.listen(3000);
