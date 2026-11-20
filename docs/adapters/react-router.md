# React Router

`@drupflare/spool/react-router` reads a React Router route array and registers each route. Pass the
default export of `app/routes.ts` and the default export of `react-router.config.ts`. Nested paths
are joined, and a layout adds no path. The result has one registration per path, with the same fields
as the Nuxt module.

```ts
// server/spool.ts
import { reactRouterPages } from '@drupflare/spool/react-router';
import { createSpool, defineRoute } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import routes from '../app/routes';
import config from '../react-router.config';

const pages = reactRouterPages(routes, config);

export const spool = createSpool({
  routes: pages
    .filter((page) => page.pattern && page.register !== 'network' && !page.pattern.includes(':'))
    .map((page) =>
      defineRoute(page.pattern!, {
        strategy: 'template',
        template: { source: '<h1>{{title}}</h1>' },
        depends: () => [page.path],
        load: () => ({ title: page.path })
      })
    ),
  store: memoryStore()
});
```

A static path registers as a family. A path with a param, a splat, or an optional segment stays on the
network with its reason, until the app declares a family for it as the Nuxt section shows. The `ssr`
and `prerender` settings are global in React Router, so they apply to every route. With `ssr: false`,
every route registers as a client shell. A `prerender` function cannot be read, so its routes stay on
the network.

`spoolReactRouter({ spool })` is a Vite plugin for `react-router dev`. It serves `/spool-sw.js` and
spool's paths, and it prints the registered routes, the network routes and the reason for each.

The client build also writes the static tier into its output directory (`build/client`), as
[`spoolVite`](vite.md#static-tier) does and with the same `static` option. The tier is spool's own files
(the page runtime, the worker script, the packs and a `_headers` file), not prerendered pages. A static host
serves them with no Worker invocation, and the server build is left alone. Pass `static: false` to turn it
off.

Server-rendered HTML comes from React Router's request handler, so the tag and the envelope come from
`spool.handle`. Wrap that handler with it, and the wrapper answers spool's paths and decorates the
response:

```ts
// server.ts
import { createRequestHandler } from 'react-router';
import * as build from './build/server/index.js';
import { spool } from './server/spool';

const handler = createRequestHandler(build, 'production');

Bun.serve({
  port: 4750,
  fetch: (request) => spool.handle(request, (req) => handler(req))
});
```

Dev server HTML is rendered by React Router's own middleware, so `spoolReactRouter` does not decorate
it. Run the production server to test a held page.

## Example Project

No folder under `examples/` runs React Router. `bun run typecheck` compiles the
fences above.
