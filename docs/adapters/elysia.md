# Elysia

`onRequest` answers the spool paths and returns nothing for the rest. The hook has to be an
`async` function, because Elysia does not await a promise that a plain function returns. Pass the
request to `spool.stub(request)` so the browser can revalidate the worker script with
`If-None-Match` and get a `304`. `stub()` with no request sends no validator. The
[Economics](../economics.md) page has the reading.

```ts
import { Elysia } from 'elysia';
import { page } from './routes';
import { spool } from './spool';

export const app = new Elysia()
  .onRequest(async ({ request }) => {
    const { pathname } = new URL(request.url);
    return pathname === '/spool-sw.js' ? await spool.stub(request) : await spool.respond(request);
  })
  .get('/node/:id', ({ request }) => spool.decorate(request, page(request)));
```

## Example Project

`examples/courses/elysia/` runs this shape. Run `bun elysia.ts` in that folder.
