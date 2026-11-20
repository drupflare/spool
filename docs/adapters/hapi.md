# hapi

hapi keeps the Node objects at `request.raw`. Returning `h.abandon` tells it the response is
already written. Pass the request to `spool.stub(request)` so the browser can revalidate the worker
script with `If-None-Match` and get a `304`. `stub()` with no request sends no validator. The
[Economics](../economics.md) page has the reading.

```ts
import Hapi from '@hapi/hapi';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const server = Hapi.server();

server.ext('onRequest', async (request, h) => {
  const { req, res } = request.raw;
  const spoolRequest = toRequest(req, res);
  const response =
    request.path === '/spool-sw.js'
      ? await spool.stub(spoolRequest)
      : await spool.respond(spoolRequest);
  if (!response) return h.continue;
  await writeResponse(res, response);
  return h.abandon;
});
server.route({
  method: 'GET',
  path: '/node/{id}',
  handler: async (request, h) => {
    const { req, res } = request.raw;
    const spoolRequest = toRequest(req, res);
    await writeResponse(res, await spool.decorate(spoolRequest, page(spoolRequest)));
    return h.abandon;
  }
});
```

## Example Project

`examples/courses/hapi/` runs this shape. Run `node hapi.ts` in that folder.
