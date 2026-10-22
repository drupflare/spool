import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ROOT,
	buildFigures,
	buildImpact,
	byReading,
	fixed,
	latest,
	loadReadings,
	range,
	render,
	sig,
	table,
	unusedFigures
} from '../../scripts/impact';
import {
	addLevers,
	crawlLevers,
	imageSavings,
	lazyUnscrolled,
	ledgerJoules,
	ledgerMWh,
	leverStats,
	trimLevers,
	type Measurement
} from '../../src/report/index';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('docs/impact.md', () => {
	it('matches what the readings and src/report produce', async () => {
		const built = await buildImpact();
		expect(readFileSync(join(root, 'docs/impact.md'), 'utf8')).toBe(built);
	});

	it('uses every figure it computes and every placeholder has a figure', () => {
		const template = readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
		const figures = buildFigures(loadReadings());
		expect(unusedFigures(template, figures)).toEqual([]);
		expect(() => render(template, figures)).not.toThrow();
		expect(render(template, figures)).not.toMatch(/\{\{/);
	});

	it('reproduces the 12.4 J headline, the retired server-year and the tier table', () => {
		const { values, tables } = buildFigures(loadReadings());
		expect(values.headlineJ).toBe('12.4');
		expect(values.serverYear).toBe('3.80');
		expect(values.freeTierViews).toBe('3,040,000');
		expect(tables['views-channel']).toContain('| Transformative | 90% | 0.309 MWh |');
		expect(tables['free-tier']).toContain('20.97M');
	});

	it('prices bandwidth from the host table, with every host in each dollar table', () => {
		const { tables, values } = buildFigures(loadReadings());
		for (const name of ['host-prices', 'bandwidth-per-million', 'bandwidth-worked']) {
			for (const host of ['Cloudflare Workers', 'AWS CloudFront', 'Azure', 'Google Cloud']) {
				expect(tables[name], `${name} ${host}`).toContain(host);
			}
		}
		expect(tables['bandwidth-per-million']).toContain('| $0.30 |');
		expect(values.gbPerMillion).toBe('17.1');
	});

	it('opens with the notice before the evidence', () => {
		const text = readFileSync(join(root, 'docs/impact.md'), 'utf8');
		expect(text.startsWith('# Impact Notice\n')).toBe(true);
		const order = [
			'## What Spool Saves',
			'## Bandwidth and Request Costs',
			'## How the Figures Are Made',
			'## Measured Readings',
			'## Per-Site Figures',
			'## Capacity',
			'## What This Does Not Claim',
			'## Reproducing'
		].map((h) => text.indexOf(`\n${h}\n`));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('names each rig of the readings it prints from', () => {
		expect(ROOT).toBe(root.replace(/\/$/, ''));
		for (const rig of ['rapl', 'iphone', 'repeat-nav', 'on-wire', 'zero-network']) {
			expect(latest(loadReadings(), rig).rig).toBe(rig);
		}
	});
});

describe('the template renderer', () => {
	const figures = { values: { a: '1' }, tables: { t: '| x |' } };

	it('replaces values and tables', () => {
		expect(render('v={{value:a}}\n\n{{table:t}}', figures)).toBe('v=1\n\n| x |');
	});

	it('throws on a name no figure has', () => {
		expect(() => render('{{value:missing}}', figures)).toThrow(/no figure has that name/);
		expect(() => render('{{table:a}}', figures)).toThrow(/no figure/);
	});

	it('lists figures a template leaves out', () => {
		expect(unusedFigures('{{value:a}}', figures)).toEqual(['table:t']);
	});

	it('refuses a rig with no reading', () => {
		expect(() => latest(new Map(), 'rapl', 'views')).toThrow(/no rapl views reading/);
	});

	it('takes a same-day experiment as later than the plain reading of that day', () => {
		const at = (date: string) => ({ rig: 'r', date }) as unknown as Measurement;
		const readings = new Map([
			['r/2026-10-19-document.json', at('b')],
			['r/2026-10-19.json', at('a')]
		]);
		expect(latest(readings, 'r').date).toBe('b');
		expect(['r/2026-10-19-x.json', 'r/2026-10-19.json'].sort(byReading)).toEqual([
			'r/2026-10-19.json',
			'r/2026-10-19-x.json'
		]);
	});
});

describe('formatting', () => {
	it('keeps three significant figures, thousands separators and fixed decimals', () => {
		expect(sig(0.000717)).toBe('0.000717');
		expect(sig(10.875)).toBe('10.9');
		expect(sig(1234.5)).toBe('1,235');
		expect(sig(0)).toBe('0');
		expect(fixed(65000)).toBe('65,000');
		expect(fixed(3.8041, 2)).toBe('3.80');
	});

	it('prints a spread with its range and builds aligned tables', () => {
		expect(range({ median: 1, min: 0.5, max: 2, n: 3 })).toBe('1.00 (0.500 to 2.00)');
		expect(table(['a', 'b'], [['1', '2']], [1])).toBe('| a | b |\n| --- | ---: |\n| 1 | 2 |');
	});
});

describe('the savings ledger', () => {
	const image = (
		page: string,
		bytes: number,
		arms: Record<string, { bytes: number } | null> | null
	) => ({
		kind: 'image',
		site: 'https://a.test/',
		profile: 'desktop',
		page,
		bytes,
		format: 'jpeg',
		arms
	});
	const pageRow = (page: string, over: Record<string, unknown> = {}) => ({
		kind: 'page',
		site: 'https://a.test/',
		profile: 'desktop',
		variant: 'original',
		page,
		ok: true,
		imageBytesLoad: 0,
		imageBytesScroll: 0,
		videoBytes: 0,
		videoTags: [],
		iframes: [],
		lcp: null,
		...over
	});

	it('takes the smaller of the original and each arm, and never counts a larger one as a saving', () => {
		expect(
			imageSavings([
				image('/', 1000, {
					native: { bytes: 400 },
					ceiling: null,
					resized: { bytes: 100 }
				}),
				image('/', 1000, {
					native: { bytes: 1200 },
					ceiling: null,
					resized: { bytes: 900 }
				}),
				image('/', 500, null)
			] as never)
		).toEqual({ format: 600, resize: 400 + 0, lossless: 0 });
	});

	it('builds one entry per page with the levers added page by page', () => {
		const rows = [
			pageRow('/a', { videoBytes: 500, videoTags: [{ autoplay: false }] }),
			pageRow('/b', { videoBytes: 700, videoTags: [{ autoplay: true }] }),
			pageRow('/c', {
				iframes: [
					{ host: 'www.youtube.com', bytes: 100_000 },
					{ host: 'ads.test', bytes: 5000 }
				]
			}),
			image('/a', 1000, { native: { bytes: 400 } }),
			{ kind: 'embed', provider: 'youtube', arm: 'facade', bytes: 20_000, docBytes: 1000 }
		];
		const levers = crawlLevers(rows as never);
		const byId = Object.fromEntries(levers.map((l) => [l.id, l.bytes]));
		expect(byId['images-format']).toEqual([600, 0, 0]);
		expect(byId['video-preload']).toEqual([500, 0, 0]);
		expect(byId['video-defer']).toEqual([0, 700, 0]);
		expect(byId.embeds).toEqual([0, 0, 79_000]);
		expect(addLevers(levers)?.bytes).toEqual([1100, 700, 79_000]);
		expect(addLevers([])).toBeNull();
	});

	it('reports the share of pages that save, the medians and the mean, and a site mean per site', () => {
		const stats = leverStats(['a', 'a', 'b', 'b', 'b'], [0, 100, 0, 0, 300]);
		expect(stats).toEqual({
			pages: 5,
			withSaving: 2,
			medianPage: 0,
			medianEligible: 200,
			medianSite: (50 + 100) / 2,
			mean: 80
		});
		expect(leverStats(['a'], [0])?.medianEligible).toBeNull();
		expect(leverStats([], [])).toBeNull();
	});

	it('pairs the lazy and original loads and counts an LCP image the rewrite made lazy', () => {
		const rows = [
			pageRow('/a', { imageBytesLoad: 900, lcp: { tag: 'IMG', loading: null } }),
			pageRow('/a', {
				variant: 'lazy',
				imageBytesLoad: 400,
				lcp: { tag: 'IMG', loading: 'lazy' }
			}),
			pageRow('/b', { imageBytesLoad: 100 }),
			pageRow('/b', { variant: 'lazy', imageBytesLoad: 300 }),
			pageRow('/c', { variant: 'lazy', imageBytesLoad: 5 })
		];
		const lazy = lazyUnscrolled(rows as never);
		expect(lazy.pairs).toBe(2);
		expect(lazy.bytes).toEqual([500, 0]);
		expect(lazy.lcpImagePages).toBe(1);
		expect(lazy.lcpLazyPages).toBe(1);
		expect(lazyUnscrolled(rows as never, 'phone').pairs).toBe(0);
	});

	it('prices bytes at the SWD rate and converts joules to megawatt-hours', () => {
		expect(ledgerJoules(1e9)).toBeCloseTo(0.194 * 3.6e6, -3);
		expect(ledgerMWh(3.6e9, 1, 1)).toBe(1);
		expect(ledgerMWh(10, 100e6, 0.6)).toBeCloseTo((10 * 100e6 * 0.6) / 3.6e9, 10);
	});

	it('keeps the trim savings and the aggregate ceiling per internal page', () => {
		const trimmed = [
			{
				site: 's',
				pages: [
					{ kind: 'home', saved: { br5Saved: 99 } },
					{ kind: 'internal', saved: { br5Saved: 10 } }
				]
			}
		];
		const crawl = [
			{
				site: 's',
				pages: [
					{
						kind: 'internal',
						ok: true,
						newAgg: { transfer: 1000, zstdAlone: 500, zstdDict: 100 }
					},
					{
						kind: 'internal',
						ok: true,
						newAgg: { transfer: 1000, zstdAlone: 0, zstdDict: 0 }
					}
				]
			}
		];
		const levers = trimLevers(trimmed as never, crawl as never);
		expect(levers.map((l) => l.bytes)).toEqual([[10], [800, 0]]);
	});
});
