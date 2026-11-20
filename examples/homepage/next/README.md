# Homepage Next example

The Larkspur College site from `../shared/site.ts`, served by Next 16 with the `@drupflare/spool/next` adapter. `next.config.ts` sets `adapterPath` to the adapter. At `next build` the adapter writes one registration per page to `.next/spool-pages.json` and prints a report. The App Router pages read the shared data through `server/content.ts`.

An App Router page is held only when its response passes through `spool.handle` in front of Next, so `server.ts` runs Next on a loopback port and puts the spool handler in front of it. `next dev` runs no adapter and no wrapper.

`server/spool.ts` reads `.next/spool-pages.json` and passes it to the shared site, which turns the registrations into routes with `routesFromPages`; `/site.css` is a route handler, not a page, so the site declares it beside them. Next writes the file after the build, so `next build` and `next dev` find none and the site keeps its own route list. A start after a build uses Next's table, and a page the site does not declare is logged as `spool: no route declared for <pattern>`. Next answers `Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`, which the in-process gate accepts. Every public page carries the ring that names the boot script, including `/`. The home page `/` is a `template` route over the three newest articles and the three soonest events, so a view of it is local once the worker holds its artifact (the worker registers on the third document view and fetches the artifact on the fourth, in Chromium the fourth view fetched it and a fifth was not run, L1). The first click on a held link loads the boot script in place of the document and installs the pack, and the later held clicks of the same run (news, events) made no request in Chromium, Firefox and WebKit. `/` is a projection route the library refuses to keep, so each view of it is still a network document. A leftover `.next/spool-pages.json` from an older build is read during the next `next build`, and a declaration for a page that build no longer has throws there.

The `news/[slug]`, `events/[id]`, `departments/[id]`, `programs/[id]`, `people/[id]` and `about/[slug]` pages prerender their first two params with `generateStaticParams`. The shared site declares a family for each of those routes, so spool's family routes cover the params Next does not prerender.

`next.config.ts` sets the Turbopack root to the repository root, and `tsconfig.json` maps the `@drupflare/spool` subpaths to `dist/`, because Turbopack does not follow the package's self-reference from `../shared`.

Until `@drupflare/spool` 1.0.0 is on npm, this example uses the repository checkout, so run `bun run build` in the repository root first. After that build, run `bun install --force --ignore-scripts` here, because bun copies `file:` dependencies.

Build and run:

```sh
npm install
npx next build
PORT=3000 node server.ts
```

Verify with the server on port 3000. These requests return 200:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/news?page=1"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/news/story-05
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/events/event-09
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/site.css
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/spool-sw.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/.spool/bundle/1
```

`http://localhost:3000/news/nope` returns 404. The `story-05` and `event-09` pages are not prerendered, so Next renders them on request; their responses carry `spool-artifact` and `x-spool-route` headers.
