# Nuxt Module

`@drupflare/spool/nuxt` is a Nuxt 4 module. It serves `/spool-sw.js` and `/.spool/**` from the Nitro
server, decorates each server-rendered page with spool's envelope and page runtime tag, and classifies
each page. The `spool` option is a path to a module whose default export is a `Spool`. The module needs
`nuxt` and `@nuxt/kit` in the project, and it prints the registered and network pages on `nuxt dev`.

```ts
// nuxt.config.ts
import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  modules: ['@drupflare/spool/nuxt'],
  spool: { spool: './server/spool.ts' }
});
```

```ts
// server/spool.ts
import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export default createSpool({ routes: [], store: memoryStore() });
```

`#spool/pages` is a virtual module that exports one registration per page: its `path`, the spool
`pattern` when the path converts, the `register` value (`family`, `shell` or `network`), `maxAge` for a
revalidating page, and the `reason`. A page whose path cannot convert, such as an optional or catch-all
segment, stays on the network with the reason. The module does not declare spool routes from these
registrations. Nothing in the module reads `#spool/pages`; an app that wants the registrations imports
it in its own `spool` module. The module serves `/spool-sw.js` and `/.spool/**` through a server handler
that calls the default export of the `spool` module, and it adds a Nitro plugin that does the same for
the page runtime tag. On `nuxt dev` it logs the registered and network pages.

A production build also writes the static tier into Nitro's public directory (`.output/public`), at the
`nitro:build:public-assets` hook, after Nitro copied `public/` and before it lists the files. The tier is
spool's own files (the page runtime, the worker script, the packs and a `_headers` file), not prerendered
pages: the documents still come from the Nitro server. A host serves the files with no Worker
invocation, and after a first visit the device renders held pages from the pack and makes no request. It is on by default
and `static: false` in the module options turns it off. An object sets `policy` (the site's security
headers, which the worker replays on local renders), `url` (the origin the dataset seed functions receive,
`http://localhost/` by default) or `spool` (a function that returns the instance, `({ outDir }) => spool`).

The build loads the `spool` module in Node with jiti, the way Nitro loads it, so `#spool/pages` and the
project's aliases resolve. Its stores and bundles must be reachable from the build machine: the pack is named
after the store cursor, and a `memoryStore` starts at the build process's own state. Without a `policy`,
the module uses the `policy` option of the spool, the headers of a page the instance already answered, then
the `/*` block of a `_headers` file in `public/`. With none of them the stub names no policy, the build logs
one line saying so, and a device makes one network view that teaches it the headers. A build that cannot
publish fails with the library's error. An existing `_headers` file keeps its lines.

A dynamic page needs a family that the app declares. Declare the route next to its dataset:

```ts
// server/spool.ts
import { defineRoute } from '@drupflare/spool/server';

const rows: { id: string; title: string }[] = [];

const article = defineRoute('/articles/:id', {
  strategy: 'template',
  template: { source: '<h1>{{row.title}}</h1>' },
  family: { dataset: 'articles', key: 'id' },
  load: (ctx) => ({ row: rows.find((row) => row.id === ctx.params.id) })
});
```

The module cannot enumerate a dynamic page's params, so it lists the page under the network with its
reason, and the family route holds it. The app also passes `bundles: memoryBundleStore()` to
`createSpool` and calls `spool.publish(url)` at boot, because a held family reads its rows from the
published pack.

## Example Project

`examples/homepage/nuxt/` runs the module. Run `npx nuxi dev` after `npm install` in that folder.
`examples/dashboard/nuxt/` builds the same module against the dashboard site: run
`npx nuxt build`, then `node .output/server/index.mjs`.

Both examples read their rows through `useFetch` on a client navigation, and both declare those reads
as `data` routes, so the worker answers them from the held pack. The homepage example routes `/api/**`
through `spool.handle` with the site's own origin function (`apiBody` in `shared/site.ts`), the same
function that fills the `data` routes' rows, so the origin and the held row return one JSON body.
Nuxt's router takes every link click, so the page makes no document views. The gate loads the boot
script beside the router's request and the runtime registers the worker on that click; the
dashboard example then makes 0 requests from its second click in Chromium, Firefox and WebKit. The
homepage example makes 0 on a detail page once the worker holds the pack, and one request for the
artifact of each list route on its first visit.
