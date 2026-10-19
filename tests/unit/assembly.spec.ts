import { describe, expect, it } from 'vitest';
import {
	assemble,
	CLIENT_TAG_ATTR,
	clientTag,
	fillSlots,
	injectClientTag,
	placeholder,
	placeholderIds,
	renderAssembly,
	slot,
	slotNames
} from '../../src/protocol/index';

const shell = `<body>${placeholder('menu')}<main>${placeholder('body')}</main>${slot('nonce')}</body>`;

describe('assemble', () => {
	it('lists placeholder ids in document order', () => {
		expect(placeholderIds(shell)).toEqual(['menu', 'body']);
		expect(slotNames(shell)).toEqual(['nonce']);
	});

	it('fills holes and reports what did not line up', () => {
		const result = assemble(shell, { menu: '<nav></nav>', extra: 'x' });
		expect(result.filled).toEqual(['menu']);
		expect(result.unfilled).toEqual(['body']);
		expect(result.unmatched).toEqual(['extra']);
		expect(result.html).toContain('<nav></nav>');
		expect(result.html).toContain(placeholder('body'));
	});

	it('does not read a fragment named like an Object property', () => {
		const result = assemble(placeholder('constructor'), {});
		expect(result.unfilled).toEqual(['constructor']);
	});

	it('does not re-expand a fragment that contains a placeholder', () => {
		const result = assemble(placeholder('a'), { a: placeholder('b'), b: 'no' });
		expect(result.html).toBe(placeholder('b'));
		expect(result.unmatched).toEqual(['b']);
	});

	it('fills slots with the same contract', () => {
		const result = fillSlots(`a${slot('x')}b${slot('y')}`, { x: '1' });
		expect(result.html).toBe(`a1b${slot('y')}`);
		expect(result.unfilled).toEqual(['y']);
	});

	it('does not confuse slot names where one is a prefix of another', () => {
		expect(fillSlots(`${slot('n1')}${slot('n10')}`, { n1: 'a', n10: 'b' }).html).toBe('ab');
	});
});

describe('renderAssembly', () => {
	it('builds the page when everything is filled', () => {
		const result = renderAssembly({
			shell,
			fragments: { menu: 'M', body: 'B' },
			slots: { nonce: 'N' }
		});
		expect(result).toEqual({ ok: true, html: '<body>M<main>B</main>N</body>' });
	});

	it('refuses an unfilled placeholder or slot rather than showing a partial page', () => {
		const missingFragment = renderAssembly({
			shell,
			fragments: { menu: 'M' },
			slots: { nonce: 'N' }
		});
		expect(missingFragment).toEqual({ ok: false, reason: 'unfilled placeholders: body' });
		const missingSlot = renderAssembly({ shell, fragments: { menu: 'M', body: 'B' } });
		expect(missingSlot).toEqual({ ok: false, reason: 'unfilled slots: nonce' });
	});
});

describe('the client tag', () => {
	const tag = clientTag({ src: '/.spool/0.1.0/client.js' });

	it('is a deferred same-origin script with the marker attribute', () => {
		expect(tag).toBe(
			`<script src="/.spool/0.1.0/client.js" defer ${CLIENT_TAG_ATTR}></script>`
		);
	});

	it('carries integrity and crossorigin for a CDN script and escapes attributes', () => {
		const cdn = clientTag({ src: 'https://cdn.example/a?x="1"&y=<', integrity: 'sha384-abc' });
		expect(cdn).toContain('integrity="sha384-abc" crossorigin="anonymous"');
		expect(cdn).toContain('src="https://cdn.example/a?x=&quot;1&quot;&amp;y=&lt;"');
	});

	it('goes before </head>, else before </body>, else at the end', () => {
		expect(injectClientTag('<head></HEAD><body></body>', tag)).toBe(
			`<head>${tag}</HEAD><body></body>`
		);
		expect(injectClientTag('<body>x</body>', tag)).toBe(`<body>x${tag}</body>`);
		expect(injectClientTag('<p>x</p>', tag)).toBe(`<p>x</p>${tag}`);
	});

	it('is idempotent', () => {
		const once = injectClientTag('<head></head>', tag);
		expect(injectClientTag(once, tag)).toBe(once);
	});
});
