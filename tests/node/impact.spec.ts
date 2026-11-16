import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ORIGINAL_RAPL,
	ROOT,
	buildFigures,
	buildImpact,
	byReading,
	fixed,
	latest,
	loadReadings,
	pinned,
	range,
	render,
	retakeOf,
	secondTimePointTable,
	sig,
	table,
	unusedFigures,
	type Readings,
	type RetakenExperiment
} from '../../scripts/impact';
import {
	addLevers,
	crawlLevers,
	firstViewFigures,
	halves,
	imageSavings,
	lazyUnscrolled,
	ledgerJoules,
	ledgerMWh,
	leverStats,
	parseMeasurementText,
	trimLevers,
	type Measurement,
	type Row
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
		expect(tables['views-channel']).toContain('| Transformative | 90% |');
		expect(tables['views-channel']).toContain('3.09');
		expect(tables['free-tier']).toContain('20.97M');
	});

	it('prints the four channels apart, with no total or sum row', () => {
		const { tables } = buildFigures(loadReadings());
		const channels = tables.channels as string;
		const cells = channels.split('\n').flatMap((line) => line.split('|').map((c) => c.trim()));
		for (const name of ['metered', 'attributional', 'avoided demand']) {
			expect(cells).toContain(name);
		}
		expect(cells.filter((c) => /^(total|sum)\b/i.test(c))).toEqual([]);
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

	it('prints the institution figures from the report, with the meter split and no summed water', () => {
		const { values, tables } = buildFigures(loadReadings());
		expect(values.instADataCentre).toBe('12.9');
		expect(values.instAOffMeter).toBe('32.6');
		expect(values.indirectGapPct).toBe('0.7');
		expect(tables['grid-factors']).toContain('| eGRID2023 US');
		expect(tables['grid-factors']).toContain('349.7');
		expect(tables['goal-ladder']).toContain('| 0.313 |');
		expect(tables['institution-carbon-water']).not.toMatch(/\| total\b/i);
	});

	it('opens with the notice before the evidence', () => {
		const text = readFileSync(join(root, 'docs/impact.md'), 'utf8');
		expect(text.startsWith('# Impact Notice\n')).toBe(true);
		const order = [
			'## What Spool Saves',
			'## Unit and Scope',
			'## Bandwidth and Request Costs',
			'## How the Figures Are Made',
			'## Measured Readings',
			'## Per-Site Figures',
			'## Dataset Patches',
			'## Capacity',
			'## What This Does Not Claim',
			'## Reproducing'
		].map((h) => text.indexOf(`\n${h}\n`));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('names the view mix of every unit row and computes the metered share from the reading', () => {
		const readings = loadReadings();
		const { values, tables } = buildFigures(readings);
		const rows = (tables['unit-status'] as string).split('\n').slice(2);
		expect(rows.length).toBeGreaterThanOrEqual(5);
		for (const row of rows) expect(row.split('|')[2]?.trim(), row).toMatch(/views/);
		expect(tables['unit-status']).toContain('a cost, not a saving');
		const fv = firstViewFigures(latest(readings, 'rapl', 'first-view'));
		expect(values.unitFvRatio).toBe(`${fixed(fv.ratio.ofMeans * 100, 2)}%`);
		expect(values.kwhPerMvPerJoule).toBe('0.2778');
	});

	it('sets no target, band or reference throughput', () => {
		const text = readFileSync(join(root, 'docs/impact.md'), 'utf8');
		const template = readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
		for (const phrase of ['goal band', '10 to 12', 'reference throughput', 'maximize']) {
			expect(text, phrase).not.toContain(phrase);
			expect(template, phrase).not.toContain(phrase);
		}
		expect(text).toContain('## Unit and Scope\n');
		expect(text).not.toContain('## Goal and Unit');
	});

	it('prints no absolute view scale outside the sections that own one', () => {
		const text = readFileSync(join(root, 'docs/impact.md'), 'utf8');
		const owners = ["An Institution's Figures"];
		const outside = text
			.split(/^## /m)
			.filter((section) => !owners.some((name) => section.startsWith(`${name}\n`)))
			.join('\n');
		for (const scale of ['100 million', '420 million', '378 million']) {
			expect(outside, scale).not.toContain(scale);
		}
	});

	it('names each rig of the readings it prints from', () => {
		expect(ROOT).toBe(root.replace(/\/$/, ''));
		for (const rig of ['rapl', 'iphone', 'repeat-nav', 'on-wire', 'zero-network']) {
			expect(latest(loadReadings(), rig).rig).toBe(rig);
		}
	});
});

describe('the avoidable-loops section', () => {
	const template = () => readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const name = 'avoidable-loops/2026-11-15.json';
	const idle = (visibility: string, over: Record<string, unknown> = {}) => ({
		visibility,
		raf: 0,
		timers: { lt100: 0, lt1s: 0, gte1s: 0 },
		calls: { fetch: 0, xhr: 0, beacon: 0, websocket: 0, eventSource: 0 },
		requests: { same: {}, cross: {} },
		videoAdvancing: 0,
		infiniteAnimations: 0,
		...over
	});
	const pageRow = (site: string, advancing: boolean): Row => ({
		kind: 'page',
		site,
		page: `${site}/`,
		pageKind: 'home',
		ok: true,
		docStatus: 200,
		visible: {
			seconds: Array.from({ length: 20 }, (_, i) =>
				idle('visible', advancing && i === 0 ? { videoAdvancing: 1 } : {})
			)
		},
		hidden: { seconds: Array.from({ length: 20 }, () => idle('hidden')) }
	});
	const pages = (count: number, advancing: boolean, tag: string) =>
		Array.from({ length: count }, (_, i) => pageRow(`https://${tag}${i}.example`, advancing));
	const withRows = (rows: Row[]): Readings => {
		const readings = loadReadings();
		readings.set(name, { ...pinned(readings, name), rows });
		return readings;
	};

	it('prints the second half beside the all-pages figures and names the classes whose halves differ', () => {
		const figures = buildFigures(
			withRows([...pages(10, false, 'still'), ...pages(10, true, 'moving')])
		);
		expect(unusedFigures(template(), figures)).toEqual([]);
		const text = render(template(), figures);
		expect(text).toContain(
			'| class | pages | share | 95% interval | second half pages | second half interval | sites | layer |'
		);
		expect(text).toContain('| a video that plays with no input | 10 of 20 | 50.0% |');
		expect(text).toContain('| 10 of 10 (100.0%) | 72.2% to 100.0% |');
		expect(text).toContain(
			'do not overlap for: a video that plays with no input; at least one of the six classes above.'
		);
		expect(figures.values.loopFirstPages).toBe('10');
		expect(figures.values.loopSecondPages).toBe('10');
	});

	it('says the halves overlap when no class differs between them', () => {
		const figures = buildFigures(
			withRows([...pages(10, false, 'a'), ...pages(10, false, 'b')])
		);
		expect(render(template(), figures)).toContain(
			'The first-half and second-half intervals overlap for every class.'
		);
	});

	it('keeps the all-pages counts of the committed reading, and every window met the visibility rule', () => {
		const rows = pinned(loadReadings(), name).rows;
		const { all, first, second } = halves(rows);
		expect(all.pages).toBe(108);
		expect(all.sites).toBe(60);
		expect(all.classes['visible-frame-loop']).toMatchObject({
			n: 108,
			count: 17,
			siteN: 60,
			siteCount: 11
		});
		expect(all.classes['hidden-frame-loop']).toMatchObject({ n: 108, count: 0, siteCount: 0 });
		expect(all.classes['hidden-timer-loop']).toMatchObject({ n: 108, count: 11, siteCount: 8 });
		expect(all.classes.poll).toMatchObject({ n: 108, count: 21, siteCount: 15 });
		expect(all.classes.autoplay).toMatchObject({ n: 108, count: 24, siteCount: 22 });
		expect(all.classes['css-animation']).toMatchObject({ n: 108, count: 16, siteCount: 12 });
		expect(all.classes.any).toMatchObject({ n: 108, count: 56, siteCount: 39 });
		expect(first.pages).toBe(54);
		expect(second.pages).toBe(54);
		const meets = (w: unknown, state: string): boolean => {
			const seconds = (w as { seconds: Array<{ visibility: string }> } | null)?.seconds ?? [];
			return seconds.filter((s) => s.visibility === state).length >= 18;
		};
		const pagesOf = rows.filter((r) => r.kind === 'page');
		expect(pagesOf.every((r) => meets(r.visible, 'visible') && meets(r.hidden, 'hidden'))).toBe(
			true
		);
	});
});

describe('the first-view section', () => {
	const template = () => readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const fixture = () =>
		parseMeasurementText(readFileSync(join(root, 'tests/fixtures/first-view.json'), 'utf8'));

	const withoutFirstViews = () => {
		const readings = loadReadings();
		for (const key of [...readings.keys()]) {
			if (/-first-view(-warm)?\.json$/.test(key)) readings.delete(key);
		}
		return readings;
	};

	it('is absent without a first-view reading', () => {
		const figures = buildFigures(withoutFirstViews());
		expect(figures.tables['first-view']).toBeUndefined();
		expect(render(template(), figures)).not.toContain('### First Views');
	});

	it('renders from a first-view reading and uses every figure it adds', () => {
		const readings = withoutFirstViews();
		readings.set('rapl/2026-11-20-first-view.json', fixture());
		const figures = buildFigures(readings);
		expect(figures.values.fvPages).toBe('5');
		expect(figures.values.fvSiteCount).toBe('3');
		expect(figures.values.fvFacadePages).toBe('1');
		const text = render(template(), figures);
		expect(text).toContain('### First Views');
		expect(text).toMatch(/median over pages \| 2\.1/);
		expect(text).toContain('The facade arm serves the same pages');
		expect(text).not.toMatch(/\{\{/);
		expect(unusedFigures(template(), figures)).toEqual([]);
	});

	it('renders the repeat-view section only with a repeat reading, and uses every figure in it', () => {
		const readings = withoutFirstViews();
		const cold = fixture();
		readings.set('rapl/2026-11-20-first-view.json', cold);
		expect(render(template(), buildFigures(readings))).not.toContain('#### Repeat views');
		const rows = cold.rows
			.filter((r) => r.arm === 'original' || r.arm === 'idle')
			.map((r) =>
				r.arm === 'original'
					? {
							...r,
							arm: 'warm',
							warmRevalidated: 0,
							warm304: 0,
							warmMetrics: [
								{
									before: {
										ScriptDuration: 0,
										LayoutDuration: 0,
										RecalcStyleDuration: 0,
										TaskDuration: 0
									},
									after: {
										ScriptDuration: 0.2,
										LayoutDuration: 0.1,
										RecalcStyleDuration: 0.1,
										TaskDuration: 1
									}
								}
							]
						}
					: r
			);
		readings.set('rapl/2026-11-20-first-view-warm.json', { ...cold, rows });
		const figures = buildFigures(readings);
		const text = render(template(), figures);
		expect(text).toContain('#### Repeat views');
		expect(text).not.toMatch(/\{\{/);
		expect(unusedFigures(template(), figures)).toEqual([]);
	});

	it('refuses a repeat-view reading without a first-view reading to compare with', () => {
		const readings = withoutFirstViews();
		readings.set('rapl/2026-11-20-first-view-warm.json', fixture());
		expect(() => buildFigures(readings)).toThrow(/needs a first-view reading/);
	});
});

describe('the drupal render section', () => {
	const template = () => readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const reading = () => {
		const rows: Array<Record<string, unknown>> = [
			{ arm: 'idle', round: 0, n: 0, elapsedMs: 10_000, pkgJ: 20, otherCpuMs: 0 },
			{ arm: 'idle', round: 1, n: 0, elapsedMs: 10_000, pkgJ: 20, otherCpuMs: 0 }
		];
		for (const round of [0, 1]) {
			rows.push({
				arm: 'null',
				url: 'null',
				phase: 'steady',
				round,
				n: 100,
				elapsedMs: 1000,
				pkgJ: 2.5,
				otherCpuMs: 0,
				status: { '200': 100 },
				pageCache: { none: 100 },
				dynamicCache: { none: 100 }
			});
			for (const url of ['front', 'node', 'term']) {
				rows.push({
					arm: 'uncached',
					url,
					phase: 'steady',
					round,
					n: 40,
					elapsedMs: 4000,
					pkgJ: 18,
					otherCpuMs: 0,
					status: { '200': 40 },
					pageCache: { MISS: 40 },
					dynamicCache: { MISS: 40 }
				});
				rows.push({
					arm: 'page-cache',
					url,
					phase: 'steady',
					round,
					n: 400,
					elapsedMs: 4000,
					pkgJ: 12,
					otherCpuMs: 0,
					status: { '200': 400 },
					pageCache: { HIT: 400 },
					dynamicCache: { none: 400 }
				});
			}
		}
		return parseMeasurementText(
			JSON.stringify({
				schema: 1,
				rig: 'rapl',
				date: '2026-11-20',
				layer: 'L1',
				question: 'q',
				instrument: 'i',
				machine: { name: 'paisley-park' },
				software: {},
				method: { php: '8.5.12', drupal: '11.4.0' },
				exclusions: [],
				rows
			}),
			'drupal-render'
		);
	};

	it('is absent without a drupal-render reading', () => {
		const figures = buildFigures(loadReadings());
		expect(figures.tables['drupal-render']).toBeUndefined();
		expect(render(template(), figures)).not.toContain('#### A Drupal Render');
	});

	it('renders from a drupal-render reading and uses every figure it adds', () => {
		const readings = loadReadings();
		readings.set('rapl/2026-11-20-drupal-render.json', reading());
		const figures = buildFigures(readings);
		expect(Number(figures.values.drupalUncachedJ)).toBeCloseTo(0.245, 3);
		expect(Number(figures.values.drupalRatio)).toBeCloseTo(49, 0);
		expect(figures.values.drupalNear).toBe('nearer the 15 mJ figure');
		const text = render(template(), figures);
		expect(text).toContain('#### A Drupal Render');
		expect(text).not.toMatch(/\{\{/);
		expect(unusedFigures(template(), figures)).toEqual([]);
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

describe('the idle-activity-tabs section', () => {
	const template = () => readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const HEADING = '### Tabs and Hidden Polls';
	const tabsReading = (): [string, Measurement] => {
		const name = 'rapl/2026-11-15-idle-activity-tabs.json';
		const pkgJ: Record<string, number> = {
			'tabs-1-poll': 1260,
			'tabs-3-poll': 1500,
			'tabs-3-leader': 1320,
			'tabs-3-quiet': 1260,
			'poll-hidden-long': 2400
		};
		const rows = [0, 1].flatMap((round) => [
			{ arm: 'idle', round, n: 0, elapsedMs: 60_000, pkgJ: 1200, otherCpuMs: 0 },
			...Object.entries(pkgJ).map(([arm, joules]) => {
				const long = arm === 'poll-hidden-long';
				return {
					arm,
					round,
					n: 0,
					windowS: long ? 120 : 60,
					elapsedMs: long ? 120_000 : 60_000,
					pkgJ: joules,
					otherCpuMs: 0,
					tabs: arm.startsWith('tabs-3') ? 3 : 1,
					hiddenForS: long ? 340 : 8,
					pageEvents: 60,
					leaderPolls: arm === 'tabs-3-leader' ? 60 : 0,
					messages: arm === 'tabs-3-leader' ? 120 : 0,
					originPings: arm === 'tabs-3-poll' ? 180 : long ? 2 : 60,
					originCpuMs: 1,
					visibility: 'visible'
				};
			})
		]);
		const text = JSON.stringify({
			schema: 1,
			rig: 'rapl',
			date: '2026-11-15',
			layer: 'L1',
			question: 'q',
			instrument: 'i',
			machine: { name: 'paisley-park', governor: 'powersave' },
			software: {},
			method: { rounds: 2, 'window s': 60, 'long window s': 120 },
			exclusions: [],
			rows
		});
		return [name, parseMeasurementText(text, name)];
	};

	it('is absent from the page without a tabs reading', () => {
		const text = render(template(), buildFigures(loadReadings()));
		expect(text).not.toContain(HEADING);
		expect(text).not.toContain('{{');
	});

	it('prints the arms and the ratio of the fixture reading, and nothing unfilled', () => {
		const readings = new Map([...loadReadings(), tabsReading()]);
		const text = render(template(), buildFigures(readings));
		expect(text).toContain(HEADING);
		expect(text).toContain('three tabs, one leader polling and two listening');
		expect(text).toContain('The three-tab poll costs 4.0 times the leader arm');
		expect(text).toContain('and 4.0 times the one-tab control');
		expect(text).not.toContain('{{');
	});
});

describe('the second time point', () => {
	const template = () => readFileSync(join(root, 'docs/impact.src.md'), 'utf8');
	const MACHINE = { name: 'paisley-park', governor: 'powersave' };
	const VIEWS = { network: 120, spool: 70 };

	const entry = (
		date: string,
		experiment: string,
		pkgJ: Record<string, number>,
		navs: number,
		machine: Record<string, string> = MACHINE
	): [string, Measurement] => {
		const name = `rapl/${date}-${experiment}.json`;
		const rows = [0, 1].flatMap((round) => [
			{ arm: 'idle', round, navs, elapsedMs: 10_000, pkgJ: 20, otherCpuMs: 0 },
			...Object.entries(pkgJ).map(([arm, joules]) => ({
				arm,
				round,
				navs,
				elapsedMs: 10_000,
				pkgJ: joules,
				otherCpuMs: 0
			}))
		]);
		const text = JSON.stringify({
			schema: 1,
			rig: 'rapl',
			date,
			layer: 'L1',
			question: 'q',
			instrument: 'i',
			machine,
			software: {},
			method: {},
			exclusions: [],
			rows
		});
		return [name, parseMeasurementText(text, name)];
	};

	const withoutRetakes = (readings: Readings): Readings => {
		const retakes = new Set(
			(Object.keys(ORIGINAL_RAPL) as RetakenExperiment[]).map((e) => retakeOf(readings, e))
		);
		return new Map([...readings].filter(([, reading]) => !retakes.has(reading)));
	};

	it('is absent from the page without a retake', () => {
		const loaded = withoutRetakes(loadReadings());
		const figures = buildFigures(loaded);
		expect(figures.tables['second-time-point']).toBeUndefined();
		expect(render(template(), figures)).not.toContain('### Second Time Point');
		expect(secondTimePointTable(loaded)).toBeUndefined();
	});

	it('keeps every headline value of the committed readings when their retakes are removed', () => {
		const all = buildFigures(loadReadings());
		const originals = buildFigures(withoutRetakes(loadReadings()));
		expect(all.values).toEqual(originals.values);
	});

	it('prints each retake beside its original, with the percent difference', () => {
		const readings: Readings = new Map([
			entry('2026-10-19', 'views', VIEWS, 100),
			entry('2026-11-15', 'views', { network: 140, spool: 80 }, 100, {
				...MACHINE,
				governor: 'performance'
			}),
			entry('2026-10-20', 'sw-request', { 'http-cache': 22, 'sw-cache': 22.5 }, 1000),
			entry('2026-11-15', 'sw-request', { 'http-cache': 22.2, 'sw-cache': 22.75 }, 1000)
		]);
		const row = (...cells: string[]) => `| ${cells.join(' | ')} |`;
		const at = (value: string, date: string) => `${value} (L1, ${date})`;
		expect(secondTimePointTable(readings)).toBe(
			[
				'| experiment | figure | original | retake | difference % (L2) |',
				'| --- | --- | ---: | ---: | ---: |',
				row(
					'views',
					'idle package W (median)',
					at('2.00', '2026-10-19'),
					at('2.00', '2026-11-15'),
					'0.0'
				),
				row(
					'views',
					'J saved per view vs optimized HTTP cache',
					at('0.500', '2026-10-19'),
					at('0.600', '2026-11-15'),
					'+20.0'
				),
				row(
					'views',
					'spool view, J per navigation',
					at('0.500', '2026-10-19'),
					at('0.600', '2026-11-15'),
					'+20.0'
				),
				row(
					'views',
					'machine',
					'name paisley-park, governor powersave (2026-10-19)',
					'name paisley-park, governor performance (2026-11-15)',
					''
				),
				row(
					'sw-request',
					'idle package W (median)',
					at('2.00', '2026-10-20'),
					at('2.00', '2026-11-15'),
					'0.0'
				),
				row(
					'sw-request',
					'worker from CacheStorage, mJ per request',
					at('2.50', '2026-10-20'),
					at('2.75', '2026-11-15'),
					'+10.0'
				),
				row(
					'sw-request',
					'browser cache, mJ per request',
					at('2.00', '2026-10-20'),
					at('2.20', '2026-11-15'),
					'+10.0'
				)
			].join('\n')
		);
	});

	it('leaves every headline figure on the original reading when a retake is present', () => {
		const loaded = withoutRetakes(loadReadings());
		const base = buildFigures(loaded);
		const readings: Readings = new Map([
			...loaded,
			entry('2026-11-15', 'views', { network: 140, spool: 80 }, 100)
		]);
		const built = buildFigures(readings);
		expect(built.values).toEqual(base.values);
		for (const name of Object.keys(base.tables)) {
			expect(built.tables[name], name).toBe(base.tables[name]);
		}
		expect(built.tables['second-time-point']).toContain(
			'| views | J saved per view vs optimized HTTP cache |'
		);
		const text = render(template(), built);
		expect(text).toContain('### Second Time Point');
		expect(text).not.toMatch(/\{\{/);
		expect(unusedFigures(template(), built)).toEqual([]);
	});

	it('takes the latest retake dated after the pinned original, and none otherwise', () => {
		const original = entry('2026-10-19', 'views', VIEWS, 100);
		const earlier = entry('2026-10-01', 'views', VIEWS, 100);
		const first = entry('2026-11-15', 'views', VIEWS, 100);
		const later = entry('2026-11-20', 'views', VIEWS, 100);
		expect(retakeOf(new Map([original]), 'views')).toBeUndefined();
		expect(retakeOf(new Map([original, earlier]), 'views')).toBeUndefined();
		expect(retakeOf(new Map([original, first]), 'views')).toBe(first[1]);
		expect(retakeOf(new Map([later, original, first]), 'views')).toBe(later[1]);
	});

	it('does not take a retake of another experiment whose name ends the same way', () => {
		const hidden = entry(
			'2026-11-15',
			'idle-activity-hidden',
			{ 'poll-hidden-plain': 30 },
			1000
		);
		expect(retakeOf(new Map([hidden]), 'idle-activity')).toBeUndefined();
		expect(retakeOf(new Map([hidden]), 'idle-activity-hidden')).toBe(hidden[1]);
	});
});
