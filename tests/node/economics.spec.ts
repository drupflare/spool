import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEconomics } from '../../scripts/economics';
import { loadReadings, render, unusedFigures } from '../../scripts/impact';
import { WORKLOADS, requestsByClass } from '../../src/report/index';
import { parseMeasurementText } from '../../src/report/measurement';
import { figureFaults } from './figure-sanity';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('docs/economics.md', () => {
	it('prints only finite figures, each in the range of what it counts', () => {
		expect(figureFaults(buildEconomics(loadReadings()))).toEqual([]);
	});

	it('gives every headline row a layer and every workload a row', () => {
		const { tables } = buildEconomics(loadReadings());
		const rows = (name: string) => (tables[name] ?? '').split('\n').slice(2);
		const cell = (row: string, i: number) =>
			row
				.split('|')
				.slice(1, -1)
				.map((c) => c.trim())[i];
		expect(rows('headline').length).toBeGreaterThan(0);
		for (const row of rows('headline')) expect(cell(row, 4)).toMatch(/^L[0-3]$/);
		expect(rows('headline-workloads')).toHaveLength(WORKLOADS.length);
		for (const [i, w] of WORKLOADS.entries()) {
			expect(cell(rows('headline-workloads')[i]!, 0)).toBe(w.name);
		}
	});

	it('prints the no-worker column as the WebKit default count', () => {
		const { tables } = buildEconomics(loadReadings());
		const rows = (tables.workloads ?? '').split('\n').slice(2);
		for (const [i, w] of WORKLOADS.entries()) {
			const printed = rows[i]!.split('|').slice(1, -1)[9]!.trim();
			expect(printed).toBe(requestsByClass(w, 'webkit-auto').toFixed(3));
		}
	});

	it('uses every figure it computes and every placeholder has a figure', () => {
		const template = readFileSync(join(root, 'docs/economics.src.md'), 'utf8');
		const figures = buildEconomics(loadReadings());
		expect(unusedFigures(template, figures)).toEqual([]);
		const text = render(template, figures);
		expect(text).not.toMatch(/\{\{/);
	});
});

type Row = {
	engine: string;
	scenario: string;
	arm: string;
	requests: number;
	bytes: number;
	phase?: string;
	worker_invocations?: number;
	days: { day: number; requests: number; bytes: number }[];
};

const measurements = fileURLToPath(new URL('../../measurements/', import.meta.url));
const rowsOf = (file: string): Row[] =>
	parseMeasurementText(readFileSync(`${measurements}${file}`, 'utf8'), file)
		.rows as unknown as Row[];

/** the Chromium row of a scenario and arm; the Firefox rows of the multi-day readings did not start */
const armRow = (file: string, scenario: string, arm: 'baseline' | 'spool'): Row => {
	const found = rowsOf(file).find(
		(r) => r.engine === 'chromium' && r.scenario === scenario && r.arm === arm
	);
	if (!found) throw new Error(`no ${arm} row for ${scenario} in ${file}`);
	return found;
};

const DEMO = 'demand/2026-11-20-days-ship-a.json';
const SESSION = 'demand/2026-11-20-days-ship-b.json';
const PERSISTENT = 'demand/2026-11-20-days-ship-c.json';
const PERSISTENT_STAYS =
	'Principal reader, session stays valid, persistent retention and depends on members';
const PERSISTENT_ENDS =
	'Principal reader, session ends on the server after day 2, persistent retention and depends on members';
const SESSION_STAYS = 'Principal reader, session stays valid, session retention';

describe('the headline counts, read from the ship readings', () => {
	it('counts the once-a-day reader at 5 requests on both arms', () => {
		const name = 'Daily reader: one document a day, 5 days';
		expect(armRow(DEMO, name, 'baseline').requests).toBe(5);
		expect(armRow(DEMO, name, 'spool').requests).toBe(5);
	});

	it('counts the public edit at 9 requests against 10 on the family route and 17 on the stored-page route', () => {
		const family = 'Public edit: a held course changes between days';
		const stored =
			'Public edit, stored page route with depends: a held course changes between days';
		expect(armRow(DEMO, family, 'baseline').requests).toBe(9);
		expect(armRow(DEMO, family, 'spool').requests).toBe(10);
		expect(armRow(DEMO, stored, 'baseline').requests).toBe(9);
		expect(armRow(DEMO, stored, 'spool').requests).toBe(17);
	});

	it('counts the signed-in reader on the persistent default at 7 requests against 20', () => {
		expect(armRow(PERSISTENT, PERSISTENT_STAYS, 'baseline').requests).toBe(7);
		expect(armRow(PERSISTENT, PERSISTENT_STAYS, 'spool').requests).toBe(20);
	});

	it('counts a held persistent day at 4 requests and 288 B against 1 request and 117 B', () => {
		const spool = armRow(PERSISTENT, PERSISTENT_STAYS, 'spool');
		const base = armRow(PERSISTENT, PERSISTENT_STAYS, 'baseline');
		expect(spool.days[2]).toMatchObject({ requests: 4, bytes: 288 });
		expect(spool.days[3]).toMatchObject({ requests: 4, bytes: 288 });
		expect(base.days[2]).toMatchObject({ requests: 1, bytes: 117 });
		expect(base.days[3]).toMatchObject({ requests: 1, bytes: 117 });
	});

	it('counts the session-retention reader at 7 requests against 22, with 3,225 B on each held day', () => {
		const spool = armRow(SESSION, SESSION_STAYS, 'spool');
		expect(armRow(SESSION, SESSION_STAYS, 'baseline').requests).toBe(7);
		expect(spool.requests).toBe(22);
		expect(spool.days[2]).toMatchObject({ requests: 5, bytes: 3225 });
	});

	it('counts the revoked session at 18 requests, with the day 3 page fetched from the origin', () => {
		const spool = armRow(PERSISTENT, PERSISTENT_ENDS, 'spool');
		expect(spool.requests).toBe(18);
		expect(armRow(PERSISTENT, PERSISTENT_ENDS, 'baseline').requests).toBe(7);
		expect(spool.days[3]).toMatchObject({ requests: 4, bytes: 87 });
	});

	it('counts the static arms as Worker invocations over the visit', () => {
		const invocations = (file: string): number =>
			rowsOf(file)
				.filter((r) => r.phase !== undefined)
				.reduce((sum, r) => sum + (r.worker_invocations ?? 0), 0);
		const dir = 'static-host/2026-11-20-';
		expect(invocations(`${dir}chromium-no-spool.json`)).toBe(130);
		expect(invocations(`${dir}chromium-worker-only.json`)).toBe(13);
		expect(invocations(`${dir}chromium-static-stamped.json`)).toBe(5);
		expect(invocations(`${dir}firefox-no-spool.json`)).toBe(131);
		expect(invocations(`${dir}firefox-worker-only.json`)).toBe(14);
		expect(invocations(`${dir}firefox-static-stamped.json`)).toBe(6);
	});

	it('counts the single-day reading: the 121-view mix and the 2,000-view tab, with the tab spool arm not controlled', () => {
		const single = rowsOf('demand/2026-11-20-single.json');
		const find = (engine: string, scenario: string, arm: string) =>
			single.find((r) => r.engine === engine && r.scenario === scenario && r.arm === arm) as
				(Row & { controlled?: boolean }) | undefined;
		const mix = "Codex's mix: 1 + 100 in-page + 20 warm documents";
		const tab = 'One tab, 2,000 views';
		expect(find('chromium', mix, 'baseline')?.requests).toBe(121);
		expect(find('chromium', mix, 'spool')?.requests).toBe(5);
		expect(find('firefox', mix, 'baseline')?.requests).toBe(122);
		expect(find('firefox', mix, 'spool')?.requests).toBe(6);
		expect(find('chromium', tab, 'baseline')?.requests).toBe(2000);
		expect(find('chromium', tab, 'spool')?.requests).toBe(2);
		expect(find('chromium', tab, 'spool')?.controlled).toBe(false);
		expect(find('firefox', tab, 'baseline')?.requests).toBe(2001);
		expect(find('firefox', tab, 'spool')?.requests).toBe(3);
		expect(find('firefox', tab, 'spool')?.controlled).toBe(false);
	});
});
