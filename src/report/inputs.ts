/** where a figure comes from: L0 published, L1 measured here, L2 derived from L0/L1, L3 scenario */
export type Layer = 'L0' | 'L1' | 'L2' | 'L3';

/** one model input, carried with its unit, layer and source so a table can print all three */
export type Input = {
	value: number;
	unit: string;
	layer: Layer;
	source: string;
};

/** Sustainable Web Design v4 operational intensities, the attributional headline's basis */
export const SWD_V4 = {
	network: {
		value: 0.059,
		unit: 'kWh/GB',
		layer: 'L0',
		source: 'sustainablewebdesign.org/estimating-digital-emissions (web page read 2026-10-18)'
	},
	datacentre: {
		value: 0.055,
		unit: 'kWh/GB',
		layer: 'L0',
		source: 'sustainablewebdesign.org/estimating-digital-emissions (web page read 2026-10-18)'
	},
	device: {
		value: 0.08,
		unit: 'kWh/GB',
		layer: 'L0',
		source: 'sustainablewebdesign.org/estimating-digital-emissions (web page read 2026-10-18)'
	}
} as const satisfies Record<string, Input>;

/**
 * Median bytes of the document request a default local view replaces, on a repeat view of an
 * already-seen home page. Sub-resources are left out: an optimized HTTP cache already keeps static
 * files, and the page's own API calls and third-party requests still leave during a local view.
 */
export const DOCUMENT_BYTES: Input = {
	value: 17_054,
	unit: 'B',
	layer: 'L1',
	source: 'median repeat-view document request over every measurements/repeat-nav reading (Playwright + CDP, n=1 per site per reading)'
};

/** share of higher-ed web sessions on phones */
export const MOBILE_SHARE: Input = {
	value: 0.43,
	unit: 'fraction',
	layer: 'L0',
	source: 'OHO, 2023 Google Analytics benchmarks for higher education websites, 2022 data: 43.2% mobile (web page)'
};

/**
 * Radio wake avoided per zero-network view on a phone. The headline uses `attributed`, which stays 0
 * until a phone reading attributes a wake to a network view; the others are sensitivity values.
 */
export const RADIO_J = {
	attributed: {
		value: 0,
		unit: 'J',
		layer: 'L1',
		source: 'measurements/iphone/2026-10-19-{paced,radio}-cellular.json: no wake attributable to a network view or an isolated request'
	},
	low: { value: 2, unit: 'J', layer: 'L3', source: 'scenario' },
	central: { value: 5, unit: 'J', layer: 'L3', source: 'scenario' },
	high: {
		value: 12,
		unit: 'J',
		layer: 'L0',
		source: 'Thiagarajan et al. WWW 2012, 3G setup cost (full text)'
	}
} as const satisfies Record<string, Input>;

/** origin energy per avoided request */
export const ORIGIN_J = {
	conventional: {
		value: 0.455,
		unit: 'J',
		layer: 'L1',
		source: 'drupflare/worker docs/impact.md, RAPL mix @40 views/s, regular host, idle subtracted'
	},
	drupflare: {
		value: 0.0054,
		unit: 'J',
		layer: 'L2',
		source: 'drupflare/worker docs/impact.md, energy per view at 10M views/month'
	}
} as const satisfies Record<string, Input>;

/** a host at 15% load on the SPECpower curve the worker's impact model uses */
export const SERVER_WATTS: Input = {
	value: 282,
	unit: 'W',
	layer: 'L2',
	source: 'drupflare/worker docs/impact.md, SPECpower Dell R6725 measured curve at 15% load'
};

/** colocation facility overhead */
export const PUE: Input = {
	value: 1.54,
	unit: 'ratio',
	layer: 'L0',
	source: 'Uptime Institute average, as cited in drupflare/worker docs/impact.md'
};

/** monthly views the Workers free plan carries at one request per view */
export const FREE_TIER_VIEWS: Input = {
	value: 3_040_000,
	unit: 'views/month',
	layer: 'L2',
	source: '100,000 Worker requests/day (Cloudflare, L0) x 30.4 days'
};

