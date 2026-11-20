# Vercel Functions

A function under `api/` takes a default export with `fetch`. Send every path to it from
`vercel.json`, so the function sees `/.spool/*` and `/spool-sw.js` as well as the pages. Function
instances do not share memory, so `store` has to be a shared `VersionStore`.

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }
```

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  fetch: (request: Request) => spool.handle(request, page)
};
```

## Example Project

`examples/courses/vercel/` runs this shape. Run `vercel dev`, or `PORT=3000 bun api/index.ts`
locally, in that folder.
