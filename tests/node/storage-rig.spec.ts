import { describe, expect, it } from 'vitest';
import {
	fixtureOf,
	installPhase,
	itemsPhase,
	listsPhase,
	makeRecords,
	parse,
	planOf,
	runStorage,
	TABLE,
	type Fixture,
	type Page,
	type Seams
} from '../../scripts/measure/storage';
import { measurementProblems } from '../../src/report/measurement';

type Variant = 'good' | 'wrong' | 'no-install';

// a page that answers the three phases from the fixture's own Node render, so the rig's comparison is what runs
function stubSeams(variant: Variant = 'good'): Seams {
	let fixture: Fixture | undefined;
	const page: Page = {
		goto: async () => undefined,
		waitForFunction: async () => undefined,
		evaluate: async (fn, arg) => {
			const f = fixture as Fixture;
			if (fn === installPhase) {
				if (variant === 'no-install') {
					return {
						bootstrapMs: 1,
						usageBefore: 0,
						usageAfter: 0,
						head: null,
						recordCounts: { blocks: 0, index: 0, overlay: 0, head: 0 },
						userAgent: 'stub'
					};
				}
				return {
					bootstrapMs: 1,
					usageBefore: 0,
					usageAfter: f.pack.length,
					head: { version: 1, tables: [TABLE] },
					recordCounts: { blocks: f.blocks, index: 1, overlay: 0, head: 1 },
					userAgent: 'stub'
				};
			}
			if (fn === itemsPhase) {
				const keys = (arg as { keys: string[] }).keys;
				return {
					timedOut: false,
					results: keys.map((key, n) => {
						const html = f.expected.items.get(key) as string;
						return {
							key,
							lookupMs: 0.1,
							viewMs: 0.2,
							html: variant === 'wrong' && n === 0 ? `${html}<!-- stale -->` : html
						};
					})
				};
			}
			if (fn === listsPhase) {
				return {
					timedOut: false,
					results: [1, 2].map((pass) => ({ pass, ms: 1, html: f.expected.list }))
				};
			}
			throw new Error('unexpected phase');
		}
	};
	return {
		engine: async (name) => ({
			version: `${name} stub`,
			open: async () => ({ page, close: async () => undefined })
		}),
		serve: async (served) => {
			fixture = served;
			return { origin: 'http://stub.test', close: async () => undefined };
		}
	};
}

type Row = Record<string, unknown>;

describe('storage rig arguments', () => {
	it('reads rows, engines and budget from the environment', () => {
		const options = parse([], { ROWS: '1000,10000', ENGINES: 'chromium', BUDGET_MS: '5000' });
		expect(options).toMatchObject({
			rows: [1000, 10000],
			engines: ['chromium'],
			budgetMs: 5000,
			dryRun: false,
			force: false
		});
	});

	it('defaults to all three engines at 1,000, 10,000 and 100,000 rows', () => {
		const options = parse([], {});
		expect(options.rows).toEqual([1000, 10000, 100000]);
		expect(options.engines).toEqual(['chromium', 'firefox', 'webkit']);
		expect(options.budgetMs).toBe(120000);
	});

	it('refuses an unknown engine and a row count that is not a positive integer', () => {
		expect(() => parse([], { ENGINES: 'opera' })).toThrow('unknown engine opera');
		expect(() => parse([], { ROWS: '0' })).toThrow('ROWS must be a positive integer');
		expect(() => parse([], { ROWS: '1.5' })).toThrow('ROWS must be a positive integer');
	});

	it('prints the plan for the chosen engines and rows', () => {
		const plan = planOf(parse(['--dry-run'], { ROWS: '1000', ENGINES: 'chromium' }));
		expect(plan).toMatchObject({
			rig: 'storage',
			engines: ['chromium'],
			rows: [1000],
			blockRows: 128,
			budgetMs: 120000,
			itemViews: 200,
			coldViews: 20,
			listPasses: 2
		});
	});

	it('names the file a run would write and whether it exists', () => {
		const plan = planOf(parse(['--out', '/nowhere'], { ROWS: '1000', ENGINES: 'chromium' }));
		expect(plan.file).toMatch(/^\/nowhere\/storage\/\d{4}-\d{2}-\d{2}\.json$/);
		expect(plan.fileExists).toBe(false);
	});
});

describe('storage rig records', () => {
	it('makes one unique record per row, sorted by key', () => {
		const rows = makeRecords(1000);
		const keys = rows.map(([key]) => key);
		expect(rows).toHaveLength(1000);
		expect(new Set(keys).size).toBe(1000);
		expect([...keys].sort()).toEqual(keys);
	});
});

describe('storage rig run against a stub page', () => {
	it('checks every item and list page against the Node render', async () => {
		const result = await runStorage(
			parse([], { ROWS: '1000', ENGINES: 'chromium' }),
			stubSeams()
		);
		const rows = result.reading['rows'] as Row[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			engine: 'chromium',
			rows: 1000,
			blocks: 8,
			installed: true,
			compared: 202,
			mismatches: [],
			equal: true,
			timeouts: []
		});
		expect(rows[0]).toMatchObject({ items: { n: 200 }, lists: { n: 2 } });
		expect(result.failures).toBe(0);
	});

	it('names the item page that differs from the Node render', async () => {
		const result = await runStorage(
			parse([], { ROWS: '1000', ENGINES: 'chromium' }),
			stubSeams('wrong')
		);
		const [row] = result.reading['rows'] as Row[];
		// the first view is the first key in sorted order
		expect(row).toMatchObject({ equal: false, mismatches: [makeRecords(1000)[0]?.[0]] });
		expect(result.failures).toBe(1);
	});

	it('counts a pack the page client did not install and runs no views', async () => {
		const result = await runStorage(
			parse([], { ROWS: '1000', ENGINES: 'chromium' }),
			stubSeams('no-install')
		);
		const [row] = result.reading['rows'] as Row[];
		expect(row).toMatchObject({ installed: false });
		expect(row?.['items']).toBeUndefined();
		expect(result.failures).toBe(1);
	});

	it('keeps the 1,000-row fixture for the same count', async () => {
		const first = await fixtureOf(1000);
		expect(await fixtureOf(1000)).toBe(first);
		expect(first.blocks).toBe(8);
	});

	it('writes a reading that the schema-1 reader accepts', async () => {
		const result = await runStorage(
			parse([], { ROWS: '1000', ENGINES: 'chromium' }),
			stubSeams()
		);
		expect(measurementProblems(result.reading)).toEqual([]);
	});
});