/**
 * Share of all views that are a device's first view of a page it has not seen, so they go to the
 * network and move that page's new bytes. A scenario range: the low end is a new-visitor session
 * share times the share of views that are not a session's entry; the high end is a phone study.
 */
export const FIRST_VIEW_SHARE = {
	low: {
		value: 0.451,
		unit: 'fraction',
		layer: 'L3',
		source: 'spool-survey-breakeven.md Part D: 79.8% new-visitor sessions (Study in the States, one .gov site, October 2021; labelled FT-C in the survey, not re-read here) x (1 - 1/2.3 pages per session, OHO 2023 benchmarks, web page), computed'
	},
	central: {
		value: 0.6,
		unit: 'fraction',
		layer: 'L3',
		source: 'spool-survey-breakeven.md Part D: the midpoint of the low and high values, a choice'
	},
	high: {
		value: 0.75,
		unit: 'fraction',
		layer: 'L3',
		source: 'LiveLab, Wang et al. TR1215-2011 (full text): on average 75% of the webpages 24 iPhone users visited were new visits'
	}
} as const satisfies Record<string, Input>;

/** share of origin load that is reads spool can answer, before a trace replaces it */
export const READ_SHARE: Input = { value: 0.9, unit: 'fraction', layer: 'L3', source: 'scenario' };

/** servers a redundant deployment keeps whatever the load */
export const SERVER_FLOOR: Input = { value: 2, unit: 'servers', layer: 'L3', source: 'scenario' };

/** date the vendor pricing pages below were read */
export const PRICES_READ = '2026-10-19';

/** a host's published list prices for traffic a local view no longer sends */
export type HostPrice = {
	name: string;
	/** the tier the egress price is taken from */
	tier: string;
	page: string;
	egress: Input;
	bytesPerUnit: number;
	freeAllowance?: Input;
	requests?: Input;
};

/** list prices of hosts higher ed uses, first paid tier, USD, read from each vendor's own page */
export const HOSTS: readonly HostPrice[] = [
	{
		name: 'Cloudflare Workers (Standard plan)',
		tier: 'Standard plan, requests past the included 10 million a month',
		page: 'developers.cloudflare.com/workers/platform/pricing',
		egress: {
			value: 0,
			unit: 'USD/GB',
			layer: 'L0',
			source: `developers.cloudflare.com/workers/platform/pricing (web page read ${PRICES_READ}): "no additional charges for data transfer (egress) or throughput (bandwidth)"`
		},
		bytesPerUnit: 1e9,
		requests: {
			value: 0.3,
			unit: 'USD/million requests',
			layer: 'L0',
			source: `developers.cloudflare.com/workers/platform/pricing (web page read ${PRICES_READ}): 10 million included a month, then $0.30 per additional million; static asset requests are free`
		}
	},
	{
		name: 'AWS CloudFront (pay as you go)',
		tier: 'United States, Mexico and Canada; the next 9 TB after the first free 1 TB',
		page: 'aws.amazon.com/cloudfront/pricing/pay-as-you-go',
		egress: {
			value: 0.085,
			unit: 'USD/GB',
			layer: 'L0',
			source: `aws.amazon.com/cloudfront/pricing/pay-as-you-go (web page read ${PRICES_READ}): data transfer out to internet, $0.085 per GB for the next 9 TB`
		},
		bytesPerUnit: 1e9,
		freeAllowance: {
			value: 1000,
			unit: 'GB/month',
			layer: 'L0',
			source: `aws.amazon.com/cloudfront/pricing/pay-as-you-go (web page read ${PRICES_READ}): first 1 TB free`
		},
		requests: {
			value: 1,
			unit: 'USD/million requests',
			layer: 'L2',
			source: `aws.amazon.com/cloudfront/pricing/pay-as-you-go (web page read ${PRICES_READ}): HTTPS requests $0.0100 per 10,000 after 10 million free a month, times 100`
		}
	},
	{
		name: 'Microsoft Azure',
		tier: 'default routing from North America or Europe; the next 10 TB after the first free 100 GB',
		page: 'azure.microsoft.com/en-us/pricing/details/bandwidth',
		egress: {
			value: 0.087,
			unit: 'USD/GB',
			layer: 'L0',
			source: `azure.microsoft.com/en-us/pricing/details/bandwidth (web page read ${PRICES_READ}): Microsoft Premium Global Network, $0.087 per GB for the next 10 TB`
		},
		bytesPerUnit: 1e9,
		freeAllowance: {
			value: 100,
			unit: 'GB/month',
			layer: 'L0',
			source: `azure.microsoft.com/en-us/pricing/details/bandwidth (web page read ${PRICES_READ}): first 100 GB a month free`
		}
	},
	{
		name: 'Google Cloud (Premium Tier)',
		tier: 'to North America, 1 to 1,024 GiB a month, per GiB',
		page: 'cloud.google.com/vpc/network-pricing',
		egress: {
			value: 0.12,
			unit: 'USD/GiB',
			layer: 'L0',
			source: `cloud.google.com/vpc/network-pricing (web page read ${PRICES_READ}): Premium Tier data transfer out to North America, 1 to 1,024 GiB a month, $0.12 per GiB`
		},
		bytesPerUnit: 2 ** 30,
		freeAllowance: {
			value: 1,
			unit: 'GiB/month',
			layer: 'L0',
			source: `cloud.google.com/vpc/network-pricing (web page read ${PRICES_READ}): first 1 GiB a month free`
		}
	}
];

