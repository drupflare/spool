# 🧵 spool

> A browser replica that removes repeated demand from your server

[![Build](https://github.com/drupflare/spool/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/build.yml)
[![Browser](https://github.com/drupflare/spool/actions/workflows/browser.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/browser.yml)
[![Prettier](https://github.com/drupflare/spool/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/spool/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/spool)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/drupflare/spool/blob/master/LICENSE)

spool removes repeated execution demand from your server. It keeps a replica of what a page needs
on the visitor's device. The server sends templates and authorised, versioned data, and a service
worker computes eligible pages from them. A page answered there is a request that never reaches
your Worker or origin, and server work that never runs. The contract is a count: a test asserts
the server hits of a local view, and in Chromium and Firefox the count is zero.

spool has three uses. In a drupflare deployment it takes eligible public views off the Worker.
For a team on a free or constrained plan it lowers the requests the plan has to carry, by an
amount that depends on the site's traffic ([Request Arithmetic](ADVANCED_USAGE.md#request-arithmetic)). It is also
a research system: every figure it reports carries a layer and a method.

It runs on any runtime that speaks `Request` and `Response`, bridges `node:http` for the rest, and
has no runtime dependencies. A site with no server code can load it from two files and a manifest.

---

## Table of Contents

- [Why Spool](#why-spool)
- [Install](#install)
- [Quick Start](#quick-start)
- [Page Runtime](#page-runtime)
- [Runtimes](#runtimes)
- [Compatibility](#compatibility)
- [Static Sites](#static-sites)
- [Advanced Usage](#advanced-usage)
- [Security](#security)
- [Energy Reporting](#energy-reporting)
- [Prior Art](#prior-art)
- [Out of Scope](#out-of-scope)
- [Browser Support](#browser-support)
- [Subpath Exports](#subpath-exports)
- [Testing](#testing)
- [Documentation](#documentation)
- [Related Repositories](#related-repositories)
- [License](#license)

---

## Why Spool

A local view removes, in order, a request that would have reached the Worker, the server work
behind it (rendering, queries, Durable Object and database reads), and the bytes of a document the
device already holds. Energy follows from those and is one objective an administrator may weigh.

A response is a deterministic transformation of a set of authorised, versioned dependencies. The
server half names those dependencies and sends the snapshot the visitor may hold. The worker keeps
a graph of records, projections and responses, with their versions, and syncs only what the next
page needs.

Your application keeps every access decision and every page it cannot reproduce safely on the
device. It keeps every write too, except the last-value writes you declare, which ship off. A route
the worker cannot answer goes to the network, so adopting spool changes no page that was not
declared.

A collection of thousands of rows, such as a directory or a course catalogue, can be held as a
[dataset](ADVANCED_USAGE.md#datasets). The device seeds it once and then receives only the rows that changed.

[docs/impact.md](docs/impact.md) holds the request, cost and energy figures and the measurements
behind them. See [Energy Reporting](#energy-reporting).

---

## Install

### Package

```sh
bun add @drupflare/spool
```

The package ships ES modules and type declarations. Node, Deno, Bun, Workers and bundlers import
it directly.

### CDN Script

A page can load the runtime from `cdn.drupflare.com` with a Subresource Integrity hash. The release
notes list the hash for each version.

```html
<script
  src="https://cdn.drupflare.com/spool/<version>/client.js"
  integrity="sha384-<hash from the release notes>"
  crossorigin="anonymous"
  defer
  data-spool-client
></script>
```

[Page Runtime](#page-runtime) shows how `createSpool` injects the same tag.

### Direct Files

`spool-sw.js`, `client.js` and `manifest.json` are attached to every GitHub release and published
under `https://cdn.drupflare.com/spool/<version>/`. A site that serves them as plain files needs no
server library. See [Static Sites](#static-sites).

---

## Quick Start

Every runtime below makes the same three moves:

1. Declare the routes the device may answer, and the version store that tracks changes.
2. Wrap the application's handler with `spool.handle`. It answers `/.spool/*` and `/spool-sw.js`.
3. Send the client tag, which is the script tag for the page runtime. `handle` injects it into
   every HTML page the application returns, and `spool.decorate` does the same where there is no
   Fetch response to wrap.

The [Getting Started](docs/getting-started.md) page walks through the same steps with the install
options, a run and the checks that confirm the setup.

### Declare Routes

A route has a path pattern, a strategy, the tags it depends on and a `load` function that returns
the data for one page. `load` runs on the server and may check the visitor's identity. Only its
result reaches the device.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const routes = [
  defineRoute('/node/:id', {
    strategy: 'template',
    template: {
      source:
        '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
    },
    depends: (ctx) => [`node:${ctx.params['id']}`],
    load: (ctx) => ({ id: ctx.params['id'] })
  })
];

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page = (request: Request) => {
  const id = escape(new URL(request.url).pathname.split('/')[2] ?? '');
  return new Response(
    `<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
};
```

`page` stands in for your application. The page it returns has to match what the template
renders from the route's data, because the device renders the same route without asking you.

The version store records which tags changed. `memoryStore` serves a single process. Every other
deployment needs a store that all instances share, which is any object with three methods:
`bump(tags)`, `cursor()` and `diff(from)`. On Cloudflare, `durableObjectStore` keeps the vector in
a Durable Object.

```ts
import { memoryStore } from '@drupflare/spool/stores';

export const store = memoryStore();
```

`createSpool` joins the two:

```ts
import { createSpool } from '@drupflare/spool/server';
import { routes } from './routes';
import { store } from './store';

export const spool = createSpool({ routes, store });
```

After a write, call `await spool.invalidate(['node:1'])` with the tags it touched. Devices
holding a page that depends on them fetch a fresh copy before they show it again.

---

## Page Runtime

`handle` and `decorate` inject one script tag into each HTML page. By default the script is
served from the same origin at `/.spool/<version>/client.js`, which suits a strict
`script-src 'self'` policy. To serve it from `cdn.drupflare.com` instead, pass the integrity hash
that the release notes list for your version. The URL defaults to that version's file.

```ts
import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  cdn: { integrity: 'sha384-<hash from the release notes>' }
});
```

The CDN copy carries `Cache-Control: public, max-age=31536000, immutable` and the browser checks
it against the hash, so a changed file never runs. Release files are never overwritten. If the
script fails to load, the page works as it did before.

The script registers `/spool-sw.js` and exposes `window.spool.ready`, which resolves to the client
handle or to `null` where service workers do not exist. It also exposes `window.spool.activity`,
described below, and the write calls of [Declared Writes](ADVANCED_USAGE.md#declared-writes). To bundle the runtime
yourself, import `register` from `@drupflare/spool/client`. The `window.spool` types come with that
path too, so a project that imports it gets them.

`createSpool({ workerMode: 'never' })` serves a site with no service worker. The page installs its
pack and answers held reads itself, and `/spool-sw.js` answers `404`. A declared write goes through
`window.spool.fetch` in place of `fetch`. The answer updates the held pack from the delta or digest it
carries, and any other URL goes to `fetch` unchanged. `spool.write` still queues a value for the
worker, so without a worker it answers `unavailable`. A public HTML page carries the declarations in
its ring, or in a `spool-writes` element when it has no ring. On a site with the bootstrap gate, every
public HTML page carries the ring.

```ts
// a page with no worker
const response = await window.spool?.fetch('/courses/101', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Biology 101' })
});
```

### Activity Hooks

A loop that keeps running while nobody can see its output costs the visitor's device power. The
page runtime exposes `window.spool.activity.register`, which lets a page hand spool a `pause` and
a `resume` for one of its own loops. Spool calls `pause` while the loop's `target` is off screen
and after the page has been hidden for `hiddenAfterMs`, and calls `resume` when neither holds.

```ts
import { createActivity } from '@drupflare/spool/client';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
let frame = 0;

const draw = () => {
  canvas.style.transform = `translateX(${(performance.now() / 10) % 200}px)`;
  frame = requestAnimationFrame(draw);
};

draw();

export const stop = createActivity().register(
  { pause: () => cancelAnimationFrame(frame), resume: draw },
  { target: canvas, hiddenAfterMs: 10_000 }
);
```

`target` is optional, and without it only the hidden-page rule applies. `hiddenAfterMs` defaults to
10000, and 0 pauses at once. `register` returns a function that stops watching and resumes the loop
if it is paused. Spool does not touch `setInterval`, `requestAnimationFrame`, `fetch`, audio,
WebRTC or any element the page did not name, and a `pause` or `resume` that throws is logged once.
Where `IntersectionObserver` is missing the target counts as on screen. On the one desktop
measured, the off-screen pause lowered power for a page whose frame loop kept running, and the
hidden-page pause showed no saving for a once-a-second poll. Both readings are in
[docs/impact.md](docs/impact.md#metered-figures-beside-the-ledger).

### In-Page Navigation

The page answers a link or a GET form in place when its content sits in a swap region. The region is the first element marked `data-spool-swap`, or else the first `<main>`:

```html
<body>
  <header>
    <a href="/">Site</a>
  </header>
  <main data-spool-swap>
    <h1>Course 101</h1>
  </main>
</body>
```

The page replaces the region, the element marked `data-spool-swap-sidebar` when both pages have one, and the title. It answers only public routes declared with `family`, from the rows the device holds ([Dataset Routes](ADVANCED_USAGE.md#dataset-routes)). Modified clicks, links with `target` or `download`, cross-origin links and non-GET forms go to the browser, and so does any route the device does not hold. The page writes at most 90 history entries in any 10 seconds. Past that count it swaps the content and leaves the address bar on the previous URL until the window clears.

A page with no swap element navigates by document, and no error is shown.

---

## Runtimes

Each runtime has its own page, with the framework context and a minimal example. The
[Adapters](docs/adapters/README.md) index lists every page with its import path.

| Runtime                    | Page                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| Cloudflare Workers         | [cloudflare-workers.md](docs/adapters/cloudflare-workers.md)                 |
| Cloudflare Pages Functions | [cloudflare-pages-functions.md](docs/adapters/cloudflare-pages-functions.md) |
| Hono                       | [hono.md](docs/adapters/hono.md)                                             |
| Elysia                     | [elysia.md](docs/adapters/elysia.md)                                         |
| itty-router                | [itty-router.md](docs/adapters/itty-router.md)                               |
| Bun                        | [bun.md](docs/adapters/bun.md)                                               |
| Deno                       | [deno.md](docs/adapters/deno.md)                                             |
| Netlify Functions          | [netlify-functions.md](docs/adapters/netlify-functions.md)                   |
| Netlify Edge Functions     | [netlify-edge-functions.md](docs/adapters/netlify-edge-functions.md)         |
| Vercel Functions           | [vercel-functions.md](docs/adapters/vercel-functions.md)                     |
| Next.js                    | [nextjs.md](docs/adapters/nextjs.md)                                         |
| Nuxt and Nitro             | [nuxt-and-nitro.md](docs/adapters/nuxt-and-nitro.md)                         |
| Nuxt Module                | [nuxt-module.md](docs/adapters/nuxt-module.md)                               |
| React Router               | [react-router.md](docs/adapters/react-router.md)                             |
| Next Adapter               | [next-adapter.md](docs/adapters/next-adapter.md)                             |
| Vite                       | [vite.md](docs/adapters/vite.md)                                             |
| Vue                        | [vue.md](docs/adapters/vue.md)                                               |
| Angular                    | [angular.md](docs/adapters/angular.md)                                       |
| AWS Lambda                 | [aws-lambda.md](docs/adapters/aws-lambda.md)                                 |
| Azure Functions            | [azure-functions.md](docs/adapters/azure-functions.md)                       |
| Node                       | [node.md](docs/adapters/node.md)                                             |
| Express                    | [express.md](docs/adapters/express.md)                                       |
| Fastify                    | [fastify.md](docs/adapters/fastify.md)                                       |
| Koa                        | [koa.md](docs/adapters/koa.md)                                               |
| hapi                       | [hapi.md](docs/adapters/hapi.md)                                             |
| NestJS                     | [nestjs.md](docs/adapters/nestjs.md)                                         |
| Google Cloud Functions     | [google-cloud-functions.md](docs/adapters/google-cloud-functions.md)         |

Pick the page for your framework. A runtime with a Fetch `fetch(request)` handler needs only
`spool.handle`, as the [Quick Start](#quick-start) shows.

---

## Compatibility

The gate column says how far each row is checked. **runs** means the fixture above drives the
framework's own package. **stand-in** means a fixture calls the platform's handler with a plain
object where the platform would pass its context. **not tested** means the adapter column comes
from the framework's documentation and nothing here has run it.

| Framework or host                    | What a handler receives                                        | Spool entry                                                  | Gate                                         |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Express                              | Node `req`, `res`                                              | `spoolExpress`                                               | runs                                         |
| Fastify                              | Node `req.raw`, `reply.raw`; `reply.send` takes a `Response`   | `toRequest`, `respond`, `decorate`                           | runs                                         |
| Koa                                  | Node `ctx.req`, `ctx.res`                                      | `toRequest`, `writeResponse`                                 | runs                                         |
| hapi                                 | Node `request.raw.req`, `request.raw.res`                      | `toRequest`, `writeResponse`                                 | runs                                         |
| NestJS, Express adapter              | Node, through Express                                          | `app.use` with `toNodeListener`; `toRequest` in a controller | runs                                         |
| NestJS, Fastify adapter              | Node, through Fastify                                          | the Fastify entry                                            | not tested                                   |
| AdonisJS                             | Node at `ctx.request.request` and `ctx.response.response`      | `toRequest`, `writeResponse` in a middleware                 | not tested                                   |
| Hono                                 | Fetch                                                          | `spoolHono`                                                  | runs                                         |
| Elysia                               | Fetch                                                          | `respond`, `decorate`                                        | runs                                         |
| itty-router                          | Fetch                                                          | `respond`, `decorate`                                        | runs                                         |
| Oak                                  | Fetch, through `app.handle`; published on JSR only             | `handle`                                                     | not tested                                   |
| h3, Nitro, Nuxt                      | Fetch, through `toWebRequest`                                  | `respond`, `handle`                                          | runs                                         |
| Analog                               | Nitro and h3 routes                                            | as Nuxt                                                      | not tested                                   |
| Next.js                              | Fetch                                                          | `respond` in the proxy, `handle` in the route                | runs                                         |
| SvelteKit                            | Fetch `event.request` in the `handle` hook                     | `handle(event.request, () => resolve(event))`                | not tested                                   |
| Astro                                | `context.request` in `onRequest(context, next)`                | `handle(context.request, () => next())`                      | not tested                                   |
| React Router v7, Remix               | Fetch `request` in `handleRequest` and the server build        | `handle` around the request handler                          | not tested                                   |
| TanStack Start                       | Fetch, in the server entry's `fetch(request)`                  | `handle(request, () => handler.fetch(request))`              | not tested                                   |
| SolidStart                           | an event in `onRequest` that may return a `Response`           | `respond` in the middleware                                  | not tested                                   |
| Qwik City                            | `requestEv` in `onRequest`; `send(Response)`                   | `respond` in the middleware                                  | not tested                                   |
| Cloudflare Workers                   | Fetch                                                          | `handle`                                                     | runs, in workerd                             |
| Cloudflare Pages Functions           | Fetch, in `onRequest(context)`                                 | `handle(request, () => context.next())`                      | stand-in                                     |
| Netlify Functions                    | Fetch                                                          | `handle`                                                     | stand-in                                     |
| Netlify Edge Functions               | Fetch; returning `undefined` passes on                         | `handle(request, () => context.next())`                      | stand-in                                     |
| Deno, Deno Deploy                    | Fetch, through `Deno.serve` or `deno serve`                    | `handle`                                                     | stand-in                                     |
| Bun                                  | Fetch                                                          | `handle`                                                     | runs, under `Bun.serve`                      |
| Vercel Functions                     | Fetch                                                          | `handle`                                                     | stand-in                                     |
| AWS Lambda, Function URL or HTTP API | JSON event version 2.0                                         | `@hono/aws-lambda` around a Hono app                         | stand-in event                               |
| AWS Lambda, API Gateway REST API     | JSON event version 1.0                                         | `@hono/aws-lambda` around a Hono app                         | not tested                                   |
| Lambda@Edge                          | CloudFront event with header arrays                            | none; a converter to `Request` is needed                     | not tested                                   |
| Fastly Compute                       | Fetch, through `event.request` in a `fetch` listener           | `event.respondWith(spool.handle(event.request, next))`       | not tested                                   |
| Azure Functions v4                   | `HttpRequest`, which follows Fetch; returns `HttpResponseInit` | convert, then `handle`                                       | runs, with a real `HttpRequest`              |
| Google Cloud Functions               | Node `req`, `res` from the Functions Framework                 | `toNodeListener`                                             | runs, on the Functions Framework test server |
| Google Cloud Run                     | any HTTP server on `PORT`                                      | the Node example                                             | not tested                                   |

A host that serves static files and runs no code, such as an object store or a plain web server, uses
[Static Sites](#static-sites).

---

## Static Sites

A site with no spool server can still answer repeat views from the device. It serves three files
from one directory:

- `spool-sw.js`, the worker, from a release or `https://cdn.drupflare.com/spool/<version>/`.
- `client.js`, the page script, from the same place.
- `spool.json`, the list of files the worker may keep.

Each page loads the script with the tag from [CDN Script](#cdn-script), or from the site's own copy.
The worker has no server to talk to, so it reads `spool.json` from the directory its own script
sits in.

```json
{
  "schema": 1,
  "routes": [
    {
      "pattern": "/",
      "strategy": "static",
      "version": "sha256-<base64 digest of the page>",
      "freshness": { "maxStale": 3600, "mode": "soft" }
    },
    { "pattern": "/about", "strategy": "static", "version": "sha256-<base64 digest of the page>" },
    { "pattern": "/css/site.css", "strategy": "static", "version": "build-42" },
    {
      "pattern": "/client.js",
      "strategy": "static",
      "version": "sha384-<base64 digest of the file>"
    }
  ]
}
```

A route names one path, or a `:name` pattern whose paths share one version. `version` says what
the file is now:

- A `sha256-`, `sha384-` or `sha512-` value is checked against the bytes the worker fetched. A
  mismatch keeps nothing.
- An entity tag such as `"abc"` is checked against the response's `ETag`.
- Any other string is a label you change when the file changes.

The first view of a path goes to the network, and the worker keeps a copy of the response as it
arrives: the bytes and the headers, including any `Content-Security-Policy`. Later views of that
path make no request until the route's `maxStale` passes, which defaults to 15 minutes. After that
a `soft` route shows the copy and fetches `spool.json` once, and a `hard` route fetches it first.
A file whose version changed, or whose route left the manifest, is dropped and the next view
fetches it again. Set `sync` to `deferred` to wait for a request the page makes anyway, and
`offline` to `refuse` to keep a hard route from showing a copy it cannot check.

The worker keeps files up to 4 MiB and never a redirect or an error. It sends no analytics batches
and makes no request to `/.spool/*`. Serve `spool-sw.js` with `Cache-Control: max-age=86400`; that
header is what lets Chromium and Firefox skip the update check. To pin the script to the CDN, make
`/spool-sw.js` a one-line file:

```js
importScripts('https://cdn.drupflare.com/spool/<version>/spool-sw.js');
```

`importScripts` has no integrity check, so this form trusts the CDN host with the worker.

`spool.publishStatic(sink)` is a different route to the same tier, for a host that runs no spool server. It writes the page runtime, the worker script, the packs and their deltas, one boot script per pack and a `_headers` file to the sink, and the host answers those files with no handler call. It does not write `spool.json`. With no policy known, the stub names none, and a device renders locally after one network view that teaches it the headers. Pass `policy` to `createSpool` (`{}` for a site with no security headers) to name them. The Vite, Vue, React Router and Nuxt plugins call `publishStatic` at the end of a build by default; `static: false` turns that off. See [Static Tier](docs/protocol.md#static-tier) and the [static example](examples/static/README.md).

---

## Advanced Usage

[ADVANCED_USAGE.md](ADVANCED_USAGE.md) covers each declaration and setting past the Quick Start,
in the order an operator meets them. Each section gives the use, the smallest declaration and the
limit.

- [Strategies](ADVANCED_USAGE.md#strategies): the five ways a route is answered locally, and the
  security headers a local page keeps.
- [Records and Projections](ADVANCED_USAGE.md#records-and-projections): shared records, stored once
  per id.
- [Templates](ADVANCED_USAGE.md#templates): the template syntax and the trusted-field rule.
- [Static Files](ADVANCED_USAGE.md#static-files): files kept as the server sent them.
- [Projection and Data Routes](ADVANCED_USAGE.md#projection-and-data-routes): JSON answers, bundled
  renderers and the provisioning rule.
- [Query Routes](ADVANCED_USAGE.md#query-routes): filter, sort and page a held collection with no
  request.
- [Freshness Contracts](ADVANCED_USAGE.md#freshness-contracts): hard and soft bounds, and the script
  lease.
- [Datasets](ADVANCED_USAGE.md#datasets): row patches with a proof, plus
  [Dataset Routes](ADVANCED_USAGE.md#dataset-routes) and
  [Principal Datasets](ADVANCED_USAGE.md#principal-datasets).
- [Authenticated Data](ADVANCED_USAGE.md#authenticated-data): per-principal partitions, sealed
  storage and logout wipes.
- [Declared Writes](ADVANCED_USAGE.md#declared-writes): queued last-value edits with a version check.
- [Page Runtime Settings](ADVANCED_USAGE.md#page-runtime-settings): the bootstrap gate, `workerMode`,
  swap elements and the `window.spool` surface.
- [Catalogue](ADVANCED_USAGE.md#catalogue): data for the pages a visitor may open next.
- [Analytics Batching](ADVANCED_USAGE.md#analytics-batching) and
  [Collectors](ADVANCED_USAGE.md#collectors): beacons, sinks and third-party collection.
- [Third-Party Files](ADVANCED_USAGE.md#third-party-files) and
  [Subresource Handling](ADVANCED_USAGE.md#subresource-handling).
- [Shadow Mode](ADVANCED_USAGE.md#shadow-mode): compare local renders with the network before
  serving.
- [Proxy Mode](ADVANCED_USAGE.md#proxy-mode): front an origin that cannot load the library.
- [Trimmed Stylesheets](ADVANCED_USAGE.md#trimmed-stylesheets) and
  [Images and Video](ADVANCED_USAGE.md#images-and-video): proxy options for CSS, images and video.
- [Capacity Reports](ADVANCED_USAGE.md#capacity-reports): the capacity plan, the institution report
  and request arithmetic.

---

## Security

Authorisation stays on the server. The device holds only what the server already sent that
principal, and the worker has no access rule. Principal data sits in a per-partition IndexedDB
database sealed with AES-GCM, and deleting the key at logout is crypto-shredding of data at rest.
That does not protect against script running on your origin. A revoked permission can still show
for up to a route's `maxStale`, because nothing pushes a revocation to a device. Tag names are
readable through `/.spool/sync`, so use opaque ids for anything sensitive. Principal datasets and
declared writes ship off and have had no external review.

[docs/security.md](docs/security.md) is the threat model. It names the file and the test behind
each claim and lists the open limitations in one table. Report a vulnerability as
[SECURITY.md](https://github.com/drupflare/spool/blob/master/SECURITY.md) describes.

---

## Energy Reporting

Energy is one objective among those spool reports, and the administrator decides how much weight
it gets. The energy of one deployment is small against an institution's total, and small against
the idle and hosting energy drupflare removes per site. The figures below are research figures.

[docs/impact.md](docs/impact.md) is generated from the readings in `measurements/` by
`bun run impact`, and `bun run impact:check` fails when the page differs from them. Energy is
reported in kWh per million views, and nothing sets a target intensity. Every figure carries a
layer: L0 published, L1 measured here, L2 derived, L3 scenario. A per-view figure that spreads a
published intensity over bytes is an allocation of that figure, and the page prints the metered
reading beside it. The savings from trimming, images and dictionaries apply to network views and
never add to the local-view figure.

The request counts in [Economics](docs/economics.md#headline-numbers) come from library readings on Chromium and Firefox. WebKit is absent from every library reading. The library's headline covers Chromium and Firefox only. WebKit, which is every browser on iOS, defaults to no worker because of an upstream script check on every navigation; its figures are model rows or single script-check readings, never library readings. "Chromium and Firefox" is well under all of mobile.

[An Institution's Figures](docs/impact.md#an-institutions-figures) leads with economics, storage
and trust and treats energy as a research figure. [What This Does Not
Claim](docs/impact.md#what-this-does-not-claim) lists what the page leaves unsaid.

---

## Prior Art

spool is a server-authoritative replica whose freshness policy lets a provisioned view render with
no per-view validation request, with shadow mode and a fall back to the server for anything it
cannot answer. HTTP caching, service-worker precaching and earlier replication systems cover parts
of it. What is shared and what differs:

| System             | What it does                                                  | Shared with spool                               | Difference                                                                                |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| HTTP caching       | reuses a response within `max-age` with no validation         | a repeat view with no request                   | one response at a time; no per-dependency invalidation and no held collections            |
| Workbox precaching | answers a precached navigation from the cache with no request | a worker answering a navigation with no request | the list and its revisions are fixed at build time and refresh when a new worker installs |
| Fawkes (NSDI 2020) | caches static page templates and sends a patch of DOM updates | a cached template, the server authoritative     | the patch is requested on every load, so a cached template never answers a view alone     |
| Speculation Rules  | prefetches or prerenders pages the visitor may open next      | acting on a predicted next view                 | the origin answers every speculated request, used or not                                  |

Sync Kit (WWW 2010) also keeps templates and data in the browser to reduce server load. The
[technical report](TECHNICAL_REPORT.md#executive-summary) states the narrow claim.

---

## Out of Scope

- spool never authorises on the client. The device holds only what the server already sent that
  principal.
- It never shows a hard route past its bound without validating it first.
- It never writes on its own. Your application owns every write, and `invalidate` only announces
  one. The one exception is a declared write class, which is off until you enable it.
- It never infers dependencies from opaque HTML. A route names its tags, or the records it
  reads, and in proxy mode the origin names them in its cache tag headers.
- It never replaces a published release file on the CDN.

---

## Browser Support

| Engine   | Controlled navigation                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium | no request, new tabs included                                                                                                                                                                                                                                                                             |
| Firefox  | no request, new tabs included                                                                                                                                                                                                                                                                             |
| WebKit   | with `workerMode: 'always'`, on macOS, one request to re-check `/spool-sw.js` on each document navigation (none on Linux while the worker runs); with the default `'auto'`, no worker on a page with a ring, so no script request; one refetch of each cacheable subresource on the first controlled load |

The worker registers with `updateViaCache: 'all'` and the script is served at
`max-age=86400`, which is what lets Chromium and Firefox skip the update check. WebKit on macOS
re-checks the script regardless, so with `workerMode: 'always'` a document navigation there costs one
request whatever the site does ([docs/impact.md](docs/impact.md#demand-per-client)). With the default
`workerMode: 'auto'`, WebKit registers no worker on a page that carries a ring, so the script is not
requested; the page runtime still answers held reads and in-page navigation
([WebKit Default](docs/protocol.md#webkit-default)). A deploy changes the script bytes and reaches a
browser within that day. A browser without service workers gets the
page it always got.

A page that loads a resource from another origin is not a zero-request view. spool counts those
loads per view and reports the view as such.

---

## Subpath Exports

| Import                                   | What is in it                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@drupflare/spool`                       | the protocol and report modules                                                                               |
| `@drupflare/spool/protocol`              | envelopes, artifacts, patterns, templates, the manifest, view events                                          |
| `@drupflare/spool/server`                | `createSpool`, `defineRoute`, `defineDataset`, `defineWrite`, `datasetProof`, sinks, identity and work series |
| `@drupflare/spool/node`                  | `toNodeListener`, `toRequest`, `writeResponse`                                                                |
| `@drupflare/spool/proxy`                 | `spoolProxy`, `chooseBases`, the tag readers and the eligibility verdict                                      |
| `@drupflare/spool/stores`                | `memoryStore` and the `VersionStore` type                                                                     |
| `@drupflare/spool/stores/durable-object` | `durableObjectStore` and the `SpoolVersions` class                                                            |
| `@drupflare/spool/sw`                    | `serve`, for a site that bundles its own worker                                                               |
| `@drupflare/spool/client`                | `register`, the page handle and `createActivity`                                                              |
| `@drupflare/spool/report`                | the energy model, capacity plans and institution reports                                                      |
| `@drupflare/spool/trim`                  | `buildTrimManifest`, `trimCss` and `guardPage`                                                                |
| `@drupflare/spool/media`                 | `tinyimgEncoder`, `imageVariant`, `rewriteVideo` and `rewriteEmbeds`                                          |
| `@drupflare/spool/express`               | `spoolExpress`                                                                                                |
| `@drupflare/spool/hono`                  | `spoolHono`                                                                                                   |
| `@drupflare/spool/vite`                  | `spoolVite`                                                                                                   |
| `@drupflare/spool/vue`                   | `spoolVue` and `vuePages`                                                                                     |
| `@drupflare/spool/angular`               | `spoolAngular`                                                                                                |
| `@drupflare/spool/nuxt`                  | the Nuxt module (default export) and `#spool/pages`                                                           |
| `@drupflare/spool/react-router`          | `spoolReactRouter`, `reactRouterPages` and `flattenRoutes`                                                    |
| `@drupflare/spool/next`                  | the Next adapter (default export), `spoolTag`, `spoolRouteHandler`, `nextPages` and `SPOOL_PAGES_FILE`        |

---

## Testing

```sh
bun run typecheck
bun run test
bun run test:coverage
bun run test:browser
bun run prettier:check
bun run impact:check
bun run docs:build
bun run build
```

`typecheck` also compiles every `ts` fence in this page and the guides as written, and it fails with
the page and line of the first fence that does not compile. A fence that cannot stand alone takes
`ts no-check` after the opening backticks and is skipped. Samples that tests run live under
`tests/node/readme/`.

`impact:check` fails when `docs/impact.md` differs from the readings in `measurements/`. A node
test fails when `src/server/embedded.ts` differs from the source under `src/protocol`, `src/sw`
and `src/client`, and `bun run build:sw` regenerates it. `test` runs the unit project in workerd and the node project, which includes a test that packs the
package and imports every subpath in plain Node. `test:browser` runs Chromium, Firefox and WebKit
against real servers and counts the requests that reach them. `bunx playwright install chromium
firefox webkit` fetches the browsers.

---

## Documentation

- [docs/configuration.md](docs/configuration.md) covers the settings a first deployment decides.
- [docs/protocol.md](docs/protocol.md) holds the paths, headers, JSON bodies and limits for anyone
  who writes an adapter or a second server. A test pins what `Spool-Protocol: 1` freezes, and the
  page lists what may change without a new number.
- [docs/security.md](docs/security.md) holds the threat model and the open limitations.
- [docs/impact.md](docs/impact.md) holds the energy model, the readings and what they leave unsaid.
- [docs/economics.md](docs/economics.md) holds the bandwidth and Worker invocation projections.
- [examples/README.md](examples/README.md) lists the example sites and runtimes, and the command that runs each one.

---

## Related Repositories

| Repository                                                      | What it is                                               |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)       | Drupal on Cloudflare Workers                             |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge) | runs a blocking wasm interpreter inside a Durable Object |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb) | the limits of Durable Object SQLite, encoded as a codec  |
| [`drupflare/burrow`](https://github.com/drupflare/burrow)       | executes WebAssembly on Workers                          |

---

## License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).

The documentation favicons in `docs/` come from Google's [Noto Emoji](https://github.com/googlefonts/noto-emoji) set, licensed under [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).
