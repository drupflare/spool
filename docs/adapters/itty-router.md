# itty-router

A handler that returns `undefined` passes the request to the next one, which is what
`spool.respond` returns for a path that is not spool's. Pass the request to `spool.stub(request)` so
the browser can revalidate the worker script with `If-None-Match` and get a `304`. `stub()` with no
request sends no validator. The [Economics](../economics.md) page has the reading.

```ts
import { IttyRouter } from 'itty-router';
import { page } from './routes';
import { spool } from './spool';

const router = IttyRouter();

router
  .all('*', (request) => spool.respond(request))
  .get('/spool-sw.js', (request) => spool.stub(request))
  .get('/node/:id', (request) => spool.decorate(request, page(request)));

export default { fetch: router.fetch };
```

## Example Project

`examples/courses/itty-router/` runs this shape. Run `bun itty-router.ts` in that folder.
