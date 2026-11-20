# Homepage Nuxt example

The Larkspur College site from `../shared/site.ts`, served through Nuxt 4. The `@drupflare/spool/nuxt` module serves `/spool-sw.js` and `/.spool/**` from the Nitro server, decorates each server-rendered page with spool's envelope and page runtime tag, and registers the page routes. The pages are file based: home, news, events, departments, programs, people and about, with a detail page for each dynamic type.

`server/spool.ts` passes the `#spool/pages` records to the shared site, which turns them into routes with `routesFromPages`. The shared site declares the template, scope, freshness and dataset of each page by pattern. A page Nuxt registers that the site does not declare is logged at start as `spool: no route declared for <pattern>`, and a declaration for a page Nuxt does not have throws. `/site.css` is not a page, so the site declares it beside the helper's routes. The pages read their rows from `/api/**` through `useFetch`. `server/api/[...path].get.ts` passes each request to `spool.handle` with the shared site's own origin function (`page`, which answers `/api/*` through `apiBody` in `shared/site.ts`), so the response carries the envelope and the origin and the held rows cannot differ: the same function builds both. `homepageSite({ pages, api: true })` declares four `data` routes beside the page routes: `/api/news/:slug` and `/api/events/:id` (families over the `news` and `events` datasets) and `/api/news` and `/api/events` (collections of those datasets, 10 per page, with `provision` priors because their artifact is empty). The other reads (`/api/home`, `/api/departments`, `/api/programs`, `/api/people`, `/api/about`) are not declared and stay on the network. The home page `/` is a `template` route over the three newest articles and the three soonest events, which are public rows, and the origin renders the same template.

Nuxt's router takes every click, so the page makes no document views. The gate loads the boot script beside the router's own request and the runtime registers the worker on that click (a router-taken click leaves `__SPOOL_BOOT__ = { router: true }`). Measured with a router-only visit (view 1, then nine router clicks and no reload, Chromium, L1): click 1 makes 3 requests to the server (boot script, worker script and `GET /api/news/<slug>`); each detail click after that makes 0; the first two visits to each list make 2 requests each (its artifact, then a dataset seed); a third visit was not run, and Firefox and WebKit were not run for this example. The held-click goal holds for the detail pages of `news` and `events` from the second click, and does not hold for a list page on its first two visits. The cause of the list cost is that a query URL answers from the datasets store, which the worker seeds on demand, while the pack already holds the same rows; that is a library path, not an example choice.

The module cannot enumerate the params of a dynamic page, so it lists those pages on the network with the reason. A declaration in the shared site covers each of them.

`nitro.esbuild.options.target` is set to `es2022` in `nuxt.config.ts`, because Nitro's default `es2019` target rejects the top-level await in `server/spool.ts`.

Until `@drupflare/spool` 1.0.0 is on npm, this example uses the repository checkout, so run `bun run build` in the repository root first.

Run it in development:

```sh
npm install
npx nuxi dev
```

Build and run the server:

```sh
npx nuxi build
PORT=3000 node .output/server/index.mjs
```

Verify with the server on port 3000. These requests return 200:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/news?page=1"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/news/story-01
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/events/event-01
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/site.css
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/spool-sw.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/.spool/bundle/1
```

`http://localhost:3000/news/nope` returns 404. A page response carries the `spool-artifact` header, and a dynamic page also carries `x-spool-route`.
