# Koa

Koa exposes the Node objects as `ctx.req` and `ctx.res`. Setting `ctx.respond` to `false` stops
Koa from writing a second response. Pass the request to `spool.stub(request)` so the browser can
revalidate the worker script with `If-None-Match` and get a `304`. `stub()` with no request sends
no validator. The [Economics](../economics.md) page has the reading.

```ts
import Koa from 'koa';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = new Koa();

app.use(async (ctx, next) => {
  const request = toRequest(ctx.req, ctx.res);
  const response =
    ctx.path === '/spool-sw.js' ? await spool.stub(request) : await spool.respond(request);
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
```

## Example Project

`examples/courses/koa/` runs this shape. Run `node koa.ts` in that folder.
