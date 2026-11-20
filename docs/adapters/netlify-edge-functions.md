# Netlify Edge Functions

An edge function runs in front of the site. `context.next()` returns the response the site would
have sent, which `handle` decorates.

```ts
import type { Config, Context } from '@netlify/edge-functions';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, () => context.next());

export const config: Config = { path: '/*' };
```

## Example Project

`examples/courses/netlify-edge/` runs this shape. Run `netlify dev` in a Netlify project that
holds the folder.