/** Pantheon bills traffic in unique visits, which no per-view figure converts to */
export const PANTHEON_OVERAGE: Input = {
	value: 40,
	unit: 'USD per 10,000 unique visits',
	layer: 'L0',
	source: `docs.pantheon.io/guides/account-mgmt/traffic/overages (web page read ${PRICES_READ}): a visit is an IP address and user agent over 24 hours; the page carries a notice that the automated overage program is paused`
};

/** the three tiers, named by the share of annual views served with zero network */
export const TIERS = { meaningful: 0.3, major: 0.65, transformative: 0.9 } as const;

/** grams per pound, the mass conversion behind eGRID's lb/MWh rates */
export const G_PER_LB = 453.59237;

const cents = (value: number): Input => ({
	value,
	unit: 'cents/kWh',
	layer: 'L0',
	source: 'EIA Electric Power Annual 2025, Table 2.10, https://www.eia.gov/electricity/annual/html/epa_02_10.html (raw HTML read 2026-11-05)'
});

/**
 * Average retail electricity price in cents per kWh for 2025, from EIA Electric Power Annual Table
 * 2.10 (L0). The table holds these five states. Any other state has no price here, and
 * `electricityPrice` throws on it rather than guessing.
 */
export const ELECTRICITY_PRICE = {
	US: { commercial: cents(13.37), industrial: cents(8.51) },
	NH: { commercial: cents(20.11), industrial: cents(16.82) },
	MA: { commercial: cents(23.1), industrial: cents(19.04) },
	AZ: { commercial: cents(12.45), industrial: cents(8.05) },
	WA: { commercial: cents(10.97), industrial: cents(7) }
} as const satisfies Record<string, Record<'commercial' | 'industrial', Input>>;

export type PriceState = keyof typeof ELECTRICITY_PRICE;

const egrid = (value: number): Input => ({
	value,
	unit: 'lb/MWh',
	layer: 'L0',
	source: 'EPA eGRID2023, eGRID subregion total output emission rates, CO2e (https://www.epa.gov/egrid/summary-data), one WebFetch excerpt not cross-checked against the xlsx'
});

/** an eGRID2023 subregion; `US` is the national total */
export type EgridSubregion = 'US' | 'NEWE' | 'AZNM' | 'NWPP' | 'SRVC' | 'ERCT';

