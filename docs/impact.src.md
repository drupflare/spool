# Energy Impact

This page sets out how spool's energy figures are built. Every number comes from a reading in [`measurements/`](../measurements/README.md) or from an input in `src/report/inputs.ts`. `bun run impact` regenerates the page from those, and `bun run impact:check` fails when the committed page differs from what the readings produce. Edit `docs/impact.src.md`, never `docs/impact.md`.

Two channels carry the numbers. The capacity channel is the ceiling: what an institution reaches when it acts on the numbers and removes servers, at {{value:serverYear}} MWh per retired server-year. It counts only when equipment is actually removed. The per-view figures in the views channel are floors. They are measured, and the work is to raise them.

Tiers on this page are relative to an institution's own views. The tables use 100 million views a year as a scale, an L3 choice that names no institution. Multiply a table by your own yearly views over 100 million.

## Measurement Labels

Each figure carries one label, and a derived figure keeps its label wherever it travels.

| label | meaning                                                     |
| ----- | ----------------------------------------------------------- |
| L0    | published by someone else, with its source named            |
| L1    | measured here, on the hardware the reading's file describes |
| L2    | derived: arithmetic over L0 and L1 figures                  |
| L3    | a scenario: an assumption, or a what-if no reading backs    |

A figure that mixes an L2 product with an L3 term is L3 as a whole. The {{value:headlineJ}} J headline below is L2, and the table that builds it says so.

## Accounting Quantities

Spool counts five quantities and never assumes they move together.

1. **Browser resource operations.** What the browser's network stack reports for a navigation: requests, cache hits and 304s.
2. **On-wire requests.** Requests that reach an origin, counted by a proxy between the browser and the origin.
3. **Worker invocations.** Requests a Worker runs. A request answered by a static asset or by the browser does not count.
4. **Encoded bytes.** Bytes transferred, as sent.
5. **Network-active intervals.** The stretches a device's radio stays awake. One avoided request is not one avoided radio wake.

Where a rig reads device or server energy, joules are a sixth quantity beside these.

The browser's count and the proxy's count differ, and the difference is the reason for counting both.

{{table:on-wire}}

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

{{value:headlineJ}} J per local revisit view is the attributional figure. It applies the Sustainable Web Design v4 intensities (network, data centre and device, {{value:swdTotal}} kWh/GB together) to the bytes of the document request a local view replaces, then adds an origin request. The radio-wake term is 0 J until a phone reading attributes a wake to a network view (see the cellular reading below).

{{table:headline}}

Every term counts as energy that goes away when the view makes no request, the same sense drupflare's own impact page uses. The figure is an allocation of a published model over measured bytes. No meter read it.

A default local view replaces one request, the page's document. The model prices that request: {{value:revisitBytesInput}} B, the median repeat-view document over every repeat-navigation reading ({{value:revisitViews}} views from {{value:revisitReadings}} readings). The rest of a repeat view is left out. An optimized HTTP cache already keeps a site's static files, so those bytes are the baseline fix's saving and not spool's. The page's own API calls and every third-party request still leave the browser during a local view, unless the site declares `data` routes or turns on the third-party cache. For scale, the whole repeat view's median is {{value:revisitWholeMedian}} B, and the latest reading's median is {{value:revisitRequests}} network requests over {{value:revisitSites}} sites.

The saving grows with the size of a site's document. Where the browser's own cache answered the document (a long `max-age` on the HTML), a local view has no request to replace and saves nothing. The headline is the typical site; an institution's own figure comes from its own pages and traffic. Every site read so far, lightest document first, with the attributional joules a local view of that page avoids. Sites that answered the rig with an error page instead of their home page are left out ({{value:blockedSites}}).

{{table:bytes-by-site}}

{{table:repeat-nav}}

Bytes are what the browser received. Requests are the ones the browser sent to the network: a repeat view also lists dozens of sub-resources it answered from its own cache, and those are left out. The on-wire table sets a proxy's count of the same navigations beside the browser's.

### Measured Figures

The meter-visible part is smaller. These readings are the floor the engineering work has to raise.

{{table:desktop-views}}

Against a page served with optimized HTTP caching, a local view saves {{value:desktopSaving}} J on this desktop (the difference of the arm medians over {{value:desktopRounds}} rounds each). Against the demo's shipping headers, where every asset revalidates, the saving is {{value:shippingSaving}} J. The second figure belongs to the baseline fix, not to spool. drupflare has since shipped that fix (a one-year cache lifetime on static assets through `assets/_headers`) and measured it: a repeat navigation of a deployed free-plan drupflare site costs 1.31 J (1.23 to 1.41) on the same desktop over a real network, one request a navigation (drupflare/worker `docs/impact.md`, L1). That is the baseline spool is measured against on drupflare; a matched spool arm on a deployed site waits for the drupflare adapter.

