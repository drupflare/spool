# Technical Report: A Versioned Replica in the Browser

What `@drupflare/spool` does, what each mechanism costs, and what was measured to find out. Written for maintainers and for a reader deciding whether to trust a spool number. Every figure carries its layer (L0 published, L1 measured here, L2 derived, L3 scenario) and either its method or a pointer to the `docs/impact.md` section or the `measurements/` file that holds it. This report restates no large table from `docs/impact.md`. Written 2026-11-15 and reframed 2026-11-16 against the 0.4.0 working tree.

## Contents

- [Executive Summary](#executive-summary)
- [Measurement Rules](#measurement-rules)
- [Claims and Evidence](#claims-and-evidence)
- [Architecture](#architecture)
- [What Was Measured and Held](#what-was-measured-and-held)
- [What Was Tried and Refuted](#what-was-tried-and-refuted)
- [Measurement Mistakes](#measurement-mistakes)
- [Research Strength](#research-strength)
- [Unmet Items](#unmet-items)
- [Limits](#limits)

## Executive Summary

spool removes repeated execution demand from a site's platform. It keeps an authorised, versioned replica of a site's dependencies in the browser and answers eligible page views and read requests locally: no network request, no Worker invocation, no server work. It is an enhancement to drupflare, a way for a request-limited plan to carry more views, and a research system whose figures carry a layer and a method. The server half (`src/server`, `src/protocol`, `src/stores`) names dependencies and versions. The device half (`src/sw`, `src/client`) holds them and renders. A proxy mode (`src/proxy`) fronts an origin that cannot load the library.

**Verdict.** The demand result is a count. With `updateViaCache: 'all'` and a 24-hour script lifetime, a controlled navigation reached no origin in Chromium and Firefox, and WebKit still re-checks the worker script. spool's own syncs and flushes are netted against that. No deployed site supplies traffic, so the share of a real site's requests this removes is unmeasured. Energy is a second objective an administrator may weigh. On one metered desktop a local view saves 0.80 J of package energy against optimized HTTP caching. The modelled figure for the same view is 12.4 J, and it is an allocation. A cold first view of a recorded public page costs a median 47.5 J of package energy above idle on that desktop (L1 windows, L2 per page). That is the cost of the page without spool. The cost of spool's own install and provisioning on a first visit is unmeasured.

1. With `updateViaCache: 'all'` and a 24-hour script lifetime, 0 of 13 controlled navigations reached the origin in Chromium and Firefox (L1). WebKit differs, and the details are under [Zero-Network Navigation](#zero-network-navigation).
2. A local view sends the server nothing. A network view costs it 0.61 to 0.98 J of package energy across node, bun, hono and workerd, 6 windows each, and a local view sent nothing in all but one window per runtime (L1; see [spool's Own Requests](#spools-own-requests)).
3. A cold visit through `spoolProxy` made 2 requests from the first controlled visit to the first local view with the first-payload lever off, and 1 with it on (L1, exact counts, a synthetic page; see [First Payload](#first-payload)).
4. A dataset update sends 227 to 232 B for one changed row. The v0.3 list refetch sends 2,236 to 191,744 B for 50 to 5,000 rows.
5. The requests a platform sees per view follow a formula with three inputs, and a device's share of local views is at most one minus one over the views it makes in a freshness window (L3, [Request Arithmetic](README.md#request-arithmetic)). No multiplier follows from it until a site's traffic supplies the inputs.
6. A local view saves 0.80 J (L1, RAPL, 8 rounds; retake 0.817 J). In the report's one unit that is 0.223 kWh per million views (L2). The view is a repeat navigation of a mirror of `demo.drupflare.com` on one desktop. The energy of one deployment is small against an institution's total electricity and against the idle and hosting energy drupflare removes per site, so the weight energy gets is the administrator's choice.
7. The modelled 12.4 J per view is an allocation. Sustainable Web Design v4 intensities are spread over 17,054 bytes of document, plus one origin request. No meter read it. It sits beside the metered 0.80 J and carries its own label.
8. `trim` removed rules from 233 of 303 stylesheets with 0 false removals in 26,571 rule uses on Chromium's own coverage data. That check is this project's own and no outside oracle confirms it.
9. The first-view corpus recorder had two defects, an identity-coded replay and dropped YouTube embeds. Both are fixed, and the v3 corpus was measured over 2 rounds. See [The First-View Class Fit](#the-first-view-class-fit), [Measurement Mistakes](#measurement-mistakes) and [Limits](#limits).
10. Most of spool is engineering of known ideas. The registration option is documented on MDN, dictionary transport is RFC 9842, speculation rules, Workbox precaching and Fawkes-style static templating exist, unused-CSS removal is PurgeCSS-style, and partial replication is what sync engines such as Electric do. The distinct contract is narrow: a server-authoritative replica whose freshness policy lets a provisioned view render with no per-view validation request, with shadow mode and a fall back to the server. HTTP caching and earlier replication systems cover parts of it ([Prior Art](README.md#-prior-art)). The other contributions that can be defended are the four-layer labelled measurement method, the checked record of refuted mechanisms and the exact-count contract tests (server hits per local view), behind a frozen wire protocol.
11. The ledger holds 15 closed mechanisms, each with its measurement and the objective it left open. The ledger is under [What Was Tried and Refuted](#what-was-tried-and-refuted).

## Measurement Rules

Each figure carries one label, and a derived figure keeps its label wherever it travels.

| label | meaning                                                  |
| ----- | -------------------------------------------------------- |
| L0    | published by someone else, source named                  |
| L1    | measured here, on the hardware the reading's file names  |
| L2    | derived: arithmetic over L0 and L1 figures               |
| L3    | a scenario: an assumption, or a what-if no reading backs |

A figure that mixes an L2 product with an L3 term is L3 as a whole. Per-view energy is also given in kWh per million views, where 1 J per view is 0.2778 kWh per million views. The unit makes readings comparable, and no figure here is a target.

1. **Meter and allocation sit side by side, labelled.** The metered figure is the package energy of one desktop. The attributional figure spreads a published per-byte intensity over measured bytes.
2. **The baseline is optimized HTTP caching.** Immutable hashed assets, ETag revalidation and compression are the site's own fix and spool takes no credit for them. Every dataset result carries two controls, v0.3 and native HTTP.
3. **Tests assert exact counts.** Server hits per local view, requests per sync, records per patch. No test asserts a timing or an energy threshold. Magnitudes live in readings.
4. **Every reading carries its method and exclusions.** The schema (`measurements/README.md`, File Format) holds `rig`, `date`, `layer`, `question`, `instrument`, `machine`, `software`, `method`, `exclusions` and raw `rows`. `scripts/impact.ts` derives per-view figures from rows and stores none. A node test reads every file through `src/report/measurement.ts`.
5. **Arms rotate and idle is subtracted.** In the RAPL rig arm order rotates per round, an idle window opens each round, and joules are reported above the idle draw of the same round. A window is dropped when other containers used more than 100 ms of CPU per second of it. The rule sees containers only. It missed a container that started inside a window until the rig counted one from zero, and it never sees a host process.
6. **A retake sits beside its original.** `scripts/impact.ts` pins every headline RAPL figure to the original date (`ORIGINAL_RAPL`) and prints the retake in a Second Time Point section. A retake on the same machine gives a second time point and no independent replication.
7. **No feature is turned off to get a clean run.** A defect that blocks a measurement is its first result. The rig measures shipped defaults.
8. **A reading is labelled by what was read.** Papers are cited as full text or abstract only. A number from a search summary is not written down.
9. **A negative result closes a mechanism and leaves its objective open.** Each closure records the measurement and the objective that remains.
10. **Page bytes from a replay are checked for encoding.** Added after the first-view corpus defect below.

### Environment

| item                 | value                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| meter host           | paisley-park, AMD Ryzen 9 9900X, Ubuntu 24.04, governor `powersave`; the 2026-11-15 retake adds `amd-pstate-epp` with EPP `performance` to the machine record |
| meter                | RAPL package-0 and core counters read through sysfs; no DRAM, platform or wall domain exists on the host                                                      |
| browser in the meter | Chromium (new headless) in the Playwright v1.62.1 noble container, `--cpus 8 --memory 6g`                                                                     |
| origin in the meter  | a Node static mirror of `demo.drupflare.com` in the same container, 40 ms emulated round trip, 300 navigations per window, 8 rounds, 30 s idle window         |
| idle draw            | 18.77 W median package (`docs/impact.md`, Desktop and Phone)                                                                                                  |
| zero-network host    | MacBook Pro, Apple M2 Pro, macOS 26.5.2, Playwright 1.62.1 bundled Chromium, Firefox and WebKit                                                               |
| what the meter omits | the display, the network interface, the radio, every router and data centre between the two ends, and any DRAM draw                                           |

The demo site runs spool v0.3 features, so it is no baseline without spool. The 0.652 J spool arm in the desktop reading is a spool-served page and sets no ceiling on what a mechanism can save per view.

### Reproducing

`bun run impact:check` fails when the committed `docs/impact.md` differs from what `measurements/` produces. It runs in CI. Each rig runs from `scripts/measure/` with `--dry-run` first, which prints the resolved plan and touches nothing. The RAPL runs need a Linux host with a readable package counter. They sit outside the hermetic gate, so a clean checkout reproduces the arithmetic and cannot reproduce the joules.

## Claims and Evidence

| claim                                                | evidence                                                                                           | layer     | status                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| A local view saves energy on a desktop               | 0.80 J, difference of arm medians over 8 rounds; retake 0.817 J                                    | L1        | one desktop, against optimized HTTP caching |
| Attributional saving per local view                  | 12.4 J: SWD v4 over 17,054 B plus a 0.455 J origin request, radio term 0                           | L2        | an allocation of the document request only  |
| spool's own requests are netted                      | `Z_daily` nets syncs and flushes; one window in six per runtime shows up to 6 `/.spool/*` requests | L1 and L2 | modelled; no deployed trace                 |
| A controlled navigation makes no request             | 0 of 13 navigations reach the origin in Chromium and Firefox                                       | L1        | Chromium and Firefox only                   |
| A dataset patch costs fewer bytes than both controls | `measurements/dataset-baseline/2026-11-15.json`                                                    | L1        | synthetic rows, one run each                |
| Platform requests per view fall with the local share | `L / (r - h*rho + h*s)`, [Request Arithmetic](README.md#request-arithmetic)                        | L3        | no deployed trace supplies h, r, rho or s   |

The saving scales with the size of a site's document. Where the browser's own cache answered the document, a local view has no request to replace and saves nothing. `docs/impact.md` (Per-Site Figures) lists the 15 sites read so far, from 0 J to 669.4 J per local view on the allocation.

## Architecture

The server declares routes with a strategy and a freshness contract. A route is `assembly` (a shell with holes plus data), `template`, `projection` (records sent once, the page computes the result) or `data`. The server sends an envelope that names an artifact's identity, scope, dependencies and a version vector. The worker keeps records and projections once in a lazily loaded graph and syncs only the next page's invalid ids, by cursor or by `need`.

The worker renders `public` routes locally under hard or soft freshness. Shadow mode serves the network answer and compares it with a local render, per route or globally, with a sampled canary. Analytics are queued in the worker and flushed on a network moment that already happens. A provisioning rule sends an artifact only when `reuse x futureViews x avoided - provision - maintain` is positive.

Signed-in data is partitioned per principal. The partition id is an HMAC under a server secret. Stored rows are sealed with AES-GCM under a non-extractable key, so deleting the key makes them unreadable. That is crypto-shredding at rest and gives no defence against script on the origin. Logout wipes before the request leaves. Authorisation stays on the server: the device holds only what the server already sent that principal.

The wire protocol is frozen at `Spool-Protocol: 1`. `tests/node/protocol-freeze.spec.ts` pins the header names, paths, envelope encoding, response key sets, limits and public export names as literal values (`docs/protocol.md`, Stability). The shared `spool` IndexedDB database stays at version 2, because v0.2 and v0.3 workers open it at that version and fail with a `VersionError` on a higher one. New stores live in their own databases. The package version is the worker's runtime version, and a different one empties a worker's replica and asset caches.

Two further facts govern the design. A URL with a query string is never answered from a path's artifact unless the route declares a `query` schema, and the proxy and the worker send such a URL to the network. The drupflare adapter is a `spoolProxy` integration for eligible public traffic: a request with a cookie or an `Authorization` header bypasses spool.

## What Was Measured and Held

### Zero-Network Navigation

The question is how many server hits one service-worker navigation makes, by registration setting and engine. The instrument is the origin's request log, because the browser is not trusted to report `fromServiceWorker`. The method is 13 navigations per engine (clicks, typed navigations, a new tab) over 12 synthetic 30 KB pages on localhost, on the Mac (`measurements/zero-network/2026-10-18.json`, L1).

| registration                             | engine   | navigations | reached the origin | paths that did |
| ---------------------------------------- | -------- | ----------: | -----------------: | -------------- |
| default registration                     | chromium |          13 |                  1 | `/sw.js` x 1   |
| default registration                     | firefox  |          13 |                  4 | `/sw.js` x 4   |
| default registration                     | webkit   |          13 |                  3 | `/sw.js` x 3   |
| updateViaCache all, script max-age 86400 | chromium |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | firefox  |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | webkit   |          13 |                  5 | `/sw.js` x 5   |

The registration is in `src/client/register.ts`, and the worker script is served with `max-age=86400`. Neither setting changes without re-running `tests/browser/zero-network.pw.ts`. The option is documented on MDN.

WebKit makes no page or data requests and still re-checks the worker script. The test asserts an empty hit list only outside WebKit (`tests/browser/zero-network.pw.ts`, line 70). The claim covers Chromium and Firefox, on a localhost origin and 12 synthetic pages. No reading on a real site over a real network exists. In a probe, a cross-origin `@font-face` font cost WebKit one request per local view.

A view that makes any cross-origin request is not zero-network, and the service worker answers same-origin requests only. On the 16 sites of the on-wire reading, 63% of proxy requests on a cold home page and on a warm internal page, and 73% on a repeated home page, went to other hosts (`docs/impact.md`, Third-Party Requests).

One request breaks the saving. In round 0 of the network arm of `measurements/rapl/2026-10-19-views.json`, 599 of 899 origin hits were `/cdn-cgi/rum`, Cloudflare's analytics beacon. A local view that lets such a post through is a network view again, with its bytes and its origin work. Thiagarajan et al. (WWW 2012, full text, a 3G phone) found that on 10 of 25 sites a page rendered from cache used 6.8% to 40.5% of the networked load's energy. On the other 15, dynamic script and style requests could not be cached, and the paper names Google Analytics as one cause on static pages. spool queues analytics in the worker for this reason. Firefox does not route `fetch` with `keepalive` through a service worker, so those posts bypass the queue.

### Per-View Energy on a Desktop

The reading is `measurements/rapl/2026-10-19-views.json`, and its retake is `2026-11-15-views.json` (L1, method in the Environment table). Medians per navigation above idle, with the range over 8 rounds:

| arm                    | J per navigation       | origin requests per navigation |
| ---------------------- | ---------------------- | -----------------------------: |
| Optimized HTTP caching | 1.45 (1.36 to 1.51)    |                           3.00 |
| Spool local view       | 0.652 (0.593 to 0.693) |                           0.00 |
| Demo shipping headers  | 5.02 (4.86 to 5.09)    |                          30.75 |

The saving against optimized caching is 0.80 J, the difference of the arm medians. The retake reads 0.817 J (+1.9%), a spool view at 0.678 J (+4.0%), and idle at 18.4 W against 18.8 W. Against the shipping headers the saving is 4.37 J, which belongs to the baseline fix. drupflare has since shipped that fix and measured 1.31 J for a repeat navigation of a deployed free-plan site over a real network. A matched spool arm on a deployed site waits for the drupflare adapter.

The retakes of the other desktop experiments moved between -5.5% and +20.1% on single figures (`docs/impact.md`, Second Time Point). The largest, +20.1% on a CMS recompute at 15 mJ per request, shows what a single time point is worth on small quantities.

The meter reads the browser, the co-located origin over loopback and the service worker. The round trip is emulated. A sparse real load also pays wake costs this loop never sees.

### The 12.4 J Allocation

The headline applies SWD v4's network (0.059), data centre (0.055) and device (0.080) kWh per GB, 0.194 together (L0, read from the method's web page), to 17,054 bytes of document, and adds the origin request.

| term           | joules | layer |
| -------------- | -----: | ----- |
| Network        |    3.6 | L2    |
| Data centre    |    3.4 | L2    |
| Device         |    4.9 | L2    |
| Origin request |  0.455 | L1    |
| Radio wake     |   0.00 | L1    |
| Total          |   12.4 | L2    |

The 17,054 B is the median repeat-view document over 59 views from 4 `measurements/repeat-nav` readings, and `scripts/impact.ts` refuses to run if `DOCUMENT_BYTES` drifts from it. Only the document counts, because an optimized HTTP cache already keeps static files. The page's API calls and every third-party request still leave the browser during a local view. The radio-wake term is 0 until a phone reading attributes a wake. As a unit, 12.4 J is 3.43 kWh per million views. It is an allocation. No meter read it, and the metered 0.80 J is the figure to compare against optimized caching.

SWD's network term applies a per-byte intensity to measured bytes. Network energy is not proportional to data volume (Mytton, Lunden and Malmodin 2024, abstract only), and one institution's traffic cannot be tied to an operator's power state. The model likely overestimates actual emissions, by its own account.

### spool's Own Requests

`Z_daily` is the strict zero-network views of a day net of the sync and flush requests spool itself sends. In the server-runtime reading, one window of six per runtime made up to 6 `/.spool/*` requests about 15 minutes after the worker was primed, which matches the default soft bound of public routes expiring. The rig counted `/.spool/*` requests without recording their paths, so the cause is read from timing. The medians leave that window out, and `docs/impact.md` (Server Runtimes) says so.

A network view costs the server 0.61 to 0.98 J across node, bun, hono and workerd, 6 windows each (L1). A local view sent nothing in all but one window per runtime, and its measured energy (0.32 J at most, as a median) sits inside the idle drift.

A worker costs energy too. In the worker request reading (8 rounds, 60,000 `fetch` calls of a 4,096 B asset per window), the browser cache cost 14.0 mJ per request, a worker answering from CacheStorage 18.9 mJ and a conditional 304 19.3 mJ. A worker answer saves energy only for URLs the browser would revalidate on more than 93% of views. The ranges of the worker and the 304 overlap.

### Compute and Origin Work

A server cache already removes recompute, so spool's increment against one is the transaction. Measured on paisley-park (L1, 8 rounds unless noted):

| workload                | origin energy per request |
| ----------------------- | ------------------------: |
| cache hit               |                  0.717 mJ |
| CMS render              |                   15.1 mJ |
| analytics page          |                    10.9 J |
| local 8B model, CPU+GPU |                     286 J |

Against an optimized server cache a local view saves 0.82 J on the CMS page and 0.98 J on the analytics page per navigation, whatever the page costs to compute. Against recompute on every request the saving grows with the computation: 0.89 J and 12.4 J. The 8B model figure includes a sampled GPU board with a stated accuracy of +-5 W and no energy counter, so it is labelled L1-sampled. It counts only for model-derived results that repeat for identical authorised inputs.

The `projection` strategy relocates work. On the desktop a local projection costs 0.19 J more than a static local view when records come from CacheStorage. It removes 3.57 J of server work per view above a server cache, and its 1.73 MB of records repay after about 340 views against the attributional byte term (L2).

### First Payload

A cold visit through `spoolProxy` used to fetch the page twice. The proxy now names a SHA-256 of the page in `Spool-Artifact`, and the worker keeps the page it already received when its own hash matches. The reading (`measurements/first-payload/2026-10-26.json`, Chromium, loopback, synthetic page, 5 rounds per arm that came out identical) records origin requests from the first controlled visit to the first strict local view.

| arm               | requests, cold to local | `/.spool/artifact` requests | origin work           |
| ----------------- | ----------------------: | --------------------------: | --------------------- |
| assembly, off     |                       2 |                           1 | 2 origin page fetches |
| assembly, lever 1 |                       1 |                           0 | 1 origin page fetch   |
| template, off     |                       2 |                           1 | 1 load                |
| template, lever 2 |                       1 |                           0 | 1 load                |

The counts are exact. The byte columns are uncompressed counts of a synthetic page, so they show the shape of the saving and give no size for a real page. No reading says how many visits are cold. `inlineMaxBytes` saves the artifact request and nothing else, and is off by default.

### Datasets

A dataset keeps rows on the device, and an update sends the rows that changed. The reading is `measurements/dataset-baseline/2026-11-15.json` (L1, synthetic rows, one machine, one run each, in-process `createSpool` and `node:zlib`). Bytes after one changed row:

|  rows | v0.3 list refetch | v0.4 patch | native 200 |
| ----: | ----------------: | ---------: | ---------: |
|    50 |             2,236 |        227 |      2,379 |
|   500 |            19,981 |        228 |     20,239 |
| 5,000 |           191,744 |        232 |    193,240 |

A 304 under native HTTP is 220 B at every size. The v0.4 seed costs more than the v0.3 seed by 89 B at 50 rows, 867 B at 500 and 13,881 B at 5,000, so a seed is repaid after 0.044 to 0.072 updates per device. A device that never returns pays for the seed and gets no update, and the admission rule `datasetBenefit` and the provisioning rule limit how often that happens. The per-site table in `docs/impact.md` (What a Site Pays) uses a 7-day hold and a return survival of 0.50, both L3 and unmeasured. Safari deletes script-writable storage after 7 days without interaction (WebKit blog, full text), and Chromium and Firefox show no time-based deletion. No source gives a single-site return interval or a survival rate.

`datasetBenefit` (`src/protocol/provision.ts`) counts views from a prior, and the site table counts views from traffic. The two agree on arithmetic, and this report makes no claim that they reach the same decision at any site. The server measures gzip for its seed size and the reading uses brotli, so the decision inputs differ from the reading's bytes.

The v0.3 baseline work found two defects in v0.3 itself: a query route over record references passed the server proof and failed the client's, and default priors declined every `data` route. Both shaped the dataset design.

### Next-Page Prediction

The catalogue ships the data of pages a visitor may open next when the expected share repays the entry. The replay uses MSNBC (UCI dataset 133, CC BY 4.0): 989,818 visitors over one day in 1999, a median of 2 pages each, 354,425 scored first views (`measurements/nav-replay/2026-10-26.json`, L1 counts, L2 joules). A population first-order model earns 3.62 J per provisioned KB at a 473 B entry where the all-views share earns 2.81 and popularity 1.50. Nothing pays at a whole document, and `population-first` provisions nothing at 2,048 B.

The first run credited repeat visits and was wrong. The calibration table found the all-views share over-confident exactly where decisions are made: 0.259 given and 0.039 observed in the 0.20 to 0.40 bin. Models with each visitor's own history match the population model exactly, because a visitor here opens two pages. The data cannot show whether multi-day history helps.

### Asset Trimming

`trim` serves a site's stylesheets with rules that no page or script of the site can match removed. The proxy does this because a service worker cannot save bytes on a file it already fetched. It applies to a network view of an unseen page and saves nothing on a local or repeat view.

The reading (`measurements/trim/2026-10-19.json`, with a second date in `2026-11-15.json`; Chromium coverage and DevTools, zstd; 85 pages on 10 Drupal sites) fetched 303 stylesheets and removed rules from 233. The checks:

| check                    | result                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| Oracle A, false removals | 0 of 26,571 rule uses                                            |
| Oracle B, render         | pixel-identical on 62 pages; the untrimmed control matched on 65 |
| leave-one-out, guard     | fired on 33 of 75 internal pages                                 |
| leave-one-out, Oracle A  | 0 of 3,643 rules lost, on the 13 pages the guard let through     |

Oracle A reads Chromium rule usage on the original CSS and is this project's own check, so no external oracle confirms it. Oracle B differed on 4 pages where the control did not, and one screenshot per arm is a small sample.

The typical first view of an internal page saves 3.2 KB (2.21 J, L2), and the mean is 15.2 KB (10.6 J). A few pages with large unused files carry the mean. JavaScript is left alone: used same-origin JavaScript rose from 36% at load to 40% after one scroll, and CSS stayed at 9%, so no load-time measure says which of the rest a visitor will run.

`trim` does not guard a same-origin stylesheet that carries `integrity`, and the browser rejects the rewritten file. The 52-page first-view corpus has 4 pages with a stylesheet `integrity` attribute, all cross-origin (`pro.fontawesome.com`), which trim never rewrites (`sameOriginKey`, `src/trim/manifest.ts`). It is listed in `docs/security.md` (Open Limitations) and not fixed in this release.

Aggregate names churn. Over 27 days between the two trim readings, 2 of 10 sites kept the same set of aggregate names (L1). The changed names carry a median of 59.5% of a site's aggregate transfer bytes (L2). Across the 4 sites where an earlier file still answered, the zstd dictionary size over the standalone size has a median of 0.06. Two readings show churn between two deployments and give no rate.

### Dictionary Transport

`dictionary` serves public CSS and JS as `dcz` or `dcb` against an earlier file of the same directory (RFC 9842). The dictionary-size reading (`measurements/dictionary-size/2026-10-22.json`, 356 new files of 10 Drupal sites, bytes only, L1) compares four ways of choosing the base, each against brotli 11 alone.

- A browser that picks the latest earlier file of the same directory saves 2.0% with `dcz` and 3.3% with `dcb` at the median site.
- A server base used once the visit has fetched it saves 3.9% with `dcz`, because the base must be fetched before it can serve.
- A server base held from an earlier visit saves 29.9% (chosen with the page measured) and 32.6% (without).
- The oracle, the best earlier file of the same kind, saves 41.4%, and no browser reaches it.

How many visitors hold a base is an L3 scenario that no reading measures. `docs/impact.md` brackets the median-site saving at 6.5% when 10% of visitors hold it and 22.1% when 70% do. `chooseBases` has two scoring policies, `held` and `first-visit`, and neither is a proven minimum of total transfer.

One pair in one browser: Chromium 151.0.7922.34 negotiated the transport, and one page load fetching a 1,719,688 B target cost 769.4 mJ above idle as brotli (432,066 B on the wire) and 686.1 mJ as `dcz` (105,331 B), 11% lower over 6 rounds of 60 loads (`measurements/rapl/2026-10-22-dictionary-load.json`). The retake reads 766 and 720 mJ. In this pair `dcz` decode costs no more than brotli decode. The pair says nothing about how many visitors hold a dictionary.

### Images, Video and Lazy Loading

The image-crawl reading (`measurements/image-crawl/2026-10-22.json`, 70 desktop pages on 16 public sites, empty cache, L1 bytes, L2 joules) gives WebP at native size a saving on 59% of pages, with a median page of 65.5 KB (45.7 J) and a mean of 1,211.8 KB (846 J). Resizing to the rendered width reaches 43% of pages. Autoplay video deferral reaches 10%, and a YouTube or Vimeo facade 9%. A few image-heavy or embed-heavy pages carry the mean, so the share of pages with any saving and the median site describe the typical case.

Format-only WebP does not lower decode energy (`measurements/rapl/2026-10-22-image-decode.json`, 40 images, 6 rounds, one Chromium). Through `createImageBitmap`, a native-size WebP cost 1.39 times the original's energy and a WebP resized to the rendered width 0.79 times. Through an `<img>` at its CSS width the native WebP was 0.95 times the original, with an overlapping range. A conversion costs 0.57 J with the module loaded. The decode saving of an `<img>` repays that after 8 views at the rendered width and 25 at native size. One kilobyte moved is 0.70 J at the SWD rate (L2), which exceeds the decode saving of a view, so the proxy converts every image it can. That arithmetic leaves the network, which has no metered figure, out of the metered column.

Lazy loading changes when an image loads, so its saving exists only for a visit that does not scroll. The rewrite put `loading="lazy"` on the largest contentful element on 1 of 23 desktop pages at `skip` 4 and on 2 of 23 at `skip` 2, and no tested value reached zero on both profiles. `lazy` stays off by default.

### Activity and Loops

The activity hook is cooperative: `window.spool.activity.register` hands spool a pause and resume for a page's own loop. The reading (`measurements/rapl/2026-10-26-idle-activity.json`, 8 rounds, nothing dropped, one desktop) shows a `requestAnimationFrame` loop with its box off screen drawing 2.71 W above idle and 0.16 W with the hook, so the hook removed 2.55 W. The same page hidden with a once-a-second poll shows a hook saving of 0.28 W with a range of -0.07 to 0.46 W, so no hidden-page saving is claimed.

The crawl (`measurements/avoidable-loops/2026-11-15.json`) loaded 60 public sites and counted 108 pages. A frame loop of 20 or more callbacks a second ran in the visible window on 17 of 108 pages (15.7%, Wilson interval 10.1% to 23.8%). A video played with no input on 24 (22.2%). At least one of six classes appeared on 56 (51.9%). The shares count pages loaded fresh, with no traffic weighting. The operator used the machine during the first half of the crawl, and the reading records no per-window time that could locate a disturbance. No page reached the hidden frame-loop threshold.

### Third-Party Files

The repeat-view `requestList` of 15 sites (`measurements/repeat-nav/2026-10-19-requests.json`) puts each third-party request in a class by its cache headers. The median site's third-party bytes are 92.2% uncacheable and 0.0% immutable. Answerable bytes, meaning immutable or long responses from hosts the origin table treats as cache-remedy, have a median of 0 B (L2, a ceiling that forecasts nothing). 99.5% of third-party bytes come from hosts `src/report/thirdparty.ts` does not know. The worker-side third-party cache exists and has nothing to answer on this sample.

### Query Routes

A public `template`, `projection` or `data` route with a `query` schema holds a whole collection and a proof of it. The worker answers a query locally only when every parameter is in the schema and the proof verifies. The proof shows integrity against a declared collection. Completeness comes from the route's declaration that `list` holds the whole collection.

SQLite serves as an independent oracle for correctness: 400 seeded random queries in `tests/node/query.spec.ts` and 300 random plans for the plan engine. Strings compare by UTF-16 code unit here and by bytes in SQLite, so a character above U+FFFF orders differently. A test pins that difference. A principal route cannot declare `query`.

### Capacity and Institution Figures

The capacity channel is a ceiling that counts only when equipment is removed. A retired server-year is 3.80 MWh (282 W at a PUE of 1.54, L2). The sensitivity table in `docs/impact.md` (Capacity) is a model with an L3 read share, and a real report replaces it with peak traces. No retirement is demonstrated, and "no physical capacity saving demonstrated" is a valid report beside a large drop in requests. A retained node can save more than a request's own work: one sparse isolated request brackets at 29 to 56 mJ against 15.1 mJ of work, bounded at 0.046 kWh per million views (L2 over an L3 request count).

The institution report leads with money, storage and trust. Its hosting counterfactual is a peak-sized deployment at 390 kWh a site (L2), with a production deployment at 224.2 and a single small VPS at 9.3 beside it. None is measured against a real Acquia or Pantheon site. The list-price egress and request saving of a million local views runs from $0.30 to $2.45 across four hosts (L0 prices, L2). The storage block prints no figure because the worker does not report held bytes, and the trust block prints none because no live site exists.

## What Was Tried and Refuted

A closure records the mechanism, the measurement that closed it and the objective that stays open. No closure here closed an objective.

| mechanism                                       | measurement that closed it                                                                                                                                                                                              | objective that stays open                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Facades for providers beyond YouTube and Vimeo  | `measurements/embed-markup/2026-10-26.json`: 249 pages of 52 sites, server-rendered markup. One Kaltura iframe, and it is a hero loop. The largest third-party bytes in the repeat reading are an autoplaying `<video>` | embedded third-party media bytes; Save-Data poster replacement of ambient loops  |
| Automatic HTML decomposition                    | `measurements/payload/2026-10-19.json`: 172 internal pages of 10 Drupal sites, median unique part 7,603 B (brotli 5), 2.9% of pages at or under 2 KB                                                                    | unique-part entries for opaque pages; site-supplied fields, a Drupal module      |
| Device-local navigation learner                 | `measurements/nav-replay/2026-10-26.json`: per-visitor blends equal the population model, a device-only model provisions nothing at a 2-page session                                                                    | next-page accuracy at equal bytes; real multi-day traces or a design partner     |
| Energy-weighted image variant policy            | `measurements/rapl/2026-10-22-image-decode.json` and `-image-encode.json`: the transfer term at the SWD rate outweighs the decode difference, so the weighted rule always picks the smallest file                       | image bytes and joules where images are; a per-image choice from content class   |
| Persistent shell                                | not started. It depended on automatic HTML decomposition, and its saving rested on a guessed 0.2 J per local view that no reading backs                                                                                 | browser CPU and joules per navigation; `content-visibility`, bfcache eligibility |
| Power-state elasticity as an MWh channel        | `docs/impact.md` (Retained Nodes): about twice the work per sparse request, linear when batched, below the work cost above about 500 requests a second                                                                  | a fleet power-policy measurement on a server with visible states                 |
| Network-gear power states                       | no causal tie can be shown from one institution's traffic (Counting Rules, 5)                                                                                                                                           | none attributable                                                                |
| Compute elimination as an unconditional channel | `docs/impact.md` (Against a Server Cache): 0.82 J against a server cache for a CMS page                                                                                                                                 | the per-workload compute ledger                                                  |
| Icon and meta-link interception                 | `measurements/link-assets/2026-10-20.json` and `measurements/rapl/2026-10-20-sw-request.json`: worker answer 18.9 mJ against 14.0 mJ for the browser cache; optimized headers give 0 requests in all three engines      | WebKit media refetch on every play                                               |
| Proxy-side JavaScript removal                   | Chromium coverage: 36% used at load, 40% after one scroll, so a set removed for one visitor is wrong for another                                                                                                        | script cost; see the script survey below                                         |
| Browser-chosen dictionaries                     | `measurements/dictionary-size/2026-10-22.json`: 2.0% and 3.3% at the median site                                                                                                                                        | a server that nominates the dictionary, built as `chooseBases`                   |
| Hidden-page pause                               | `measurements/rapl/2026-10-26-idle-activity-hidden.json`: the saving range runs through zero                                                                                                                            | hidden-tab work; Chrome's intensive throttling caps what a pause can save        |
| Third-party answers from the worker's store     | `docs/impact.md` (Third-Party Cacheability): answerable bytes 0 B at the median over 15 sites, one date                                                                                                                 | third-party repeat bytes on a wider sample                                       |
| Stable chunks and stable aggregates             | `docs/impact.md` (Churn Between Two Readings): the built `dictionary` path covers churned aggregates at serve time. Stable chunks need build control outside spool                                                      | bytes of churned aggregates                                                      |
| End-to-end metered session across versions      | closed as not metered: document views are zero-network in v0.2 to v0.4 by the same path, dataset paths differ in bytes the dataset arms give exactly, and loopback cannot meter network energy                          | an end-to-end session arm on a second machine                                    |

Three more closed on reasoning with no committed reading: AVIF (worse than WebP in tinyimg's encoder), font subsetting (no tool, no figure) and one site-wide CSS bundle (it would change cascade order).

### Script Survey

The survey read prior art for cutting script cost at a proxy without breaking JavaScript. Every tool that rewrites whole sites documents its own breakage classes: `document.write`, code that must run before `DOMContentLoaded`, order-dependent scripts and a content security policy. Muzeel and Lacuna report savings in their abstracts, with no breakage count and no full text read. The ranking:

- Build first: a dry-run verification harness that loads each page twice in a real browser, original and rewritten, and diffs the serialised DOM, the console and the request list. Build an advisory coverage report beside it.
- Hold: a serving rewriter. Lossless minification is the first candidate behind the harness. A trial with the Bun bundler's minify arms dropped or renamed top-level bindings of classic scripts on some bodies, even in the whitespace-only arm. A classic script's top-level names are globals, so a printer that keeps them is a precondition. The trial ran on the identity-coded corpus, and the mechanism does not depend on the encoding.
- Refuse: live dead-code removal, whole-site loader rewriting, property mangling and function-level stubs on the live path. A synchronous result cannot be fetched on the main thread.

The objective of cutting script cost stays open through the harness, facades for allowlisted widgets and file-level splits behind a dynamic import.

### Chunk Survey

The survey asked whether many small requests cost more than their bytes. No source supplies a per-request joule figure for DNS, handshake, headers, CDN or radio. The SWD v4 model has no request term. The one bundle-versus-split measurement read is a 2015 single-site test in which compressed JavaScript grew 2.5% when 28 packaged files became 296. It speaks to compression and says nothing about energy. Hashed file names are an unreliable split signal. Only a build manifest or preload tags are signals a proxy can trust.

The chunk-split rig is built (`scripts/measure/rapl-chunk.ts`) and will not run in this release. It serves the same synthetic JavaScript as 1, 5, 25 and 50 scripts, each brotli-compressed on its own, at 0 and 40 ms emulated delay. Its offline smoke counted exactly one request more than the page needs in every arm, and the extra request is unidentified. A negative result would close de-chunking and keep the objective of fewer bytes and joules per view.

### The First-View Class Fit

The cold first-view rig replays 52 recorded pages from 26 sites over local HTTPS, 5 cold navigations per window and 2 rounds (`measurements/rapl/2026-11-16-first-view.json`, L1 windows, L2 per page). The median page costs 47.5 J above idle and the mean 54.0 J. For the same pages the attributional figure is a median 2,845 J, and the metered figure is 1.97% of it at the median of the page ratios (L2). The two quantities use different boundaries, so the ratio describes these pages and corrects nothing.

A regression of each page's metered joules on its image, script and other bytes has a residual standard error of 27.4 J and an R squared of 0.30 (L2). The coefficients, with 95% bootstrap intervals over pages (2,000 resamples, fixed seed):

| term                   | value                | share of metered joules |
| ---------------------- | -------------------- | ----------------------- |
| intercept, J per page  | 24.10 [15.63, 32.55] | 44.6%                   |
| script bytes, J per MB | 10.43 [6.39, 15.67]  | 34.9%                   |
| image bytes, J per MB  | 1.56 [-0.98, 4.47]   | 4.7%                    |
| other bytes, J per MB  | 6.97 [1.24, 20.37]   | 15.8%                   |

The script and image intervals do not overlap, so script bytes cost more per byte than image bytes at this resolution. That is one bootstrap on 52 pages and no formal test, and the ratio of the two point estimates has no interval. Bytes alone explain 0.23 of the variance, and a fixed per-page term accounts for 44.6% of the joules. The cost of a page is therefore not proportional to its bytes. More rounds would not narrow the intervals much, because they measure the spread between pages.

The facade arm replaces each YouTube or Vimeo iframe with a link, on the 8 pages where that changes the page. It saved 15.8 J per page on average and 12.2 J at the median, with 1,111 KB fewer body bytes on average. Eight pages are too few to rate a facade on a page with an embed, and one of them (`rice.edu-2`) has no embed recorded and shows no change.

## Measurement Mistakes

Each paragraph says what happened, what it cost and what now prevents it.

**The first-view corpus was identity-coded.** The recorder forwarded Playwright's `route.request().headers()`, which has no `Accept-Encoding`, so origins answered uncompressed. The corpus held about 150 MB of identity-coded text and only 19 of about 2,800 responses were encoded. Every first-view byte count, the attributional joules and the class fit were inflated, and the metered joules were taken against replays with more loopback bytes. The 2026-11-15 first-view reading was invalid and is replaced by the 2026-11-16 reading on the v3 corpus. The fix is `ACCEPT_ENCODING` and `forwardHeaders` in `scripts/measure/first-view.ts`, with a unit test in `tests/node/measure.spec.ts`. The corpus was re-recorded (52 pages, 26 sites). The cost was a day of rig time on paisley-park and a measurement that cannot be used. The check now is to read the encoded share of a corpus before running a meter on it.

**The recorder dropped every YouTube embed.** The second recorder defect hid behind the first. `rawFetch` in `scripts/measure/first-view.ts` used Node's default 16 KiB response-header limit, and `www.youtube.com` embed responses exceed it, so each request failed with `Parse Error: Header overflow` and was aborted unrecorded. None of the 26 YouTube iframes in the 52-page corpus has a recorded embed document or player payload, and Vimeo has 3 recorded for 2 iframes. In the replay the original arm requests the embed and gets an unrecorded 12-byte miss, so it never pays for the player, while the facade arm adds the recorded thumbnail of 7 to 62 KB. The arm could show only the thumbnail's cost. Where the embed was recorded (Vimeo on `utah.edu-3`) the facade arm served 55,230 B less, as it should. The fix is `MAX_RESPONSE_HEADER_BYTES` (256 KiB) passed as `maxHeaderSize`, with the regression test 'records a response whose header block passes the 16 KiB default' reproducing the exact error on a 40 KB header. The v3 corpus holds 35 YouTube embed responses. `rice.edu-2` and `swarthmore.edu-3` are YouTube pages with no embed recorded.

**Tracker-heavy pages differ run to run.** A single-navigation smoke seemed to show a facade effect on a tracker-heavy page. It was loader timing. In one arm on one corpus, `wsu.edu-3` facade runs served 5,968,957 and 6,380,396 B, 411,439 B apart, and one run lacked five `connect.facebook.net` scripts and a 148,693 B `googletagmanager` script. `rice.edu-1` original runs served 2,326,689 and 2,231,233 B. `miracosta.edu-3` original runs served 3,400,929 and 3,269,698 B and its facade runs 3,322,654 and 3,152,811 B. Single-navigation bytes on such pages carry roughly 95 to 411 KB of noise, larger than a facade effect of tens of KB. `utah.edu-3` replays byte-identical. Only multi-round, many-page statistics can resolve a facade effect, and this report quotes no per-page smoke figure.

**A blanket certificate flag stopped Chromium's HTTP cache.** The warm arm of the first-view rig launched Chromium with `--ignore-certificate-errors` against a self-signed replay certificate. On `yale.edu-1` a second load in a new tab got 3 of 46 long-lived resources from cache. Pinning the certificate's public key with `--ignore-certificate-errors-spki-list` restored 46 of 46. A same-tab reload with the blanket flag reused 45 of 46, so the exact Chromium rule is unknown, and the fix rests on the measured effect. The cold and warm arms now differ in TLS handling, and whether that changes a cold view's cost is unmeasured. A unit test pins both flag lists.

**A retake broke the reading folder.** `scripts/impact.ts` picks the newest reading per rig and experiment, so a retake landing beside its original would have silently replaced the headline, and two impact tests that read the real folder failed. The fix pins every headline figure to `ORIGINAL_RAPL`, adds `retakeOf` and prints the retake in its own section. The impact tests use a `withoutFirstViews` helper so they do not depend on whether a first-view reading exists.

**An allocation was read as a meter.** The 12.4 J figure is SWD v4 spread over bytes, and early notes treated it as a reading. `docs/impact.md` now prints the metered figure beside it and the label on every row.

**The demo was treated as a baseline without spool.** The demo is built from drupflare's latest tree, which already runs spool v0.3 features. Its 0.65 J local view was used as a ceiling for what a mechanism could save per view. A spool-served page sets no such ceiling.

**A closure was written without reading its interval.** A point estimate for script bytes looked higher in joules per byte than image bytes. The bootstrap intervals overlap, so the ordering is unestablished. A persistent-shell bound had the same fault: it used a guessed 0.2 J per local view that no reading backs. A closure now cites the interval beside the claim.

**The first navigation replay credited repeat visits.** The device-local learner's first run counted pages a visitor had already opened as predictions. A rig needs a baseline that already holds what the product already holds. Opened pages are now held without a prediction.

**A per-fetch estimate was a navigation delta divided by requests.** The early 0.1 to 0.3 J per request figure overstated a `fetch` by 5 to 15 times. The worker request rig measures the fetch directly.

**The first idle-activity run was polluted.** Only 2 of 4 rounds were kept, with idle windows from 18.4 W to 67.6 W. The 2026-10-26 rerun kept 8 of 8. One plain-arm window read 28.8 W in round 1 while the other 7 read about 20.7 to 21.0 W. The cause is unknown, and the median does not depend on it.

**bun's npm shim first on PATH broke the pack test.** `~/.bun/bin/npm` shadowed nvm's npm and printed no usable `npm pack --json`, so the packed-package spec in `exports.spec.ts` failed with bun first and passed 30 of 30 with nvm's npm first. It looked like a repo defect. PATH now puts bun's bin last.

**Package self-imports passed locally through `dist` and failed in CI.** The gate runs with `dist` moved aside before it is called green.

**An IndexedDB version bump broke old workers.** Raising the shared `spool` database to a higher version made v0.2 and v0.3 workers fail with `VersionError`, and the upgrade test's "still serving" cases failed 6 of 6. New stores go in their own databases, and `tests/browser/upgrade.pw.ts` runs both directions in three engines. A first local run of that test also skipped its 3 Chromium cases because `beforeAll` swallowed an import error. CI throws instead of skipping.

**`SECURITY.md` listed 0.1.x as supported at 0.4.0.** It now lists 0.4.x only.

## Research Strength

The comparison is with three sibling reports: bytebox, the drupflare worker's Zend park, and tinyimg.

| row                                              | spool against the siblings                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claims backed by a measurement with method       | equal. Every reading carries `method` and `exclusions`                                                                                                                          |
| Refuted approaches logged with their measurement | equal to the park and tinyimg, stronger than bytebox. One closure (the persistent shell) rests on a guessed 0.2 J                                                               |
| Instrument mistakes recorded                     | equal in kind to tinyimg and the park, and recent: the rig's own checks found the corpus defects above                                                                          |
| Reproduction from a clean checkout               | weaker than bytebox and tinyimg. The joule readings need a Linux host with a readable counter, and the 2026-11-15 readings and the code that derives them are not yet committed |
| External validation                              | weaker than all three. One desktop, loopback replay, synthetic pages in places, no traffic-weighted mix, no deployed site, no replication by anyone else                        |
| Size of the evidence base                        | moderate. 16 sites for repeat navigation, 10 Drupal sites for trim, a public dataset for navigation, one desktop and one phone                                                  |
| What the report says it cannot show              | strong. `docs/impact.md` (What This Does Not Claim) and `docs/security.md` (Open Limitations)                                                                                   |

Three contributions have the best case for being research-grade. Each has one measurement that would strengthen it.

1. **The gap between an attributional per-view model and a metered desktop reading.** The method is written, the labels are kept and the two quantities have a stated relation. The measurement: the end-to-end session arms (origin, optimized HTTP caching, each spool version, one mechanism off at a time) on a second machine, with the first-view figure now re-recorded on the v3 corpus.
2. **Proxy-side CSS trimming with a per-page guard.** The guard is checkable and has a measured fire rate (33 of 75). The measurement: a blind test on sites not used to build the manifest, with a real browser DOM diff over clicks and scroll, reporting the guard's miss rate with an interval. That also tests the blind spots the security document names.
3. **Zero-network navigation under the chosen registration.** It holds for Chromium and Firefox. The measurement: the registration in WebKit over 50 or more real navigations on a real site over a real network, with the zero-hit assertion on for WebKit or a documented exception.

## Unmet Items

- The first-view reading covers a page without spool. The cost of spool's own worker install and provisioning on a first visit has no reading, so the net of a first visit is unmeasured.
- The cold first-view run was configured for 3 rounds and stopped after 2 once the direction was clear. The published reading has exactly 2.
- The warm-arm rig (`first-view-warm`) and the chunk-split rig are built and will not run in this release.
- The retake queue after the cold first-view run (projection, dictionary-load, image-decode, Drupal render) was cut, so the existing readings for those stand. The drupal-render rig has a smoke run only, so no figure compares an uncached Drupal render with a cached one.
- Principal datasets and declared writes ship behind flags that are off. Both are unreviewed, and a flag change needs a redeploy because no runtime kill switch exists. Turning a flag off leaves queued writes and held rows on the device until a logout, a `Spool-Clear` or a partition change.
- The six pass conditions for the drupflare adapter are not re-verified. They need the deployed worker, Cloudflare observability and a Drupal save path, which is production-touching.
- Design-partner items: an institution pilot with real query and traffic data, multi-day device traces, a retirement ledger from a real estate, independent correctness and electricity evidence, and an external security review.
- Ambient media has no metered reading of the joules an autoplaying video or looping embed costs. Bytes (`measurements/image-crawl/`) and prevalence (`measurements/avoidable-loops/`) are measured.
- The subresource modes `passthrough` and `static-routing` have no reading. The README says neither is measured to save energy.
- Two protocol facts are untested: an old worker against `/.spool/dataset` and `/.spool/write`, and a multi-instance site where a retry lands on another instance.

## Limits

The first-view reading replays recorded responses over loopback with a self-signed certificate, in a fresh Chromium context per navigation with no service worker and no HTTP cache. 49 of the 52 pages made requests the replay could not answer, and the reading keeps and lists them. The replay server runs on the metered host, so its CPU sits inside the package counter and is not subtracted. Each page's figure is the mean of two windows, and the spread between pages, which the coefficient intervals measure, is larger than the spread between rounds.

One desktop carries every metered figure. The package domain excludes the display, the network interface, the radio, intermediate equipment and DRAM. The loopback origin has an emulated round trip and no real network. Several corpora are synthetic: 12 pages for zero-network, a single page for first payload, synthetic rows for datasets, and a synthetic CMS and enrollment database for the origin-workload readings.

The 0.80 J saving is against optimized HTTP caching on a mirror of the demo. The traffic mix, the return rate and the device population of a real site are L3 inputs, and no deployed trace exists. A device that never returns pays for what it provisioned, and a dataset with fewer than 0.044 to 0.072 updates per device does not repay its seed.

No phone reading is used. The device term is desktop only, and no claim covers a phone, a paced phone view or cellular use. The radio-wake term is 0 until a reading attributes a wake.

Zero-network holds in Chromium and Firefox and does not hold in WebKit (see Zero-Network Navigation). A view with any third-party request is not zero-network.

Query answers are integrity-checked against a declared collection. Completeness is the route's declaration.

Sealed storage gives no protection against script on the origin. Tag names and the write rate are readable through `/.spool/sync`, and a sealed row can be rolled back. Revocation shows for up to `maxStale`.

`trim` risks correctness and exposes nothing confidential. Its guard cannot see a class a foreign script adds after load, markup injected from an endpoint the crawl did not request, a runtime-built class name, a non-UTF-8 charset or a stylesheet reached through `@import`. A same-origin stylesheet with `integrity` fails under `trim`.

In shadow mode a non-200 network answer is neither read nor cancelled, so its copy buffers the body until the copy is collected. `ga4Sink` with `debug: true` records nothing.

The attributional figures use SWD v4 intensities read from the method's web page, and no primary paper backs them. The Fawkes figures in `docs/impact.md` (92% of HTML tags identical across loads 12 hours apart, 75% across a week) were read in full text and are the authors' measurements. spool did not measure them.
