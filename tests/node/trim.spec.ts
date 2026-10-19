import { describe, expect, it } from 'vitest';
import {
	blockMask,
	brotli5,
	classOf,
	coverMask,
	dictionaryOf,
	markupBloat,
	maskedText,
	missingRules,
	reduceQuery,
	reuseOf,
	savings,
	selectorOf,
	settingsOf,
	settingsVariation,
	usedRuleTexts,
	warmInternalTable,
	zstdWithDictionary,
	type WarmNav
} from '../../scripts/measure/trim';

const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/a.css">
</head>
<body data-drupal-selector="page" data-history-node-id="5">
<!-- c -->
<svg><path/></svg>
<script type="application/json" data-drupal-selector="drupal-settings-json">{"a":1,"b":[2]}</script>
<script>var x=1;</script>
<script src="/b.js"></script>
<style>p{}</style>
<p>a   b</p>
</body>
</html>`;

describe('trim url and masks', () => {
	it('keeps parameter names only, with no fragment', () => {
		expect(reduceQuery('https://a.edu/x.css?v=1&foo=2#f')).toBe('https://a.edu/x.css?v&foo');
		expect(reduceQuery('https://a.edu/x.css')).toBe('https://a.edu/x.css');
		expect(reduceQuery('https://a.edu/x.css?')).toBe('https://a.edu/x.css');
	});

	it('splits a text by a span union', () => {
		const mask = coverMask(6, [
			[1, 3],
			[2, 5]
		]);
		expect(maskedText('abcdef', mask, true)).toBe('bcde');
		expect(maskedText('abcdef', mask, false)).toBe('af');
	});

	it('uses the innermost block count whatever the range order', () => {
		const outer = { startOffset: 0, endOffset: 10, count: 1 };
		const inner = { startOffset: 2, endOffset: 5, count: 0 };
		for (const ranges of [
			[outer, inner],
			[inner, outer]
		]) {
			const mask = blockMask(10, ranges);
			expect(maskedText('abcdefghij', mask, true)).toBe('abfghij');
			expect(maskedText('abcdefghij', mask, false)).toBe('cde');
		}
	});
});

describe('trim churn and dictionary', () => {
	it('classes a URL by whether an earlier page fetched it', () => {
		const earlier = new Set(['https://a.edu/x.js?v']);
		expect(reuseOf('https://a.edu/x.js?v', earlier)).toBe('reused');
		expect(reuseOf('https://a.edu/x.js?w', earlier)).toBe('new');
	});

	it('maps resource types to report classes', () => {
		expect(classOf('Image')).toBe('Image');
		expect(classOf('XHR')).toBe('Other');
	});

	it('keeps the most recent 1 MiB as the dictionary', () => {
		expect(
			dictionaryOf(
				new Map([
					['a', Buffer.from('ab')],
					['b', Buffer.from('cd')]
				])
			).toString()
		).toBe('abcd');
		expect(dictionaryOf(new Map([['a', Buffer.alloc((1 << 20) + 10)]])).length).toBe(1 << 20);
	});

	it('compresses smaller with a dictionary of the same content', () => {
		const text = Buffer.from(PAGE.repeat(4));
		const z = zstdWithDictionary(text, Buffer.from(PAGE));
		expect(z.dict).toBeLessThan(z.alone);
		expect(zstdWithDictionary(text, Buffer.alloc(0))).toEqual({
			alone: z.alone,
			dict: z.alone
		});
		expect(brotli5('')).toBe(0);
	});
});

describe('trim markup bloat', () => {
	it('counts every class of a fixture page exactly', () => {
		const { raw, classes } = markupBloat(PAGE);
		expect(raw).toBe(Buffer.byteLength(PAGE));
		const counts = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.count]));
		expect(counts).toEqual({
			'drupal-settings-json': 1,
			'head-meta-link': 2,
			'data-drupal-attributes': 2,
			'data-history-node-id': 1,
			'html-comments': 1,
			'inline-svg': 1,
			'inline-script': 1,
			'inline-style': 1,
			'whitespace-runs': 1
		});
		expect(classes['html-comments']?.raw).toBe(10);
		expect(classes['inline-svg']?.raw).toBe(18);
		expect(classes['inline-script']?.raw).toBe(25);
		expect(classes['inline-style']?.raw).toBe(18);
		expect(classes['whitespace-runs']?.raw).toBe(3);
	});

	it('saves nothing for a class the page does not have', () => {
		expect(markupBloat('<p>x</p>').classes['inline-svg']?.br5Marginal).toBe(0);
	});

	it('reads the settings keys and their JSON bytes', () => {
		const s = settingsOf(PAGE);
		expect(s?.raw).toBe(15);
		expect(s?.keysBytes).toBe(4);
		expect(s?.keys.map((k) => [k.key, k.bytes])).toEqual([
			['a', 1],
			['b', 3]
		]);
		expect(settingsOf('<p>no settings</p>')).toBeNull();
	});

	it('marks the settings keys that differ across a site', () => {
		const a = { key: 'a', bytes: 3, hash: 'x' };
		const b = { key: 'b', bytes: 5, hash: 'y' };
		expect(settingsVariation([[a, b], [a, { ...b, hash: 'z' }], [a]])).toEqual([
			{ bytes: 8, varyingBytes: 5 },
			{ bytes: 8, varyingBytes: 5 },
			{ bytes: 3, varyingBytes: 0 }
		]);
	});
});

describe('trim warm-internal table', () => {
	it('sums the warm-internal navs of the chosen sites', () => {
		const rows: Array<{ site: string; navs: WarmNav[] }> = [
			{
				site: 's1',
				navs: [
					{
						kind: 'warm-internal',
						docBytes: 100,
						revalidations304: 2,
						cacheHits: 1,
						thirdPartyBytes: 10,
						byType: { Script: 5, Image: 7 }
					},
					{
						kind: 'warm-internal',
						docBytes: 300,
						revalidations304: 1,
						cacheHits: 0,
						thirdPartyBytes: 0,
						byType: { Script: 1 }
					},
					{ kind: 'cold-home', docBytes: 900, byType: { Script: 999 } }
				]
			},
			{ site: 's2', navs: [{ kind: 'warm-internal', docBytes: 50, byType: { Script: 1 } }] }
		];
		expect(warmInternalTable(rows, new Set(['s1']))).toEqual([
			{
				site: 's1',
				navs: 2,
				docBytesMedian: 200,
				revalidations304: 3,
				cacheHits: 1,
				thirdPartyBytes: 10,
				byType: { Script: 6, Image: 7 }
			}
		]);
	});
});

describe('trimmed experiment helpers', () => {
	const sheet = '.a{x:1}\n.b{y:2}\n@media x{.c{z:3}}';

	it('reads the text of each used rule from its span, once', () => {
		expect(
			usedRuleTexts(sheet, [
				[0, 7],
				[0, 7],
				[8, 15],
				[25, 32],
				[3, 3]
			])
		).toEqual(['.a{x:1}', '.b{y:2}', '.c{z:3}']);
	});

	it('names the used rules a trimmed sheet no longer holds', () => {
		expect(
			missingRules('.a{x:1}\n@media x{.c{z:3}}', ['.a{x:1}', '.b{y:2}', '.c{z:3}'])
		).toEqual(['.b{y:2}']);
		expect(missingRules('', [])).toEqual([]);
	});

	it('cuts a rule to its selector list', () => {
		expect(selectorOf('.a, .b > c{x:1}')).toBe('.a, .b > c');
		expect(selectorOf('x'.repeat(300))).toHaveLength(160);
	});

	it('counts bytes saved only for stylesheets new to the visit, home first', () => {
		const sizes = new Map([
			['/a.css', { raw: 1000, br5: 300, trimmedRaw: 400, trimmedBr5: 120 }],
			['/b.css', { raw: 500, br5: 200, trimmedRaw: 500, trimmedBr5: 200 }]
		]);
		expect(
			savings(
				[
					{ styles: ['/a.css', '/a.css'], guarded: false },
					{ styles: ['/a.css', '/b.css', '/unfetched.css'], guarded: false },
					{ styles: ['/a.css', '/b.css'], guarded: false }
				],
				sizes
			)
		).toEqual([
			{ newStyleFiles: 1, br5New: 300, br5Saved: 180, rawSaved: 600 },
			{ newStyleFiles: 1, br5New: 200, br5Saved: 0, rawSaved: 0 },
			{ newStyleFiles: 0, br5New: 0, br5Saved: 0, rawSaved: 0 }
		]);
	});

	it('gives a guarded page the full file under its own URL, which saves nothing and is new once', () => {
		const sizes = new Map([
			['/a.css', { raw: 1000, br5: 300, trimmedRaw: 400, trimmedBr5: 120 }]
		]);
		expect(
			savings(
				[
					{ styles: ['/a.css'], guarded: true },
					{ styles: ['/a.css'], guarded: true },
					{ styles: ['/a.css'], guarded: false }
				],
				sizes
			)
		).toEqual([
			{ newStyleFiles: 1, br5New: 300, br5Saved: 0, rawSaved: 0 },
			{ newStyleFiles: 0, br5New: 0, br5Saved: 0, rawSaved: 0 },
			{ newStyleFiles: 1, br5New: 300, br5Saved: 180, rawSaved: 600 }
		]);
	});
});