/**
 * eGRID2023 total output CO2e per subregion, lb per MWh (L0). The boundary is stack emissions at the
 * plant: no transmission or distribution losses and no upstream or construction emissions (eGRID
 * Technical Guide, read in full).
 */
export const EGRID_LB_PER_MWH: Readonly<Record<EgridSubregion, Input>> = {
	US: egrid(770.884),
	NEWE: egrid(543.178),
	AZNM: egrid(706.189),
	NWPP: egrid(635.267),
	SRVC: egrid(596.326),
	ERCT: egrid(736.629)
};

/**
 * Ember's US carbon intensity of electricity generation, 2025, in gCO2e per kWh (L0). Ember states no
 * boundary. It is printed beside the eGRID figure and never in its place.
 */
export const EMBER_US_G_PER_KWH: Input = {
	value: 384,
	unit: 'gCO2e/kWh',
	layer: 'L0',
	source: 'Ember, Global Electricity Review 2026, major countries and regions (https://ember-energy.org/latest-insights/global-electricity-review-2026/major-countries-and-regions), WebFetch excerpt; another Ember page prints the same figure as 2024'
};

/**
 * Litres of water per kWh of data-centre electricity, consumed on site (L2, derived from LBNL 2024:
 * 66 billion L in 2023 over 176 TWh). drupflare's worker docs use the same value.
 */
export const WATER_DIRECT: Input = {
	value: 0.375,
	unit: 'L/kWh',
	layer: 'L2',
	source: 'drupflare/worker docs/impact/water.md, from LBNL 2024 (2023 data)'
};

/**
 * Litres of water per kWh of electricity through generation (L2). drupflare's worker docs round
 * LBNL's figure to 4.55.
 */
export const WATER_INDIRECT: Input = {
	value: 4.55,
	unit: 'L/kWh',
	layer: 'L2',
	source: 'drupflare/worker docs/impact/water.md, from LBNL 2024 (nearly 800 billion L through generation)'
};

/** LBNL 2024's printed indirect water for data centres, 4.52 L/kWh (L0), shown beside `WATER_INDIRECT` */
export const WATER_INDIRECT_LBNL: Input = {
	value: 4.52,
	unit: 'L/kWh',
	layer: 'L0',
	source: 'LBNL 2024 United States Data Center Energy Usage Report, full text (4.35 for the whole US grid)'
};

/**
 * Median bytes of a first view's home page (L0). The Web Almanac chapter's own figures conflict, from
 * 2.16 to 2.41 MB; the midpoint is used here.
 */
export const FIRST_VIEW_BYTES: Input = {
	value: 2_200_000,
	unit: 'B',
	layer: 'L0',
	source: 'Web Almanac 2025, home-page weight median (mobile and desktop)'
};

/**
 * Median bytes of a whole repeat view, pooled over every repeat-navigation reading (L1).
 * `scripts/impact.ts` refuses to run if the readings give another median.
 */
export const REPEAT_VIEW_BYTES: Input = {
	value: 66_343,
	unit: 'B',
	layer: 'L1',
	source: 'measurements/repeat-nav, pooled whole-repeat-view median'
};

/** the high case of the ceiling scenario: every cut at its high value (L3) */
export const GOAL_HIGH_SHARE: Input = {
	value: 0.415,
	unit: 'fraction',
	layer: 'L3',
	source: 'scenario, SPOOL_PLAN "How high can the share go" (2026-11-03): every cut at its high value'
};

/**
 * Proposed goal shares of a site's own page-view footprint (L3). Proposed in the plan on 2026-11-03
 * and not adopted; they are a research target, not a business figure.
 */
export const GOAL_SHARES = [0.025, 0.05, 0.1, 0.25] as const;

/**
 * drupflare's hosting saving per site a year against three deployments (L2, modelled). The
 * production-baseline page of the worker docs prints these three; the peak-sized figure is the
 * headline.
 */
