import { describe, expect, it } from 'vitest';
import {
	escapeInline,
	INLINE_OPEN,
	inlineElement,
	placeInline,
	readInline,
	stripInline
} from '../../src/protocol/index';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('escapeInline', () => {
	it('writes <, >, & and both line separators as \\u escapes and nothing else', () => {
		const text = JSON.stringify({ a: `</script><b>&${LS}${PS}"x"` });
		const out = escapeInline(text);
		expect(out).not.toMatch(/[<>&]/);
		expect(out).not.toContain(LS);
		expect(out).not.toContain(PS);
		expect(out).toContain('\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028\\u2029');
		expect(JSON.parse(out)).toEqual(JSON.parse(text));
	});

	it('leaves a string with none of them as it was', () => {
		expect(escapeInline('{"a":"b c"}')).toBe('{"a":"b c"}');
	});
});

describe('the inline element', () => {
	const element = inlineElement('{"a":1}');

	it('goes before the last </body>, in any case, or at the end when there is none', () => {
		expect(placeInline('<html><body>x</body></html>', element)).toBe(
			`<html><body>x${element}</body></html>`
		);
		expect(placeInline('<p>a</p></body ><p>b</p></BODY>', element)).toBe(
			`<p>a</p></body ><p>b</p>${element}</BODY>`
		);
		expect(placeInline('<p>x</p>', element)).toBe(`<p>x</p>${element}`);
	});

	it('is read back from the last element, and null when there is none or it never closes', () => {
		expect(readInline(`<p>a</p>${element}`)).toBe('{"a":1}');
		expect(readInline(`${inlineElement('first')}<p>a</p>${inlineElement('second')}`)).toBe(
			'second'
		);
		expect(readInline('<p>a</p>')).toBeNull();
		expect(readInline(`<p>a</p>${INLINE_OPEN}{"a":1}`)).toBeNull();
	});

	it('is stripped wherever it sits, every copy of it, and a page without one is untouched', () => {
		expect(stripInline(`<p>a</p>${element}<p>b</p>${element}`)).toBe('<p>a</p><p>b</p>');
		expect(stripInline('<p>a</p>')).toBe('<p>a</p>');
		const open = `<p>a</p>${INLINE_OPEN}{"a":1}`;
		expect(stripInline(open)).toBe(open);
	});
});
