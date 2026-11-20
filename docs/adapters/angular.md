# Angular

`spoolAngular` reads an Angular app's `Routes` array and its `serverRoutes`, and returns one
registration per page. Each page registers under the render mode its server route declares. A
dynamic page stays on the network until the app declares its family for it.

`spoolAngular` does not publish the static tier, unlike the Vite, React Router and Nuxt plugins. It is a
function the app calls for its registrations, and Angular's builder has no plugin hook that runs after the
output directory exists. To serve spool's own files (the page runtime, the worker script, the packs and a
`_headers` file) with no Worker invocation, run `spool.publishStatic(fileStaticSink(dir), { url })` from a
script after `ng build`, into the browser output directory. The files are not prerendered pages. The
[static example](../../examples/static/README.md) shows the script form.

```ts
// server.ts
import { spoolAngular } from '@drupflare/spool/angular';
import { createSpool, defineRoute } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { reqHandler, routes, serverRoutes } from './dist/angular-app/server/server.mjs';

const pages = spoolAngular({ routes, serverRoutes });

const shell = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

const spool = createSpool({
  routes: pages.flatMap((page) =>
    page.pattern && page.register !== 'network' && !page.pattern.includes(':')
      ? [
          defineRoute(page.pattern, {
            strategy: 'template',
            template: { source: shell(page.path) },
            depends: () => [page.path],
            load: () => ({})
          })
        ]
      : []
  ),
  store: memoryStore()
});

Bun.serve({
  fetch: (request) => spool.handle(request, reqHandler)
});
```

`spoolAngular` takes `{ routes, serverRoutes }` and no spool instance, since the pages must exist before
`createSpool` declares its routes. In development (`NODE_ENV` is not `production`), `spoolAngular`
prints the routes it registered,
the ones it left on the network, and the reason for each. Angular's dev server has no plugin hook,
so the log comes from this call. The tag and the envelope come from `spool.handle`, which wraps the
Angular request handler, as in the React Router section.

A route is a page when it has a `component` or a `loadComponent`. A route with children and no component
is a layout and adds no page of its own. A `redirectTo` route, a route with a custom `matcher` and a
route with `loadChildren` stay on the network with the reason. A route matches a server route with the
same path text, and a `**` server route answers every route that no other entry names. A route with
neither stays on the network. A prerendered route with parameters registers as a `family` when its
server route declares `getPrerenderParams`, with the reason `prerendered with enumerable params`. The
plugin does not call that function, so it does not list the parameter values. Without the function the
route stays on the network with the reason `prerendered without enumerable params`.

## Example Project

No folder under `examples/` runs Angular. `bun run typecheck` compiles the fence above.
