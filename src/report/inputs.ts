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
