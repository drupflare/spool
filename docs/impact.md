# Impact Notice

Spool lets a visitor's browser answer a page view it has already seen, without asking the site. A local view removes the document request, the transaction that carries it and the server work behind it. The page's own API calls and every third-party request still leave the browser unless the site declares `data` routes or turns on the third-party cache.

This page says what that saves, how sure each number is and what it means in money. Every figure carries a label: L0 published by someone else, L1 measured here, L2 derived from L0 and L1, L3 a scenario. The sections after the notice show the readings and the arithmetic.

## What Spool Saves

The headline is 12.4 joules per local view (L2). It applies the Sustainable Web Design v4 intensities for the network, the data centre and the device to the 17,054 bytes of the document a local view replaces, then adds the origin's energy for one request. No meter read it.

Meters read less, because they leave out the network and every data centre between the two ends. Three readings sit beside the headline:

| where              | figure per view                     | label | what it covers                                                                                   |
| ------------------ | ----------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| Desktop            | saves 0.80 J                        | L1    | package energy of the browser, the origin and the service worker, against optimized HTTP caching |
| iPhone 14 Pro      | saves 0.088 J                       | L1    | the whole phone with the screen on, over Wi-Fi, against a network view                           |
| Server, 4 runtimes | a network view costs 0.61 to 0.98 J | L1    | package energy of the server, which a local view does not spend                                  |

On the server, a local view sent nothing in all but one window per runtime, and its measured energy (0.32 J at most, as a median) sits inside the idle drift. The ranges and the method are under Measured Readings.

Spool does not claim that the headline is a meter reading, a saving in radio wakes, a capacity saving without evidence that equipment was removed, or a figure for paced or cellular phone use. The full list is under What This Does Not Claim.

### A Worked Example

Take an institution with 100 million views a year, a scale chosen for the example that names no institution (L3). Spool's tiers name the share of those views that are local: Meaningful at 30%, Major at 65% and Transformative at 90%. The table gives the energy those local views avoid at each of the three per-view figures.

| tier           | Z_annual | attributional, 12 J | measured desktop, 0.80 J | measured phone, 0.088 J |
| -------------- | -------: | ------------------: | -----------------------: | ----------------------: |
| Meaningful     |      30% |           0.103 MWh |              0.00668 MWh |            0.000731 MWh |
| Major          |      65% |           0.223 MWh |               0.0145 MWh |             0.00158 MWh |
| Transformative |      90% |           0.309 MWh |               0.0200 MWh |             0.00219 MWh |

The attributional column is L2 over an L3 radio term. The two measured columns are L2: an L1 per-view figure times a view count and a tier share. One retired server-year is 3.80 MWh (L2), the unit to compare each cell with. Multiply a row by your own yearly views over 100 million.

## Bandwidth and Request Costs

A local view moves no document, so a host that bills traffic bills less. The bytes saved per local view are the document's median size, 17,054 B or 17.1 KB (L1, the same median the headline uses). The requests saved are one per local view. Per million local views that comes to 17.1 GB and one million requests.

Prices are each vendor's published list prices, read from the vendor's own page on 2026-10-19. Every input is L0 unless the table says L2, and every input's source is in `src/report/inputs.ts`. A price that could not be read from the vendor's page is left out.

| host                               | tier the price is taken from                                                             | egress price  | free egress a month | request price     | label           | vendor page, read 2026-10-19                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------- | ------------------- | ----------------- | --------------- | --------------------------------------------------- |
| Cloudflare Workers (Standard plan) | Standard plan, requests past the included 10 million a month                             | $0 per GB     | no egress charge    | $0.30 per million | L0, requests L0 | developers.cloudflare.com/workers/platform/pricing  |
| AWS CloudFront (pay as you go)     | United States, Mexico and Canada; the next 9 TB after the first free 1 TB                | $0.085 per GB | 1,000 GB            | $1.00 per million | L0, requests L2 | aws.amazon.com/cloudfront/pricing/pay-as-you-go     |
| Microsoft Azure                    | default routing from North America or Europe; the next 10 TB after the first free 100 GB | $0.087 per GB | 100 GB              | not read          | L0              | azure.microsoft.com/en-us/pricing/details/bandwidth |
| Google Cloud (Premium Tier)        | to North America, 1 to 1,024 GiB a month, per GiB                                        | $0.12 per GiB | 1 GiB               | not read          | L0              | cloud.google.com/vpc/network-pricing                |

Egress is priced at the first paid tier of each host. A free allowance is used up by everything the site serves, not by the bytes spool removes, so for a site whose total traffic is past the allowance the saving comes off at the paid rate. A site large enough to reach a host's later tiers pays a lower rate per GB there, so for it these figures are the high end. A site that serves less than its allowance in total saves nothing in dollars. A GiB is 2^30 bytes and a GB is 10^9.

| host                               | bytes no longer moved | egress | requests | total |
| ---------------------------------- | --------------------: | -----: | -------: | ----: |
| Cloudflare Workers (Standard plan) |               17.1 GB |     $0 |    $0.30 | $0.30 |
| AWS CloudFront (pay as you go)     |               17.1 GB |  $1.45 |    $1.00 | $2.45 |
| Microsoft Azure                    |               17.1 GB |  $1.48 | not read | $1.48 |
| Google Cloud (Premium Tier)        |              15.9 GiB |  $1.91 | not read | $1.91 |

The dollar figure is small. A million local views save between $0.30 and $2.45 at these list prices. Scaled to the institution above:

| host                               | Meaningful, 30M local views | Major, 65M local views | Transformative, 90M local views |
| ---------------------------------- | --------------------------: | ---------------------: | ------------------------------: |
| Cloudflare Workers (Standard plan) |                $9.00 a year |             $20 a year |                      $27 a year |
| AWS CloudFront (pay as you go)     |                  $73 a year |            $159 a year |                     $220 a year |
| Microsoft Azure                    |                  $45 a year |             $96 a year |                     $134 a year |
| Google Cloud (Premium Tier)        |                  $57 a year |            $124 a year |                     $172 a year |

At the Transformative tier that is $27 to $220 a year across these hosts. The bytes and requests behind it, a month at a time:

| tier           | local views a year | local views a month, requests no longer sent | bytes no longer moved, GB a month |
| -------------- | -----------------: | -------------------------------------------: | --------------------------------: |
| Meaningful     |         30 million |                                  2.5 million |                                43 |
| Major          |         65 million |                                  5.4 million |                                92 |
| Transformative |         90 million |                                  7.5 million |                               128 |

The same rule holds for requests. Cloudflare Workers and CloudFront each include 10 million requests a month, and that allowance is used by all of the site's requests. Past it, each request spool removes saves the request price in the table.

Two more hosts publish traffic terms that this page cannot turn into dollars. Pantheon bills overage at $40 for each 10,000 unique visits, counting an IP address and user agent once over 24 hours; the page carries a notice that the automated overage program is paused. A visit is a different unit from a view, and no reading here says how many visits spool removes, so no Pantheon figure is derived. Acquia's pricing page lists no traffic or bandwidth price, so Acquia is left out.

The money above does not include:

- staff time spent on the site or on the migration;
- plan tiers that do not scale with traffic, such as a flat hosting plan, which gets cheaper only when traffic falls under a tier boundary;
- request fees at hosts where none was read (Azure and Google Cloud above);
- the origin's compute and the servers behind it, which the Capacity section treats;
- the requests spool sends itself. The table counts one request avoided per local view and does not subtract spool's syncs and flushes.

Cloudflare Workers bills a request only when a Worker runs. A site that serves its document from static assets makes no Worker request for it, and saves $0 in the Workers row. Prices are list prices. An institution's contract can differ from every number here.

