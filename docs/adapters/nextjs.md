# Next.js

Next.js route handlers return `Response` objects, so `handle` wraps one directly. The spool
endpoints and the worker script go through the proxy, which returns `undefined` for every other
request. Next.js 16 calls the file `proxy.ts` and the export `proxy`. Earlier versions call them
`middleware.ts` and `middleware`. The proxy and the route handlers need the same shared store. The
proxy passes the request to `spool.stub(request)` so the browser can revalidate the worker script
with `If-None-Match` and get a `304`. `stub()` with no request sends no validator. The
[Economics](../economics.md) page has the reading.

```ts
import { spool } from './spool';

export function proxy(request: Request) {
  const { pathname } = new URL(request.url);
  return pathname === '/spool-sw.js' ? spool.stub(request) : spool.respond(request);
}
```

```ts
import { page } from './routes';
import { spool } from './spool';

export const GET = (request: Request) => spool.handle(request, page);
```

## Example Project

`examples/courses/next-proxy/` and `examples/courses/next-route/` run the proxy and the route
handler. Run `next dev` in a Next.js project that holds the folder.
