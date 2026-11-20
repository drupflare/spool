# Fastify

Fastify's `reply.send` takes a Fetch `Response`. An `onRequest` hook answers the spool paths from
the raw request before Fastify reads the body. Pass the request to `spool.stub(request)` so the
browser can revalidate the worker script with `If-None-Match` and get a `304`. `stub()` with no
request sends no validator. The [Economics](../economics.md) page has the reading.

```ts
import Fastify from 'fastify';
import { toRequest } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = Fastify();

app.addHook('onRequest', async (req, reply) => {
  const response = await spool.respond(toRequest(req.raw, reply.raw));
  if (response) return reply.send(response);
});
app.get('/spool-sw.js', async (req, reply) =>
  reply.send(await spool.stub(toRequest(req.raw, reply.raw)))
);
app.get('/node/:id', async (req, reply) => {
  const request = toRequest(req.raw, reply.raw);
  return reply.send(await spool.decorate(request, page(request)));
});
```

## Example Project

`examples/courses/fastify/` runs this shape. Run `node fastify.ts` in that folder.