## Asset Trimming

The proxy can serve a site's stylesheets with the rules that no page of the site can match removed. This is a separate channel from the 12.4 J headline. The headline is what a local view saves, and a local view fetches no stylesheet. Trimming applies to a network view of a page the visitor has not seen. A repeat view saves nothing from it, since an optimized HTTP cache already keeps the file. The two do not add, and nothing in this section is part of the headline.

The saving has to happen where the file is served. A service worker cannot save bytes by trimming a file it already fetched. The proxy trims each file against every page and script of the site and never against one page, so the file keeps its URL and one cached copy, and only rules that match nothing in the crawl go. A build step that runs PurgeCSS with a safelist reaches the same saving. The proxy reaches it without a change to the origin.

JavaScript stays as it is. Coverage at load cannot see what a click or a scroll will need. Over 85 pages the used share of same-origin JavaScript rose from 36% at load to 40% after one scroll (L1), and no load-time measure can say which of the rest a visitor will run. CSS coverage stayed at 9% after the same scroll.

| same-origin files | used at load, median (quartiles) | used after one scroll, median (quartiles) |
| ----------------- | -------------------------------: | ----------------------------------------: |
| CSS               |                   9% (5% to 17%) |                            9% (5% to 17%) |
| JavaScript        |                 36% (26% to 47%) |                          40% (31% to 54%) |

### What the Trim Removes and Whether It Is Safe

The run crawled 85 pages on 10 Drupal sites, built one manifest per site from all its pages and the scripts they load, and fetched 303 stylesheets, of which the trim removed rules from 233 (L1). Four checks decide whether the trimmed files are safe to serve.

| check                    | what it counts                                                                                                                   | result                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle A, false removals | rules CDP marked used at load or after a scroll, over 85 pages, that the trimmed text lost                                       | 0 of 26,571 rule uses                                                                                                                                            |
| Oracle B, render         | full-page screenshots of 85 pages (0 failed): the trimmed CSS against the original, and the original against itself as a control | identical to the pixel on 62 pages, and 65 for the control; most differing pixels 934,285 trimmed and 838,405 control; trimmed differs and control does not on 4 |
| Leave-one-out, guard     | internal pages, each against a manifest built without it, where the guard fired                                                  | 33 of 75                                                                                                                                                         |
| Leave-one-out, Oracle A  | rules used on the 13 pages the guard let through, that the trimmed text lost                                                     | 0 of 3,643, on 0 pages                                                                                                                                           |

Oracle A reads CDP rule usage on the original CSS, at load and after one scroll, and counts the used rules the trimmed text lost. Oracle B screenshots each page at full height with the original CSS and again with the trimmed CSS, and counts the pixels that differ. The control is the original page screenshotted twice, so the pixels it differs by come from the page and not from the CSS. One screenshot of each arm is a small sample, and a page that differs in the trimmed arm and not in the control is not proof of a CSS difference. Leave-one-out rebuilds the manifest without the page, which is how a page the crawl missed would meet it.

### Bytes and Joules Saved

Each figure is the brotli-5 size of a stylesheet before and after the trim, summed over the files that were new to the visit, with the home page first. A first view of an internal page therefore counts only the files that a visit starting at the home page had not fetched. The home page row is the cold case. The proxy sends a decoded body and a host's edge compresses it, so the bytes are an estimate of transfer (L2). Joules apply the attributional 0.194 kWh/GB to those bytes (L2). A trimmed file is the same request, so there is no origin term.

| site               | home page, cold: bytes saved | home page, cold: joules | internal pages | first view: bytes saved, median (quartiles) | first view: joules, median (quartiles) | stylesheet bytes removed |
| ------------------ | ---------------------------: | ----------------------: | -------------: | ------------------------------------------: | -------------------------------------: | -----------------------: |
| demo.drupflare.com |                       6.8 KB |                    4.73 |              3 |                   0.0 KB (0.0 KB to 1.7 KB) |                          0 (0 to 1.16) |                      21% |
| www.asu.edu        |                      27.6 KB |                    19.3 |              8 |                27.6 KB (20.7 KB to 27.6 KB) |                    19.3 (14.4 to 19.3) |                      40% |
| www.yale.edu       |                      41.3 KB |                    28.8 |              8 |                36.2 KB (27.2 KB to 36.4 KB) |                    25.3 (19.0 to 25.4) |                      48% |
| www.colorado.edu   |                      39.1 KB |                    27.3 |              8 |                 19.1 KB (0.0 KB to 38.3 KB) |                       13.4 (0 to 26.8) |                      63% |
| www.uiowa.edu      |                      32.9 KB |                    23.0 |              8 |                32.9 KB (32.5 KB to 33.5 KB) |                    23.0 (22.7 to 23.4) |                      50% |
| www.tufts.edu      |                      13.5 KB |                    9.42 |              8 |                 10.3 KB (7.7 KB to 11.4 KB) |                    7.22 (5.39 to 7.94) |                      28% |
| www.unl.edu        |                       3.2 KB |                    2.22 |              8 |                   3.2 KB (3.1 KB to 3.5 KB) |                    2.20 (2.19 to 2.43) |                      49% |
| www.ucdavis.edu    |                      53.5 KB |                    37.4 |              8 |                 53.5 KB (0.0 KB to 53.5 KB) |                       37.4 (0 to 37.4) |                      61% |
| www.rutgers.edu    |                     106.9 KB |                    74.7 |              8 |                   0.0 KB (0.0 KB to 0.0 KB) |                             0 (0 to 0) |                      40% |
| www.mit.edu        |                      49.9 KB |                    34.9 |              8 |                   0.0 KB (0.0 KB to 0.0 KB) |                             0 (0 to 0) |                      67% |
| **Pooled**         | 36.0 KB (17.0 KB to 47.8 KB) |     25.2 (11.9 to 33.4) |             75 |                  3.2 KB (0.0 KB to 32.9 KB) |                       2.21 (0 to 23.0) |                      48% |

The typical first view of an internal page saves 3.2 KB and 2.21 J, and the mean is 15.2 KB and 10.6 J. The mean is the figure to multiply by a view count, since a few pages with large unused files carry the total.

### Per Million Views

The share of views that are network views of a page the visitor has not seen is an L3 input. It runs from 45% to 75%, and `src/report/inputs.ts` gives the source of each value and the one in between. A view counted here is a network view of an unseen page.

| views counted                                                           | bytes saved per view (mean) | joules per view (mean) | joules per million views | kWh per million views | label |
| ----------------------------------------------------------------------- | --------------------------: | ---------------------: | -----------------------: | --------------------: | ----- |
| cold view of a home page, over the network                              |                     37.5 KB |                   26.2 |             26.2 million |                  7.27 | L2    |
| first view of an unseen internal page, over the network                 |                     15.2 KB |                   10.6 |             10.6 million |                  2.95 | L2    |
| all views, 45% of them first views of an unseen internal page (low)     |                      6.8 KB |                   4.78 |             4.78 million |                  1.33 | L3    |
| all views, 60% of them first views of an unseen internal page (central) |                      9.1 KB |                   6.36 |             6.36 million |                  1.77 | L3    |
| all views, 75% of them first views of an unseen internal page (high)    |                     11.4 KB |                   7.95 |             7.95 million |                  2.21 | L3    |

Dollars use the rule of Bandwidth and Request Costs: the paid marginal rate at each host's first paid tier, which is the high end for a site large enough to reach a later tier. A free allowance is used up by everything the site serves, so a site under its allowance saves no dollars. Cloudflare Workers bills no egress and its row is $0.

