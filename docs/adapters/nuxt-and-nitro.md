# Nuxt and Nitro

h3 turns an event into a standard request with `toWebRequest`, and it sends a `Response` that a
handler returns. A server middleware that returns nothing passes the request on. Put the first
file in `server/middleware/` and the second in `server/routes/node/[id].ts`. Both share one store
from `./store`. The middleware passes the request to `spool.stub(request)` so the browser can
revalidate the worker script with `If-None-Match` and get a `304`. `stub()` with no request sends no
validator. The [Economics](../economics.md) page has the reading.

```ts
import { defineEventHandler, toWebRequest } from 'h3';
import { spool } from './spool';

export default defineEventHandler((event) => {
  const request = toWebRequest(event);
  return new URL(request.url).pathname === '/spool-sw.js'
    ? spool.stub(request)
    : spool.respond(request);
});
```

```ts
import { defineEventHandler, toWebRequest } from 'h3';
import { page } from './routes';
import { spool } from './spool';

export default defineEventHandler((event) => spool.handle(toWebRequest(event), page));
```

## Example Project

`examples/courses/nuxt-middleware/` and `examples/courses/nuxt-route/` run the middleware and the
route. Run `npx nuxi dev` in a Nuxt project that holds the folder. For the module instead of
hand-written routes, see [Nuxt Module](nuxt-module.md).
