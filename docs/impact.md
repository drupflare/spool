# Energy Impact

This page sets out how spool's energy figures are built. Every number comes from a reading in [`measurements/`](../measurements/README.md) or from an input in `src/report/inputs.ts`. `bun run impact` regenerates the page from those, and `bun run impact:check` fails when the committed page differs from what the readings produce. Edit `docs/impact.src.md`, never `docs/impact.md`.

Two channels carry the numbers. The capacity channel is the ceiling: what an institution reaches when it acts on the numbers and removes servers, at 3.80 MWh per retired server-year. It counts only when equipment is actually removed. The per-view figures in the views channel are floors. They are measured, and the work is to raise them.

Tiers on this page are relative to an institution's own views. The tables use 100 million views a year as a scale, an L3 choice that names no institution. Multiply a table by your own yearly views over 100 million.

## Measurement Labels

Each figure carries one label, and a derived figure keeps its label wherever it travels.

| label | meaning                                                     |
| ----- | ----------------------------------------------------------- |
| L0    | published by someone else, with its source named            |
| L1    | measured here, on the hardware the reading's file describes |
| L2    | derived: arithmetic over L0 and L1 figures                  |
| L3    | a scenario: an assumption, or a what-if no reading backs    |

A figure that mixes an L2 product with an L3 term is L3 as a whole. The 12.3 J headline below is L2, and the table that builds it says so.

## Accounting Quantities

Spool counts five quantities and never assumes they move together.

1. **Browser resource operations.** What the browser's network stack reports for a navigation: requests, cache hits and 304s.
2. **On-wire requests.** Requests that reach an origin, counted by a proxy between the browser and the origin.
3. **Worker invocations.** Requests a Worker runs. A request answered by a static asset or by the browser does not count.
4. **Encoded bytes.** Bytes transferred, as sent.
5. **Network-active intervals.** The stretches a device's radio stays awake. One avoided request is not one avoided radio wake.

Where a rig reads device or server energy, joules are a sixth quantity beside these.

The browser's count and the proxy's count differ, and the difference is the reason for counting both.

| navigation         | navigations | browser network requests | proxy requests | equal counts | browser bytes | proxy response bytes | proxy requests to other hosts |
| ------------------ | ----------: | -----------------------: | -------------: | ------------ | ------------: | -------------------: | ----------------------------: |
| Cold home page     |          16 |                     81.5 |           83.5 | 5 of 16      |     4,777,004 |            8,278,496 |                           63% |
| Warm internal page |          82 |                     24.0 |           28.5 | 0 of 82      |       976,383 |            1,131,257 |                           63% |
| Home page again    |          16 |                     46.5 |           52.0 | 1 of 16      |     1,155,129 |            4,360,757 |                           73% |

The two counts differ in both directions. The browser's network count leaves out requests it answered from its memory or disk cache, and the proxy sees requests the browser's counter does not attribute to the network. This reading does not explain every difference. The byte columns differ too: on repeat views the proxy saw several times the bytes the browser reports, and the gap is not explained here either. Both counts are printed because neither alone is the wire.

## Traffic Measures

Three measures feed three different benefits.

