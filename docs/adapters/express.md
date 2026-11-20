# Express

`spoolExpress` is Express middleware. It answers spool's own paths, and it adds the envelope and
the script tag to each GET that a route answers with a 200 HTML page. A declared write runs through
`spool.handle`, so its answer carries `Spool-Delta`. Every other request reaches the application
unchanged. Mount it with `app.use` before the routes.

```ts
import express from 'express';
import { spoolExpress } from '@drupflare/spool/express';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = express();

app.use(spoolExpress(spool));
app.get('/node/:id', async (req, res) => {
  await writeResponse(res, page(toRequest(req, res)));
});
```

## Example Project

`examples/courses/express/` runs this shape. Run `node app.ts` in that folder. The dashboard example
has an Express folder too (`examples/dashboard/express/`).
