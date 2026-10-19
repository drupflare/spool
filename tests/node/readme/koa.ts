import Koa from 'koa';
import { toRequest, writeResponse } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const app = new Koa();

app.use(async (ctx, next) => {
	const request = toRequest(ctx.req, ctx.res);
	const response = ctx.path === '/spool-sw.js' ? spool.stub() : await spool.respond(request);
	if (!response) return next();
	ctx.respond = false;
	await writeResponse(ctx.res, response);
});
app.use(async (ctx) => {
	if (!ctx.path.startsWith('/node/')) return;
	const request = toRequest(ctx.req, ctx.res);
	ctx.respond = false;
	await writeResponse(ctx.res, await spool.decorate(request, page(request)));
});
