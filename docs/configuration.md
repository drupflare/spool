# Configuration

This page covers the settings an operator decides first: which routes are public, how old a
stored page may get, where the bundles live, and how the page runtime loads. Each setting gives its
default, the value this page recommends and the reason. Defaults come from the code and the file
that holds them is named. Where a recommendation is a judgment rather than something the code or a
measurement fixes, the text says so.

Figures carry a layer: L0 is a published default or a package constant, L1 a measurement under
`measurements/`, L2 a derivation from those, and L3 a scenario. Proxy mode, collectors, trimming,
image conversion and the reports are in [Advanced Usage](../ADVANCED_USAGE.md). If the server does
not answer yet, start with [Getting Started](getting-started.md).

## Routes and Freshness

A route has one of two scopes. A `public` route serves the same page to every visitor. A
`principal` route serves one signed-in person and needs the `identity` option on `createSpool`.
Public is the default.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const news = defineRoute('/news/:slug', {
  strategy: 'template',
  template: { source: '<h1>{{row.title}}</h1>' },
  family: { dataset: 'news', key: 'slug' },
  freshness: { maxStale: 300, mode: 'soft' }
});

export const account = defineRoute('/account', {
  scope: 'principal',
  strategy: 'template',
  template: { source: '<h1>{{owner}}</h1>' },
  depends: (ctx) => [`account:${ctx.identity?.principal}`],
  load: (ctx) => ({ owner: ctx.identity?.principal })
});
```

Use a public route for content that every visitor sees. Use a principal route only where the page
depends on who asks. A principal route is kept sealed in that person's partition on the device, and
it carries a stricter default contract (below), so it costs more to serve.

For a public collection that editors change, declare a `family` route. In the four-day public edit reading, the stored-page route (a `template` with `depends`) made 17 requests over nine views, against 10 requests for the family route over the same views (L1, `measurements/demand/2026-11-20-days-ship-a.json`). The family route is the one to declare for an editable public collection.

### Freshness

`freshness` takes `maxStale`, in seconds, and a `mode`. The defaults are in `DEFAULT_FRESHNESS`
(`src/protocol/route.ts`):

- Public: `maxStale` 900, mode `soft` (L0).
- Principal: `maxStale` 300, mode `hard` (L0).

In `soft` mode the device shows the stored page at once and queues one sync for a later network
moment. In `hard` mode the device syncs first and shows the page only if it is still current. A
soft route therefore makes no request for the view that finds its bound passed. A device that
reads only local pages never reaches a network moment, so a queued sync that has waited a full
lease (`freshness.maxAge`, one day by default) is sent from the next local view, at most once a
lease (`docs/protocol.md`, Lease). A hard route makes a request on each view after the bound
passes.

Recommendation: keep the public default for most content. Lower `maxStale` for data that changes
within the hour. Make a route `hard` only where showing an old page does harm, such as a grade or a
price. This is a judgment. The reason is the request count above: `hard` puts a sync on the view
path, and `soft` moves it off.

The examples set their own values. The homepage example uses 300 seconds soft for news and events,
and 86,400 seconds hard for program and about pages. These are example settings, not measurements.

### Tags

`depends` names the tags a page is built from. `spool.invalidate(tags)` marks every stored page
with a matching tag as changed, and the device fetches it again at its next sync. A tag a page
reads but does not list is not invalidated, so that page keeps its old copy until `maxStale`
passes.

Recommendation: list one tag per record the page reads and one per collection a list reads, such as
`node:<id>` and `nodes`. This is a judgment that follows from the rule above.

### Lists and Filters

A list route declares `query` with a `dataset`. Its `pageSize` turns on the `page` parameter. Without
`pageSize` the route answers one page of everything, and its artifact holds the whole collection
(`docs/protocol.md`, Query Routes; [Query Routes](../ADVANCED_USAGE.md#query-routes)).

Recommendation: set `pageSize` to the number of items the list shows. This is a judgment. A
collection sent in full is large, and the device pages through a copy it already holds.

Declare only the filters and sort fields the page uses. The worker answers a query string locally
only when every parameter appears in the schema. Any other query string goes to the network
(`docs/protocol.md`, Query Routes).

## Server Options

Most of the server's behavior comes from `createSpool`. The options below are the ones a first
deployment touches. Every option is optional unless the text says otherwise.

```ts
import { createSpool, memoryBundleStore, memorySink } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  bundles: memoryBundleStore(),
  sink: memorySink(),
  mode: 'shadow',
  beacons: ['/cdn-cgi/rum'],
  policy: { 'content-security-policy': "script-src 'self'" }
});
```

### Store and Bundles

- `store` is required. `memoryStore` serves one process. Any deployment with more than one instance
  needs a store all of them share, such as `durableObjectStore` on Cloudflare
  ([Getting Started](getting-started.md#keep-the-version-store)).
- `bundles` has no default. Without it, `GET /.spool/bundle/<version>` answers `404`, and a family
  page carries no ring (`docs/protocol.md`, Ring). Recommendation: pass a bundle store on any site
  with family routes or datasets. Reason: the ring is how the first document gives the page its
  rows.
- `publish(url)` builds the pack at the store cursor. A data change moves the cursor. A page gets no
  ring until a pack exists for the new cursor, so call `invalidate`, then `publish`. The doc comment
  on `publish` in `src/server/spool.ts` says to call `invalidate` after a data change.
- `bundle.ringBytes` defaults to 24,576 (L0). The code comment calls this default unmeasured. Keep
  it. `bundle.blockRows` defaults to 128 and `bundle.maxBytes` to 8,388,608, the frame cap
  (`src/protocol/bundle.ts`, L0). Keep both.

### Stub Lease

- `freshness.maxAge` is the lease of `/spool-sw.js` in the browser's cache. It defaults to 86,400
  seconds, one day (`STUB_MAX_AGE`, `src/server/spool.ts`, L0). Recommendation: keep the default.
  Chromium checked the stub on the first navigation after each 24 hours whatever the lease was, as
  the code comment records (measured in Chromium only). A longer lease therefore cuts no checks. A
  shorter one adds one check per lease per page, at load or at an in-page view
  (`docs/protocol.md`, Lease). Lower it only when a deploy must reach devices sooner than a day.
  A check after the lease costs the full script, 138,569 to 152,832 B over the example sites (L1),
  unless the host passes the request to `spool.stub(request)`, so the browser can revalidate with
  `If-None-Match`; `stub()` with no request sends no validator. The stub then carries an `ETag`
  and an unchanged script answers `304` with no body in Chromium and Firefox (L1, Chromium 156,
  Firefox 157; [Economics](economics.md) has the reading). WebKit sends no validator and gets the full script each time (L1, WebKit 27.2). A
  changed script is one full response everywhere, so a site with one view a day pays it on each
  day the script changed (`docs/protocol.md`, Worker Script).
- `stamp` is a counter, or a function that returns one, that changes the stub's bytes. It has no
  default. Set it when a static host republishes the stub at each lease period, so a forced check
  installs the new script. Otherwise leave it out.
- `static` is an option of the Vite, Vue, React Router and Nuxt plugins, not of `createSpool`. It
  defaults to on: the build writes spool's own files (the runtime, the stub, the packs and a `_headers`
  file) into the public directory with `spool.publishStatic`, and the site's pages still come from its
  server. `false` turns it off. Its `policy` defaults to the spool's `policy` option, then a page the
  instance answered, then the `/*` block of a `_headers` file in the output, then none. Leave it unset
  unless the build cannot see the site's security headers ([Vite](adapters/vite.md#static-tier)).

### Page Runtime

- `clientTag` defaults to `'inline'`. The inline gate stands in for the script tag on a second-view
  page, and it loads the runtime from the second view. A one-view visitor makes no request for the
  runtime (`src/server/spool.ts`). Use `'script'` when the page's Content Security Policy forbids
  inline scripts. A first-view site always uses the tag, whatever this option says.
- `bootstrap` defaults to `'second-view'`. Set to `'first-view'`, the device fetches the pack on the
  first view. Economics puts the bootstrap at two requests after the first document with a worker
  (L3, a design figure with no reading yet, `docs/economics.md`). Recommendation: keep
  `'second-view'`. A visitor who makes one view then pays nothing. The worker waits for the third view
  inside one lease period (`freshness.maxAge`, a day by default), so a visitor who returns once a day
  never installs one. Switch to `'first-view'` only
  when the reports show that most visits make two or more views. That is a judgment.
- `cdn` is off by default. The runtime then comes from `/.spool/<version>/client.js` on the site's
  own origin. Recommendation: keep the same-origin default. A CDN load needs the CDN origin in
  `script-src` and the integrity hash for the version (`docs/security.md`, Script Delivery).
- `cdn.worker` is off by default. Set to `true`, or to `{ url }` for another host, the stub is the
  config and one `importScripts` line, and the worker core comes from the CDN. The stub then costs
  7,175 B in place of 141,976 B at the site's origin (L1, one fixture), and a deploy that changes
  only the stub sends the short one. WebKit checks the worker script on each navigation, and the
  check fetches the imported script from the CDN too (L1, WebKit 27.2 on Linux). A browser checks no hash for an imported script, so the site
  trusts the CDN host with code that answers every request of the origin. Recommendation: keep it
  off unless the stub's bytes are a cost you have measured, and run
  `publishStatic(sink, { verifyCore: true })` when it is on. This is a judgment
  (`docs/security.md`, Worker Core from the CDN).
- `workerMode` defaults to `'auto'`. `'never'` serves no service worker, so `/spool-sw.js` answers
  `404`. `'auto'` registers the worker everywhere except WebKit, where a page that carries a ring
  keeps its reads in the page and registers none. WebKit re-fetches the worker script after each
  document navigation (bug 332455), a WebKit issue that site code cannot remove
  ([WebKit Default](protocol.md#webkit-default)). `'always'` keeps the worker on WebKit too. Recommendation: keep `'auto'`. Use `'never'` only where the site cannot
  or should not run a worker, and `'always'` only where a WebKit visitor's typed documents must come
  from the worker and the script request per navigation is acceptable. This is a judgment. In that mode a public HTML page carries the declared writes in its ring,
  or in a `spool-writes` element when it has no ring; on a gate site every public HTML page carries
  the ring ([Page Runtime](../README.md#page-runtime)).
- `policy` has no default. The worker takes the site's security headers from the stub, and the stub
  takes them from this option or from the last HTML page the server answered
  (`docs/security.md`, Content Security Policy). A worker with no page yet has no policy, so local
  renders wait for one. Recommendation: set `policy` to the site's policy headers when the policy
  is part of the release, so the first install already carries it. This is a judgment.

### Views, Shadow Mode and Sinks

- `mode` defaults to `'serve'`. `'shadow'` renders each page locally, compares it with the network
  answer and never serves the local copy. A route's own `mode` overrides it. Recommendation: start a
  new site in `'shadow'`, check the mismatches, then switch to `'serve'`
  ([Shadow Mode](../ADVANCED_USAGE.md#shadow-mode)).
- `shadowSample` defaults to 0. It is the share of views, from 0 to 1, that run in shadow while the
  rest are served. The Shadow Mode section uses 0.05 as an example value. Pick the share from the
  traffic you can afford to check. This is a judgment.
- `views` defaults to `true` when there is a `sink`, so each page view reports a `spool.view` event.
  With no `sink` it defaults to `false`, and the worker queues no view event. An explicit
  `views: true` with no `sink` still sends them, and the server drops them. The mismatch counts, the
  route-to-route shares and the catalogue figures all read these events (`docs/protocol.md`, View
  Events).
- `sink` has no default. Events the worker sends to `/.spool/beacon`, and drop counts, go to the
  sink, and the reports read it with `viewsOf(sink.events)`. Recommendation: set a sink on any site
  whose reports you read.
- `beacons` has no default. It lists the same-origin POST paths that analytics scripts send to. A
  post to a path not in this list makes a request on every view, which defeats a local view.
  Listed paths are queued and sent at a network moment that happens anyway
  ([Analytics Batching](../ADVANCED_USAGE.md#analytics-batching)). Recommendation: list the paths
  your analytics scripts post to.

### Assets and Third Parties

- `assets` defaults to `'cache'`, which answers an immutable same-origin file from the worker's
  cache. Recommendation: keep the default. `'static-routing'` has no energy reading in
  `docs/impact.md`, and `'passthrough'` leaves the file to the browser's own cache
  ([Subresource Handling](../ADVANCED_USAGE.md#subresource-handling)).
- `thirdParty` is off by default. Recommendation: leave it off until `thirdPartyReport` ranks an
  origin high enough to matter. Then allow only that origin
  ([Third-Party Files](../ADVANCED_USAGE.md#third-party-files)).

### Provisioning and Catalogue

- `provision` sets the priors the server uses before it has telemetry. Each number is a scenario
  assumption, and the operator should replace it with measured values (`src/protocol/config.ts`).
  Recommendation: leave the priors unset until a site has its own reports.
- `catalogueBytes` defaults to 32,768 compressed bytes (L0). It caps what one catalogue bundle
  carries. Keep the default.
- `catalogueConfidence` defaults to 0, which judges each share on its point value. The option
  documents 1.28 as one-sided 90% confidence. Recommendation: leave it at 0 until the shares have
  counts behind them, then set 1.28.
- `inlineMaxBytes` defaults to 0, which is off. Set above 0, it puts a template page's artifact in
  the page, and every network view of that page then pays for those bytes and one more load, with
  or without a worker (`src/server/spool.ts`). Recommendation: keep 0.

### Provisionable Routes

A family route with a key other than `viewer.id` and no `load` is not provisionable. Its row comes
from the dataset, so there is no artifact to send. The route declaration has no `provisionable`
option. `defineRoute` sets the flag, and no site sets it by hand (`src/protocol/route.ts`).

## Identity and Sign-In

Principal routes need the `identity` option. Without it, a principal artifact request answers `401`
with `sign in`, and `createSpool` refuses declared writes and principal datasets. The options below
are the ones to decide before the first signed-in page ships.

```ts
import { createSpool, memoryBundleStore } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  bundles: memoryBundleStore(),
  identity: {
    secret: 'a long random value kept on the server',
    resolve: () => null
  },
  logout: ['/logout']
});
```

- `identity.secret` keys the partition id, an HMAC of the principal. The browser can tell users
  apart from it without learning who they are. Recommendation: a long random value from the
  server's secret store. A value that leaks lets anyone compute the partition id of a known
  principal.
- `identity.resolve` returns `{ principal }` for the request's session, or `null`. The server calls
  it on each request it handles, so keep it to a session lookup.
- `logout` has no default. List every path that ends a session. The worker wipes the principal's
  store before the logout request leaves, so the wipe works with the network down
  ([Authenticated Data](../ADVANCED_USAGE.md#authenticated-data)).
- A principal route's `retention` defaults to `'persistent'`, a non-extractable key in IndexedDB
  that survives a worker restart and a browser restart and is deleted at logout. Declare
  `retention: 'session'` on a shared or kiosk device: that key lives in the worker's memory, so
  the browser discarding the worker makes the held page and rows unreadable, and every return is a
  network view ([Sealed Stores](security.md#sealed-stores)).
- `live` is on by default when `identity` is set, except on Workers, where it needs a `hub`, such as
  `durableObjectHub(env.SPOOL_LIVE)` (`liveSettings`, `src/server/live.ts`). A visible page then holds
  one `/.spool/live` stream and renews its lease inside it. With `durableObjectHub(ns, { hibernate: true })`,
  pages open a WebSocket instead, and an idle object can hibernate. Pages whose upgrade fails fall back
  to SSE. Hibernation saves no dollars at the documented scenario
  ([Economics](economics.md#hibernation-transport)).

## Starting Values

These are starting points for two common sites. Each non-default setting names its reason.

A public content site, such as a blog or a course catalogue, starts with:

- Public routes at the default `soft` freshness. Shorten `maxStale` for data that changes within
  the hour.
- A bundle store, so family pages carry a ring.
- `pageSize` on every list route, set to the number the list shows.
- `mode: 'shadow'` on the first deploy, then `'serve'` once mismatches are gone.
- A sink, so the reports have events to read.
- `beacons` for each analytics post path, if the site runs analytics scripts.

A dashboard with principal data and writes starts with:

- `identity` with a secret and a `resolve` that returns the session's principal.
- `logout` listing every session-ending path.
- Principal routes at the default hard bound of 300 seconds. Revocation rides the same bound, so a
  removed permission can show until the first required sync past it
  ([Authenticated Data](../ADVANCED_USAGE.md#authenticated-data)). Keep the bound short.
- Principal datasets only after review, since the option is documented as unreviewed. A principal
  dataset needs `principalDatasets: true` and its own `maxStaleMs`. The dashboard example uses
  600,000 ms, ten minutes. That value is an example, not a measurement.
- Declared writes off. `writes` is off by default and documented as unreviewed. Resource writes,
  which declare item routes with `defineResource`, need no flag, and they need a bundle store so the
  device keeps its pack current.

## Checking Your Setup

The [Getting Started](getting-started.md#check-that-it-works) page gives three `curl` checks for the
stub, the gate and the envelope. Those confirm the server half is wired. The checks below confirm
the device side.

A healthy site shows these counts. The README states the first one as a contract, and the zero
network browser test holds it:

- A local view makes zero server hits in Chromium and Firefox. The README states this as the
  contract (L1, the browser test in `tests/browser/zero-network.pw.ts`).
- In WebKit on macOS, a page with a worker makes one request to re-check `/spool-sw.js` on each
  document navigation (L1, [Browser Support](../README.md#browser-support)). Under the default
  `workerMode` a WebKit page that carries a ring registers no worker and makes none; a typed
  document there is a network request, as without spool.
- Each page makes at most one stub check per lease (`docs/protocol.md`, Lease).
- A first view has the reason `cold` and the tier `network`. A fresh view has the reason `fresh` and
  the tier `local` (`docs/protocol.md`, View Events).

Shadow mode shows what the local render would have sent. A view with `mismatch: true` names a route
whose template and application disagree. The check below reads the mismatches from the sink.

```ts
import { createSpool, memorySink, viewsOf } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

const sink = memorySink();

export const spool = createSpool({ routes, store: memoryStore(), sink, mode: 'shadow' });

export const mismatches = () => viewsOf(sink.events).filter((view) => view.mismatch === true);
```

Treat a non-empty result as a failure to fix before `mode` moves to `'serve'`.
