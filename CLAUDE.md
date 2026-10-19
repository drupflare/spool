# spool

A workload-agnostic TypeScript framework that keeps an authorised, versioned replica of a site's
dependencies in the browser and answers eligible page views and read requests locally: no network
request, no Worker invocation, no server work. Ships as `@drupflare/spool` 1.0.0 with drupflare v1.1;
0.x shadow-mode releases ride drupflare v1.0.4. The plan is `~/.claude/plans/deep-crafting-dahl.md`.

## Status

**P0 to P7 built.** `src/report/` holds the energy model (inputs with their L0-L3 labels, the views
and capacity channels, the free-tier ceiling) and `traffic.ts` (`Z_annual`, `Z_daily`,
`Z_peak_work`, the three P factors per engine, mismatches per route), `measurement.ts` (the
schema-1 reading format and its validating reader) and `derive.ts` (per-view joules, fits and
counts from readings). `measurements/` holds every reading, written by `scripts/measure/*.ts`;
`scripts/impact.ts` renders `docs/impact.md` from them and `docs/impact.src.md`, and a node test
fails when the committed page differs. `src/protocol`, `src/server`,
`src/node` and `src/stores` are the server half (envelope, version vector, `assembly` and
`template` routes, `/.spool/sync` with `from` or `need`, `/.spool/artifact` with `have`,
`/.spool/beacon` with `want`, `createSpool`, sinks, the work series, `SpoolVersions`). `src/sw` and
`src/client` are the device half: a service worker that renders `public` routes locally under hard
or soft freshness, runs shadow mode (`mode: 'shadow'`, per route or global, plus a sampled canary),
records a `spool.view` per page view, keeps records and projections once in a lazily loaded graph,
syncs only the next page's invalid ids, defers soft syncs to a network moment, and provisions
by expected benefit. `src/server/embedded.ts` is generated: run `bun run build:sw` after any change
under `src/protocol`, `src/sw` or `src/client` (a node test fails on drift). P5 added sealed
per-partition stores and the logout wipe, P6 the `projection` and `data` strategies, collectors and
the third-party cache, P7 `src/proxy` (`spoolProxy` in front of an origin that cannot load the
library), and `src/trim` (`@drupflare/spool/trim`, used as `spoolProxy({ trim })`) trims a site's CSS
against every page and script, behind a hash check and a per-page guard, and never touches JS. Not built yet: the capacity and institution reports (P8) and the drupflare adapter (P9),
both pinned to drupflare v1.0.4.

## Load-bearing facts, each measured

**Zero-network depends on how the service worker is registered.** With `updateViaCache: 'all'` and
the script at `max-age=86400`, Chromium and Firefox make no request for a controlled navigation, new
tabs included; WebKit still re-checks the script. `tests/browser/zero-network.pw.ts` holds that down
in all three engines. Do not change either setting without re-running it.

**One beacon breaks the saving.** drupflare's demo HTML carries Cloudflare's RUM script, which posts
to `/cdn-cgi/rum` about twice per navigation. A local view that lets it through is not zero-network,
and it costs a request, its bytes and the origin's work. Thiagarajan et al. (WWW 2012, 3G) found one
analytics request woke the radio; an iPhone 14 Pro over cellular (2026-10-19) showed no wake
attributable to an isolated request. Analytics are queued in the service worker and flushed on a
network moment that already happens.

**The modelled 12.4 J per view is an allocation, not a meter reading.** 11.9 J of it is SWD v4's
0.194 kWh/GB spread over 17,054 B, the median repeat-view document request over every
`measurements/repeat-nav` reading (`scripts/impact.ts` refuses to run if `DOCUMENT_BYTES` drifts
from that median); the rest is the origin request. Only the document counts: an optimized HTTP cache
already keeps static files, and API calls and third-party requests still leave during a local view.
The radio-wake term is 0 until a phone reading attributes a wake. The saving scales with a site's
document size; `docs/impact.md` prints every site.
paisley-park's RAPL counter reads about 0.8 J saved per view on a desktop against optimized HTTP
caching. Report both, labelled.

**A URL with a query string is never answered from a path's artifact.** The worker sends a
navigation or `data` GET with a query to the network, and `spoolProxy` declines it; `/news?page=2`
is a different page from `/news`.

## Rules

- Every figure in `src/report/inputs.ts` and `docs/impact.md` carries its layer: L0 published, L1
  measured here, L2 derived, L3 scenario. A derived number never loses its label.
- Assert contracts as exact counts (server hits per local view); never assert a timing or energy
  threshold in a test. Magnitudes belong in measurement output.
- Authorisation stays on the server. The client holds only what the server already sent that
  principal, and client-side encryption is crypto-shredding at rest, not an XSS defence.

## Commands

```sh
bun run typecheck
bun run test # unit (workerd) + node
bun run test:coverage
bun run test:browser # chromium, firefox, webkit
bun run prettier:check
bun run docs:build
bun run build                       # dist/: compiled JS and .d.ts, what the package ships
bun run impact                      # regenerates docs/impact.md from measurements/
bun run impact:check                # fails when docs/impact.md differs from the readings
bun run measure:on-wire             # also measure:repeat-nav, zero-network, device-cpu, iphone, rapl, traces; add --dry-run first
bun run build:cdn                   # dist/cdn/client.js, spool-sw.js and manifest.json (schema 2)
bun run publish:cdn --dev --dry-run # prints the wrangler puts; never run a real publish without Gregory
```

`bun run test:browser` needs browsers matching the installed `@playwright/test`; `bunx playwright
install chromium firefox webkit` fetches them. It also needs `php` for the proxy's PHP origin.