| host                               |  egress price | per million first views | per million views, 45% first views (low) | per million views, 60% first views (central) | per million views, 75% first views (high) |
| ---------------------------------- | ------------: | ----------------------: | ---------------------------------------: | -------------------------------------------: | ----------------------------------------: |
| Cloudflare Workers (Standard plan) |     $0 per GB |                      $0 |                                       $0 |                                           $0 |                                        $0 |
| AWS CloudFront (pay as you go)     | $0.085 per GB |                   $1.29 |                                    $0.58 |                                        $0.77 |                                     $0.97 |
| Microsoft Azure                    | $0.087 per GB |                   $1.32 |                                    $0.60 |                                        $0.79 |                                     $0.99 |
| Google Cloud (Premium Tier)        | $0.12 per GiB |                   $1.70 |                                    $0.77 |                                        $1.02 |                                     $1.27 |

## Savings Today and at Maximum

The proxy has four byte-saving levers beyond the trim: converting JPEG and PNG to WebP under a width ceiling, deferring video, replacing embeds with a facade, and sending new CSS and JavaScript aggregates against text the browser already holds. This section sizes each one on a first view of a page, with the median first, then the mean. Every byte figure is L1 (a crawl or a Chromium coverage run). Every joule figure is L2: those bytes at the Sustainable Web Design v4 rate of 0.194 kWh/GB, with no origin term, since a smaller file is the same request.

Two corpora carry the figures and they are never added together. The image-crawl corpus is 70 desktop pages on 16 public sites, each loaded with an empty cache (reading `measurements/image-crawl`). The trim corpus is 75 internal pages on 10 Drupal sites of the trim reading, which is where the aggregate churn was measured. A page's saving is the sum of its levers, and a site's figure is the mean over its pages.

| Lever                                                                    | Corpus                | Pages with a saving | Median page      | Median of pages that save | Median site      | Mean               |
| ------------------------------------------------------------------------ | --------------------- | ------------------- | ---------------- | ------------------------- | ---------------- | ------------------ |
| WebP at native size under the 2560 px ceiling (images)                   | image-crawl, 16 sites | 59% of 70           | 65.5 KB (45.7 J) | 398.0 KB (278 J)          | 248.6 KB (174 J) | 1,211.8 KB (846 J) |
| Resize to the rendered width, Chromium with hints (images)               | image-crawl, 16 sites | 43% of 70           | 0.0 KB (0 J)     | 151.1 KB (105 J)          | 19.7 KB (13.8 J) | 206.8 KB (144 J)   |
| Video preload none, for videos that do not autoplay (video)              | image-crawl, 16 sites | 3% of 70            | 0.0 KB (0 J)     | 16.5 KB (11.5 J)          | 0.0 KB (0 J)     | 0.5 KB (0.330 J)   |
| Video autoplay deferred (video, option)                                  | image-crawl, 16 sites | 10% of 70           | 0.0 KB (0 J)     | 31.1 KB (21.7 J)          | 0.0 KB (0 J)     | 112.1 KB (78.3 J)  |
| YouTube and Vimeo facade, pages with no CSP (embeds, option)             | image-crawl, 16 sites | 9% of 70            | 0.0 KB (0 J)     | 3,076.1 KB (2,148 J)      | 0.0 KB (0 J)     | 276.9 KB (193 J)   |
| Trimmed stylesheets (trim, option)                                       | trim, 10 Drupal sites | 60% of 75           | 3.2 KB (2.21 J)  | 27.6 KB (19.3 J)          | 13.8 KB (9.61 J) | 15.2 KB (10.6 J)   |
| New aggregates against the text of earlier pages, a ceiling (dictionary) | trim, 10 Drupal sites | 80% of 75           | 94.9 KB (66.3 J) | 126.0 KB (88.0 J)         | 94.7 KB (66.1 J) | 131.6 KB (91.9 J)  |

Images are the one lever with a median page above zero. Resizing, video, embeds and the trim reach a minority of pages, so their median page is at or near zero, and a few image-heavy or embed-heavy pages carry every mean. The share of pages with any saving and the median site describe the typical case. The mean is the figure to multiply by a view count.

The dictionary row is a ceiling. It compresses each new aggregate against the concatenated text of every earlier page (the last 1 MiB), which a browser does not hold: it holds the dictionaries the server marked, and it sends one of them. The row says what the repeated bytes in new aggregates are worth, and nothing about how many of them a real dictionary choice recovers.

The 356 new files of 10 Drupal sites in the dictionary-size reading (the home page and four internal pages of each, same-origin CSS and JavaScript, bytes only, L1) show how much of that ceiling a real choice recovers. Every arm is measured against brotli 11 alone, and a file that gains nothing goes out plain.

| Dictionary choice                                                        | Coding          | Median site, share of brotli 11 bytes saved | All files | Median internal page | Internal pages saving over 5% |
| ------------------------------------------------------------------------ | --------------- | ------------------------------------------: | --------: | -------------------: | ----------------------------: |
| Oracle: the best earlier file of the same kind                           | dcz (zstd 19)   |                                       41.4% |     48.8% |              74.3 KB |                      27 of 29 |
| Oracle: the best earlier file of the same kind                           | dcb (brotli 11) |                                       42.0% |     49.7% |              74.6 KB |                      28 of 29 |
| Browser: the latest earlier file of the same directory                   | dcz (zstd 19)   |                                        2.0% |     27.2% |               1.0 KB |                       9 of 29 |
| Browser: the latest earlier file of the same directory                   | dcb (brotli 11) |                                        3.3% |     28.2% |               1.8 KB |                      13 of 29 |
| Server base, used once the visit has fetched it                          | dcz (zstd 19)   |                                        3.9% |     14.2% |               0.4 KB |                      14 of 29 |
| Server base, used once the visit has fetched it                          | dcb (brotli 11) |                                        5.1% |     14.3% |               0.4 KB |                      15 of 29 |
| Server base held from an earlier visit, chosen with the page measured    | dcz (zstd 19)   |                                       29.9% |     47.4% |              36.3 KB |                      22 of 29 |
| Server base held from an earlier visit, chosen with the page measured    | dcb (brotli 11) |                                       30.3% |     47.6% |              36.4 KB |                      23 of 29 |
| Server base held from an earlier visit, chosen without the page measured | dcz (zstd 19)   |                                       32.6% |     60.1% |              36.3 KB |                      24 of 29 |
| Server base held from an earlier visit, chosen without the page measured | dcb (brotli 11) |                                       32.8% |     60.3% |              36.4 KB |                      26 of 29 |

A browser that picks the latest earlier file of the same directory saves 2.0% at the median site with `dcz`. A server that marks one base file per directory saves 3.9% on a first visit, because the base has to be fetched before it can serve as a dictionary. For a visitor whose browser already holds the base it saves 32.6%, with the base chosen without the page measured, and 29.9% with it. The oracle saves 41.4% and no browser reaches it. How many visitors hold a base is an L3 scenario that no reading here measures.

| Corpus                | Figure      | Built levers         | With the dictionary ceiling |
| --------------------- | ----------- | -------------------- | --------------------------- |
| image-crawl, 16 sites | Median page | 227.6 KB (159 J)     | 227.6 KB (159 J)            |
| image-crawl, 16 sites | Median site | 517.6 KB (362 J)     | 517.6 KB (362 J)            |
| image-crawl, 16 sites | Mean        | 1,808.1 KB (1,263 J) | 1,808.1 KB (1,263 J)        |
| trim, 10 Drupal sites | Median page | 3.2 KB (2.21 J)      | 126.0 KB (88.0 J)           |
| trim, 10 Drupal sites | Median site | 13.8 KB (9.61 J)     | 114.6 KB (80.0 J)           |
| trim, 10 Drupal sites | Mean        | 15.2 KB (10.6 J)     | 146.7 KB (102 J)            |

