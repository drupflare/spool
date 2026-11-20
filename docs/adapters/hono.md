# Hono

`spoolHono` is Hono middleware. It answers spool's own paths, and it adds the envelope and
the script tag to each GET that a route answers with a 200 HTML page.

Mount it with `app.use('*', spoolHono(spool))` before the routes. Spool's own paths are answered
before the routes run. A declared write runs through `spool.handle`, so the route answers it and
the answer carries `Spool-Delta` or the digest. Every other response is left as the application
made it.

```ts
import { Hono } from 'hono';
import { spoolHono } from '@drupflare/spool/hono';
import { page } from './routes';
import { spool } from './spool';

const app = new Hono();

app.use('*', spoolHono(spool));
app.get('/node/:id', (c) => page(c.req.raw));

export default app;
```

## Example Project

`examples/courses/hono/` runs this shape. Run `bun app.ts` in that folder. The dashboard example
has a Hono folder too (`examples/dashboard/hono/`).
