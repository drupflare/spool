# Bun

Bun serves a default export that has a `fetch` function.

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  port: 3000,
  fetch: (request: Request) => spool.handle(request, page)
};
```

## Example Project

`examples/courses/bun/` runs this shape. Run `bun bun.ts` in that folder.