export const HOSTING_KWH_PER_SITE = {
	peak: {
		value: 390,
		unit: 'kWh/site/yr',
		layer: 'L2',
		source: 'drupflare/worker docs/impact/energy/production-baseline.md: peak-sized, 3 regions, 12 nodes, 8 vCPU, 10%'
	},
	production: {
		value: 224.2,
		unit: 'kWh/site/yr',
		layer: 'L2',
		source: 'drupflare/worker docs/impact/energy/production-baseline.md: production, 3 regions, 12 nodes, 4 vCPU, 15%'
	},
	floor: {
		value: 9.34,
		unit: 'kWh/site/yr',
		layer: 'L2',
		source: 'drupflare/worker docs/impact/energy/production-baseline.md: worst case, one small VPS, 2 vCPU, 15%'
	}
} as const satisfies Record<string, Input>;

const count = (value: number, column: string, term: string): Input => ({
	value,
	unit: 'requests',
	layer: 'L1',
	source: `review/model.json, column "${column}", ${term}`
});

const review = (value: number, what: string): Input => ({
	value,
	unit: 'requests',
	layer: 'L1',
	source: `review/REVIEW.md section 3, ${what}; Chromium, Firefox and WebKit; measured on 2026-11-18`
});

/** the request-law constants of `Q`, each a count from review/model.json or the review's constants table */
export const DEMAND = {
	bootstrapWorker: count(2, 'min worker, Chromium', 'k'),
	bootstrapNoWorker: count(1, 'min no worker, any engine', 'k'),
	contact: count(1, 'min worker, Chromium', 'x'),
	contactInLease: review(0, '"contact inside the lease", min worker column'),
	write: review(1, '"write" row, min worker column'),
	inPage: review(0, '"in-page view" row, min worker column'),
	coldChromium: count(1, 'min worker, Chromium', 'cold'),
	coldRoute: count(0, 'min worker + route, Chromium', 'cold'),
	coldFirefox: count(0, 'min worker, Firefox', 'cold'),
	coldWebkitMac: count(2, 'min worker, WebKit macOS', 'cold'),
	coldWebkitLinux: count(1, 'min worker, WebKit Linux', 'cold'),
	coldTls: {
		value: 0,
		unit: 'requests',
		layer: 'L1',
		source: 'review/REVIEW.md section 8, six cold restarts per engine against the deployed Worker; Chromium, Firefox and WebKit; measured on 2026-11-18; the count is Worker invocations'
	},
	warmChromium: count(0, 'min worker, Chromium', 'warm'),
	warmFirefox: count(0, 'min worker, Firefox', 'warm'),
	warmWebkitMac: count(1, 'min worker, WebKit macOS', 'warm'),
	warmWebkitLinux: count(0, 'min worker, WebKit Linux', 'warm')
} as const satisfies Record<string, Input>;

const retrofit = (value: number, unit: string, what: string): Input => ({
	value,
	unit,
	layer: 'L1',
	source: `drupflare Worker retrofit reading, ${what}`
});

/** counted views of the retrofit reading: one bootstrap, then the in-page and document views below */
export const RETROFIT_VIEWS = retrofit(121, 'views', 'counted views, warm static assets');
export const RETROFIT_IN_PAGE = retrofit(100, 'views', 'in-page views');
export const RETROFIT_DOCUMENTS = retrofit(20, 'views', 'document navigations');

/** requests that reached the origin over the retrofit views; WebKit includes its script check per navigation */
export const RETROFIT_ORIGIN = {
	chromium: retrofit(4, 'requests', 'origin requests, Chromium'),
	firefox: retrofit(4, 'requests', 'origin requests, Firefox'),
	webkit: retrofit(23, 'requests', 'origin requests, WebKit')
} as const satisfies Record<string, Input>;

/** Worker invocations over the retrofit views, per engine */
export const RETROFIT_WORKER = {
	chromium: retrofit(4, 'calls', 'Worker invocations, Chromium'),
	firefox: retrofit(4, 'calls', 'Worker invocations, Firefox'),
	webkit: retrofit(6, 'calls', 'Worker invocations, WebKit')
} as const satisfies Record<string, Input>;