The desktop figure includes the package energy of the browser, the co-located origin and the service worker. It excludes the display, the network interface, the radio and every router and data centre between the two ends.

On the phone:

{{table:phone-views}}

A local view saves {{value:phoneSavingBurst}} J on an iPhone 14 Pro, back to back over Wi-Fi in this reading ({{value:phoneBurstRounds}} rounds, the difference of the arm medians). The same page pair in the projection reading below gives {{value:phoneSaving}} J ({{value:phoneRounds}} rounds), the figure the rest of this page uses. The counter is the whole phone with the screen on, so the figure includes the display's share while navigating and the Wi-Fi radio. It excludes the cellular radio, its tail state and the network. Back-to-back navigation keeps the radio awake, which understates what a network view costs between idle periods.

Views paced at one every 15 seconds could not be resolved. Idle windows of {{value:pacedSeconds}} seconds varied by {{value:pacedIdleRange}} J, more than the {{value:pacedSignal}} J that {{value:pacedViews}} views would add at the back-to-back saving, so no paced figure is claimed over Wi-Fi.

Over cellular, with the Wi-Fi switched off, the idle windows were steadier and both pacings resolved:

{{table:phone-cellular}}

Back to back, a local view saves {{value:cellBurstSaving}} J over cellular, about what it saves over Wi-Fi. At one view every {{value:cellPacedSeconds}} seconds, each view costs 11 to 18 times its back-to-back cost (most likely the cost of waking the phone from idle for one view; not measured separately), and the network view and the local view cost about the same ({{value:cellPacedSaving}} J apart, inside the spread across rounds). A second reading isolates the request. The phone ran the same WebDriver script every {{value:radioSeconds}} s over {{value:radioRounds}} rounds, once with a `fetch` to a Worker that answers 204 with no body and once without it. Above idle, a call with the request cost {{value:radioRequest}} J and a call without it {{value:radioScript}} J: the medians are {{value:radioDifference}} J apart and the ranges overlap. No radio wake can be attributed to the request at this resolution, so the headline carries 0 J for it. The earlier scenario value of 5 J per phone view stays out until a reading attributes one.

### Server Runtimes

The same small site ran under spool 0.1 in four server runtimes on paisley-park, one container at a time, with Chromium on another machine reaching it over Tailscale. Each window was {{value:runtimeViews}} views. The server's package energy and its interface byte counters were read per window, less the idle window of the same round. The overlay interface carries the HTTP traffic; the physical interface adds the relay's framing, since this path went through a Tailscale relay in every round.

{{table:runtimes}}

A spool local view sent nothing to the origin in every window but one per runtime, and its server energy is inside the idle drift. The exception is the fourth spool window, which made up to {{value:runtimeFlushRequests}} requests to `/.spool/*` in every runtime. It ended about 15 minutes after the worker was primed, which is when the public routes' default soft bound expires: the timing matches one sync with the held view telemetry flushed on the same network moment (the rig counted `/.spool/*` requests, not their paths). That is spool's own overhead. The medians above leave it out, since it is one window in six; the measured per-view figure P8 reports nets syncs and flushes against the saving. A bare HTML request from curl costs the server more than a browser view, most likely because curl opens a new connection through the relay for each request while the browser reuses one.

One request per view is also what breaks the saving. A page that posts to an analytics endpoint on every view makes each view a network view again, with that request's bytes and origin work. On a 2012 3G phone that post also woke the radio (Thiagarajan et al.); this phone showed no wake for an isolated request. Spool queues those posts in the service worker and sends them on a network moment that happens anyway.

### Origin Term by Workload

The headline's origin term is modelled. For a view the origin would otherwise render, such as an authenticated view or a cache miss (a meaningful share of views), the measured origin joules for that workload replace SWD's data-centre term and the modelled origin request. They never add to the headline. Where a cache would have answered, the term is the cost of a cache hit, a fraction of a millijoule.

{{table:origin-term}}

Each origin figure is package energy above idle on paisley-park (L1, {{value:computeRounds}} rounds unless noted) against a synthetic CMS and enrollment database that each file describes. The per-view figure is L2 over the L3 radio term. A real origin's joules replace the origin column when they are measured.

