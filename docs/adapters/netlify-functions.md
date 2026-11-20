# Netlify Functions

A function takes a `Request` and returns a `Response`. `config.path` sends the spool paths and the
pages to it.

```ts
import type { Config, Context } from '@netlify/functions';
import { page } from './routes';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, page);

export const config: Config = { path: ['/node/*', '/spool-sw.js', '/.spool/*'] };
```

## Example Project

`examples/courses/netlify-functions/` runs this shape. Run `netlify dev` in a Netlify project
that holds the folder. The dashboard example has a Netlify Functions folder too
(`examples/dashboard/netlify-functions/`).