const session = (value: number, what: string): Input => ({
	value,
	unit: 'views',
	layer: 'L1',
	source: `review/deploy/runs/2026-11-18T09-36-16-583Z/reading.json, ${what}; three engines; measured on 2026-11-18`
});

/** the deployed session of section 8: the rig's phases, one Worker invocation each for the first document */
export const SESSION = {
	views: session(
		108,
		'phases first-document, second-view-bootstrap, 100-held-reads, 5-documents and restart-document'
	),
	heldReads: session(100, 'phase 100-held-reads'),
	documents: session(5, 'phase 5-documents'),
	restarts: session(1, 'phase restart-document')
} as const satisfies Record<string, Input>;

const bench = (value: number, unit: string, what: string): Input => ({
	value,
	unit,
	layer: 'L1',
	source: `review/storage RESULTS.md, ${what}`
});

/** the device layouts at 1,000, 10,000 and 100,000 rows, on the M2 Pro bench */
export const STORAGE = {
	rowsSmall: bench(1000, 'rows', 'synthetic site, 1,000 rows'),
	rowsLarge: bench(10000, 'rows', 'synthetic site, 10,000 rows'),
	rowsXl: bench(100000, 'rows', 'synthetic site, 100,000 rows, Chromium only'),
	plainRowChromium: bench(794.3, 'B a row', '10k, usage, codex, Chromium'),
	plainRowFirefox: bench(9373.2, 'B a row', '10k, usage, codex, Firefox'),
	plainRowWebkit: bench(1754.5, 'B a row', '10k, usage, codex, WebKit'),
	packedRowChromium: bench(121.2, 'B a row', '10k, usage, packed, Chromium'),
	packedRowFirefox: bench(396.3, 'B a row', '10k, usage, packed, Firefox'),
	packedRowWebkit: bench(115.4, 'B a row', '10k, usage, packed, WebKit'),
	plainItemChromium: bench(61.7, 'ms', '10k, item p50, codex, Chromium'),
	plainItemFirefox: bench(112, 'ms', '10k, item p50, codex, Firefox'),
	plainItemWebkit: bench(65, 'ms', '10k, item p50, codex, WebKit'),
	packedItemChromium: bench(1.7, 'ms', '10k, item p50, packed, Chromium'),
	packedItemFirefox: bench(2, 'ms', '10k, item p50, packed, Firefox'),
	packedItemWebkit: bench(2, 'ms', '10k, item p50, packed, WebKit'),
	plainItemChromium100k: bench(675.3, 'ms', '100k, item p50, codex, Chromium'),
	packedItemChromium100k: bench(2.7, 'ms', '100k, item p50, packed, Chromium'),
	wirePacked: bench(1146591, 'B', '10k, wire, packed gzip blocks'),
	wireBrotli: bench(293408, 'B', '10k, wire, one brotli stream of the plain seed')
} as const satisfies Record<string, Input>;

const crawl = (value: number, unit: string, what: string): Input => ({
	value,
	unit,
	layer: 'L1',
	source: `review/radius RESULTS.md, ${what}`
});

/** the 300-page crawls behind the real-page figures; each total is summed over the pages */
export const CRAWL = {
	pages: crawl(300, 'pages', 'max-pages cap, docs.drupflare.com and MDN Service Worker API'),
	docsText: crawl(326886, 'B', 'solidBrotliBytes text, docs.drupflare.com, one stream'),
	mdnText: crawl(532348, 'B', 'solidBrotliBytes text, MDN, one stream'),
	docsHtml: crawl(505352, 'B', 'solidBrotliBytes html, docs.drupflare.com, one stream'),
	mdnHtml: crawl(991858, 'B', 'solidBrotliBytes html, MDN, one stream'),
	docsHtmlEach: crawl(1027054, 'B', 'brotliBytes per page, summed, docs.drupflare.com'),
	mdnHtmlEach: crawl(5711674, 'B', 'brotliBytes per page, summed, MDN')
} as const satisfies Record<string, Input>;
