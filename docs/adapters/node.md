# Node

`toNodeListener` turns a Fetch-style handler into a `node:http` listener. Its `toRequest` and
`writeResponse` parts are what the frameworks below use to cross between Node and Fetch.

```ts
import { createServer } from 'node:http';
import { toNodeListener } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const server = createServer(toNodeListener((request) => spool.handle(request, page)));
```

## Example Project

`examples/courses/node/` runs this shape. Run `node server.ts` in that folder. The campus, blog and
homepage examples each have a Node folder too.
