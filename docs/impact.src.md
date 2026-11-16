# Impact Notice

Spool lets a visitor's browser answer a page view it has already seen, without asking the site. A local view removes the document request, the transaction that carries it and the server work behind it. The page's own API calls and every third-party request still leave the browser unless the site declares `data` routes or turns on the third-party cache.

This page says what that saves, how sure each number is and what it means in money. Every figure carries a label: L0 published by someone else, L1 measured here, L2 derived from L0 and L1, L3 a scenario. The sections after the notice show the readings and the arithmetic.

## What Spool Saves

The headline is {{value:headlineJ}} joules per local view (L2). It applies the Sustainable Web Design v4 intensities for the network, the data centre and the device to the {{value:revisitBytesInput}} bytes of the document a local view replaces, then adds the origin's energy for one request. No meter read it.

Meters read less, because they leave out the network and every data centre between the two ends. Three readings sit beside the headline:

| where                                   | figure per view                                                                    | label | what it covers                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| Desktop                                 | saves {{value:desktopSaving}} J                                                    | L1    | package energy of the browser, the origin and the service worker, against optimized HTTP caching |
| iPhone 14 Pro                           | saves {{value:phoneSaving}} J                                                      | L1    | the whole phone with the screen on, over Wi-Fi, against a network view                           |
| Server, {{value:runtimeCount}} runtimes | a network view costs {{value:runtimeNetworkLow}} to {{value:runtimeNetworkHigh}} J | L1    | package energy of the server, which a local view does not spend                                  |

On the server, a local view sent nothing in all but one window per runtime, and its measured energy ({{value:runtimeLocalHigh}} J at most, as a median) sits inside the idle drift. The ranges and the method are under Measured Readings.

Spool does not claim that the headline is a meter reading, a saving in radio wakes, a capacity saving without evidence that equipment was removed, or a figure for paced or cellular phone use. The full list is under What This Does Not Claim.

## Unit and Scope

The per-view figures on this page are reported in kWh per million views, so they compare at any throughput. A reader multiplies one by their own yearly views in millions. One joule a view is one megajoule per million views, which is {{value:kwhPerMvPerJoule}} kWh per million views (L2). The unit is for research and communication. Nothing in this report sets a target intensity.

