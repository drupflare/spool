import { describe, expect, it } from 'vitest';
import {
	compileTemplate,
	escapeHtml,
	interpretTemplate,
	ProtocolError,
	type CompiledTemplate
} from '../../src/protocol/index';

const render = (source: string, data: unknown, trusted: string[] = []) =>
	interpretTemplate(compileTemplate({ source, trusted }), data);

describe('variables', () => {
	it('escapes the five HTML characters', () => {
		expect(render('{{x}}', { x: `<a href="x">&'</a>` })).toBe(
			'&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
		);
		expect(escapeHtml('plain')).toBe('plain');
	});

	it('resolves dotted paths and prints numbers', () => {
		expect(render('{{a.b.c}} {{n}}', { a: { b: { c: 'deep' } }, n: 7 })).toBe('deep 7');
	});

	it('prints nothing for a missing field, null, a boolean or an object', () => {
		expect(render('[{{no}}][{{n}}][{{t}}][{{o}}]', { n: null, t: true, o: { a: 1 } })).toBe(
			'[][][][]'
		);
	});

	it('only resolves own properties, so prototype names print nothing', () => {
		expect(render('[{{constructor}}][{{__proto__}}][{{a.toString}}]', { a: {} })).toBe(
			'[][][]'
		);
	});

	it('prints a trusted field raw and refuses to compile an untrusted one', () => {
		expect(render('{{{html}}}|{{html}}', { html: '<b>x</b>' }, ['html'])).toBe(
			'<b>x</b>|&lt;b&gt;x&lt;/b&gt;'
		);
		expect(() => compileTemplate({ source: '{{{html}}}' })).toThrow(/not a trusted field/);
	});

	it('interprets a trusted list that was edited after compilation as untrusted', () => {
		const compiled = compileTemplate({ source: '{{{html}}}', trusted: ['html'] });
		expect(() => interpretTemplate({ ...compiled, trusted: [] }, { html: 'x' })).toThrow(
			ProtocolError
		);
	});

	it('skips comments', () => {
		expect(render('a{{! note }}b', {})).toBe('ab');
	});
});

describe('blocks', () => {
	it('repeats #each over an array with this and @index', () => {
		expect(render('{{#each xs}}{{@index}}={{this}};{{/each}}', { xs: ['a', 'b'] })).toBe(
			'0=a;1=b;'
		);
	});

	it('reads item fields first and falls back to the outer scope', () => {
		const source = '{{#each rows}}{{name}}@{{site}} {{/each}}';
		expect(render(source, { site: 's', rows: [{ name: 'x' }, { name: 'y' }] })).toBe(
			'x@s y@s '
		);
	});

	it('treats a missing or non-array each target as empty', () => {
		expect(render('[{{#each xs}}x{{/each}}]', { xs: 'str' })).toBe('[]');
		expect(render('[{{#each xs}}x{{/each}}]', {})).toBe('[]');
	});

	it('branches with #if and else; zero, empty string, empty list and null are false', () => {
		const source = '{{#if v}}yes{{else}}no{{/if}}';
		for (const v of [0, '', [], null, false, undefined]) {
			expect(render(source, { v })).toBe('no');
		}
		for (const v of [1, 'a', [0], true, {}]) expect(render(source, { v })).toBe('yes');
	});

	it('allows #if without else and nesting inside both branches', () => {
		const source =
			'{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}{{#each xs}}{{this}}{{/each}}{{/if}}';
		expect(render(source, { a: 1, b: 0 })).toBe('Ab');
		expect(render(source, { a: 0, xs: [1, 2] })).toBe('12');
		expect(render('{{#if a}}x{{/if}}', {})).toBe('');
	});
});

describe('compile errors', () => {
	it.each([
		['{{#each xs}}x', /unclosed/],
		['{{/each}}', /unexpected/],
		['{{#if a}}x{{/each}}', /unexpected/],
		['{{else}}', /outside/],
		['{{#each}}x{{/each}}', /bad block/],
		['{{#each a b}}x{{/each}}', /bad block/],
		['{{#unless a}}x{{/unless}}', /unknown block/],
		['{{a b}}', /bad field/],
		['{{}}', /bad field/],
		['{{a-}}{{1}}', /bad field/]
	])('refuses %s', (source, message) => {
		expect(() => compileTemplate({ source })).toThrow(message);
		try {
			compileTemplate({ source });
		} catch (error) {
			expect((error as ProtocolError).code).toBe('bad-template');
		}
	});

	it('refuses a compiled template of another version', () => {
		const compiled = compileTemplate({ source: 'x' });
		expect(() =>
			interpretTemplate({ ...compiled, v: 2 } as unknown as CompiledTemplate, {})
		).toThrow(/version/);
	});
});

describe('compiled output', () => {
	it('is plain JSON that survives a round trip and renders the same', () => {
		const compiled = compileTemplate({
			source: '<ul>{{#each xs}}<li>{{this}}</li>{{/each}}</ul>{{{raw}}}',
			trusted: ['raw']
		});
		const copy = JSON.parse(JSON.stringify(compiled)) as CompiledTemplate;
		const data = { xs: ['a', '<'], raw: '<hr>' };
		expect(interpretTemplate(copy, data)).toBe(interpretTemplate(compiled, data));
		expect(interpretTemplate(copy, data)).toBe('<ul><li>a</li><li>&lt;</li></ul><hr>');
	});
});