The first-view saving applies to a network view of a page the visitor has not seen. The share of views that are such views is the L3 input of the trim section, and the table below runs it at its three values. Views are the two scales this page uses: 100 million and 420 million a year. One retired server-year is 3.80 MWh (L2), the unit to compare each cell with.

| Corpus                | First-view share (L3) | Figure      | Built, 100 million views (MWh) | Ceiling, 100 million views (MWh) | Built, 420 million views (MWh) | Ceiling, 420 million views (MWh) |
| --------------------- | --------------------- | ----------- | -----------------------------: | -------------------------------: | -----------------------------: | -------------------------------: |
| image-crawl, 16 sites | Low, 45%              | Median page |                           1.99 |                             1.99 |                           8.36 |                             8.36 |
| image-crawl, 16 sites | Low, 45%              | Median site |                           4.53 |                             4.53 |                           19.0 |                             19.0 |
| image-crawl, 16 sites | Low, 45%              | Mean        |                           15.8 |                             15.8 |                           66.4 |                             66.4 |
| image-crawl, 16 sites | Central, 60%          | Median page |                           2.65 |                             2.65 |                           11.1 |                             11.1 |
| image-crawl, 16 sites | Central, 60%          | Median site |                           6.03 |                             6.03 |                           25.3 |                             25.3 |
| image-crawl, 16 sites | Central, 60%          | Mean        |                           21.0 |                             21.0 |                           88.4 |                             88.4 |
| image-crawl, 16 sites | High, 75%             | Median page |                           3.31 |                             3.31 |                           13.9 |                             13.9 |
| image-crawl, 16 sites | High, 75%             | Median site |                           7.53 |                             7.53 |                           31.6 |                             31.6 |
| image-crawl, 16 sites | High, 75%             | Mean        |                           26.3 |                             26.3 |                            110 |                              110 |
| trim, 10 Drupal sites | Low, 45%              | Median page |                         0.0277 |                             1.10 |                          0.116 |                             4.63 |
| trim, 10 Drupal sites | Low, 45%              | Median site |                          0.120 |                             1.00 |                          0.506 |                             4.21 |
| trim, 10 Drupal sites | Low, 45%              | Mean        |                          0.133 |                             1.28 |                          0.558 |                             5.39 |
| trim, 10 Drupal sites | Central, 60%          | Median page |                         0.0368 |                             1.47 |                          0.155 |                             6.16 |
| trim, 10 Drupal sites | Central, 60%          | Median site |                          0.160 |                             1.33 |                          0.673 |                             5.60 |
| trim, 10 Drupal sites | Central, 60%          | Mean        |                          0.177 |                             1.71 |                          0.742 |                             7.17 |
| trim, 10 Drupal sites | High, 75%             | Median page |                         0.0460 |                             1.83 |                          0.193 |                             7.70 |
| trim, 10 Drupal sites | High, 75%             | Median site |                          0.200 |                             1.67 |                          0.841 |                             7.00 |
| trim, 10 Drupal sites | High, 75%             | Mean        |                          0.221 |                             2.14 |                          0.928 |                             8.97 |

Local views add a second ceiling that does not depend on any lever above: a local view replaces the whole repeat view if every file in it is answered locally. The median whole repeat view is 66.3 KB (46.3 J, L2). An optimized HTTP cache already keeps the static files of a repeat view, so most of that figure is the baseline fix's saving and not spool's. It is the upper bound on what a local repeat view could remove.

| Local share of views | Repeat-view ceiling, 100 million views (MWh) | Repeat-view ceiling, 420 million views (MWh) |
| -------------------- | -------------------------------------------: | -------------------------------------------: |
| Meaningful, 30%      |                                        0.386 |                                         1.62 |
| Major, 65%           |                                        0.837 |                                         3.51 |
| Transformative, 90%  |                                         1.16 |                                         4.87 |

### Metered Figures Beside the Ledger

The ledger above is attributional (L2): bytes at a fixed rate. The table below holds meter readings (L1) of what individual steps cost the machine that runs them. They come from the package counter of paisley-park, a Ryzen 9 9900X, and from the iPhone battery gauge for the phone row. They leave out the display, the network and every machine between the two ends, so they do not add to the ledger and are not a second way to compute it. Each cell is the median of the kept windows with the minimum and maximum in brackets, in joules or watts above the idle draw of the same round unless the row says package watts.

| Quantity                                              | Arm                                                                  |                   Median (min to max) | Windows                                       | Layer |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------: | --------------------------------------------- | ----- |
| J saved per local view against optimized HTTP caching | paisley-park desktop, Chromium                                       |  0.80 (difference of the arm medians) | 16 kept, 0 dropped                            | L1    |
| J saved per local view against optimized HTTP caching | iPhone 14 Pro, Wi-Fi, whole-phone counter                            | 0.088 (difference of the arm medians) | 3 rounds                                      | L1    |
| mJ per image decoded above idle                       | `createImageBitmap`, original JPEG or PNG                            |                   58.6 (57.0 to 62.8) | 6 kept, 0 dropped                             | L1    |
| mJ per image decoded above idle                       | `createImageBitmap`, WebP at native size                             |                   81.7 (79.5 to 88.1) | 6 kept, 0 dropped                             | L1    |
| mJ per image decoded above idle                       | `createImageBitmap`, WebP resized to the rendered width              |                   46.3 (45.8 to 47.2) | 6 kept, 0 dropped                             | L1    |
| mJ per image decoded above idle                       | `<img>` at its CSS width, original JPEG or PNG                       |                511.1 (458.5 to 526.6) | 6 kept, 0 dropped                             | L1    |
| mJ per image decoded above idle                       | `<img>` at its CSS width, WebP at native size                        |                487.3 (471.1 to 496.0) | 6 kept, 0 dropped                             | L1    |
| mJ per image decoded above idle                       | `<img>` at its CSS width, WebP resized to the rendered width         |                451.6 (420.9 to 456.7) | 6 kept, 0 dropped                             | L1    |
| J per conversion to WebP above idle                   | tinyimg 1.1.1, module loaded, native size                            |                   0.57 (0.56 to 0.58) | 6 kept, 0 dropped                             | L1    |
| J per conversion to WebP above idle                   | tinyimg 1.1.1, module loaded, rendered width                         |                   0.44 (0.44 to 0.45) | 6 kept, 0 dropped                             | L1    |
| J per conversion to WebP above idle                   | tinyimg 1.1.1, fresh Node process per pass, native size              |                   0.64 (0.63 to 0.65) | 6 kept, 0 dropped                             | L1    |
| J per MB of input above idle                          | tinyimg 1.1.1, module loaded, native size                            |                   6.94 (6.79 to 7.04) | 6 kept, 0 dropped                             | L1    |
| J per MB of input above idle                          | tinyimg 1.1.1, module loaded, rendered width                         |                   5.32 (5.26 to 5.42) | 6 kept, 0 dropped                             | L1    |
| J per MB of input above idle                          | tinyimg 1.1.1, fresh Node process per pass, native size              |                   7.74 (7.64 to 7.81) | 6 kept, 0 dropped                             | L1    |
| package W, no browser running                         | idle windows of the kept rounds (median per round, then over rounds) |                   18.6 (18.6 to 18.7) | 6 kept, 0 dropped, 6 more by the idle control | L1    |
| package W                                             | a quiet visible page                                                 |                   18.7 (18.6 to 18.7) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| package W                                             | a page polling a local endpoint once a second                        |                   19.2 (19.2 to 19.3) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| package W                                             | a requestAnimationFrame loop moving one box                          |                   22.4 (22.2 to 22.6) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| W above the idle of the same round                    | a quiet visible page                                                 |                  0.03 (-0.01 to 0.06) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| W above the idle of the same round                    | a page polling a local endpoint once a second                        |                   0.61 (0.45 to 0.76) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| W above the idle of the same round                    | a requestAnimationFrame loop moving one box                          |                   3.79 (3.53 to 4.05) | 2 kept, 0 dropped, 2 more by the idle control | L1    |
| mJ per page load above idle (one aggregate file)      | brotli 11, 432,066 B on the wire                                     |                769.4 (760.6 to 815.3) | 6 kept, 0 dropped                             | L1    |
| mJ per page load above idle (one aggregate file)      | dcz against a stored dictionary, 105,331 B on the wire               |                686.1 (633.4 to 741.5) | 6 kept, 0 dropped                             | L1    |