| measure       | definition                                                                               | drives                                                 |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Z_annual`    | strict zero-network local views over all views, per year                                 | the views channel                                      |
| `Z_daily`     | the same per day, net of the sync and flush requests spool itself sends                  | the Workers free-tier ceiling                          |
| `Z_peak_work` | origin work avoided over origin work without spool in the busiest intervals, by CPU time | whether fewer servers meet the same throughput and SLO |

The code is in `src/report/traffic.ts`. `Z_annual` names the tiers: Meaningful at 30%, Major at 65% and Transformative at 90%. `scripts/measure/traces.ts` turns an institution's server-work trace into the intervals `Z_peak_work` reads.

## Views Channel

The channel's energy is `E_views = V x Z_annual x J_view`, where `V` is the institution's yearly views and `J_view` is the joules one local view avoids. Two `J_view` figures exist, and the page always prints both. Both are floors: they count what a meter or a published model attributes to a view today, and the work is to raise them.

### Attributional Headline

12.3 J per local revisit view is the attributional figure. It applies the Sustainable Web Design v4 intensities (network, data centre and device, 0.194 kWh/GB together) to the bytes of the document request a local view replaces, then adds an origin request. The radio-wake term is 0 J until a phone reading attributes a wake to a network view (see the cellular reading below).

| term           | basis                                                                                                       | joules | label |
| -------------- | ----------------------------------------------------------------------------------------------------------- | -----: | ----- |
| Network        | SWD v4 0.059 kWh/GB over 16,900 B                                                                           |    3.6 | L2    |
| Data centre    | SWD v4 0.055 kWh/GB over the same bytes                                                                     |    3.3 | L2    |
| Device         | SWD v4 0.08 kWh/GB over the same bytes                                                                      |    4.9 | L2    |
| Origin request | a conventional origin, drupflare/worker docs/impact.md, RAPL mix @40 views/s, regular host, idle subtracted |  0.455 | L1    |
| Radio wake     | 0 J on 43% of views (phones), until a phone reading attributes a wake; 5 J was the earlier scenario value   |   0.00 | L1    |
| Total          | the sum of the rows                                                                                         |   12.3 | L2    |

Every term counts as energy that goes away when the view makes no request, the same sense drupflare's own impact page uses. The figure is an allocation of a published model over measured bytes. No meter read it.

A default local view replaces one request, the page's document. The model prices that request: 16,900 B, the median repeat-view document over every repeat-navigation reading (44 views from 3 readings). The rest of a repeat view is left out. An optimized HTTP cache already keeps a site's static files, so those bytes are the baseline fix's saving and not spool's. The page's own API calls and every third-party request still leave the browser during a local view, unless the site declares `data` routes or turns on the third-party cache. For scale, the whole repeat view's median is 66,311 B, and the latest reading's median is 31 network requests over 15 sites.

The saving grows with the size of a site's document. Where the browser's own cache answered the document (a long `max-age` on the HTML), a local view has no request to replace and saves nothing. The headline is the typical site; an institution's own figure comes from its own pages and traffic. Every site read so far, lightest document first, with the attributional joules a local view of that page avoids. Sites that answered the rig with an error page instead of their home page are left out (www.ox.ac.uk).

| site               | document bytes, 2026-10-18 | document bytes, 2026-10-19 | document bytes, 2026-10-19-document | whole view bytes, latest reading | J per local view |
| ------------------ | -------------------------: | -------------------------: | ----------------------------------: | -------------------------------: | ---------------: |
| www.mass.gov       |                          0 |                          0 |                                   0 |                          327,335 |              0.0 |
| www.harvard.edu    |                          0 |                          0 |                                   0 |                            3,853 |              0.0 |
| www.mit.edu        |                          0 |                          0 |                                   0 |                                0 |              0.0 |
| www.unl.edu        |                        415 |                        413 |                                 414 |                          142,325 |              0.7 |
| www.uiowa.edu      |                        515 |                        515 |                                 516 |                           18,167 |              0.8 |
| demo.drupflare.com |                      5,227 |                      5,259 |                               5,265 |                           35,894 |              4.1 |
| www.berkeley.edu   |                     16,264 |                     16,265 |                              16,265 |                           17,009 |             11.8 |
| www.asu.edu        |                     17,076 |                     17,054 |                              16,746 |                           26,566 |             12.2 |
| www.colorado.edu   |                     18,355 |                     18,337 |                              18,364 |                          110,551 |             13.3 |
| www.cornell.edu    |                     18,924 |                     18,934 |                              18,934 |                        6,651,081 |             13.7 |
| www.yale.edu       |                     31,945 |                     31,946 |                              31,969 |                           33,421 |             22.8 |
| www.tufts.edu      |                     43,166 |                     43,165 |                              43,128 |                          120,633 |             30.6 |
| www.georgetown.edu |                     56,089 |                     56,098 |                              56,093 |                           66,251 |             39.6 |
| www.rutgers.edu    |                    193,748 |                    193,745 |                             193,742 |                       14,562,912 |            135.8 |
| www.ucdavis.edu    |                   not read |                    957,863 |                             957,877 |                        1,068,401 |            669.4 |

| navigation         | navigations | sites | median bytes | mean bytes | 75th percentile bytes | median network requests | median document bytes |
| ------------------ | ----------: | ----: | -----------: | ---------: | --------------------: | ----------------------: | --------------------: |
| Cold home page     |          15 |    15 |    4,992,103 |  7,359,851 |             8,361,679 |                    85.0 |                29,559 |
| Warm internal page |          82 |    14 |      971,451 |  3,571,297 |             2,283,203 |                    23.0 |                23,258 |
| Home page again    |          15 |    15 |       66,251 |  1,545,627 |               234,830 |                    31.0 |                16,746 |

Bytes are what the browser received. Requests are the ones the browser sent to the network: a repeat view also lists dozens of sub-resources it answered from its own cache, and those are left out. The on-wire table sets a proxy's count of the same navigations beside the browser's.

### Measured Figures

The meter-visible part is smaller. These readings are the floor the engineering work has to raise.

| arm                    | J per navigation above idle | ms per navigation | origin requests per navigation | origin CPU ms per navigation | rounds |
| ---------------------- | --------------------------: | ----------------: | -----------------------------: | ---------------------------: | -----: |
| Optimized HTTP caching |         1.45 (1.36 to 1.51) |              49.9 |                           3.00 |                         0.33 |      8 |
| Spool local view       |      0.652 (0.593 to 0.693) |              10.8 |                           0.00 |                         0.00 |      8 |
| Demo shipping headers  |         5.02 (4.86 to 5.09) |             252.4 |                          30.75 |                         2.11 |      8 |
| Idle package draw (W)  |      18.77 (18.37 to 19.29) |                   |                                |                              |      8 |

Against a page served with optimized HTTP caching, a local view saves 0.80 J on this desktop (the difference of the arm medians over 8 rounds each). Against the demo's shipping headers, where every asset revalidates, the saving is 4.37 J. The second figure belongs to the baseline fix, not to spool. drupflare has since shipped that fix (a one-year cache lifetime on static assets through `assets/_headers`) and measured it: a repeat navigation of a deployed free-plan drupflare site costs 1.31 J (1.23 to 1.41) on the same desktop over a real network, one request a navigation (drupflare/worker `docs/impact.md`, L1). That is the baseline spool is measured against on drupflare; a matched spool arm on a deployed site waits for the drupflare adapter.

The desktop figure includes the package energy of the browser, the co-located origin and the service worker. It excludes the display, the network interface, the radio and every router and data centre between the two ends.

On the phone:

| arm              |  J per view above idle | views per window | seconds per view | rounds |
| ---------------- | ---------------------: | ---------------: | ---------------: | -----: |
| Network          | 0.243 (0.223 to 0.248) |            1,666 |            0.072 |      4 |
| Spool local view | 0.150 (0.137 to 0.165) |            3,208 |            0.038 |      4 |
| Idle window (J)  | 130.5 (124.0 to 135.9) |                  |                  |      4 |

A local view saves 0.093 J on an iPhone 14 Pro, back to back over Wi-Fi in this reading (4 rounds, the difference of the arm medians). The same page pair in the projection reading below gives 0.088 J (3 rounds), the figure the rest of this page uses. The counter is the whole phone with the screen on, so the figure includes the display's share while navigating and the Wi-Fi radio. It excludes the cellular radio, its tail state and the network. Back-to-back navigation keeps the radio awake, which understates what a network view costs between idle periods.

Views paced at one every 15 seconds could not be resolved. Idle windows of 180 seconds varied by 5.2 J, more than the 1.1 J that 12 views would add at the back-to-back saving, so no paced figure is claimed over Wi-Fi.

Over cellular, with the Wi-Fi switched off, the idle windows were steadier and both pacings resolved:

| reading             | arm              |  J per view above idle | views per window | rounds |
| ------------------- | ---------------- | ---------------------: | ---------------: | -----: |
| Back to back        | Network          | 0.265 (0.253 to 0.279) |            1,482 |      4 |
| Back to back        | Spool local view | 0.164 (0.160 to 0.188) |            3,493 |      4 |
| One view every 20 s | Network          |    2.98 (2.00 to 3.16) |                9 |      4 |
| One view every 20 s | Spool local view |    2.88 (1.99 to 6.34) |                9 |      4 |

Back to back, a local view saves 0.101 J over cellular, about what it saves over Wi-Fi. At one view every 20 seconds, each view costs 11 to 18 times its back-to-back cost (most likely the cost of waking the phone from idle for one view; not measured separately), and the network view and the local view cost about the same (0.10 J apart, inside the spread across rounds). A second reading isolates the request. The phone ran the same WebDriver script every 20 s over 6 rounds, once with a `fetch` to a Worker that answers 204 with no body and once without it. Above idle, a call with the request cost 1.38 (1.10 to 2.68) J and a call without it 0.791 (-0.0452 to 2.59) J: the medians are 0.59 J apart and the ranges overlap. No radio wake can be attributed to the request at this resolution, so the headline carries 0 J for it. The earlier scenario value of 5 J per phone view stays out until a reading attributes one.

### Server Runtimes

The same small site ran under spool 0.1 in four server runtimes on paisley-park, one container at a time, with Chromium on another machine reaching it over Tailscale. Each window was 60 views. The server's package energy and its interface byte counters were read per window, less the idle window of the same round. The overlay interface carries the HTTP traffic; the physical interface adds the relay's framing, since this path went through a Tailscale relay in every round.

| runtime | arm                      | server J per view above idle | overlay bytes per view | wire bytes per view | origin requests per view | windows |
| ------- | ------------------------ | ---------------------------: | ---------------------: | ------------------: | -----------------------: | ------: |
| node    | Network view             |        0.643 (0.117 to 1.01) |                    794 |               1,580 |          1.00 (max 1.00) |       6 |
| node    | Spool local view         |      0.126 (-0.568 to 0.405) |                      4 |                 302 |          0.00 (max 0.08) |       6 |
| node    | Bare HTML request (curl) |         1.08 (0.745 to 1.33) |                  1,290 |               3,932 |          1.00 (max 1.00) |       5 |
| bun     | Network view             |       0.620 (0.345 to 0.931) |                    745 |               1,616 |          1.00 (max 1.00) |       6 |
| bun     | Spool local view         |     0.259 (-0.0124 to 0.950) |                     39 |                 556 |          0.00 (max 0.10) |       6 |
| bun     | Bare HTML request (curl) |         1.20 (0.794 to 1.62) |                  1,141 |               3,500 |          1.00 (max 1.00) |       6 |
| hono    | Network view             |       0.608 (0.405 to 0.750) |                    791 |               1,566 |          1.00 (max 1.00) |       6 |
| hono    | Spool local view         |     0.188 (-0.0730 to 0.261) |                      3 |                 109 |          0.00 (max 0.10) |       6 |
| hono    | Bare HTML request (curl) |         1.10 (0.776 to 1.35) |                  1,188 |               3,313 |          1.00 (max 1.00) |       6 |
| workerd | Network view             |        0.977 (0.577 to 1.49) |                    732 |               1,703 |          1.00 (max 1.00) |       6 |
| workerd | Spool local view         |     0.324 (-0.0238 to 0.430) |                     21 |                 554 |          0.00 (max 0.10) |       6 |
| workerd | Bare HTML request (curl) |          1.35 (1.21 to 1.71) |                  1,278 |               4,103 |          1.00 (max 1.00) |       6 |

A spool local view sent nothing to the origin in every window but one per runtime, and its server energy is inside the idle drift. The exception is the fourth spool window, which made up to 6 requests to `/.spool/*` in every runtime. It ended about 15 minutes after the worker was primed, which is when the public routes' default soft bound expires: the timing matches one sync with the held view telemetry flushed on the same network moment (the rig counted `/.spool/*` requests, not their paths). That is spool's own overhead. The medians above leave it out, since it is one window in six; the measured per-view figure P8 reports nets syncs and flushes against the saving. A bare HTML request from curl costs the server more than a browser view, most likely because curl opens a new connection through the relay for each request while the browser reuses one.

One request per view is also what breaks the saving. A page that posts to an analytics endpoint on every view makes each view a network view again, with that request's bytes and origin work. On a 2012 3G phone that post also woke the radio (Thiagarajan et al.); this phone showed no wake for an isolated request. Spool queues those posts in the service worker and sends them on a network moment that happens anyway.

### Origin Term by Workload

The headline's origin term is modelled. For a view the origin would otherwise render, such as an authenticated view or a cache miss (a meaningful share of views), the measured origin joules for that workload replace SWD's data-centre term and the modelled origin request. They never add to the headline. Where a cache would have answered, the term is the cost of a cache hit, a fraction of a millijoule.

| workload                               | origin J per request | label           | J per local view |
| -------------------------------------- | -------------------: | --------------- | ---------------: |
| Modelled origin request (the headline) |                0.455 | L1, modelled    |  12.3 (headline) |
| Cache hit                              |             0.000717 | L1              |              8.5 |
| CMS render                             |               0.0151 | L1              |              8.5 |
| Analytics page                         |                 10.9 | L1              |             19.3 |
| Local 8B model request                 |                  286 | L1, GPU sampled |            294.4 |

Each origin figure is package energy above idle on paisley-park (L1, 8 rounds unless noted) against a synthetic CMS and enrollment database that each file describes. The per-view figure is L2 over the L3 radio term. A real origin's joules replace the origin column when they are measured.

#### Per-Request Cost

| arm                                     |        J per request above idle | server CPU ms | client CPU ms |        server-attributed J (L2) |
| --------------------------------------- | ------------------------------: | ------------: | ------------: | ------------------------------: |
| Null route (204)                        | 0.000528 (0.000514 to 0.000583) |       0.00699 |        0.0124 | 0.000191 (0.000184 to 0.000212) |
| CMS recompute, 200                      |       0.0151 (0.0144 to 0.0156) |         0.523 |        0.0238 |       0.0144 (0.0137 to 0.0148) |
| CMS recompute, conditional 304          |       0.0147 (0.0141 to 0.0156) |         0.520 |        0.0194 |       0.0141 (0.0136 to 0.0150) |
| CMS server cache, 200                   | 0.000717 (0.000692 to 0.000733) |       0.00897 |        0.0159 | 0.000251 (0.000240 to 0.000263) |
| CMS server cache, conditional 304       | 0.000572 (0.000553 to 0.000581) |       0.00763 |        0.0130 | 0.000212 (0.000204 to 0.000216) |
| Analytics recompute, 200                |             10.9 (10.7 to 11.1) |           393 |         0.260 |             10.9 (10.7 to 11.1) |
| Analytics recompute, conditional 304    |             11.0 (10.6 to 11.3) |           395 |         0.245 |             11.0 (10.6 to 11.2) |
| Analytics server cache, 200             | 0.000655 (0.000644 to 0.000673) |       0.00851 |        0.0149 | 0.000238 (0.000234 to 0.000246) |
| Analytics server cache, conditional 304 | 0.000569 (0.000550 to 0.000593) |       0.00766 |        0.0131 | 0.000211 (0.000204 to 0.000220) |

The null route is the transaction floor: loopback HTTP, keep-alive, no body. A cache hit costs about as much as the floor. A CMS render costs 21 times a cache hit and the analytics page about 16.6 thousand times. Across the two recompute rows the rule of thumb is 27.7 to 28.8 mJ of package energy per busy CPU millisecond, for one boosted core in a closed loop. A shared and loaded server amortises idle power differently.

#### Against a Server Cache

Chromium navigations with 40 ms of emulated latency, J per navigation above idle:

| page           |       recompute (a) | optimized server cache (b) |   spool local view (c) | (a) less (c) | (b) less (c) | origin CPU ms per navigation, recompute |
| -------------- | ------------------: | -------------------------: | ---------------------: | -----------: | -----------: | --------------------------------------: |
| CMS render     | 1.58 (1.57 to 1.64) |        1.52 (1.47 to 1.56) | 0.694 (0.635 to 0.727) |        0.886 |        0.823 |                                     1.5 |
| Analytics page | 13.1 (12.8 to 13.4) |        1.65 (1.58 to 1.68) | 0.665 (0.634 to 0.771) |         12.4 |        0.984 |                                   401.6 |

Against an optimized server cache, spool's increment is the transaction only: 0.82 J for the CMS page and 0.98 J for the analytics page, whatever the page costs to compute. Against recompute on every request the saving grows with the computation. The origin term above is the part of that saving the origin accounts for.

#### Projection

The `projection` strategy sends records once and lets the page compute the result. It relocates work. Per view, on the desktop:

| arm                                                            | J per navigation above idle | ms per navigation | origin requests per navigation |
| -------------------------------------------------------------- | --------------------------: | ----------------: | -----------------------------: |
| Server computes every navigation                               |         5.09 (4.96 to 5.17) |             176.8 |                           3.01 |
| Server cache, same page                                        |         1.52 (1.47 to 1.54) |              50.4 |                           3.00 |
| Projection, records from the HTTP cache, page over the network |         2.05 (1.99 to 2.19) |              51.5 |                           3.00 |
| Projection, service worker serves page and records             |      0.868 (0.750 to 0.880) |              14.5 |                           0.01 |
| Static local page, no computation                              |      0.679 (0.623 to 0.743) |              12.4 |                           0.01 |

A local projection costs 0.19 J more than a static local view when the records come from CacheStorage, and 0.53 J more than the cached server page when the network serves the page. The experiment does not explain the difference between those two. It removes 3.57 J of server work per view above a server cache. The records are a one-time transfer of 1.73 MB, which the per-view saving repays after about 340 views against the attributional bytes term (L2).

On the phone, back to back over Wi-Fi:

| arm                                     |  J per view above idle | views per window | rounds |
| --------------------------------------- | ---------------------: | ---------------: | -----: |
| Network fetch of the computed page      | 0.228 (0.209 to 0.241) |            1,457 |      3 |
| Local render of the same page           | 0.140 (0.138 to 0.155) |            2,882 |      3 |
| Local render plus on-device aggregation | 0.245 (0.221 to 0.248) |            1,783 |      3 |
| Network page plus aggregation           | 0.321 (0.304 to 0.322) |            1,191 |      3 |

A local projection costs 0.105 J more than a static local view and lands within the range of a network fetch of the computed page. The aggregation of 97,000 rows costs more than the radio-awake fetch it replaces. The server never ran, but the device-side saving of a projection view is about zero in this configuration. The records are synthetic and one size.

Report a projection as server joules removed, less device joules added, with the provisioning bytes beside both. Credit the net.

#### Inference

A local 8B model behind the origin, against a cached copy of the same response (5 rounds, 120 output tokens per request, CPU package and a sampled GPU board):

| quantity                               |                  median (range) |
| -------------------------------------- | ------------------------------: |
| CPU package J per request              |             44.0 (43.8 to 45.4) |
| GPU board J per request (L1-sampled)   |                241 (240 to 242) |
| Total J per request                    |                286 (284 to 286) |
| Latency per request (s)                |             1.52 (1.51 to 1.54) |
| Ollama container CPU per request (ms)  |                           1,563 |
| Origin CPU per request (ms)            |                            1.85 |
| Resident model, CPU package (W)        |             1.29 (0.71 to 1.70) |
| Resident model, GPU board (W)          |             8.57 (8.30 to 9.02) |
| Cached copy of the response, J per hit | 0.000905 (0.000876 to 0.000912) |

The GPU term is sampled power, labelled L1-sampled. The card's stated accuracy is +-5 W and it has no energy counter. A resident model also draws 9.9 W while idle, which a cache hit does not save unless the model gets unloaded because of it.

Published per-request figures for hyperscale serving (0.24 Wh median for a Gemini text prompt, L0, and modelled estimates of 0.31 and 3.91 Wh) include host machines, provisioned idle capacity and facility overhead. They describe an attributional stack. They are never printed here as spool savings.

#### Reach of the Origin Term

| avoided operation                                                 | J per operation (L1) | kWh per million operations (L2) |
| ----------------------------------------------------------------- | -------------------: | ------------------------------: |
| A CMS render                                                      |               0.0151 |                            0.00 |
| An analytics page                                                 |                 10.9 |                            3.02 |
| A local 8B model request                                          |                  286 |                              79 |
| The transaction alone, against a server cache (CMS page, desktop) |                 0.82 |                            0.23 |

The first column is the energy one avoided operation saves on this machine. The second is that energy for a million avoided operations, in kWh, an L2 product.

- If every one of 100 million views a year were an uncached analytics read, the origin term would add up to 0.302 MWh (L3).
- At a CMS render's cost, 100 million avoided renders save 0.419 kWh.
- Model inference is the one class whose per-operation joules are large, and it counts only for model-derived results that repeat for identical authorised inputs. Free-form prompts rarely repeat.

The origin term is measured per workload against the origin's real baseline. It is close to zero where a server cache exists and it is net of device work a projection relocates.

### Tiers at the Reference Scale

Views-channel energy per 100 million views a year, at the three per-view figures.

| tier           | Z_annual | attributional, 12 J | measured desktop, 0.80 J | measured phone, 0.088 J |
| -------------- | -------: | ------------------: | -----------------------: | ----------------------: |
| Meaningful     |      30% |           0.102 MWh |              0.00668 MWh |            0.000731 MWh |
| Major          |      65% |           0.221 MWh |               0.0145 MWh |             0.00158 MWh |
| Transformative |      90% |           0.306 MWh |               0.0200 MWh |             0.00219 MWh |

The attributional column is L2 over an L3 radio term. The two measured columns are L2: an L1 per-view figure times a view count and a tier share.

### Free-Tier Ceiling

The Workers free plan carries 3,040,000 views a month at one request per view. A local view makes no request, and the protocol syncs when it has something to learn. The table assumes one sync for every 20 local views, an L3 ratio used for illustration only. The scheduler has no fixed interval.

| tier           | Z_annual | views a month on the free plan |
| -------------- | -------: | -----------------------------: |
| Meaningful     |      30% |             4.25M (from 3.04M) |
| Major          |      65% |             7.95M (from 3.04M) |
| Transformative |      90% |            20.97M (from 3.04M) |

## Capacity Channel

This channel is the ceiling. It counts infrastructure an institution can stop running because spool lowers peak work, and an institution reaches it when it acts on the numbers and removes servers. It assigns no energy to an individual request. It is conditional and discontinuous: a fleet sized by peak throughput shrinks only when peak work falls far enough to retire a whole node, and the channel counts only when equipment is actually removed.

Spool reports it as three separate results, and any of them can read zero.

1. **Potential.** The capacity reduction computed from real peak traces and the latency SLO.
2. **Financial.** A smaller hosting plan or fewer billed instances, from invoices.
3. **Physical.** Electricity, counted only when equipment is removed or the provider's energy is measured. A retired server-year is 3.80 MWh (282 W at a PUE of 1.54, L2).

"No physical capacity saving demonstrated" is a valid report beside a large drop in requests.

The table is a sensitivity model, not an institutional one. It keeps `max(2, ceil(N x (1 - Z x 0.9)))` servers of `N` throughput-sized ones, where 0.9 is the share of load that is reads (L3).

| tier           | peak work cut | 10 servers sized by throughput | 20 servers sized by throughput | 50 servers sized by throughput | 100 servers sized by throughput |
| -------------- | ------------: | -----------------------------: | -----------------------------: | -----------------------------: | ------------------------------: |
| Meaningful     |           27% |            2 retired, 7.61 MWh |            5 retired, 19.0 MWh |           13 retired, 49.5 MWh |             27 retired, 103 MWh |
| Major          |           59% |            5 retired, 19.0 MWh |           11 retired, 41.8 MWh |            29 retired, 110 MWh |             58 retired, 221 MWh |
| Transformative |           81% |            8 retired, 30.4 MWh |           16 retired, 60.9 MWh |            40 retired, 152 MWh |             81 retired, 308 MWh |

Peak traces and SLOs replace this rule in a real report. Spool generates one per institution from its telemetry and the institution's own traces (`src/report/`).

### Retained Nodes

A node that stays in service can still draw less. Removing a request from a sparse stream can save more than the request's own work, because the package stays out of its deeper idle states.

| requests per second |    steady W above idle | steady mJ per request |    bursty W above idle |  bursty mJ per request |
| ------------------: | ---------------------: | --------------------: | ---------------------: | ---------------------: |
|                   5 |   0.21 (-0.11 to 1.09) | 41.8 (-20.8 to 215.9) |   0.24 (-0.85 to 1.42) | 48.3 (-170.2 to 283.7) |
|                  20 |    1.53 (0.81 to 2.17) |  76.5 (40.3 to 108.6) |   0.03 (-0.18 to 0.78) |     1.3 (-8.9 to 39.1) |
|                  50 |    2.78 (1.57 to 3.39) |   55.5 (31.4 to 67.7) |   0.61 (-0.04 to 1.25) |    12.1 (-0.8 to 25.1) |
|                 100 |    5.11 (4.71 to 5.65) |   51.1 (47.1 to 56.5) |    1.41 (0.90 to 2.32) |     14.1 (9.0 to 23.2) |
|                 200 |  10.36 (9.44 to 11.43) |   51.8 (47.2 to 57.1) |    3.07 (2.41 to 3.41) |    15.4 (12.1 to 17.1) |
|                 500 | 19.80 (19.72 to 20.25) |   39.6 (39.4 to 40.5) |    7.48 (6.60 to 8.11) |    15.0 (13.2 to 16.2) |
|               1,000 | 25.07 (24.63 to 25.68) |   25.1 (24.6 to 25.7) | 14.71 (14.43 to 15.62) |    14.7 (14.4 to 15.6) |

Across the sweep a steady stream below 200 requests per second fits 0.21 W plus 50.6 mJ per request (R2 0.971), while a bursty stream fits -0.01 W plus 14.9 mJ per request (R2 0.987), which is the closed-loop work cost. A generator that only fires its timer costs 13.8 mJ per tick at 50 per second, so an isolated request carries about one wake. That brackets the saving of one sparse isolated request at 29 to 56 mJ against 15.1 mJ of work. Batched arrivals save the work and nothing more, and above about 500 requests per second the marginal cost falls below the work cost.

The effect is bounded by the node's whole above-idle energy. At three origin requests per network view it comes to 0.0046 MWh a year per 100 million views (L2 over an L3 request count). It is the retained-node part of this channel. A node is either retired, and counted once at its full retired energy, or retained, and counted once here, never both. The scheduler batches beacons and syncs for this reason as well as for the radio.

### Embodied Energy

Embodied energy is a separate line in kgCO2e, L3 until a retirement ledger exists. It covers a server or instance-year not bought because a measured drop in peak work let a refresh slip. It stays outside the MWh figures so one retired server is never counted twice.

## Counting Rules

1. The attributional headline already holds a data-centre term (SWD v4's 3.3 J of the bytes term). Where a workload's origin joules were measured, they replace that term and the modelled origin request. They never add to the headline.
2. The meter-visible figure is the part of the headline spool controls directly. The origin-term figures break the headline down. They do not add to it.
3. Origin-term and power-state joules on a node that is later retired sit inside that node's retired 3.80 MWh. Subtract them from the views and retained-node figures for that node.
4. A projection view reports server joules removed, device joules added and provisioning bytes, per device class. Only the net is credited.
5. Network hardware stays out of the measured savings. The 12.3 J headline still carries SWD's network term (3.6 J of the bytes term), and that term is attributional: a published per-byte intensity applied to measured bytes. It is not a measurement of any router, and network energy is not proportional to data volume (Mytton, Lunden and Malmodin 2024, abstract only). One institution's traffic is a small share of any operator node's load, so no causal tie to an operator's power state can be shown from it.
6. Every figure keeps its label. Hyperscale per-request figures are never printed as spool savings.
7. Embodied energy is a separate kgCO2e line.

## Shared Responsibility

drupflare removes fixed idle capacity: a site that ran on a provisioned server runs on Workers, and the capacity it kept idle goes away. Spool removes throughput work: requests and renders that never reach the origin. A provider sized by throughput downsizes when demand falls, so spool lowers demand and drupflare lowers the floor. The two counts do not overlap, and a capacity saving already realised by migration is not spool's. On drupflare the immediate benefit is Worker requests and execution avoided. Cloud-hosted origins show a smaller bill, and the provider's electricity is not established.

## Third-Party Requests

A view is strict zero-network only when it makes no request at all, and the service worker can answer only same-origin requests. Most requests that leave the browser on the 16 sites of the on-wire reading go to hosts other than the page's own.

| navigation         | median proxy requests to other hosts | share of proxy requests | median bytes from other origins (direct run) |
| ------------------ | -----------------------------------: | ----------------------: | -------------------------------------------: |
| Cold home page     |                                 46.5 |                     63% |                                    1,771,682 |
| Warm internal page |                                 17.0 |                     63% |                                       15,643 |
| Home page again    |                                 26.0 |                     73% |                                       10,158 |

Spool's page runtime counts cross-origin loads per view (`crossOriginLoads`) and a view with any is not strict zero-network. WebKit also re-checks the worker script on some navigations, which `updateViaCache: 'all'` with a 24-hour script lifetime removes in Chromium and Firefox:

| registration                             | engine   | navigations | reached the origin | paths that did |
| ---------------------------------------- | -------- | ----------: | -----------------: | -------------- |
| default registration                     | chromium |          13 |                  1 | `/sw.js` x 1   |
| default registration                     | firefox  |          13 |                  4 | `/sw.js` x 4   |
| default registration                     | webkit   |          13 |                  3 | `/sw.js` x 3   |
| updateViaCache all, script max-age 86400 | chromium |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | firefox  |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | webkit   |          13 |                  5 | `/sw.js` x 5   |

## Evidence Behind the Design

Each finding forced a mechanism in code. Labels give what was read: full text, abstract only, or a web page.

| finding                                                                                                                                                 | source (label)                                    | mechanism                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A page rendered from cache with no network used 6.8% to 40.5% of the networked load's energy; one analytics request erased the saving on 15 of 25 sites | Thiagarajan et al., WWW 2012 (full text)          | batched analytics in `src/sw/analytics.ts`; zero requests per view as the target            |
| 92% of HTML tags were identical across loads 12 hours apart, 75% across a week                                                                          | Mardani et al., Fawkes, NSDI 2020 (full text)     | dependency-level sync and hard and soft freshness (`src/sw/freshness.ts`)                   |
| Safari deletes script-writable storage after 7 days without interaction                                                                                 | WebKit blog 10218 (full text)                     | a re-provision path and `P_warm` reported per engine                                        |
| Network, data centre and device intensities of 0.059, 0.055 and 0.080 kWh/GB                                                                            | Sustainable Web Design v4 (web page)              | the attributional headline in `src/report/inputs.ts`                                        |
| 43% of higher-education sessions are on phones, 2.3 pages per session                                                                                   | OHO 2022 benchmarks (full text)                   | the mobile share and the session-entry view                                                 |
| A controlled navigation reaches the origin zero times in Chromium and Firefox with `updateViaCache: 'all'` and a one-day script lifetime                | the zero-network reading (L1)                     | the registration in `src/client/register.ts`; the worker script served with `max-age=86400` |
| Cloudflare's analytics script posts to `/cdn-cgi/rum` about twice per navigation                                                                        | the views reading (L1)                            | beacon queueing in the worker                                                               |
| Firefox does not route `fetch` with `keepalive` through a service worker                                                                                | a probe in the browser lane (L1)                  | a limit of the beacon queue in `src/sw/analytics.ts`: a keepalive post bypasses it          |
| WebKit re-fetches a page's cacheable subresources once on the first controlled navigation and routes subresources through the worker                    | a probe in the browser lane (L1)                  | the worker's asset cache and the per-engine zero-network tests                              |
| Page weight is dominated by new media; a revisit moves few bytes, and the browser still lists dozens of cached requests                                 | the repeat-navigation and on-wire readings (L1)   | the target is the transaction, so `Z_annual` counts views that make no request              |
| A server cache already removes recompute, and a projection relocates work                                                                               | the compute readings (L1)                         | the strategies `assembly` and `template` first, and the projection net-of-relocation rule   |
| Median 0.24 Wh for a Gemini text prompt, including 10% provisioned idle and facility overhead                                                           | Elsworth et al., arXiv 2508.15734 (full text, L0) | such figures are never printed as spool savings                                             |

## Baselines

Spool's saving is credited against an optimized HTTP baseline: immutable hashed assets, ETag revalidation and compression. Fixing a site's own asset caching comes first and is not spool's credit. Other baselines it is compared with:

- **Compression Dictionary Transport (RFC 9842).** Shrinks bytes for repeat loads, but every view still makes a request.
- **Back-forward cache and Speculation Rules.** Make some navigations instant. A bfcache restore needs no request, and it covers only back and forward navigations in one session.
- **The Drupal PWA module.** Caches the shell, with no story for authenticated pages.
- **Fawkes-style patching.** Sends a patch against a stored template on each load, so it still makes one request per view.

## What Spool Does Not Claim

Spool does not claim:

- that 12.3 J is a meter reading. It is an attributional allocation, and the meters read 0.80 J on a desktop and 0.088 J on a phone;
- a marginal kWh per GB;
- that one avoided request is one avoided radio wake;
- a capacity saving without evidence that equipment was removed, since a cloud-hosted origin shows a bill and the provider's electricity is not established;
- savings from a projection without its relocated device work and its provisioning bytes;
- that one institution's traffic moves a network operator's power state;
- a paced or cellular phone figure, which neither run has resolved.

## Reproducing

Each reading is one JSON file written by one script under `scripts/measure/`. Run a script with `--dry-run` first: it prints the resolved plan and the file it would write, and touches nothing.

```sh
bun run measure:repeat-nav
bun run measure:on-wire
bun run measure:zero-network
bun run measure:device-cpu
UDID=<device id> bun scripts/measure/iphone.ts --experiment burst --net <origin> --sw <origin>
bun run impact
```

The RAPL runs happen on a Linux host with the package counter readable, inside the Playwright container, with the counter and the cgroup tree mounted read-only. `scripts/measure/rapl.ts run <experiment>` writes raw lines and `publish` turns them into the reading, strips container ids and integrates a GPU trace sampled on the host.

```sh
node scripts/measure/rapl.ts run compute-server --raw out/compute-server.jsonl
node scripts/measure/rapl.ts publish compute-server --raw out/compute-server.jsonl
```

`bun run impact:check` runs in CI and fails on any difference between the committed page and the readings.
