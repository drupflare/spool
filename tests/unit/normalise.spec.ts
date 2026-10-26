import { describe, expect, it } from 'vitest';
import { equivalent, inlineElement, normalise } from '../../src/protocol/index';

describe('normalise', () => {
	it('collapses whitespace, drops whitespace between tags and strips comments', () => {
		const a = '<div>\n  <p>one   two</p>\n  <!-- note -->\n</div>\n';
		const b = '<div><p>one two</p></div>';
		expect(normalise(a)).toBe(b);
	});

	it('blanks every ignore match, adding the global flag when missing', () => {
		const out = normalise('<a nonce="abc"></a><b nonce="xyz"></b>', {
			ignore: [/nonce="\w+"/]
		});
		expect(out).toBe('<a \u0000></a><b \u0000></b>');
	});

	it('treats the inline artifact element as absent', () => {
		const plain = '<html><body><p>x</p></body></html>';
		const inlined = `<html><body><p>x</p>${inlineElement('{"a":1}')}</body></html>`;
		expect(normalise(inlined)).toBe(normalise(plain));
		expect(equivalent(inlined, plain).equal).toBe(true);
		expect(equivalent(inlined, '<html><body><p>y</p></body></html>').equal).toBe(false);
	});

	it('keeps text that differs', () => {
		expect(normalise('<p>a</p>')).not.toBe(normalise('<p>b</p>'));
	});
});

describe('equivalent', () => {
	it('is equal when only formatting and an ignored nonce differ', () => {
		const left = '<p id="n-1">x</p>';
		const right = '<p  id="n-2">x</p>\n';
		expect(equivalent(left, right).equal).toBe(false);
		expect(equivalent(left, right, { ignore: [/n-\d+/g] }).equal).toBe(true);
	});

	it('names where two renders first differ', () => {
		const result = equivalent('<p>abcdef</p>', '<p>abcxef</p>');
		expect(result.equal).toBe(false);
		if (!result.equal) {
			expect(result.at).toBe(6);
			expect(result.reason).toContain('diverges at 6');
		}
	});
});