#### Per-Request Cost

{{table:compute-server}}

The null route is the transaction floor: loopback HTTP, keep-alive, no body. A cache hit costs about as much as the floor. A CMS render costs {{value:cmsRenderRatio}} times a cache hit and the analytics page about {{value:analyticsRatio}} thousand times. Across the two recompute rows the rule of thumb is {{value:mjPerCpuMs}} mJ of package energy per busy CPU millisecond, for one boosted core in a closed loop. A shared and loaded server amortises idle power differently.

#### Against a Server Cache

Chromium navigations with 40 ms of emulated latency, J per navigation above idle:

{{table:compute-pages}}

Against an optimized server cache, spool's increment is the transaction only: {{value:cmsIncrement}} J for the CMS page and {{value:anaIncrement}} J for the analytics page, whatever the page costs to compute. Against recompute on every request the saving grows with the computation. The origin term above is the part of that saving the origin accounts for.

#### Projection

The `projection` strategy sends records once and lets the page compute the result. It relocates work. Per view, on the desktop:

{{table:projection-desktop}}

A local projection costs {{value:projectionRelocationSw}} J more than a static local view when the records come from CacheStorage, and {{value:projectionRelocationNet}} J more than the cached server page when the network serves the page. The experiment does not explain the difference between those two. It removes {{value:projectionServerRemoved}} J of server work per view above a server cache. The records are a one-time transfer of {{value:recordsMb}} MB, which the per-view saving repays after about {{value:recordsRepay}} views against the attributional bytes term (L2).

On the phone, back to back over Wi-Fi:

{{table:projection-phone}}

A local projection costs {{value:phoneProjectionRelocation}} J more than a static local view and lands within the range of a network fetch of the computed page. The aggregation of {{value:recordRows}} rows costs more than the radio-awake fetch it replaces. The server never ran, but the device-side saving of a projection view is about zero in this configuration. The records are synthetic and one size.

Report a projection as server joules removed, less device joules added, with the provisioning bytes beside both. Credit the net.

#### Inference

A local 8B model behind the origin, against a cached copy of the same response ({{value:inferenceRounds}} rounds, {{value:inferenceTokens}} output tokens per request, CPU package and a sampled GPU board):

{{table:inference}}

The GPU term is sampled power, labelled L1-sampled. The card's stated accuracy is +-5 W and it has no energy counter. A resident model also draws {{value:keepWarmWatts}} W while idle, which a cache hit does not save unless the model gets unloaded because of it.

Published per-request figures for hyperscale serving (0.24 Wh median for a Gemini text prompt, L0, and modelled estimates of 0.31 and 3.91 Wh) include host machines, provisioned idle capacity and facility overhead. They describe an attributional stack. They are never printed here as spool savings.

#### Reach of the Origin Term

{{table:operations}}

The first column is the energy one avoided operation saves on this machine. The second is that energy for a million avoided operations, in kWh, an L2 product.

- If every one of 100 million views a year were an uncached analytics read, the origin term would add up to {{value:analyticsCeiling}} MWh (L3).
- At a CMS render's cost, 100 million avoided renders save {{value:cmsCeiling}} kWh.
- Model inference is the one class whose per-operation joules are large, and it counts only for model-derived results that repeat for identical authorised inputs. Free-form prompts rarely repeat.

The origin term is measured per workload against the origin's real baseline. It is close to zero where a server cache exists and it is net of device work a projection relocates.

### Tiers at the Reference Scale

Views-channel energy per 100 million views a year, at the three per-view figures.

{{table:views-channel}}

The attributional column is L2 over an L3 radio term. The two measured columns are L2: an L1 per-view figure times a view count and a tier share.

### Free-Tier Ceiling

The Workers free plan carries {{value:freeTierViews}} views a month at one request per view. A local view makes no request, and the protocol syncs when it has something to learn. The table assumes one sync for every 20 local views, an L3 ratio used for illustration only. The scheduler has no fixed interval.

{{table:free-tier}}

## Capacity Channel

This channel is the ceiling. It counts infrastructure an institution can stop running because spool lowers peak work, and an institution reaches it when it acts on the numbers and removes servers. It assigns no energy to an individual request. It is conditional and discontinuous: a fleet sized by peak throughput shrinks only when peak work falls far enough to retire a whole node, and the channel counts only when equipment is actually removed.

Spool reports it as three separate results, and any of them can read zero.

