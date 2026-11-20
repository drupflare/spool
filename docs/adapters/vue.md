# Vue

`spoolVue` is `spoolVite` for a Vue single-page app. It takes the same `spool` instance and the
vue-router instance whose routes the app declares. It adds the same tag and serves the same paths in
`serve`, and it logs the routes at startup: each convertible route with its `shell` registration, and
each route that stays on the network with its reason.

A client build also writes the static tier into `build.outDir`, as [`spoolVite`](vite.md#static-tier)
does. The tier is spool's own files (the page runtime, the worker script, the packs and a `_headers`
file), not prerendered pages. A static host serves them with no Worker invocation, and after a first visit
the device renders held routes locally and makes no request. Pass `static: false` to turn it off. The
example passes `static.spool`, a function that makes the instance from the built `index.html`: the instance
made when the config loads holds the dev shell.

```ts
// vite.config.ts
import { spoolVue } from '@drupflare/spool/vue';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { appSpool } from './server/spool';
import { memoryRouter } from './src/routes';

const spool = appSpool(readFileSync('index.html', 'utf8'));

export default defineConfig({
  plugins: [
    spoolVue({
      spool,
      router: memoryRouter(),
      static: { spool: ({ outDir }) => appSpool(readFileSync(join(outDir, 'index.html'), 'utf8')) }
    })
  ]
});
```

`vuePages(router)` returns one registration per route, read from `router.getRoutes()`. A route renders
on the client, so each convertible path registers as the app shell. `/articles/:id` registers as one
shell. A path with an optional or catch-all
segment stays on the network with the reason. Data for a route is not part of the shell; declare a
family for it.

A production build has no server of its own. Serve the built `index.html` as a template for each
registered pattern. Route requests through `spool.handle`, which answers spool's own paths and adds the
runtime tag to each HTML response:

```ts
// server/spool.ts
import { createSpool, defineRoute, memoryBundleStore } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { vuePages } from '@drupflare/spool/vue';
import { memoryRouter } from '../src/routes';

// the built index.html, read at boot
export function appSpool(shell: string) {
  const statics = vuePages(memoryRouter()).flatMap((page) =>
    page.pattern && page.register !== 'network'
      ? [
          defineRoute(page.pattern, {
            strategy: 'template',
            template: { source: shell },
            depends: () => [page.path],
            load: () => ({})
          })
        ]
      : []
  );
  return createSpool({
    routes: statics,
    store: memoryStore(),
    bundles: memoryBundleStore()
  });
}
```

A parameter route needs a field in its template. `createSpool` refuses a template made only of text under a
pattern with a parameter (`bad-template`), because every value of the parameter would show the same page. The
example app has constant routes only (`/`, `/articles`, `/about`), so its sample never reaches that check.

The plugin reads `getRoutes()` and nothing else from the router, so it works with any vue-router
instance. A Vue app that renders on the server is not covered: every route is treated as client
rendered.

## Example Project

[`examples/static/vite-vue`](../../examples/static/vite-vue/README.md) runs this setup. It is a Vue Router
app with constant routes, built by Vite, with `spoolVue` in `vite dev` and the static tier written into `dist/` by `vite build`.
`bun run typecheck` compiles the fences above.