A CMS website uses little energy next to an institution's whole IT estate, so energy is a research and communication item here and not a business one. The largest part of drupflare's saving is idle and hosting energy per site-year, which is not a per-view quantity. That saving keeps its own units in [Economics](#economics), where the peak-sized hosting counterfactual sits, and in [Capacity](#capacity), where a retired server-year is {{value:serverYear}} MWh (L2). This page computes no per-view equivalent of it.

Every kWh per million views figure assumes a view mix: the share of cold first views against repeat views, the page weight and the device. The table names the mix of each row. The first-view rows are cold views of landing pages from university sites, not weighted by traffic. The repeat rows are repeat views. Where a table needs a cold share it takes one from an L3 input. A fleet-wide kWh per million views is never printed without its mix.

Two kinds of kWh appear. The attributional figure is SWD v4 over wire bytes, an allocation (L2). The metered figure is the package energy of one desktop (L1) or the whole phone. Where both exist they sit side by side and are labelled. The attributional column is the upper reading. Where a metered reading exists, what to build is decided on the metered column.

{{#unit-first-view}}
On the first-view pages the metered figure is {{value:unitFvRatio}} of the attributional one, the mean of the metered joules over the mean of the attributional joules (L2).

{{/unit-first-view}}
{{table:unit-status}}

The first rows are what one local view saves. A row marked as a cost is the energy a view spends, which is not a saving. The ranges and rounds behind the metered figures are under Measured Readings.

### Energy by Tier

Spool's tiers name the share of views that are local: Meaningful at 30%, Major at 65% and Transformative at 90%. The table gives the energy per million views at each of the three per-view figures, which is the tier's share times the figure.

{{table:views-channel}}

The attributional column is L2 over an L3 radio term. The two measured columns are L2: an L1 per-view figure times a tier share. The view mix is repeat views of the median document.

## Bandwidth and Request Costs

A local view removes the demand a view would place on the host, so a host that bills traffic or requests bills less. Energy is one objective among these, and an administrator decides how much weight it gets. The bytes saved per local view are the document's median size, {{value:revisitBytesInput}} B or {{value:documentKb}} KB (L1, the same median the headline uses). The requests saved are one per local view. Per million local views that comes to {{value:gbPerMillion}} GB and one million requests.

Prices are each vendor's published list prices, read from the vendor's own page on {{value:pricesRead}}. Every input is L0 unless the table says L2, and every input's source is in `src/report/inputs.ts`. A price that could not be read from the vendor's page is left out.

{{table:host-prices}}

Egress is priced at the first paid tier of each host. A free allowance is used up by everything the site serves, not by the bytes spool removes, so for a site whose total traffic is past the allowance the saving comes off at the paid rate. A site large enough to reach a host's later tiers pays a lower rate per GB there, so for it these figures are the high end. A site that serves less than its allowance in total saves nothing in dollars. A GiB is 2^30 bytes and a GB is 10^9.

{{table:bandwidth-per-million}}

The dollar figure is small. A million local views save between {{value:perMillionLow}} and {{value:perMillionHigh}} at these list prices. At each of the three tiers of local views:

{{table:bandwidth-worked}}

At the Transformative tier that is {{value:topWorkedLow}} to {{value:topWorkedHigh}} per million views across these hosts. The bytes and requests behind it:

{{table:bytes-per-tier}}

The same rule holds for requests. Cloudflare Workers and CloudFront each include 10 million requests a month, and that allowance is used by all of the site's requests. Past it, each request spool removes saves the request price in the table.

Two more hosts publish traffic terms that this page cannot turn into dollars. Pantheon bills overage at {{value:pantheonOverage}} for each 10,000 unique visits, counting an IP address and user agent once over 24 hours; the page carries a notice that the automated overage program is paused. A visit is a different unit from a view, and no reading here says how many visits spool removes, so no Pantheon figure is derived. Acquia's pricing page lists no traffic or bandwidth price, so Acquia is left out.

The money above does not include:

- staff time spent on the site or on the migration;
- plan tiers that do not scale with traffic, such as a flat hosting plan, which gets cheaper only when traffic falls under a tier boundary;
- request fees at hosts where none was read (Azure and Google Cloud above);
- the origin's compute and the servers behind it, which the Capacity section treats;
- the requests spool sends itself. The table counts one request avoided per local view and does not subtract spool's syncs and flushes.

Cloudflare Workers bills a request only when a Worker runs. A site that serves its document from static assets makes no Worker request for it, and saves $0 in the Workers row. Prices are list prices. An institution's contract can differ from every number here.

## An Institution's Figures

This section prices spool for one institution. It leads with money, then storage and trust, then energy as a research figure. Institutions A, B and C are anonymous examples at three scales. Their site counts are L3 choices, and they name no campus. The blocks come from `institutionReport` in `src/report/institution.ts`.

### Economics

The host meter carries drupflare's hosting saving: the energy the host no longer spends serving the institution's sites. The peak-sized deployment is the headline (L2). The production deployment and a single small VPS sit beside it. Each is priced at the state's average industrial and commercial rates (L0).

{{table:institution-economics}}

The electricity prices come from EIA. Only these five states are in the record, and the report throws on any other state.

{{table:institution-prices}}

Spool's data-centre share of the attributional saving is already inside the hosting saving, so the table does not add it. For Institution A the data-centre share is {{value:instADataCentre}} MWh a year and the rest, {{value:instAOffMeter}} MWh, sits on visitors' devices and networks. No institution's meter carries that rest, so no dollar figure covers it.

The dollar figures are energy charges only. The record holds no campus tariff, no energy-only share of any bill and no demand charge. A saved kWh avoids the energy charge and any per-kWh delivery charge. The averages here are all-in rates, so they overstate a saving that avoids only the energy charge. The figures are small beside hosting fees and support contracts.

### Storage

The storage block compares the bytes each dataset holds on the device and on the server with a declared budget for each side. The worker does not report those bytes yet, and the device store that would hold them is not built. This page therefore prints no storage figure. A report given storage inputs shows the held bytes and whether each side is within budget.

### Trust

The trust block counts what the worker's own views record. It counts sampled shadow comparisons and their mismatches, views the worker refused or rendered by fallback, and views answered from the network because a stored copy was outdated. Proof failures, reseeds and rollbacks are not counted anywhere in the worker. A report says so and never prints a zero for them. This page has no views from a live site, so it prints no trust figure.

### Research: energy, carbon and water

These figures are research. Energy and carbon do not decide a default or a sales claim, and the energy figures are not a business case.

For Institution A, the attributional saving at the high case is {{value:instAAttrMwh}} MWh a year, or {{value:instAKwhPerMv}} kWh per million views (L3). Every per-million-views column in this section uses the average view of the footprint paragraph below, a mix of cold first views and repeat views. It splits across three meter boundaries: visitors' devices take {{value:deviceShare}}%, networks {{value:networkShare}}% and data centres {{value:dataCentreShare}}% (L2, from the SWD v4 intensities). Only the data-centre share sits on a host's meter.

{{table:institution-boundary}}

Carbon uses each campus's own eGRID2023 subregion (L0). The eGRID rate covers stack emissions at the plant, with no transmission or distribution losses and no upstream emissions. Ember's 2025 national figure of 384 gCO2e/kWh (L0) sits beside it and does not replace it. Ember states no boundary. The carbon covers the whole attributional saving, and a visitor's device draws on its own grid, so read the carbon as a bracket.

Water covers the data-centre share only. Direct water is used on site. Indirect water is used where the electricity is generated, in the plant's watershed and not the campus's. Drupflare's indirect factor is {{value:indirectGapPct}}% above the figure LBNL prints. Water stays per institution and is never added up, because water is local.

{{table:water-factors}}

{{table:grid-factors}}

{{table:institution-carbon-water}}

The goal ladder sets each goal as a share of a page view's own footprint. An average view costs {{value:avgViewJoules}} J on the attributional basis, which is {{value:avgViewKwhPerMv}} kWh per million views (L2). First views carry the central share of {{value:firstViewShareCentral}} (L3), and the first-view and repeat-view bytes come from the Web Almanac (L0) and the repeat-navigation rig (L1). The shares of 2.5%, 5%, 10% and 25% are proposed, not adopted. The high case of {{value:goalHighShare}}% is a scenario (L3). Each cell gives kWh a year.

{{table:goal-ladder}}

The same shares as an intensity, in kWh per million views. The mix is the average view above, with cold first views at the central share (L3).

{{table:footprint-intensity}}

Unconfirmed inputs: the Dartmouth footprint is a 2019 preliminary figure, and the record holds no campus electricity price, no energy-only share of a bill, and no lifecycle or marginal grid factor. Ember's boundary is unstated.

## Asset Trimming

The proxy can serve a site's stylesheets with the rules that no page of the site can match removed. This is a separate channel from the {{value:headlineJ}} J headline. The headline is what a local view saves, and a local view fetches no stylesheet. Trimming applies to a network view of a page the visitor has not seen. A repeat view saves nothing from it, since an optimized HTTP cache already keeps the file. The two do not add, and nothing in this section is part of the headline.

The saving has to happen where the file is served. A service worker cannot save bytes by trimming a file it already fetched. The proxy trims each file against every page and script of the site and never against one page, so the file keeps its URL and one cached copy, and only rules that match nothing in the crawl go. A build step that runs PurgeCSS with a safelist reaches the same saving. The proxy reaches it without a change to the origin.

JavaScript stays as it is. Coverage at load cannot see what a click or a scroll will need. Over {{value:trimCoveragePages}} pages the used share of same-origin JavaScript rose from {{value:trimJsLoad}} at load to {{value:trimJsScroll}} after one scroll (L1), and no load-time measure can say which of the rest a visitor will run. CSS coverage stayed at {{value:trimCssLoad}} after the same scroll.

{{table:trim-coverage}}

### What the Trim Removes and Whether It Is Safe

The run crawled {{value:trimPages}} pages on {{value:trimSites}} Drupal sites, built one manifest per site from all its pages and the scripts they load, and fetched {{value:trimFiles}} stylesheets, of which the trim removed rules from {{value:trimFilesTrimmed}} (L1). Four checks decide whether the trimmed files are safe to serve.

{{table:trim-checks}}

Oracle A reads CDP rule usage on the original CSS, at load and after one scroll, and counts the used rules the trimmed text lost. Oracle B screenshots each page at full height with the original CSS and again with the trimmed CSS, and counts the pixels that differ. The control is the original page screenshotted twice, so the pixels it differs by come from the page and not from the CSS. One screenshot of each arm is a small sample, and a page that differs in the trimmed arm and not in the control is not proof of a CSS difference. Leave-one-out rebuilds the manifest without the page, which is how a page the crawl missed would meet it.

### Bytes and Joules Saved

Each figure is the brotli-5 size of a stylesheet before and after the trim, summed over the files that were new to the visit, with the home page first. A first view of an internal page therefore counts only the files that a visit starting at the home page had not fetched. The home page row is the cold case. The proxy sends a decoded body and a host's edge compresses it, so the bytes are an estimate of transfer (L2). Joules apply the attributional {{value:swdTotal}} kWh/GB to those bytes (L2). A trimmed file is the same request, so there is no origin term.

{{table:trim-savings}}

The typical first view of an internal page saves {{value:trimFirstBytes}} and {{value:trimFirstJoules}} J, and the mean is {{value:trimFirstMeanBytes}} and {{value:trimFirstMeanJoules}} J. The mean is the figure to multiply by a view count, since a few pages with large unused files carry the total.

### Per Million Views

The share of views that are network views of a page the visitor has not seen is an L3 input. It runs from {{value:trimShareLow}} to {{value:trimShareHigh}}, and `src/report/inputs.ts` gives the source of each value and the one in between. A view counted here is a network view of an unseen page.

{{table:trim-million}}

Dollars use the rule of Bandwidth and Request Costs: the paid marginal rate at each host's first paid tier, which is the high end for a site large enough to reach a later tier. A free allowance is used up by everything the site serves, so a site under its allowance saves no dollars. Cloudflare Workers bills no egress and its row is $0.

{{table:trim-prices}}

### Churn Between Two Readings

The trim rig read the same ten Drupal sites on {{value:churnFirstDate}} and again on {{value:churnSecondDate}}, {{value:churnDays}} days apart, with the same method. Two readings show churn between two deployments at most. They say nothing about a rate: there is one interval and no third reading to show a trend.

An aggregate is a same-origin CSS or JS file under a `files/css/` or `files/js/` folder. Names are compared by path with the query dropped, across every page the rig visited on each date. The first reading kept sizes and transfer bytes only. So for it, the names are the only comparison available. A content hash, and the zstd size of a changed file against the earlier file of its kind, exist only on the second reading. The earlier file was fetched by its path on the second date, so a dictionary figure exists only where that path still answers. Content under an unchanged name cannot be compared at all, since the first reading holds no hash.

The cause of a name change was not read. Drupal's aggregate names depend on the asset library set and on the site's own cache rebuilds; this reading does not separate those.

- {{value:churnUnchangedSites}} of {{value:churnSites}} sites kept the same set of aggregate names (L1).
- The changed names carry a median of {{value:churnChangedMedian}} of a site's aggregate transfer bytes, and a mean of {{value:churnChangedMean}} (L2).
- Across the {{value:churnDictSites}} sites with a changed file whose earlier file answered, the zstd 3 dictionary size over the standalone size has a median of {{value:churnDictMedian}} and a mean of {{value:churnDictMean}} (L2). Lower is better. A ratio of 1 means the earlier file saved nothing.

{{table:trim-churn}}

## First Payload

A cold visit through `spoolProxy` used to fetch the page twice, once as the navigation and once more as the worker's artifact. The proxy now names a SHA-256 of the page in `Spool-Artifact`, and the worker keeps the page it already received when its own hash matches. The reading records the requests and bytes at the origin from the first controlled visit to the first strict local view, in Chromium on loopback, with {{value:fpRounds}} rounds per arm that came out identical (L1). The bytes are uncompressed counts of a synthetic page, so they show the shape of the saving and not its size.

{{table:first-payload}}

A template route can carry its artifact in the page with `inlineMaxBytes`. That saves the artifact request and nothing else, since the route loads once either way, and every network view of the page carries the element whether a worker was there to use it. It is off by default.

For a proxied page the first lever removes {{value:fpOriginFetchesSaved}} origin page fetch and one document transfer from each cold visit. At the median document of the headline ({{value:revisitBytesInput}} B) that is {{value:fpLeverOneJ}} J (L2: the transfer at the SWD v4 rate plus one origin request). No reading says how many visits are cold.

## Next-Page Prediction

The catalogue ships the data of pages a visitor may open next when the share expected to open them repays the entry. This reading replays MSNBC (UCI dataset 133, CC BY 4.0): the ordered page categories of 989,818 visitors over one day in 1999, a median of 2 pages each. Visitors with an odd index are scored and the others build the counts. A scored step is a first view, a page the visitor had not opened, since a page already opened is held without a prediction ({{value:replayFirstSteps}} first views). Categories stand in for route classes, and the data has no URLs. Each arm provisions a candidate when its net joules are positive at a lower confidence bound of 1.28. Hits and provisions are counts (L1). Joules are L2 over three entry sizes: 473 B, a measured rendered-field entry; 2,048 B; and a 17,054 B document.

{{table:nav-replay}}

Whether the probabilities themselves are right is a separate question from whether the decisions pay. Each scored step bins every page the visitor had not opened by the probability an arm gave it, and the last column is how often that page came next.

{{table:nav-calibration}}

The all-views share (`population-1`) is over-confident exactly where decisions are made: in the 0.20 to 0.40 bin it gave {{value:replayOverconfident}} and the page came next {{value:replayOverconfidentSeen}} of the time. The cause is that it counts returning visits, and a visitor who has already opened a page is far more likely to return to it than one who has not, while an entry goes only to devices that have not. `population-first` counts only first views of the page, over every view from the page, and is calibrated or slightly conservative in the bins it fills. It earns more per provisioned kilobyte than either other arm at 473 B, and it provisions nothing at 2,048 B, so it nets less in total there. `nextShare(views, from, { first: true })` computes it from the sink.

A first-order model over the population's counts earns more per provisioned kilobyte than the most popular page at 473 B and 2,048 B, and at 2,048 B the most popular page loses joules. Under a byte cap per catalogue that is the figure to rank by; without a cap, the most popular page provisions more entries and nets slightly more in total at 473 B. No arm provisions a whole document at a gain. Models that add each visitor's own history match the population model exactly, because a visitor here opens two pages. The data cannot show whether history over many days helps, so spool has no device-side learner. `NavModel` and the net rule are in `@drupflare/spool/protocol` for a site to train on its own telemetry.

## Savings Today and at Maximum

The proxy has four byte-saving levers beyond the trim: converting JPEG and PNG to WebP under a width ceiling, deferring video, replacing embeds with a facade, and sending new CSS and JavaScript aggregates against text the browser already holds. This section sizes each one on a first view of a page, with the median first, then the mean. Every byte figure is L1 (a crawl or a Chromium coverage run). Every joule figure is L2: those bytes at the Sustainable Web Design v4 rate of {{value:swdTotal}} kWh/GB, with no origin term, since a smaller file is the same request.

Two corpora carry the figures and they are never added together. The image-crawl corpus is {{value:ledgerCrawlPages}} desktop pages on {{value:ledgerCrawlSites}} public sites, each loaded with an empty cache (reading `measurements/image-crawl`). The trim corpus is {{value:ledgerTrimPages}} internal pages on {{value:ledgerTrimSites}} Drupal sites of the trim reading, which is where the aggregate churn was measured. A page's saving is the sum of its levers, and a site's figure is the mean over its pages.

{{table:ledger-levers}}

Images are the one lever with a median page above zero. Resizing, video, embeds and the trim reach a minority of pages, so their median page is at or near zero, and a few image-heavy or embed-heavy pages carry every mean. The share of pages with any saving and the median site describe the typical case. The mean is the figure to multiply by a view count.

The dictionary row is a ceiling. It compresses each new aggregate against the concatenated text of every earlier page (the last 1 MiB), which a browser does not hold: it holds the dictionaries the server marked, and it sends one of them. The row says what the repeated bytes in new aggregates are worth, and nothing about how many of them a real dictionary choice recovers.

The {{value:dictFiles}} new files of {{value:dictSites}} Drupal sites in the dictionary-size reading (the home page and four internal pages of each, same-origin CSS and JavaScript, bytes only, L1) show how much of that ceiling a real choice recovers. Every arm is measured against brotli 11 alone, and a file that gains nothing goes out plain.

{{table:ledger-dictionary}}

A browser that picks the latest earlier file of the same directory saves {{value:dictBrowser}} at the median site with `dcz`. A server that marks one base file per directory saves {{value:dictVisit}} on a first visit, because the base has to be fetched before it can serve as a dictionary. For a visitor whose browser already holds the base it saves {{value:dictOut}}, with the base chosen without the page measured, and {{value:dictHeld}} with it. The oracle saves {{value:dictOracle}} and no browser reaches it. How many visitors hold a base is an L3 scenario that no reading here measures. A selector pays only where the base is still in the browser: it has to have been fetched, not evicted, and unchanged since. The table mixes the two measured arms at a share of visitors who hold it, a scenario over L1 bytes, so it brackets a deployed saving and does not predict one.

{{table:dictionary-retention}}

{{table:ledger-first-view}}

The first-view saving applies to a network view of a page the visitor has not seen. The share of views that are such views is the L3 input of the trim section, and the table below runs it at its three values. The table gives each figure as kWh per million views, the unit of Unit and Scope, at the three shares. The mix is the corpus named in each row, with the cold-view share as the L3 input.

{{table:ledger-intensity}}

Local views add a second ceiling that does not depend on any lever above: a local view replaces the whole repeat view if every file in it is answered locally. The median whole repeat view is {{value:ledgerWholeKb}} ({{value:ledgerWholeJ}} J, L2). An optimized HTTP cache already keeps the static files of a repeat view, so most of that figure is the baseline fix's saving and not spool's. It is the upper bound on what a local repeat view could remove.

{{table:ledger-repeat}}

### Metered Figures Beside the Ledger

The ledger above is attributional (L2): bytes at a fixed rate. The table below holds meter readings (L1) of what individual steps cost the machine that runs them. They come from the package counter of paisley-park, a Ryzen 9 9900X, and from the iPhone battery gauge for the phone row. They leave out the display, the network and every machine between the two ends, so they do not add to the ledger and are not a second way to compute it. Each cell is the median of the kept windows with the minimum and maximum in brackets, in joules or watts above the idle draw of the same round unless the row says package watts.

{{table:ledger-metered}}

A window is dropped when other containers on the host used more than 100 ms of CPU per second of it. In the image-encode reading {{value:encodeDropped}} of its windows were dropped, in image-decode {{value:decodeDropped}}, and in dictionary-load {{value:dictLoadDropped}}. The rule sees only containers. It missed a container that started inside a window until the rig was changed to count one from zero, and it never sees a host process.

Format-only WebP does not lower decode energy. Through `createImageBitmap`, a WebP at its native size cost {{value:decodeBitmapNative}} times the energy of the original JPEG or PNG, and the WebP resized to the rendered width cost {{value:decodeBitmapResized}} times. Through an `<img>` shown at its CSS width the native WebP was {{value:decodeImgNative}} times the original ({{value:decodeImgNativeText}}), and the resized WebP {{value:decodeImgResized}} times ({{value:decodeImgResizedText}}). That arm waits two animation frames per image and takes {{value:decodeImgMs}} ms an image against {{value:decodeBitmapMs}} ms for the bitmap path, so most of its window is frame waiting and its variants differ by less. The byte saving of a format-only conversion therefore comes with a decode cost on the pure decode path, and the decode figure favours WebP only for a file that was also resized. All of this is the {{value:decodeImages}} crawled images of the set, {{value:decodeRounds}} rounds, one Chromium on one desktop.

Converting an image costs {{value:encodeWarm}} J with the module loaded (about {{value:encodeWarmMs}} ms of one busy thread, {{value:encodePerMb}} J per MB of input over a set of {{value:encodeImages}} images, {{value:encodeRounds}} rounds). A fresh Node process per pass costs {{value:encodeCold}} J, {{value:encodeColdOver}}% more. Resizing to the rendered width first costs {{value:encodeResized}} J. The proxy caches each result, so a conversion is paid once per image and variant. On the meter alone, the decode saving of an `<img>` repays a conversion after {{value:encodeBreakEvenResized}} views at the rendered width and {{value:encodeBreakEvenNative}} at native size (the conversion's joules over the original's decode joules less the variant's). That counts the device and the proxy and leaves the network out, which has no metered figure. One kilobyte moved is {{value:transferJPerKb}} J at the SWD v4 rate (L2), more than the decode saving of a view, so the proxy converts every image it can.

A visible page with no timers drew {{value:activityQuietExtra}} W above the idle of its round. A once-a-second poll to a local endpoint added {{value:activityPoll}} W and a `requestAnimationFrame` loop moving one box added {{value:activityRaf}} W ({{value:activityRafMinute}} J a minute). {{value:activityRoundsText}}

{{value:activityHookText}}

{{value:activityHiddenText}}

{{value:dictLoadText}}

{{#idle-activity-tabs}}

### Tabs and Hidden Polls

A page that polls costs more when the browser holds more tabs, and a poll in a tab hidden for a long time may cost a different amount again. This reading ran in one headed Chromium on one desktop, under a virtual display. Each row is one window of {{value:tabsWindowS}} seconds, and the long hidden window is {{value:tabsLongWindowS}} seconds, over {{value:tabsRounds}} rounds. The idle draw ran at {{value:tabsIdleRange}} W. {{value:tabsDropped}} windows were dropped for contamination from other containers, and {{value:tabsUnmatched}} three-tab windows had no quiet window in their round to net against.

{{table:idle-activity-tabs}}

The two three-tab polling arms are netted against the three-tab quiet arm of their round. The one-tab and hidden arms net against the idle draw alone, because the rig has no quiet arm of their own. The ratio to one tab therefore compares a netted figure with one that still carries one open tab. The three-tab poll costs {{value:tabsRatioLeader}} times the leader arm and {{value:tabsRatioPoll1}} times the one-tab control.

The leader is written into the rig's page. spool ships no leader election. The tab that holds the Web Lock polls and posts each result on a BroadcastChannel, and the two other tabs only listen. The window counts the polls each tab sent and the messages each received. The lock holder sent a median of {{value:tabsLeaderPolls}} polls a window, and the tabs together received a median of {{value:tabsLeaderMessages}} messages. A poll from a tab without the lock stops the run.

The hidden tab waited {{value:tabsHiddenMin}} seconds after it was hidden before its window opened, which is past the five minutes at which Chromium starts intensive throttling. In that window it sent {{value:tabsLongPings}} origin requests a minute.

The reading covers one browser on one machine. Its rows hold raw quantities, and the per-minute figures and ratios are derived from them (L2). It changes no input in `src/report/inputs.ts`. The retake rule in `scripts/impact.ts` (`ORIGINAL_RAPL`) does not list this experiment, because it has no earlier reading.

{{/idle-activity-tabs}}

### Lazy Loading Before the First Scroll

Lazy loading changes when an image loads, so its saving exists only for a visit that does not scroll. The crawl loaded pages twice, once as the origin sent them and once with `loading="lazy"` added by the proxy's rewrite. Both loads went through the same Playwright route, so neither had a browser cache. The columns are image bytes requested before the first scroll. This is not part of the tables above, which count bytes any visitor receives. The first rows are the first crawl, with the first rule and `skip` 2. The other rows are three later crawls of up to five pages per site, one per `skip`, with the rule that also leaves an image with `fetchpriority`, one that a preload link names and one inside a `<header>`.

{{table:ledger-lazy}}

The last column counts pages where the rewrite put `loading="lazy"` on the element the browser reported as the largest contentful paint, and the origin had not. Any count above zero is a page whose load the rewrite can slow, so the option stays off by default. {{value:lazyVerdict}}

## How the Figures Are Made

Every number on this page comes from a reading in [`measurements/`](../measurements/README.md) or from an input in `src/report/inputs.ts`. `bun run impact` regenerates the page from those, and `bun run impact:check` fails when the committed page differs from what the readings produce. Edit `docs/impact.src.md`, never `docs/impact.md`.

Two channels carry the energy numbers. The capacity channel is the ceiling: what an institution reaches when it acts on the numbers and removes servers, at {{value:serverYear}} MWh per retired server-year. It counts only when equipment is actually removed. The per-view figures in the views channel are floors. They are measured, and the work is to raise them.

Tiers on this page are relative to an institution's own views. The tables give energy per million views, so no table depends on a traffic assumption. Only the Institution blocks use yearly view counts, because those counts are their scenario inputs.

### Measurement Labels

Each figure carries one label, and a derived figure keeps its label wherever it travels.

| label | meaning                                                     |
| ----- | ----------------------------------------------------------- |
| L0    | published by someone else, with its source named            |
| L1    | measured here, on the hardware the reading's file describes |
| L2    | derived: arithmetic over L0 and L1 figures                  |
| L3    | a scenario: an assumption, or a what-if no reading backs    |

A figure that mixes an L2 product with an L3 term is L3 as a whole. The {{value:headlineJ}} J headline is L2, and the table that builds it says so.

### Accounting Quantities

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

### Traffic Measures

Three measures feed three different benefits.

| measure       | definition                                                                               | drives                                                 |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Z_annual`    | strict zero-network local views over all views, per year                                 | the views channel                                      |
| `Z_daily`     | the same per day, net of the sync and flush requests spool itself sends                  | the Workers free-tier ceiling                          |
| `Z_peak_work` | origin work avoided over origin work without spool in the busiest intervals, by CPU time | whether fewer servers meet the same throughput and SLO |

The code is in `src/report/traffic.ts`. `Z_annual` names the tiers: Meaningful at 30%, Major at 65% and Transformative at 90%. `scripts/measure/traces.ts` turns an institution's server-work trace into the intervals `Z_peak_work` reads.

### Views Channel

The channel's energy is `E_views = V x Z_annual x J_view`, where `V` is the institution's yearly views and `J_view` is the joules one local view avoids. Two `J_view` figures exist, and the page always prints both. Both are floors: they count what a meter or a published model attributes to a view today, and the work is to raise them.

#### Attributional Headline

{{value:headlineJ}} J per local revisit view is the attributional figure. It applies the Sustainable Web Design v4 intensities (network, data centre and device, {{value:swdTotal}} kWh/GB together) to the bytes of the document request a local view replaces, then adds an origin request. The radio-wake term is 0 J until a phone reading attributes a wake to a network view (see the cellular reading under Measured Readings).

{{table:headline}}

Every term counts as energy that goes away when the view makes no request, the same sense drupflare's own impact page uses. The figure is an allocation of a published model over measured bytes. No meter read it.

A default local view replaces one request, the page's document. The model prices that request: {{value:revisitBytesInput}} B, the median repeat-view document over every repeat-navigation reading ({{value:revisitViews}} views from {{value:revisitReadings}} readings). The rest of a repeat view is left out. An optimized HTTP cache already keeps a site's static files, so those bytes are the baseline fix's saving and not spool's. The page's own API calls and every third-party request still leave the browser during a local view, unless the site declares `data` routes or turns on the third-party cache. For scale, the whole repeat view's median is {{value:revisitWholeMedian}} B, and the latest reading's median is {{value:revisitRequests}} network requests over {{value:revisitSites}} sites. Every site read so far is under Per-Site Figures.

### Counting Rules

1. The attributional headline already holds a data-centre term (SWD v4's {{value:dataCentreJ}} J of the bytes term). Where a workload's origin joules were measured, they replace that term and the modelled origin request. They never add to the headline.
2. The meter-visible figure is the part of the headline spool controls directly. The origin-term figures break the headline down. They do not add to it.
3. Origin-term and power-state joules on a node that is later retired sit inside that node's retired {{value:serverYear}} MWh. Subtract them from the views and retained-node figures for that node.
4. A projection view reports server joules removed, device joules added and provisioning bytes, per device class. Only the net is credited.
5. Network hardware stays out of the measured savings. The {{value:headlineJ}} J headline still carries SWD's network term ({{value:networkJ}} J of the bytes term), and that term is attributional: a published per-byte intensity applied to measured bytes. It is not a measurement of any router, and network energy is not proportional to data volume (Mytton, Lunden and Malmodin 2024, abstract only). One institution's traffic is a small share of any operator node's load, so no causal tie to an operator's power state can be shown from it.
6. Every figure keeps its label. Hyperscale per-request figures are never printed as spool savings.
7. Embodied energy is a separate kgCO2e line.

### Evidence Behind the Design

Each finding forced a mechanism in code. Labels give what was read: full text, abstract only, or a web page.

| finding                                                                                                                                                                                                                   | source (label)                                    | mechanism                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| On 10 of 25 sites a page rendered from cache used 6.8% to 40.5% of the networked load's energy; on the other 15, dynamic script and style requests could not be cached, and the paper names Google Analytics as one cause | Thiagarajan et al., WWW 2012 (full text)          | batched analytics in `src/sw/analytics.ts`; zero requests per view as the target            |
| 92% of HTML tags were identical across loads 12 hours apart, 75% across a week                                                                                                                                            | Mardani et al., Fawkes, NSDI 2020 (full text)     | dependency-level sync and hard and soft freshness (`src/sw/freshness.ts`)                   |
| Safari deletes script-writable storage after 7 days without interaction                                                                                                                                                   | WebKit blog 10218 (full text)                     | a re-provision path and `P_warm` reported per engine                                        |
| Network, data centre and device intensities of 0.059, 0.055 and 0.080 kWh/GB                                                                                                                                              | Sustainable Web Design v4 (web page)              | the attributional headline in `src/report/inputs.ts`                                        |
| 43% of higher-education sessions are on phones, 2.3 pages per session                                                                                                                                                     | OHO 2023 benchmarks, 2022 data (web page)         | the mobile share and the session-entry view                                                 |
| A controlled navigation reaches the origin zero times in Chromium and Firefox with `updateViaCache: 'all'` and a one-day script lifetime                                                                                  | the zero-network reading (L1)                     | the registration in `src/client/register.ts`; the worker script served with `max-age=86400` |
| Cloudflare's analytics script posts to `/cdn-cgi/rum` about twice per navigation                                                                                                                                          | the views reading (L1)                            | beacon queueing in the worker                                                               |
| Firefox does not route `fetch` with `keepalive` through a service worker                                                                                                                                                  | a probe in the browser lane (L1)                  | a limit of the beacon queue in `src/sw/analytics.ts`: a keepalive post bypasses it          |
| WebKit re-fetches a page's cacheable subresources once on the first controlled navigation and routes subresources through the worker                                                                                      | a probe in the browser lane (L1)                  | the worker's asset cache and the per-engine zero-network tests                              |
| Page weight is dominated by new media; a revisit moves few bytes, and the browser still lists dozens of cached requests                                                                                                   | the repeat-navigation and on-wire readings (L1)   | the target is the transaction, so `Z_annual` counts views that make no request              |
| A server cache already removes recompute, and a projection relocates work                                                                                                                                                 | the compute readings (L1)                         | the strategies `assembly` and `template` first, and the projection net-of-relocation rule   |
| Median 0.24 Wh for a Gemini text prompt, including 10% provisioned idle and facility overhead                                                                                                                             | Elsworth et al., arXiv 2508.15734 (full text, L0) | such figures are never printed as spool savings                                             |

### Baselines

Spool's saving is credited against an optimized HTTP baseline: immutable hashed assets, ETag revalidation and compression. Fixing a site's own asset caching comes first and is not spool's credit. Other baselines it is compared with:

- **Compression Dictionary Transport (RFC 9842).** Shrinks bytes for repeat loads, but every view still makes a request.
- **Back-forward cache and Speculation Rules.** Make some navigations instant. A bfcache restore needs no request, and it covers only back and forward navigations in one session.
- **The Drupal PWA module.** Caches the shell, with no story for authenticated pages.
- **Fawkes-style patching.** Sends a patch against a stored template on each load, so it still makes one request per view.

## Measured Readings

### Desktop and Phone

The meter-visible part is smaller than the headline. These readings are the floor the engineering work has to raise.

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

{{#first-view}}

### First Views

The first-view mechanisms (images, video, scripts and facades) are credited at the attributional rate: the page's wire bytes times SWD v4's 0.194 kWh per GB (L2). The metered figure measures something else. It is the package energy a desktop browser spends on a cold first view of a recorded page, above the idle draw of the same round (L1 windows, L2 per page). This reading covers {{value:fvPages}} pages from {{value:fvSites}} sites, {{value:fvWireMb}} MB on the wire, over {{value:fvRounds}} rounds of {{value:fvNavs}} cold navigations per window. {{value:fvDropped}} windows were dropped for contamination from other containers.

{{table:first-view}}

On these pages the package spent {{value:fvRatioMean}} of the attributional figure on average, and the median page spent {{value:fvRatioMedian}}. The site means run from {{value:fvSiteMin}} to {{value:fvSiteMax}} over {{value:fvSiteCount}} sites. The ratio describes the pages measured here. It is not a correction factor for the allocation.

The class fit regresses each page's metered joules on its image, script and other bytes. It has {{value:fvFitN}} pages and a residual standard error of {{value:fvFitResidual}} J (L2). The shares below come from the point fit.

{{table:first-view-fit}}

The intervals in the next table are 95% bootstrap intervals over pages: 2,000 resamples of the pages with a fixed seed, and the 2.5th and 97.5th percentiles of the coefficients (L2).

{{table:first-view-uncertainty}}

The script coefficient is {{value:fvScriptCoef}} J per MB {{value:fvScriptCi}}, and the image coefficient is {{value:fvImageCoef}} J per MB {{value:fvImageCi}} (L2). {{value:fvOrdering}} Dividing one point estimate by the other gives a ratio that these intervals do not bound. Bytes alone explain {{value:fvBytesR2}} of the variance of the joules (R squared, total MB only; L2). {{value:fvRequestSentence}}

More rounds would not narrow these intervals much. Each page's figure is already a median over its rounds, and the intervals measure the spread between pages. Only more pages would narrow them.

demo.drupflare.com runs spool, so it is not a no-spool page. Without its pages, the median is {{value:fvNoDemoMedian}} J and the script coefficient is {{value:fvNoDemoScript}} J per MB {{value:fvNoDemoScriptCi}} (L2).

{{#first-view-facade}}
The facade arm serves the same pages with each YouTube or Vimeo iframe replaced by a link to the player, on the {{value:fvFacadePages}} pages where that rewrite changes the page. A facade saves {{value:fvFacadeSavedJ}} J per first view on average and {{value:fvFacadeSavedMedianJ}} J at the median, so a few pages carry the mean. It saves {{value:fvFacadeSavedKb}} KB of body bytes on average and {{value:fvFacadeShare}}% of the page's metered joules (L1 windows, L2 derived). {{value:fvFacadePages}} pages are too few to say how much a facade saves on a page that has an embed.
{{/first-view-facade}}

The desktop idle draw was {{value:fvIdleW}} W (median). {{value:fvMissedPages}} pages made requests the replay could not answer. The reading keeps them and lists them.

The metered figure covers the desktop package only. It excludes the network, the display and the data centre, so it is not a per-view energy for a visitor's device.
{{#first-view-warm}}

#### Repeat views

A repeat view is the second of two navigations to the same recorded page, in one browser context. The first navigation fills the HTTP cache and is not metered. The second is metered. It still parses, runs scripts, lays out and decodes; only the bytes can come from the cache. This reading covers {{value:wvPages}} pages over {{value:wvRounds}} rounds of {{value:wvNavs}} repeat navigations per window. It comes from one Chromium on one desktop, against the recorded pages replayed over loopback with no network latency. {{value:wvDropped}} windows were dropped for contamination from other containers.

{{table:first-view-warm}}

The HTTP cache is the only reuse in this measurement. Nothing in spool reuses execution today, so a repeat view is a ceiling for what reusing rendering or computation could save on a repeat visit, not a forecast. Restores from the back-forward cache are not measured.

The median page spent {{value:wvRatioMedian}} times its cold first view on the repeat view. Task time in a repeat navigation went to script ({{value:wvScript}}), layout ({{value:wvLayout}}) and style recalculation ({{value:wvRecalc}}), as medians over pages. The three can overlap, so they are not summed. {{value:wvRefetchPages}} pages ({{value:wvRefetchShare}}%) fetched more than half of their cold view's bytes again. The repeat navigations sent {{value:wvConditional}} conditional requests, and the replay answered {{value:wvNotModified}} with a 304. The replay keeps no ETag or Last-Modified, so the browser has no validator to send.

The M8 closure used a guess of {{value:wvM8Guess}} J per local view, which is {{value:wvM8KwhPerMv}} kWh per million views (L3). The guess was not measured. The measured repeat view averages {{value:wvJoulesMean}} J, which is {{value:wvKwhPerMv}} kWh per million views and {{value:wvVsGuess}} times the guess (L3). That is arithmetic on the desktop reading, not a saving. The decision on C10 is not made here.
{{/first-view-warm}}{{/first-view}}

### Server Runtimes

The same small site ran under spool 0.1 in four server runtimes on paisley-park, one container at a time, with Chromium on another machine reaching it over Tailscale. Each window was {{value:runtimeViews}} views. The server's package energy and its interface byte counters were read per window, less the idle window of the same round. The overlay interface carries the HTTP traffic; the physical interface adds the relay's framing, since this path went through a Tailscale relay in every round.

{{table:runtimes}}

A spool local view sent nothing to the origin in every window but one per runtime, and its server energy is inside the idle drift. The exception is the fourth spool window, which made up to {{value:runtimeFlushRequests}} requests to `/.spool/*` in every runtime. It ended about 15 minutes after the worker was primed, which is when the public routes' default soft bound expires: the timing matches one sync with the held view telemetry flushed on the same network moment (the rig counted `/.spool/*` requests, not their paths). That is spool's own overhead. The medians above leave it out, since it is one window in six; the measured per-view figure P8 reports nets syncs and flushes against the saving. A bare HTML request from curl costs the server more than a browser view, most likely because curl opens a new connection through the relay for each request while the browser reuses one.

One request per view is also what breaks the saving. A page that posts to an analytics endpoint on every view makes each view a network view again, with that request's bytes and origin work. On a 2012 3G phone that post also woke the radio (Thiagarajan et al.); this phone showed no wake for an isolated request. Spool queues those posts in the service worker and sends them on a network moment that happens anyway.

### Worker Request Cost

A closed-loop `fetch` of one 4,096-byte asset from a page, one request at a time, on paisley-park (L1, {{value:swRounds}} rounds, {{value:swRequests}} requests per window for the first three arms and a quarter of that for the two that reach the origin). Millijoules per request above idle:

{{table:sw-request}}

A worker answering from CacheStorage costs {{value:swExtra}} mJ ({{value:swExtraPct}}%) more per request than the browser's own cache, and {{value:swVs304}} mJ less than a loopback 304. The ranges of those two arms overlap. A worker that receives the event and answers nothing costs {{value:swPassExtra}} mJ more than the cache. For a URL the browser would revalidate on a share of views, a worker that answers it saves energy only when that share is above {{value:swBreakEven}}%, which is the worker's extra cost over the browser cache divided by the 304's extra cost over the same cache. A worker should answer a URL only when the browser would otherwise leave for the network on most views.

The meter reads the package of the browser and the co-located origin over loopback with no emulated latency. It excludes the radio, the network and every hop between. A 304 carries no body and costs the same here as a 200 with 4,096 bytes, so the wire's share is invisible to it. The loop keeps one core busy, so each figure is energy per request in a boosted state, and a sparse real load also pays wake costs this loop never sees. It measures a `fetch` from the page, and a browser's own favicon request may take a different path.

### Origin Term by Workload

The headline's origin term is modelled. For a view the origin would otherwise render, such as an authenticated view or a cache miss (a meaningful share of views), the measured origin joules for that workload replace SWD's data-centre term and the modelled origin request. They never add to the headline. Where a cache would have answered, the term is the cost of a cache hit, a fraction of a millijoule.

{{table:origin-term}}

Each origin figure is package energy above idle on paisley-park (L1, {{value:computeRounds}} rounds unless noted) against a synthetic CMS and enrollment database that each file describes. The per-view figure is L2 over the L3 radio term. A real origin's joules replace the origin column when they are measured.

#### Per-Request Cost

{{table:compute-server}}

The null route is the transaction floor: loopback HTTP, keep-alive, no body. A cache hit costs about as much as the floor. A CMS render costs {{value:cmsRenderRatio}} times a cache hit and the analytics page about {{value:analyticsRatio}} thousand times. Across the two recompute rows the rule of thumb is {{value:mjPerCpuMs}} mJ of package energy per busy CPU millisecond, for one boosted core in a closed loop. A shared and loaded server amortises idle power differently.

{{#drupal-render}}

#### A Drupal Render

These are the request costs of one real Drupal 11 site, served by PHP 8.5's built-in server in a container on paisley-park (L1). The site is generated: 300 article nodes with seeded text, two of 20 tags each, and the standard front page. Every request is anonymous. Each figure is the package energy of a window above the round's idle draw, per request, less the null route measured in the same round ({{value:drupalRounds}} rounds, {{value:drupalDropped}} windows dropped for contamination; L2).

{{table:drupal-render}}

An uncached render costs {{value:drupalUncachedJ}} J per request, the median over the three URL classes. The internal page cache answering the same URL costs {{value:drupalCachedJ}} J, so the uncached render costs {{value:drupalRatio}} times as much. The null route costs {{value:drupalNullJ}} J per request. The client and the connection pay that cost in every arm, so the null route is what the other arms are net of.

{{table:drupal-render-cache}}

The plan holds two figures for one uncached origin request: 15 mJ, from a synthetic Node template, and 30 J, an estimate for a Drupal invalidation render. This reading is {{value:drupalNear}}. Its uncached figure is {{value:drupalVs15mJ}} times 15 mJ, and 30 J is {{value:drupalVs30J}} times the uncached figure. Neither plan figure has been changed. One reading does not settle which one holds.

The render was measured on one machine, with one generated site. PHP's built-in server stands in for php-fpm, so nothing here measures php-fpm. The package's idle draw was {{value:drupalIdleW}} W (median over the rounds). The uncacheable share of a real site's requests is not measured here.
{{/drupal-render}}

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

- If every view were an uncached analytics read, the origin term would add up to {{value:analyticsCeiling}} kWh per million views (L3).
- At a CMS render's cost, a million avoided renders save {{value:cmsCeiling}} kWh.
- Model inference is the one class whose per-operation joules are large, and it counts only for model-derived results that repeat for identical authorised inputs. Free-form prompts rarely repeat.

The origin term is measured per workload against the origin's real baseline. It is close to zero where a server cache exists and it is net of device work a projection relocates.

### Third-Party Requests

A view is strict zero-network only when it makes no request at all, and the service worker can answer only same-origin requests. Most requests that leave the browser on the 16 sites of the on-wire reading go to hosts other than the page's own.

{{table:third-party}}

Spool's page runtime counts cross-origin loads per view (`crossOriginLoads`) and a view with any is not strict zero-network. WebKit also re-checks the worker script on some navigations, which `updateViaCache: 'all'` with a 24-hour script lifetime removes in Chromium and Firefox:

{{table:zero-network}}

### Free-Tier Ceiling

The Workers free plan carries {{value:freeTierViews}} views a month at one request per view. A local view removes that request from the platform, and the protocol syncs when it has something to learn. The ceiling is a request count, so it moves with the share of views that stay local and with how often spool syncs. The table assumes one sync for every 20 local views, an L3 ratio used for illustration only. The scheduler has no fixed interval.

{{table:free-tier}}

{{#avoidable-loops}}

### Loops in Real Pages

A hook that stops a page's loop helps only where the page keeps one running. The crawl loaded the home page of {{value:loopSites}} public sites and one inner page of each, each in a fresh browser context, and counted each page for 20 seconds in front and 20 seconds behind a second tab. {{value:loopPages}} pages loaded (L1). The shares are shares of pages loaded fresh, not of page views, and no traffic weighting applies. Each share has a Wilson 95% interval (L2).

{{table:loop-classes}}

The crawl ran on a machine its operator was using. The operator says the early part may have been disturbed and the second half should be clean. The reading records no per-window time or load, so the file cannot locate or measure any disturbance. Every window met the 18-of-20 visibility rule. The all-pages column is the pre-registered figure. The second-half column is a sensitivity check: the first half has {{value:loopFirstPages}} loaded pages and the second half has {{value:loopSecondPages}}. {{value:loopOverlap}} No result was dropped, and the crawl was not rerun.

The thresholds of each class are in the reading's method and were fixed before the crawl. A window counts only when its page was in the state it was recorded in for at least 18 of its 20 seconds. A class that needs a window that failed that test is marked not measured, not false.

Most loaded pages had at least one class in their front window, and the `any` row is that union. No page reached the hidden frame-loop threshold. In some hidden windows the page ran nothing at all, not even a one-second timer, while the same page had activity in front. The crawl cannot yet separate a stopped page from a quiet one, so the hidden rows may read low.
{{/avoidable-loops}}

{{#second-time-point}}

### Second Time Point

Some desktop experiments were run again on paisley-park on a later date. Each retake sits beside its original, with the percent difference of the two medians. The retake is a second time point on the same machine. It does not replicate the result independently. The headline figures elsewhere on this page stay on the original readings, and nothing here is averaged with them.

{{table:second-time-point}}
{{/second-time-point}}

## Per-Site Figures

The saving grows with the size of a site's document. Where the browser's own cache answered the document (a long `max-age` on the HTML), a local view has no request to replace and saves nothing. The headline is the typical site; an institution's own figure comes from its own pages and traffic. Every site read so far, lightest document first, with the attributional joules a local view of that page avoids. Sites that answered the rig with an error page instead of their home page are left out ({{value:blockedSites}}).

{{table:bytes-by-site}}

### What a Repeat View Moves

The `requests` run of the repeat-navigation rig kept every request of each site's home-page repeat view: its URL without the query string, whether it was same-origin (an exact origin match), its type, bytes, which cache answered it, and its cache headers. The document is the first Document request. Same-origin static is Script, Stylesheet, Font, Image and Media. Same-origin dynamic is every other same-origin request (XHR, Fetch, Ping, EventSource, Other and further documents). Third-party is any other origin, including an institution's own subdomains and media hosts, which is why one university's video host shows up there. Requests the browser cache answered carry no bytes and are left out. {{value:splitSites}} of {{value:splitSitesAll}} sites loaded their home page ({{value:blockedSites}} answered with a block page); the blocked page is listed and left out of every share.

{{table:split-by-site}}

The last column is a second figure per site and it is not spool's credit. A site that ships today with short cache lifetimes on its static files re-downloads them on every repeat view, and a local view would remove those bytes along with the document. The saving that comes from fixing the cache headers is the baseline fix's, not spool's against an optimized HTTP cache, so the headline stays on the document only. The column prices document plus same-origin static bytes at the same SWD v4 rate and a single origin request, so it is L2 over an L3 simplification: it does not count the origin work of each static request. Its median over the {{value:splitSites}} sites is {{value:shipsTodayMedianJ}} J, against {{value:headlineJ}} J for the document alone. Most of that gap sits at a few sites (the largest figure is {{value:shipsTodayMaxJ}} J), since a median site's same-origin static share of its repeat view is {{value:splitStaticMedian}}.

{{table:split-pooled}}

Pooled over all sites, the shares are {{value:splitDocumentShare}} document, {{value:splitStaticShare}} same-origin static, {{value:splitDynamicShare}} same-origin dynamic and {{value:splitThirdShare}} third-party, out of {{value:splitTotalBytes}} B. The two heaviest sites carry {{value:splitTopTwoShare}} of the pooled bytes, so the pooled static and third-party shares describe them more than a typical page. The median site's share is the better read of a typical page.

{{table:third-party-classes}}

{{value:splitUnknownShare}} of the third-party bytes come from hosts the table in `src/report/thirdparty.ts` does not know. The largest hosts, by bytes over all sites:

{{table:third-party-hosts}}

The classified origins move little: ad calls total {{value:splitAdsBytes}} B at {{value:splitAdsSites}} sites and analytics endpoints {{value:splitAnalyticsBytes}} B. The third-party report names what blocks zero-network by host; this table says what those hosts cost in bytes. Bytes are not the cost that matters for zero-network, which a single request of any size breaks.

{{table:repeat-nav}}

Bytes are what the browser received. Requests are the ones the browser sent to the network: a repeat view also lists dozens of sub-resources it answered from its own cache, and those are left out. The on-wire table sets a proxy's count of the same navigations beside the browser's.

### Third-Party Cacheability

Each third-party request of the home-page repeat view that reached the network is put in one class by its cache headers (L1, counts from the reading). `immutable` is an `immutable` directive or a `max-age` of a year or more. `long` is a `max-age` from a day to under a year. `short` is a `max-age` under a day, or no freshness with a validator. `uncacheable` is `no-store`, or neither freshness nor a validator. The class is computed from the recorded `cache-control` value and the presence of `etag` and `last-modified`. The reading keeps `expires` as a flag only, so it is not read.

The reading does not record whether a URL carried a version token, so the share of versioned files is unknown and is not estimated. The answerable bytes count every immutable or long response from a host the origin table calls cache-remedy, versioned or not. They are therefore an upper bound on what a worker could answer without an origin visit. Requests the browser cache answered are left out, as in the split above.

Shares are over the {{value:cacheWithThird}} of {{value:cacheSites}} sites whose repeat view had third-party network bytes (L2). The median site's share is immutable {{value:cacheImmutableMedian}}, long {{value:cacheLongMedian}}, short {{value:cacheShortMedian}} and uncacheable {{value:cacheUncacheableMedian}}.

{{table:third-party-cacheability}}

{{table:third-party-cache-shares}}

Answerable bytes per site, over every site, have a median of {{value:cacheAnswerableMedianBytes}} B and a mean of {{value:cacheAnswerableMeanBytes}} B. That is a median of {{value:cacheAnswerableMedianShare}} of a site's third-party bytes (L2), and {{value:cacheAnswerablePooledShare}} pooled. These are a ceiling, not a forecast. A worker answers only what its own store holds, and the reading does not show how often that store would hold these responses.

The origin classes and remedies come from the table in `src/report/thirdparty.ts`. They are not measured here.

{{table:third-party-cache-origins}}

## Dataset Patches

A dataset is a collection the server holds per row, such as a course catalogue or a staff roster. A device keeps the rows, and each update sends only the rows that changed. This section compares that patch with two controls: the held page under v0.3, which refetches the whole artifact on each change, and a plain HTTP resource that a browser cache revalidates with its ETag. The ship gate is v0.3.

The readings come from `measurements/dataset-baseline/2026-11-15.json`: synthetic rows, one machine, one run each. No real site has been measured. Every byte figure below is L1.

### Measured Bytes

Bytes are brotli for the v0.3 and v0.4 bodies. The native column is socket bytes, so it includes the HTTP headers: about 270 bytes on each 200 and 220 on each 304. The v0.3 list refetch is the control the gate uses. The records column is the records shape with `have`, a cheaper v0.3 variant at 50 rows; at 500 and 5,000 rows the server names at most 256 ids, so it still refetches most of the collection.

{{table:dataset-arms}}

The first load costs more under v0.4 than under v0.3 at 50 and 500 rows, and less than native at 50 rows. The v0.4 seed is the sum of the dataset's pages, so the rig counts every page of the 5,000-row seed.

{{table:dataset-seeds}}

### Break-Even

A seed is repaid when the bytes an update saves exceed the seed's extra bytes. At one changed row the seed is repaid after {{value:datasetRepayLow}} to {{value:datasetRepayHigh}} updates per device, across the three sizes. The number is per device over one hold, and a device needs at least that many updates within it to repay the seed.

{{table:dataset-breakeven}}

### What a Site Pays

A device holds one copy for {{value:datasetHold}} days (L3), then refetches the seed. A held copy answers the device's views, scaled by a return survival of {{value:datasetSurvival}} (L3). A patch or refetch is fetched at most once per answered view. The table prices one update that changes one row in a 500-row collection (L1 bytes), for three illustrative sites. The views are 2,000 a day across 400 devices, and each row carries the site's own update rate (L3). The joules use the allocation constant, 0.194 kWh/GB (L2). They are not a meter reading.

{{table:dataset-sites}}

The v0.4 patch sends fewer bytes than the v0.3 refetch in every row. The native column depends on how often the resource changes between views: a weekly roster sends almost only 304s, so the seed is the larger part of v0.4's cost there.

### Admission and the Model

The server's admission rule, `datasetBenefit` in `src/protocol/provision.ts`, counts views per copy from the prior: reuse times survival times future views. The site table counts views from traffic. The two agree on the arithmetic and differ on where the views come from. The server measures gzip for its seed size, and this reading uses brotli, so the decision inputs are not the reading's exact bytes. This section does not claim that the rule and the table reach the same decision at any site.

## Channels

Spool reports four channels side by side and never adds them. Metered figures are energy a meter read. Attributional figures spread a published intensity over bytes. Capacity counts nodes an institution stopped running. Avoided demand lists what stayed off the origin and the network, in its own units: bytes, requests and CPU time. A request removed at the device and so at the origin is one avoided transaction, counted once. A sum would mix a measurement with an allocation and count one removed request in more than one place, so the report type has no total and a test checks that.

The table shows the channels for one local view. Capacity has no per-view row, because it counts retired nodes over a period. The CPU and data-centre fields of avoided demand are empty until a reading prices them.

{{table:channels}}

## Capacity

This channel is the ceiling. It counts infrastructure an institution can stop running because spool lowers peak work, and an institution reaches it when it acts on the numbers and removes servers. It assigns no energy to an individual request. It is conditional and discontinuous: a fleet sized by peak throughput shrinks only when peak work falls far enough to retire a whole node, and the channel counts only when equipment is actually removed.

Spool reports it as three separate results, and any of them can read zero. A fourth entry, `observed`, records what production telemetry saw change in the same workload over one period, which is neither what the model says could change nor what was removed.

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

The effect is bounded by the node's whole above-idle energy. At three origin requests per network view it comes to {{value:powerStateKwhPerMv}} kWh per million views (L2 over an L3 request count). It is the retained-node part of this channel. A node is either retired, and counted once at its full retired energy, or retained, and counted once here, never both. The scheduler batches beacons and syncs for this reason as well as for the radio.

### Embodied Energy

Embodied energy is a separate line in kgCO2e, L3 until a retirement ledger exists. It covers a server or instance-year not bought because a measured drop in peak work let a refresh slip. It stays outside the MWh figures so one retired server is never counted twice.

### Shared Responsibility

drupflare removes fixed idle capacity: a site that ran on a provisioned server runs on Workers, and the capacity it kept idle goes away. Spool removes throughput work: requests and renders that never reach the origin. A provider sized by throughput downsizes when demand falls, so spool lowers demand and drupflare lowers the floor. The two counts do not overlap, and a capacity saving already realised by migration is not spool's. On drupflare the immediate benefit is Worker requests and execution avoided. Cloud-hosted origins show a smaller bill, and the provider's electricity is not established.

## What This Does Not Claim

Spool does not claim:

- that {{value:headlineJ}} J is a meter reading. It is an attributional allocation, and the meters read {{value:desktopSaving}} J on a desktop and {{value:phoneSaving}} J on a phone;
- a marginal kWh per GB;
- that one avoided request is one avoided radio wake;
- a capacity saving without evidence that equipment was removed, since a cloud-hosted origin shows a bill and the provider's electricity is not established;
- savings from a projection without its relocated device work and its provisioning bytes;
- that trimming adds to the headline. It saves bytes on a network view of an unseen page and nothing on a local or repeat view;
- that one institution's traffic moves a network operator's power state;
- a paced or cellular phone figure, which neither run has resolved;
- a dollar saving beyond the list-price arithmetic in Bandwidth and Request Costs, which leaves out free allowances, contract prices, staff time and plan tiers that do not scale with traffic.

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

The four metered readings of the savings section use the same runner. `image-decode` and `image-encode` read an image set that `image-crawl.ts` builds from a crawl run with `--save`. `dictionary-load` reads two aggregate files of one site that you supply, and `idle-activity` needs no input. Run the four one at a time on a quiet host.

```sh
bun scripts/measure/image-crawl.ts --save out/crawl-files
bun scripts/measure/image-crawl.ts set --from out/crawl-files --reading measurements/image-crawl/<date>.json --to out/set --count 40 --max-mb 25 --tinyimg <dir>
node scripts/measure/rapl.ts run idle-activity --raw out/idle-activity.jsonl --rounds 4 --window-s 300 --idle-s 60
node scripts/measure/rapl.ts run image-decode --raw out/image-decode.jsonl --images out/set --rounds 6 --passes 6 --idle-s 30
node scripts/measure/rapl.ts run image-encode --raw out/image-encode.jsonl --images out/set --tinyimg <dir> --rounds 6 --passes 3 --idle-s 30
node scripts/measure/rapl.ts run dictionary-load --raw out/dictionary-load.jsonl --dict-file <base> --target-file <target> --rounds 6 --navs 60 --idle-s 30
```

Each `run` is followed by a `publish` of the same name, as above. `<dir>` holds `node_modules/@gmitch215/tinyimg` at 1.1.1.

The vendor prices are inputs in `src/report/inputs.ts` with the date each page was read. Re-read the pages and edit those values to refresh the dollar tables.

`bun run impact:check` runs in CI and fails on any difference between the committed page and the readings.