1. **Potential.** The capacity reduction computed from real peak traces and the latency SLO.
2. **Financial.** A smaller hosting plan or fewer billed instances, from invoices.
3. **Physical.** Electricity, counted only when equipment is removed or the provider's energy is measured. A retired server-year is {{value:serverYear}} MWh ({{value:serverWatts}} W at a PUE of {{value:pue}}, L2).

"No physical capacity saving demonstrated" is a valid report beside a large drop in requests.

The table is a sensitivity model, not an institutional one. It keeps `max(2, ceil(N x (1 - Z x 0.9)))` servers of `N` throughput-sized ones, where 0.9 is the share of load that is reads (L3).

{{table:capacity}}

Peak traces and SLOs replace this rule in a real report. Spool generates one per institution from its telemetry and the institution's own traces (`src/report/`).

### Retained Nodes

A node that stays in service can still draw less. Removing a request from a sparse stream can save more than the request's own work, because the package stays out of its deeper idle states.

{{table:power-state}}

Across the sweep a steady stream below 200 requests per second fits {{value:fitSteadyLow}}, while a bursty stream fits {{value:fitBursty}}, which is the closed-loop work cost. A generator that only fires its timer costs {{value:timerWake}} mJ per tick at 50 per second, so an isolated request carries about one wake. That brackets the saving of one sparse isolated request at {{value:wakeLow}} to {{value:wakeHigh}} mJ against {{value:workMj}} mJ of work. Batched arrivals save the work and nothing more, and above about 500 requests per second the marginal cost falls below the work cost.

The effect is bounded by the node's whole above-idle energy. At three origin requests per network view it comes to {{value:powerStateMwh}} MWh a year per 100 million views (L2 over an L3 request count). It is the retained-node part of this channel. A node is either retired, and counted once at its full retired energy, or retained, and counted once here, never both. The scheduler batches beacons and syncs for this reason as well as for the radio.

### Embodied Energy

Embodied energy is a separate line in kgCO2e, L3 until a retirement ledger exists. It covers a server or instance-year not bought because a measured drop in peak work let a refresh slip. It stays outside the MWh figures so one retired server is never counted twice.

## Counting Rules

1. The attributional headline already holds a data-centre term (SWD v4's {{value:dataCentreJ}} J of the bytes term). Where a workload's origin joules were measured, they replace that term and the modelled origin request. They never add to the headline.
2. The meter-visible figure is the part of the headline spool controls directly. The origin-term figures break the headline down. They do not add to it.
3. Origin-term and power-state joules on a node that is later retired sit inside that node's retired {{value:serverYear}} MWh. Subtract them from the views and retained-node figures for that node.
4. A projection view reports server joules removed, device joules added and provisioning bytes, per device class. Only the net is credited.
5. Network hardware stays out of the measured savings. The {{value:headlineJ}} J headline still carries SWD's network term ({{value:networkJ}} J of the bytes term), and that term is attributional: a published per-byte intensity applied to measured bytes. It is not a measurement of any router, and network energy is not proportional to data volume (Mytton, Lunden and Malmodin 2024, abstract only). One institution's traffic is a small share of any operator node's load, so no causal tie to an operator's power state can be shown from it.
6. Every figure keeps its label. Hyperscale per-request figures are never printed as spool savings.
7. Embodied energy is a separate kgCO2e line.

## Shared Responsibility

drupflare removes fixed idle capacity: a site that ran on a provisioned server runs on Workers, and the capacity it kept idle goes away. Spool removes throughput work: requests and renders that never reach the origin. A provider sized by throughput downsizes when demand falls, so spool lowers demand and drupflare lowers the floor. The two counts do not overlap, and a capacity saving already realised by migration is not spool's. On drupflare the immediate benefit is Worker requests and execution avoided. Cloud-hosted origins show a smaller bill, and the provider's electricity is not established.

## Third-Party Requests

A view is strict zero-network only when it makes no request at all, and the service worker can answer only same-origin requests. Most requests that leave the browser on the 16 sites of the on-wire reading go to hosts other than the page's own.

{{table:third-party}}

Spool's page runtime counts cross-origin loads per view (`crossOriginLoads`) and a view with any is not strict zero-network. WebKit also re-checks the worker script on some navigations, which `updateViaCache: 'all'` with a 24-hour script lifetime removes in Chromium and Firefox:

{{table:zero-network}}

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

- that {{value:headlineJ}} J is a meter reading. It is an attributional allocation, and the meters read {{value:desktopSaving}} J on a desktop and {{value:phoneSaving}} J on a phone;
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
