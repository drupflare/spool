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
import type { Measurement } from '../../src/report/index';

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
