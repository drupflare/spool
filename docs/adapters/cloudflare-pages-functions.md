# Cloudflare Pages Functions

A function takes a context with the request and a `next` that runs the next function or the
static asset server.

```ts
import { spool } from './spool';

export const onRequest = (context: { request: Request; next(): Promise<Response> }) =>
  spool.handle(context.request, () => context.next());
```

## Example Project

`examples/courses/cloudflare-pages/` runs this shape. Build the site, then run
`npx wrangler pages dev <build directory>` in a Pages project.