A window is dropped when other containers on the host used more than 100 ms of CPU per second of it. In the image-encode reading 0 of its windows were dropped, in image-decode 0, and in dictionary-load 0. The rule sees only containers. It missed a container that started inside a window until the rig was changed to count one from zero, and it never sees a host process.

Format-only WebP does not lower decode energy. Through `createImageBitmap`, a WebP at its native size cost 1.39 times the energy of the original JPEG or PNG, and the WebP resized to the rendered width cost 0.79 times. Through an `<img>` shown at its CSS width the native WebP was 0.95 times the original (its range overlaps the original), and the resized WebP 0.88 times (below every original window). That arm waits two animation frames per image and takes 33.3 ms an image against 1.8 ms for the bitmap path, so most of its window is frame waiting and its variants differ by less. The byte saving of a format-only conversion therefore comes with a decode cost on the pure decode path, and the decode figure favours WebP only for a file that was also resized. All of this is the 40 crawled images of the set, 6 rounds, one Chromium on one desktop.

Converting an image costs 0.57 J with the module loaded (about 20 ms of one busy thread, 6.94 J per MB of input over a set of 40 images, 6 rounds). A fresh Node process per pass costs 0.64 J, 12% more. Resizing to the rendered width first costs 0.44 J. The proxy caches each result, so a conversion is paid once per image and variant. How many views repay it needs a metered joule figure per byte transferred, which no reading here carries, so the page states no break-even.

A visible page with no timers drew 0.03 W above the idle of its round. A once-a-second poll to a local endpoint added 0.61 W and a `requestAnimationFrame` loop moving one box added 3.8 W (227 J a minute). Of 4 rounds, 2 are kept: in rounds 1 and 2 (numbered from 1) the three idle windows of the round disagreed by more than 25%. Across the 12 idle windows of the run the draw ran from 18.4 W to 67.6 W, and the CPU rule dropped 0 of them: other containers' CPU stayed near 15 ms a second throughout. The cause is not established. A second project's build container ran on the box during this run, and the rule could not see a container that started or stopped inside a window. Each activity figure therefore rests on 2 windows, one per kept round, and should be re-run on a quiet box before it is quoted beyond this page.

Chromium 151.0.7922.34 negotiates compression dictionary transport on the box: the page's request for the target carried Available-Dictionary, its Accept-Encoding listed dcb and dcz, and the origin answered dcz. The pair is two JavaScript aggregates of one Drupal site, a dictionary of 1,131,781 B and a target of 1,719,688 B. The target is 432,066 B on the wire as brotli 11 and 105,331 B as dcz, 76% fewer. A page load that fetched the target cost 769.4 mJ above idle as brotli and 686.1 mJ as dcz, 11% lower over 6 rounds of 60 loads (the dcz arm's range sits below the brotli arm's). The figure counts the browser's decode and the loopback transfer. It leaves out the network, and the server's encode, which this origin did once at start-up. The pair comes from the churned JavaScript aggregates, where the delta is large, so its byte saving sits above the 29.9% that the dictionary-size reading gives at the median site for a base the visitor already holds. One pair in one browser shows that dcz decode costs no more than brotli decode here. It says nothing about how many visitors hold a dictionary.

### Lazy Loading Before the First Scroll

Lazy loading changes when an image loads, so its saving exists only for a visit that does not scroll. The crawl loaded pages twice, once as the origin sent them and once with `loading="lazy"` added by the proxy's rewrite. Both loads went through the same Playwright route, so neither had a browser cache. The columns are image bytes requested before the first scroll. This is not part of the tables above, which count bytes any visitor receives. The first rows are the first crawl, with the first rule and `skip` 2. The other rows are three later crawls of up to five pages per site, one per `skip`, with the rule that also leaves an image with `fetchpriority`, one that a preload link names and one inside a `<header>`.

| Rule               | Profile          | Pages loaded twice | Median page before the first scroll, as sent | With the rewrite | Pages that loaded less | Median of those pages | Pages with an image as the largest element | Rewrite put lazy on that element |
| ------------------ | ---------------- | -----------------: | -------------------------------------------: | ---------------: | ---------------------: | --------------------: | -----------------------------------------: | -------------------------------: |
| skip 2, first rule | Desktop, 1440 px |                 43 |                                   1,334.1 KB |       1,334.2 KB |                    56% |               10.4 KB |                                         13 |                                0 |
| skip 2, first rule | Pixel 7          |                 43 |                                   1,372.5 KB |       1,102.8 KB |                    63% |               11.6 KB |                                         14 |                                1 |
| skip 2             | Desktop, 1440 px |                 70 |                                     983.4 KB |         935.8 KB |                    53% |                8.7 KB |                                         23 |                                2 |
| skip 2             | Pixel 7          |                 70 |                                     964.7 KB |         772.2 KB |                    54% |               11.3 KB |                                         20 |                                2 |
| skip 3             | Desktop, 1440 px |                 70 |                                     983.6 KB |         936.0 KB |                    59% |                8.6 KB |                                         23 |                                1 |
| skip 3             | Pixel 7          |                 70 |                                     965.0 KB |         761.1 KB |                    53% |               11.5 KB |                                         20 |                                2 |
| skip 4             | Desktop, 1440 px |                 70 |                                     983.6 KB |         936.0 KB |                    56% |                4.6 KB |                                         23 |                                1 |
| skip 4             | Pixel 7          |                 70 |                                   1,059.3 KB |       1,059.5 KB |                    63% |                7.0 KB |                                         20 |                                0 |

The last column counts pages where the rewrite put `loading="lazy"` on the element the browser reported as the largest contentful paint, and the origin had not. Any count above zero is a page whose load the rewrite can slow, so the option stays off by default. No value of skip tested reached zero on both profiles. Skip 4 left the fewest, 1 of 23 desktop pages and 0 of 20 Pixel 7 pages with the largest element made lazy, and skip 2 left 2 of 23 desktop pages and 2 of 20 Pixel 7 pages.

## How the Figures Are Made

Every number on this page comes from a reading in [`measurements/`](../measurements/README.md) or from an input in `src/report/inputs.ts`. `bun run impact` regenerates the page from those, and `bun run impact:check` fails when the committed page differs from what the readings produce. Edit `docs/impact.src.md`, never `docs/impact.md`.

Two channels carry the energy numbers. The capacity channel is the ceiling: what an institution reaches when it acts on the numbers and removes servers, at 3.80 MWh per retired server-year. It counts only when equipment is actually removed. The per-view figures in the views channel are floors. They are measured, and the work is to raise them.

