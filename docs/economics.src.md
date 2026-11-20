# Economics

This page projects what a site saves under spool in two currencies: the bytes a traditional origin no longer sends, and the Worker requests a Cloudflare account no longer pays for. It covers read views only. Every figure carries its layer: L0 published, L1 measured here, L2 derived from the other two, and L3 a scenario.

Each headline row's last column is its provenance. `library 1.0.0, measured` is a count from a reading of the shipped package with the worker controlling the spool arm. `library 1.0.0 page runtime, no worker` is a count from the shipped package where the reading's `controlled` field is false: the in-page navigation of the page runtime answered the views, and no worker was registered. `model over library counts (L3)` is a projection or byte formula over those counts. `review construction, not shipped` is a count from a construction the library does not implement, and `bound, no count` is a formula or a published rate. The last two rows sit in [Constructions That Are Not Shipped](#constructions-that-are-not-shipped).

## Headline Numbers

A net saving is the share of a baseline that spool removes after it pays for the bootstrap, the worker script (the stub), contacts, the sync and dataset requests, and writes. The baseline is the same visits with no spool. A negative saving is a result: spool sent more than the baseline. The multiplier is the baseline over spool. How each multiplier moved from one stage of the project to the next is under [Moving Numbers](impact.md#moving-numbers).

{{table:headline}}

The library readings come from {{value:headlineDate}} (Chromium and Firefox on one Linux box, a 1,000-course demo site, every request that reaches the origin counted). At 121 views, one document, 100 in-page views and 20 warm documents, Chromium sent {{value:headlineChromiumSpool}} origin requests against {{value:headlineChromiumBaseline}}. That is a net saving of {{value:headlineChromiumShare}}, a multiplier of {{value:headlineChromiumX}}, and {{value:headlineFreeChromium}} read views a day against the Free plan's {{value:headlineFreeLimit}} (L2 over L1 counts; the count includes every origin hit, so it is a bound on Worker requests and not a Worker meter). Firefox gives {{value:headlineFirefoxX}}. WebKit is absent from every library reading. The library's headline covers Chromium and Firefox only. WebKit, which is every browser on iOS, defaults to no worker because of an upstream script check on every navigation; its figures are model rows or single script-check readings, never library readings. "Chromium and Firefox" is well under all of mobile. The signed-in, public-edit and revoked-session rows are Chromium only, because Firefox did not start the multi-day arms under libfaketime. The own-write scenario is not measured.

### What Each Workload Gains

The model's five workloads are scenarios (L3). The table gives the best engine class for each and the worst, the Free plan's read views a day, the paid plan's dollars at 100 million read views a month, and the bytes a read view saves net of the ring on each network document, the boot script and the stub. The two byte columns differ only in the stub: the first fetches it in full each lifetime, as the multi-day reading did, and the second revalidates it with a 304 after the first fetch. The engine classes are Chromium and Firefox with a worker, WebKit under the default (which registers no worker, so it is the no-worker class), WebKit with `workerMode: 'always'`, and no worker.

{{table:headline-workloads}}

The engaged daily public reader and the retained public library gain most, because their views stay in the page or ride a replica kept across lifetimes. The short read lifetime gains little, since five views barely repay a bootstrap. The read/write workspace is held back by its writes, which reach the origin on every path. The ungated two-view lifetime loses under every engine class: three requests for two views, a multiplier of 0.67 with a worker. Bytes follow the same order and also depend on page size. The boot script is {{value:headlineBoot}} B, the ring adds {{value:headlineRing}} B to each network document, and one stub fetch is {{value:headlineStub}} B, which a stub repays only after {{value:headlineRepaid}} held views of a {{value:headlineDocument}} B document (L2 over L1). A tiny page, or a client with few views per lease, loses bytes whatever it saves in requests.

{{table:headline-bytes}}

### Where the Saving Disappears

{{table:headline-extremes}}

The one-view-a-day row is a tie on the final tree: {{value:headlineDailySpool}} requests with spool against {{value:headlineDailyBaseline}}, and no stub is fetched on the five days (L1). The local-only reader in the same reading made {{value:headlineLocalOnlySpool}} requests against {{value:headlineLocalOnlyBaseline}}. The byte comparison on the 127 B demo page is under [Impact](impact.md#demo-page-bytes), since a document that small is smaller than the inline gate and ring.

The signed-in rows are not what a default install produces. They need `principalDatasets: true`, the `identity` option and a principal route. Behind `spoolProxy`, a public route sends a request with a cookie outside the allowlist or an `Authorization` header to the origin, and a principal route needs `identity` (`src/proxy/eligible.ts`, `src/proxy/proxy.ts`).

A principal route's `retention` defaults to `'persistent'`: a non-extractable key in IndexedDB that survives a worker restart and a browser restart and is deleted at logout. A signed-in reader on that default pays the bootstrap on day 0 with 6 to 8 requests across three repeat runs of the same code (L1, `measurements/demand/2026-11-20-days-ship-c.json`, `-ship-d.json` and `-ship-e.json`). The swing is an install race. The page registers the worker after its second view loads, the worker needs about 2 to 4 s to take control, and a view that starts first reaches the origin without it, so the bootstrap waits for the next navigation. When the harness waits for control after each view, day 0 costs 8 requests in five of five runs, the four-day total is 20, and the held days still cost 4 requests (L1, `measurements/demand/2026-11-20-days-engage-a.json` to `-engage-e.json`; the waits ran 2.0 to 4.4 s). Each held day after that costs 4 requests and 288 B: a beacon (0 B), the sync request (80 B), the dataset request (208 B) and a stub check. Day 1 cost 288 B in ship-c and ship-d and 3,234 B in ship-e (L1). The baseline spends 1 request and 117 B a day. Over four days the reader makes 18 to 20 requests against 7 while the session stays valid, across the three runs, and 18 when the session ends on the server after day 2 (one run). On that day the principal page comes from the origin, and no held page is served locally (L1). A held principal page past its dataset's `maxStaleMs` syncs before it answers, and it shows only when the sync and the dataset both succeed ([protocol.md](protocol.md#freshness)).

Known limit, not a measured claim: a signed-in held day makes four separate requests, a beacon when a sink exists, the sync, the dataset request and the stub check, where the baseline makes one. The library does not merge them into one request. Merging the contact (beacon, sync, dataset and renewal) is the work that would remove this loss, and it is not done in 1.0.

With `retention: 'session'`, the opt-in for a shared or kiosk device, the same reader makes 19 to 22 requests against 7 over four days while the session stays valid (ship-b, ship-d and ship-e), and 21 when the session ends on the server after day 2 (all three runs agree). With the harness waiting for control after each view, the session reader makes 22 requests over four days in five of five runs (L1, `-engage-a.json` to `-engage-e.json`). On days 2 and 3 each run sends 5 requests and 3,225 B, with the principal document of 2,813 B fetched from the origin (L1, `measurements/demand/2026-11-20-days-ship-b.json`, `-ship-d.json` and `-ship-e.json`). A once-a-day signed-in reader still pays 4 requests against the baseline's 1, and a held day wins on bytes only where the page document is larger than the 288 B the held day sends (L2). The settings that govern these costs are the route's `retention`, the dataset's `maxStaleMs`, the route's `freshness.maxStale`, and the `views` option, which defaults to on only with a `sink` (L3, not measured without a sink). A tab held open all day and a population of clients are the two ends the documents carry: the first is a bound over a floor of one request and never a count, and the second is a review construction, not shipped. The 60,000-view tab does not say what a deployed site reaches.

### Constructions That Are Not Shipped

The rows in this section do not come from the shipped package. Each one counts a review construction, a hand-written server and client kept outside the library, or states a bound that no reading prints. The library does not implement the miss-triggered pack or the inlined client, so the figures here are not what `@drupflare/spool` produces. Each row keeps its figure and layer, and its last column gives its provenance.

{{table:headline-not-shipped}}

### Stub on a Static Tier or on the Worker

The Worker meter figures differ only in whether the stub and the boot script are served as static assets. Static asset requests are not Worker invocations. A stub on the Worker adds one invocation each time the browser fetches it. In the 121-view reading the same visits are five origin requests with the stub on the Worker and three Worker-invocation equivalents with the stub and boot script on a static tier (L2 over L1). These figures assume a static tier: the Worker-invocation equivalent rows in the first table, the static-tier columns of the Free-plan and paid-plan tables below, and the best-class requests in the workload table, which count the bootstrap once and leave out later stub re-checks. The origin-request rows and the WebKit `always` rows put the stub on the Worker. The static-tier columns assume a stub stamped and republished each lease period; an unstamped stub leaves the contact to the page.

The stub carries a strong `ETag` when the site serves it with `spool.stub(request)`. Chromium 156 and Firefox 157 re-check with `If-None-Match` and get a 304 with no body, {{value:headlineStub304}} B of status line and headers counted from the response object, instead of the full script. WebKit 27.2 sent no validator and took the full script (L1, Mac, a 2 s lease, 3 of 3 runs per engine). The stub GET in the local-only reading is {{value:headlineStub}} B (L1). Later stub requests on held days are counted at 0 B in the same readings. No reading holds a 304 at a 25 hour lease, so the revalidated byte rows are L2 on that scope.

## Scope

A held view sends no document request. The document is the only thing counted on the origin side. Static assets stay in the browser's HTTP cache, so they are not counted. API calls and third-party requests still leave during a local view, and the figures leave them out. CPU time and energy are not on this page; [docs/impact.md](impact.md) covers them.

Prices and limits were read on {{value:pricesRead}}. Prices are third-party list prices before any free allowance.

## Inputs

{{table:inputs}}

The first-view document is the median document a first view moves: {{value:firstDocument}} B over {{value:firstPages}} corpus pages. A held view never moves it, so the outputs below use the repeat-view document only.

The five workloads are scenarios (L3). Each row sets how often a replica syncs, updates and bootstraps, and how often a read view writes or contacts the origin. The WebKit macOS navigations (e) count the document navigations on that engine per lifetime, and each one costs a script request. Each workload has its own e, stated in the inputs table above with its rationale. The request law turns those rates into requests per read view.

The Worker invocation tables split readers into two cohorts (L3). In Chromium, Firefox and Linux WebKit, a document navigation under a running worker costs no request. In WebKit on macOS under `workerMode: 'always'`, each document navigation costs one script request, so a stub on the Worker pays for it. Under the default `workerMode: 'auto'` WebKit registers no worker and takes the no-worker column of the workloads table; the WebKit macOS columns describe `'always'`. A client with no worker pays one origin request for each document navigation after the first (L1, the WebKit `never` arm), so the no-worker column adds those navigations to its bootstrap. Each cohort shows the stub on the Worker and the stub on a static tier. The static-tier columns assume a stub stamped and republished each lease period, so every forced check installs and no Worker invocation follows. A Worker-served stub instead costs one invocation per client per active day, and an unstamped stub leaves the contact to the page.

A Worker-served stub is still one invocation at each re-check after the lease, whether it answers `200` or `304`. What changes is the bytes. With `spool.stub(request)` and an unchanged script, Chromium 156 and Firefox 157 sent `If-None-Match` and got a `304` with no body and 169 B of status line and spool headers (counted from the response object, so Node's `Date` and `Connection` are extra), in 3 of 3 runs each, once from `registration.update()` and once from a navigation (L1, Mac, 2 s lease so the lease expired without a faked clock). Before the change every re-check in those engines was the full 137,529 B script (L1, 3 of 3 runs each). WebKit 27.2 sent no validator on either trigger and got the full script every time, with or without the tag (L1, 3 of 3 runs). A changed script is one full response in every engine. The full script is 138,569 to 152,832 B over the five example sites, 45,257 to 46,141 B under gzip level 9 and 39,863 to 40,653 B under Brotli level 11 (L2, computed with `node:zlib` from L1 bytes; whether a host compresses is the host's choice, and `workerResponse` and the Node listener set no `Content-Encoding`).

{{table:workloads}}

## Bandwidth on Traditional Compute

A held read view saves one document request. The bytes it no longer sends are its document, {{value:repeatDocument}} B by median, multiplied by the held views. The table prices those bytes at two compute hosts' list prices for internet egress, before each host's free allowance. Google Cloud bills per GiB, so its dollars use binary gigabytes; the GB column is decimal.

{{table:bandwidth}}

## Worker Invocations on the Free Plan

The Free plan stops at {{value:freeLimit}} Worker requests a day. The table gives the read views a day that limit supports with and without spool. After the first document, a bootstrap sends {{value:bootstrapWorker}} requests with a worker and {{value:bootstrapNoWorker}} without one. A lifetime with few views saves less, and a two-view lifetime costs more under spool than it saves. The last row shows that case. The WebKit macOS columns add the script check from the paid-plan section below.

{{table:free-plan}}

## Worker Invocations on the Paid Plan

The paid plan includes {{value:paidIncluded}} requests a month, then charges {{value:paidPrice}} for each additional million. Requests to static assets are free and unlimited on the pricing page, so a stub served from a static tier adds no invocation, on the stamped arm described above. A stub on the Worker adds one invocation per WebKit macOS script check, at {{value:webkitRate}} request per document navigation (L1). The Chromium, Firefox and Linux WebKit columns add none. The WebKit macOS columns add the navigations in each workload's e.

The first table gives the monthly Worker requests with and without spool. The second gives the part above the included amount and what it costs.

{{table:paid-plan-requests}}

{{table:paid-plan-usd}}

## Principal Sessions and the Live Stream

A signed-in page renews its lease with a Worker request each time its route's `maxStale` passes. With the live stream on, a visible page holds one Server-Sent Events request instead, and the server renews the lease inside it. Durable Object rates below were read from the published pricing page on 2026-11-19 (L0): 400,000 GB-s of duration and 1 million requests a month included, then $12.50 per million GB-s and $0.15 per million requests. Duration bills the 128 MB an object holds, in wall-clock time, for as long as the object is active and cannot hibernate. An open SSE response keeps it active. These rows are written by hand and are not generated from `src/report`.

| Row                                                            | Figure                                                         | Layer                    |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| Worker requests in a 2.3 h session at 5 minute lease, renewals | 26                                                             | L1, review run, Chromium |
| Worker requests in the same session with push                  | 2                                                              | L1, review run, Chromium |
| Durable Object requests for one stream                         | 1 to open, plus 1 for each bump or revoke                      | L2 over L0               |
| Duration of an object with a stream open all month             | 0.125 GB x 2,592,000 s = 324,000 GB-s                          | L2 over L0               |
| That duration against the included 400,000 GB-s                | inside it, so no duration charge                               | L2 over L0               |
| Duration of one stream held for an hour, object otherwise idle | 0.125 GB x 3,600 s = 450 GB-s, $0.005625 outside the allowance | L2 over L0               |
| Stream bytes an hour at the defaults                           | 60 leases x 39 B + 144 keepalives x 4 B = 2,916 B              | L2 over frame lengths    |

Duration is shared by every stream on the object, so many concurrent streams cost the same wall-clock time as one. The figure that grows with sessions is the Durable Object request count, one per stream opened, and the Worker request for the same open. A local `wrangler dev --local` run (L1) showed 3 streams, 2 bumps and 1 revoke produce 3 Durable Object `fetch` calls, 2 `publish` calls and 1 `revoke` call, with a revoke reaching the closed streams in 20 to 27 ms. A stream is lost with the page, so a site that navigates by document opens one per document; the saving needs a page that stays open. The local run cannot show billing. Under `wrangler dev --local`, workerd did not surface a client abort to the object: in two probes (keepalive 2 s, lease 4 s, with and without `reader.cancel()`), 8 keepalive comments written after the abort all succeeded and no write threw. The object detached the connection about 14 s later through the stall guard, which closes a stream after 8 unread frames (L1, local only). At the defaults, a lease every 60 s and a comment every 25 s write about 4.4 frames a minute, so the same guard would take roughly two minutes (L2 over the frame rates); the hard bound is `live.maxAge`, 3600 s by default. A silent disconnect therefore keeps the object, and its duration charge when no other stream is open, for about two minutes at the defaults and at most `maxAge`, which is 450 GB-s at the limit (0.125 GB x 3,600 s, L2 over L0). Whether production workerd surfaces the abort is not known.

### Hibernation Transport

`durableObjectHub(namespace, { hibernate: true })` serves the same path over a WebSocket accepted with the Hibernation API. SSE stays the default on every host, because `spool.handle` serves it on Workers, Node, Express, Hono and the other adapters with no host code. The sockets hold no timer. A page sends `ping` every 25 seconds and the object's auto-response answers with a `lease` frame, so an idle object can hibernate. The pricing page says an idle object that can hibernate is not billed for duration, that auto-response messages add no wall-clock time, that incoming messages bill at 20 to 1 and that outgoing messages are free (L0, read 2026-11-19). It does not say whether an auto-response message counts toward the 20 to 1 ratio, so the table carries both bounds. A connect, a `publish`, a `revoke` and the one maximum-age alarm each wake the object and bill one request (L0).

The scenario (L3): one object serves the site, each session holds its stream for 1 hour, there are 1,440 bumps a day (one a minute), a month is 30 days, each session sets one alarm for `live.maxAge`, and an event keeps a waking object running for 10 ms, the figure the pricing page uses in its own Hibernation example (L0 example, not measured here). The allowances count as unused by any other object. Average open streams are sessions a day times hours over 24. The SSE object is active for 1 - e^-c of the month, where c is the average open streams, which is the idle probability of an M/G/infinity queue under Poisson arrivals (L3).

| Sessions a day | Average open streams | SSE: object requests | SSE: GB-s | Hibernation: object requests | Hibernation: GB-s | Dollars a month, either transport |
| -------------- | -------------------- | -------------------- | --------- | ---------------------------- | ----------------- | --------------------------------- |
| 5              | 0.21                 | 43,350               | 60,933    | 43,500 to 44,580             | 54                | 0.00                              |
| 100            | 4.17                 | 46,200               | 318,977   | 49,200 to 70,800             | 62                | 0.00                              |
| 2,000          | 83.33                | 103,200              | 324,000   | 163,200 to 595,200           | 204               | 0.00                              |

Layer: L2 over the L0 rates and the L3 scenario. The low request figure treats auto-responses as free, the high one bills them at 20 to 1. Worker requests for each open are the same in both and are left out.

Hibernation saves no dollars at this scenario. Both transports stay inside the included 1 million requests and 400,000 GB-s. Hibernation cuts the duration from 318,977 to 62 GB-s at 100 sessions a day and from 324,000 to 204 at 2,000 (L2), and at 2,000 sessions it uses up to 5.8 times the requests if pings bill (595,200 against 103,200, L2). An SSE object's duration cannot pass 324,000 GB-s a month however many streams are open, so the most Hibernation can save on one object is that duration at $12.50 per million GB-s, and only when other objects in the account have already used the allowance. The pricing page rounds billable duration up to the next million GB-s, so 324,000 GB-s outside the allowance bills as $12.50 a month (L2 over L0). This closes Hibernation as a cost saver at this scenario. It does not close push at larger scale, and Hibernation stays available as a transport. It also removes the silent-disconnect cost above: an idle object that can hibernate is not billed whether or not its client is alive, so a dropped client holds no duration (L2 over L0, production unmeasured).

Measured under `wrangler dev --local` (L1, not the production meter): one Chromium page held a socket for 90 s. It sent 3 pings and got 3 `lease` frames back. The object's log showed a constructor at the connect and a `publish` 26 ms later, then nothing for 90 s: no `webSocketMessage`, no constructor and no alarm. At the `revoke` the constructor ran again with 1 socket attached, so the object had left memory and kept the socket, and the page received `revoked` and a clean close with code 1000. A dev-server reload during an earlier run closed sockets with code 1006 and the page connected again 3 s later (L1). Production hibernation and abort behaviour, duration billing, and whether auto-response messages count toward requests are unmeasured.

## How the Figures Are Made

- Requests per read view under spool, without the script check, where `k` is the bootstrap requests after the first document, `v` the read views per lifetime, `L` the lifetimes per bootstrap, `s` the syncs and `u` the updates per lifetime, and `w` the writes and `f` the contacts per read view, is:

  ```math
  \frac{1 + k}{L \times v} + \frac{s + u}{v} + w + f
  ```

- WebKit macOS requests per read view, stub on the Worker, are the Chromium count plus the term below, where `rate` is the script requests per navigation, `e` the WebKit macOS document navigations per lifetime and `v` the read views per lifetime:

  ```math
  \frac{\text{rate} \times e}{v}
  ```

  A stub on a static tier adds none.

- Requests per read view with no worker add the document navigations after the first, where `L` is the lifetimes per bootstrap, `e` the document navigations per lifetime and `v` the read views per lifetime:

  ```math
  \frac{L \times e - 1}{L \times v}
  ```

- Net saving and multiplier against a baseline `b` of requests, bytes or read views a day, where `s` is what spool sends or supports, are (a negative saving means spool sends more):

  ```math
  \frac{b - s}{b} \qquad \frac{b}{s}
  ```

- Requests per read view without spool, where `w` is the writes per read view, is:

  ```math
  1 + w
  ```

- Held share, clamped to 0 through 1, where `w` is the writes per read view, comes to:

  ```math
  1 - (\text{requests per read view} - w)
  ```

  Writes reach the origin either way, so they do not count as held views. A `maxDelayMs` deadline moves when a queued write leaves the device; its request count is measured only by the REVIEW_2 writes run, so `w` here still assumes a flush at each moment.

- Bytes no longer sent a month come to the product below, with the held share from the item above:

  ```math
  \text{read views a month} \times \text{held share} \times \text{repeat-view document}
  ```

- Dollars for bytes, before the host's free allowance, come to the ratio below times the list price, where `bytes per unit` and `list price per unit` are the host's own:

  ```math
  \frac{\text{bytes}}{\text{bytes per unit}} \times \text{list price per unit}
  ```

- Read views a day on the Free plan, where the limit is {{value:freeLimit}} Worker requests a day, is:

  ```math
  \frac{{{value:freeLimit}}}{\text{requests per read view}}
  ```

- Paid dollars, where the paid price is {{value:paidPrice}} for each additional million requests above {{value:paidIncluded}} a month, is:

  ```math
  \frac{\text{requests} - {{value:paidIncluded}}}{10^6} \times \text{paid price}
  ```
