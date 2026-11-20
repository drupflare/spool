# Deno

Run it with `deno serve`.

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  fetch: (request: Request) => spool.handle(request, page)
};
```

## Example Project

`examples/courses/deno/` runs this shape. Run `deno serve deno.ts` in that folder.