Tiers on this page are relative to an institution's own views. The tables use 100 million views a year as a scale, an L3 choice that names no institution.

### Measurement Labels

Each figure carries one label, and a derived figure keeps its label wherever it travels.

| label | meaning                                                     |
| ----- | ----------------------------------------------------------- |
| L0    | published by someone else, with its source named            |
| L1    | measured here, on the hardware the reading's file describes |
| L2    | derived: arithmetic over L0 and L1 figures                  |
| L3    | a scenario: an assumption, or a what-if no reading backs    |

A figure that mixes an L2 product with an L3 term is L3 as a whole. The 12.4 J headline is L2, and the table that builds it says so.

### Accounting Quantities

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

12.4 J per local revisit view is the attributional figure. It applies the Sustainable Web Design v4 intensities (network, data centre and device, 0.194 kWh/GB together) to the bytes of the document request a local view replaces, then adds an origin request. The radio-wake term is 0 J until a phone reading attributes a wake to a network view (see the cellular reading under Measured Readings).

| term           | basis                                                                                                       | joules | label |
| -------------- | ----------------------------------------------------------------------------------------------------------- | -----: | ----- |
| Network        | SWD v4 0.059 kWh/GB over 17,054 B                                                                           |    3.6 | L2    |
| Data centre    | SWD v4 0.055 kWh/GB over the same bytes                                                                     |    3.4 | L2    |
| Device         | SWD v4 0.08 kWh/GB over the same bytes                                                                      |    4.9 | L2    |
| Origin request | a conventional origin, drupflare/worker docs/impact.md, RAPL mix @40 views/s, regular host, idle subtracted |  0.455 | L1    |
| Radio wake     | 0 J on 43% of views (phones), until a phone reading attributes a wake; 5 J was the earlier scenario value   |   0.00 | L1    |
| Total          | the sum of the rows                                                                                         |   12.4 | L2    |

Every term counts as energy that goes away when the view makes no request, the same sense drupflare's own impact page uses. The figure is an allocation of a published model over measured bytes. No meter read it.

A default local view replaces one request, the page's document. The model prices that request: 17,054 B, the median repeat-view document over every repeat-navigation reading (59 views from 4 readings). The rest of a repeat view is left out. An optimized HTTP cache already keeps a site's static files, so those bytes are the baseline fix's saving and not spool's. The page's own API calls and every third-party request still leave the browser during a local view, unless the site declares `data` routes or turns on the third-party cache. For scale, the whole repeat view's median is 66,343 B, and the latest reading's median is 32 network requests over 15 sites. Every site read so far is under Per-Site Figures.

### Counting Rules

1. The attributional headline already holds a data-centre term (SWD v4's 3.4 J of the bytes term). Where a workload's origin joules were measured, they replace that term and the modelled origin request. They never add to the headline.
2. The meter-visible figure is the part of the headline spool controls directly. The origin-term figures break the headline down. They do not add to it.
3. Origin-term and power-state joules on a node that is later retired sit inside that node's retired 3.80 MWh. Subtract them from the views and retained-node figures for that node.
4. A projection view reports server joules removed, device joules added and provisioning bytes, per device class. Only the net is credited.
5. Network hardware stays out of the measured savings. The 12.4 J headline still carries SWD's network term (3.6 J of the bytes term), and that term is attributional: a published per-byte intensity applied to measured bytes. It is not a measurement of any router, and network energy is not proportional to data volume (Mytton, Lunden and Malmodin 2024, abstract only). One institution's traffic is a small share of any operator node's load, so no causal tie to an operator's power state can be shown from it.
6. Every figure keeps its label. Hyperscale per-request figures are never printed as spool savings.
7. Embodied energy is a separate kgCO2e line.

### Evidence Behind the Design

Each finding forced a mechanism in code. Labels give what was read: full text, abstract only, or a web page.

| finding                                                                                                                                                 | source (label)                                    | mechanism                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A page rendered from cache with no network used 6.8% to 40.5% of the networked load's energy; one analytics request erased the saving on 15 of 25 sites | Thiagarajan et al., WWW 2012 (full text)          | batched analytics in `src/sw/analytics.ts`; zero requests per view as the target            |
| 92% of HTML tags were identical across loads 12 hours apart, 75% across a week                                                                          | Mardani et al., Fawkes, NSDI 2020 (full text)     | dependency-level sync and hard and soft freshness (`src/sw/freshness.ts`)                   |
| Safari deletes script-writable storage after 7 days without interaction                                                                                 | WebKit blog 10218 (full text)                     | a re-provision path and `P_warm` reported per engine                                        |
| Network, data centre and device intensities of 0.059, 0.055 and 0.080 kWh/GB                                                                            | Sustainable Web Design v4 (web page)              | the attributional headline in `src/report/inputs.ts`                                        |
| 43% of higher-education sessions are on phones, 2.3 pages per session                                                                                   | OHO 2023 benchmarks, 2022 data (web page)         | the mobile share and the session-entry view                                                 |
| A controlled navigation reaches the origin zero times in Chromium and Firefox with `updateViaCache: 'all'` and a one-day script lifetime                | the zero-network reading (L1)                     | the registration in `src/client/register.ts`; the worker script served with `max-age=86400` |
| Cloudflare's analytics script posts to `/cdn-cgi/rum` about twice per navigation                                                                        | the views reading (L1)                            | beacon queueing in the worker                                                               |
| Firefox does not route `fetch` with `keepalive` through a service worker                                                                                | a probe in the browser lane (L1)                  | a limit of the beacon queue in `src/sw/analytics.ts`: a keepalive post bypasses it          |
| WebKit re-fetches a page's cacheable subresources once on the first controlled navigation and routes subresources through the worker                    | a probe in the browser lane (L1)                  | the worker's asset cache and the per-engine zero-network tests                              |
| Page weight is dominated by new media; a revisit moves few bytes, and the browser still lists dozens of cached requests                                 | the repeat-navigation and on-wire readings (L1)   | the target is the transaction, so `Z_annual` counts views that make no request              |
| A server cache already removes recompute, and a projection relocates work                                                                               | the compute readings (L1)                         | the strategies `assembly` and `template` first, and the projection net-of-relocation rule   |
| Median 0.24 Wh for a Gemini text prompt, including 10% provisioned idle and facility overhead                                                           | Elsworth et al., arXiv 2508.15734 (full text, L0) | such figures are never printed as spool savings                                             |

### Baselines

Spool's saving is credited against an optimized HTTP baseline: immutable hashed assets, ETag revalidation and compression. Fixing a site's own asset caching comes first and is not spool's credit. Other baselines it is compared with:

- **Compression Dictionary Transport (RFC 9842).** Shrinks bytes for repeat loads, but every view still makes a request.
- **Back-forward cache and Speculation Rules.** Make some navigations instant. A bfcache restore needs no request, and it covers only back and forward navigations in one session.
- **The Drupal PWA module.** Caches the shell, with no story for authenticated pages.
- **Fawkes-style patching.** Sends a patch against a stored template on each load, so it still makes one request per view.

## Measured Readings

### Desktop and Phone

The meter-visible part is smaller than the headline. These readings are the floor the engineering work has to raise.

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

### Worker Request Cost

A closed-loop `fetch` of one 4,096-byte asset from a page, one request at a time, on paisley-park (L1, 8 rounds, 60,000 requests per window for the first three arms and a quarter of that for the two that reach the origin). Millijoules per request above idle:

| arm                                           | mJ per request above idle | microseconds per request | origin requests per request |
| --------------------------------------------- | ------------------------: | -----------------------: | --------------------------: |
| Browser cache (immutable, no worker)          |       14.0 (13.5 to 14.2) |                      273 |                           0 |
| Worker answers from CacheStorage              |       18.9 (18.9 to 20.0) |                      370 |                           0 |
| Worker receives the event and answers nothing |       17.2 (17.0 to 17.4) |                      338 |                           0 |
| Conditional request, 304                      |       19.3 (18.8 to 19.9) |                      377 |                           1 |
| Full 200, no-store                            |       19.0 (18.4 to 19.7) |                      365 |                           1 |

A worker answering from CacheStorage costs 4.9 mJ (35%) more per request than the browser's own cache, and 0.4 mJ less than a loopback 304. The ranges of those two arms overlap. A worker that receives the event and answers nothing costs 3.2 mJ more than the cache. For a URL the browser would revalidate on a share of views, a worker that answers it saves energy only when that share is above 93%, which is the worker's extra cost over the browser cache divided by the 304's extra cost over the same cache. A worker should answer a URL only when the browser would otherwise leave for the network on most views.

The meter reads the package of the browser and the co-located origin over loopback with no emulated latency. It excludes the radio, the network and every hop between. A 304 carries no body and costs the same here as a 200 with 4,096 bytes, so the wire's share is invisible to it. The loop keeps one core busy, so each figure is energy per request in a boosted state, and a sparse real load also pays wake costs this loop never sees. It measures a `fetch` from the page, and a browser's own favicon request may take a different path.

### Origin Term by Workload

The headline's origin term is modelled. For a view the origin would otherwise render, such as an authenticated view or a cache miss (a meaningful share of views), the measured origin joules for that workload replace SWD's data-centre term and the modelled origin request. They never add to the headline. Where a cache would have answered, the term is the cost of a cache hit, a fraction of a millijoule.

| workload                               | origin J per request | label           | J per local view |
| -------------------------------------- | -------------------: | --------------- | ---------------: |
| Modelled origin request (the headline) |                0.455 | L1, modelled    |  12.4 (headline) |
| Cache hit                              |             0.000717 | L1              |              8.5 |
| CMS render                             |               0.0151 | L1              |              8.5 |
| Analytics page                         |                 10.9 | L1              |             19.4 |
| Local 8B model request                 |                  286 | L1, GPU sampled |            294.5 |

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

### Third-Party Requests

A view is strict zero-network only when it makes no request at all, and the service worker can answer only same-origin requests. Most requests that leave the browser on the 16 sites of the on-wire reading go to hosts other than the page's own.

| navigation         | median proxy requests to other hosts | share of proxy requests | median bytes from other origins (direct run) |
| ------------------ | -----------------------------------: | ----------------------: | -------------------------------------------: |
| Cold home page     |                                 46.5 |                     63% |                                    1,777,317 |
| Warm internal page |                                 17.0 |                     63% |                                       15,936 |
| Home page again    |                                 26.0 |                     73% |                                       10,229 |

Spool's page runtime counts cross-origin loads per view (`crossOriginLoads`) and a view with any is not strict zero-network. WebKit also re-checks the worker script on some navigations, which `updateViaCache: 'all'` with a 24-hour script lifetime removes in Chromium and Firefox:

| registration                             | engine   | navigations | reached the origin | paths that did |
| ---------------------------------------- | -------- | ----------: | -----------------: | -------------- |
| default registration                     | chromium |          13 |                  1 | `/sw.js` x 1   |
| default registration                     | firefox  |          13 |                  4 | `/sw.js` x 4   |
| default registration                     | webkit   |          13 |                  3 | `/sw.js` x 3   |
| updateViaCache all, script max-age 86400 | chromium |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | firefox  |          13 |                  0 | none           |
| updateViaCache all, script max-age 86400 | webkit   |          13 |                  5 | `/sw.js` x 5   |

### Free-Tier Ceiling

The Workers free plan carries 3,040,000 views a month at one request per view. A local view makes no request, and the protocol syncs when it has something to learn. The table assumes one sync for every 20 local views, an L3 ratio used for illustration only. The scheduler has no fixed interval.

| tier           | Z_annual | views a month on the free plan |
| -------------- | -------: | -----------------------------: |
| Meaningful     |      30% |             4.25M (from 3.04M) |
| Major          |      65% |             7.95M (from 3.04M) |
| Transformative |      90% |            20.97M (from 3.04M) |

## Per-Site Figures

The saving grows with the size of a site's document. Where the browser's own cache answered the document (a long `max-age` on the HTML), a local view has no request to replace and saves nothing. The headline is the typical site; an institution's own figure comes from its own pages and traffic. Every site read so far, lightest document first, with the attributional joules a local view of that page avoids. Sites that answered the rig with an error page instead of their home page are left out (www.ox.ac.uk).

| site               | document bytes, 2026-10-18 | document bytes, 2026-10-19 | document bytes, 2026-10-19-document | document bytes, 2026-10-19-requests | whole view bytes, latest reading | J per local view |
| ------------------ | -------------------------: | -------------------------: | ----------------------------------: | ----------------------------------: | -------------------------------: | ---------------: |
| www.mass.gov       |                          0 |                          0 |                                   0 |                                   0 |                          327,401 |              0.0 |
| www.harvard.edu    |                          0 |                          0 |                                   0 |                                   0 |                            3,856 |              0.0 |
| www.mit.edu        |                          0 |                          0 |                                   0 |                                   0 |                                0 |              0.0 |
| www.unl.edu        |                        415 |                        413 |                                 414 |                                 414 |                          142,115 |              0.7 |
| www.uiowa.edu      |                        515 |                        515 |                                 516 |                                 513 |                           18,163 |              0.8 |
| demo.drupflare.com |                      5,227 |                      5,259 |                               5,265 |                               5,253 |                           35,906 |              4.1 |
| www.berkeley.edu   |                     16,264 |                     16,265 |                              16,265 |                              16,264 |                           17,014 |             11.8 |
| www.asu.edu        |                     17,076 |                     17,054 |                              16,746 |                              17,477 |                           27,374 |             12.7 |
| www.colorado.edu   |                     18,355 |                     18,337 |                              18,364 |                              18,361 |                          109,609 |             13.3 |
| www.cornell.edu    |                     18,924 |                     18,934 |                              18,934 |                              18,925 |                        6,873,140 |             13.7 |
| www.yale.edu       |                     31,945 |                     31,946 |                              31,969 |                              31,845 |                           33,392 |             22.7 |
| www.tufts.edu      |                     43,166 |                     43,165 |                              43,128 |                              43,134 |                          121,180 |             30.6 |
| www.georgetown.edu |                     56,089 |                     56,098 |                              56,093 |                              56,114 |                           66,343 |             39.6 |
| www.rutgers.edu    |                    193,748 |                    193,745 |                             193,742 |                             193,747 |                       14,562,969 |            135.8 |
| www.ucdavis.edu    |                   not read |                    957,863 |                             957,877 |                             957,868 |                        1,068,391 |            669.4 |

### What a Repeat View Moves

The `requests` run of the repeat-navigation rig kept every request of each site's home-page repeat view: its URL without the query string, whether it was same-origin (an exact origin match), its type, bytes, which cache answered it, and its cache headers. The document is the first Document request. Same-origin static is Script, Stylesheet, Font, Image and Media. Same-origin dynamic is every other same-origin request (XHR, Fetch, Ping, EventSource, Other and further documents). Third-party is any other origin, including an institution's own subdomains and media hosts, which is why one university's video host shows up there. Requests the browser cache answered carry no bytes and are left out. 15 of 16 sites loaded their home page (www.ox.ac.uk answered with a block page); the blocked page is listed and left out of every share.

| site               |        document B | same-origin static B | same-origin dynamic B | third-party B | whole view B | J a local view removes, document only (headline basis) | J a local view removes on the site as it ships today, including the cache-header fix |
| ------------------ | ----------------: | -------------------: | --------------------: | ------------: | -----------: | -----------------------------------------------------: | -----------------------------------------------------------------------------------: |
| demo.drupflare.com |             5,253 |               29,617 |                 1,036 |             0 |       35,906 |                                                    4.1 |                                                                                 24.8 |
| www.asu.edu        |            17,477 |                    0 |                    60 |         9,837 |       27,374 |                                                   12.7 |                                                                                 12.7 |
| www.yale.edu       |            31,845 |                    0 |                     0 |         1,547 |       33,392 |                                                   22.7 |                                                                                 22.7 |
| www.colorado.edu   |            18,361 |                    0 |                76,556 |        14,692 |      109,609 |                                                   13.3 |                                                                                 13.3 |
| www.ox.ac.uk       | blocked, HTTP 403 |                      |                       |               |              |                                                        |                                                                                      |
| www.berkeley.edu   |            16,264 |                    0 |                     0 |           750 |       17,014 |                                                   11.8 |                                                                                 11.8 |
| www.cornell.edu    |            18,925 |              105,578 |                     0 |     6,748,637 |    6,873,140 |                                                   13.7 |                                                                                 87.4 |
| www.uiowa.edu      |               513 |                    0 |                     0 |        17,650 |       18,163 |                                                    0.8 |                                                                                  0.8 |
| www.tufts.edu      |            43,134 |                    0 |                     0 |        78,046 |      121,180 |                                                   30.6 |                                                                                 30.6 |
| www.unl.edu        |               414 |                    0 |                     0 |       141,701 |      142,115 |                                                    0.7 |                                                                                  0.7 |
| www.georgetown.edu |            56,114 |                    0 |                     0 |        10,229 |       66,343 |                                                   39.6 |                                                                                 39.6 |
| www.mass.gov       |                 0 |              322,073 |                     0 |         5,328 |      327,401 |                                                    0.0 |                                                                                225.4 |
| www.ucdavis.edu    |           957,868 |                    0 |                     0 |       110,523 |    1,068,391 |                                                  669.4 |                                                                                669.4 |
| www.rutgers.edu    |           193,747 |           14,353,583 |                     0 |        15,639 |   14,562,969 |                                                  135.8 |                                                                             10,160.3 |
| www.harvard.edu    |                 0 |                    0 |                     0 |         3,856 |        3,856 |                                                    0.0 |                                                                                  0.0 |
| www.mit.edu        |                 0 |                    0 |                     0 |             0 |            0 |                                                    0.0 |                                                                                  0.0 |

The last column is a second figure per site and it is not spool's credit. A site that ships today with short cache lifetimes on its static files re-downloads them on every repeat view, and a local view would remove those bytes along with the document. The saving that comes from fixing the cache headers is the baseline fix's, not spool's against an optimized HTTP cache, so the headline stays on the document only. The column prices document plus same-origin static bytes at the same SWD v4 rate and a single origin request, so it is L2 over an L3 simplification: it does not count the origin work of each static request. Its median over the 15 sites is 22.7 J, against 12.4 J for the document alone. Most of that gap sits at a few sites (the largest figure is 10,160.3 J), since a median site's same-origin static share of its repeat view is 0.0%.

| class                                                       | bytes over all sites | pooled share of bytes | median share of a site |
| ----------------------------------------------------------- | -------------------: | --------------------: | ---------------------: |
| Document                                                    |            1,359,915 |                  5.8% |                  15.7% |
| Same-origin static (Script, Stylesheet, Font, Image, Media) |           14,810,851 |                 63.3% |                   0.0% |
| Same-origin dynamic (XHR, Fetch, Ping, Other and the rest)  |               77,652 |                  0.3% |                   0.0% |
| Third-party                                                 |            7,158,435 |                 30.6% |                  14.4% |
| Whole repeat view                                           |           23,406,853 |                100.0% |                 100.0% |

Pooled over all sites, the shares are 5.8% document, 63.3% same-origin static, 0.3% same-origin dynamic and 30.6% third-party, out of 23,406,853 B. The two heaviest sites carry 91.6% of the pooled bytes, so the pooled static and third-party shares describe them more than a typical page. The median site's share is the better read of a typical page.

| class     | total bytes | median bytes per site | sites with any |
| --------- | ----------: | --------------------: | -------------: |
| unknown   |   7,119,616 |                 9,299 |             13 |
| ads       |      36,470 |                     0 |              5 |
| video     |       2,126 |                     0 |              4 |
| analytics |         183 |                     0 |              4 |
| social    |          40 |                     0 |              1 |

99.5% of the third-party bytes come from hosts the table in `src/report/thirdparty.ts` does not know. The largest hosts, by bytes over all sites:

| host                                | class   | bytes over all sites | sites |
| ----------------------------------- | ------- | -------------------: | ----: |
| cdnsecakmi.kaltura.com              | unknown |            3,415,557 |     2 |
| media.univcomm.cornell.edu          | unknown |            3,208,074 |     1 |
| cdn.universityrelations.cornell.edu | unknown |              124,661 |     1 |
| ucommchat.unl.edu                   | unknown |               89,721 |     1 |
| story.tagboard.com                  | unknown |               83,654 |     1 |
| api.curator.io                      | unknown |               56,961 |     1 |
| googleads.g.doubleclick.net         | ads     |               34,262 |     5 |
| mediahub.unl.edu                    | unknown |               17,084 |     1 |
| events.unl.edu                      | unknown |                8,553 |     1 |
| www.juicer.io                       | unknown |                8,540 |     1 |

The classified origins move little: ad calls total 36,470 B at 5 sites and analytics endpoints 183 B. The third-party report names what blocks zero-network by host; this table says what those hosts cost in bytes. Bytes are not the cost that matters for zero-network, which a single request of any size breaks.

| navigation         | navigations | sites | median bytes | mean bytes | 75th percentile bytes | median network requests | median document bytes |
| ------------------ | ----------: | ----: | -----------: | ---------: | --------------------: | ----------------------: | --------------------: |
| Cold home page     |          15 |    15 |    4,992,892 |  7,318,189 |             8,472,860 |                    85.0 |                29,561 |
| Warm internal page |          82 |    14 |      971,161 |  3,609,705 |             2,283,212 |                    23.5 |                23,254 |
| Home page again    |          15 |    15 |       66,343 |  1,560,457 |               234,758 |                    32.0 |                17,477 |

Bytes are what the browser received. Requests are the ones the browser sent to the network: a repeat view also lists dozens of sub-resources it answered from its own cache, and those are left out. The on-wire table sets a proxy's count of the same navigations beside the browser's.

## Capacity

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

### Shared Responsibility

drupflare removes fixed idle capacity: a site that ran on a provisioned server runs on Workers, and the capacity it kept idle goes away. Spool removes throughput work: requests and renders that never reach the origin. A provider sized by throughput downsizes when demand falls, so spool lowers demand and drupflare lowers the floor. The two counts do not overlap, and a capacity saving already realised by migration is not spool's. On drupflare the immediate benefit is Worker requests and execution avoided. Cloud-hosted origins show a smaller bill, and the provider's electricity is not established.

## What This Does Not Claim

Spool does not claim:

- that 12.4 J is a meter reading. It is an attributional allocation, and the meters read 0.80 J on a desktop and 0.088 J on a phone;
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
