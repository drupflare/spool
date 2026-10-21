import { describe, expect, it } from 'vitest';
import {
	buildTrimManifest,
	decodeEntities,
	guardPage,
	pageAssets,
	pageTokens,
	scriptTokens,
	sourceHash,
	stripTrimParam,
	tagsOf,
	trimCss,
	trimKey,
	type TrimManifest
} from '../../src/trim/index';

const set = (...words: string[]) => new Set(words);

describe('pageTokens', () => {
	const html = `<!doctype html><HTML><body class="a  b-c" id="main"><DIV data-k="v" hidden></DIV>
<script type="application/json" data-drupal-selector="drupal-settings-json">{"cls":"json-class","x":["y_z"]}</script>
<script>el.classList.add('Js-Only')</script></body></HTML>`;
	const tokens = pageTokens(html);

	it('has tag names in lowercase', () => {
		for (const tag of ['html', 'body', 'div', 'script'])
			expect(tokens.has(tag), tag).toBe(true);
		expect(tokens.has('DIV')).toBe(false);
	});

	it('has attribute names, class values and ids', () => {
		for (const word of ['class', 'id', 'data-k', 'hidden', 'a', 'b-c', 'main']) {
			expect(tokens.has(word), word).toBe(true);
		}
	});

	it('has every word of a JSON block and of an inline script', () => {
		for (const word of ['cls', 'json-class', 'x', 'y_z', 'Js-Only', 'js-only', 'classList']) {
			expect(tokens.has(word), word).toBe(true);
		}
	});

	it('decodes entities in a class value', () => {
		expect([...pageTokens('<p class="a&#x20;b"></p>')].sort()).toEqual(
			['a', 'b', 'class', 'p', 'x20'].sort()
		);
	});

	it('reads a stray quote in an attribute name as part of the name, as a browser does', () => {
		const html =
			'<a class="sidebar_callout_button button" href="https://a.test/" 13715"="">Learn</a>';
		const [tag] = tagsOf(html);
		expect(tag?.attributes.map((a) => [a.name, a.value])).toEqual([
			['class', 'sidebar_callout_button button'],
			['href', 'https://a.test/'],
			['13715"', '']
		]);
		expect(pageTokens(html).has('sidebar_callout_button')).toBe(true);
	});

	it('reads unquoted, single-quoted, bare and spaced attributes with their spans', () => {
		const html = '<p a=1 b=\'x y\' c  d = "z" e>';
		const [tag] = tagsOf(html);
		expect(tag?.attributes.map((a) => [a.name, a.value, html.slice(a.start, a.end)])).toEqual([
			['a', '1', 'a=1'],
			['b', 'x y', "b='x y'"],
			['c', '', 'c'],
			['d', 'z', 'd = "z"'],
			['e', '', 'e']
		]);
	});

	it('gives each tag the offsets of its < and its closing >, and the length when it never closes', () => {
		const html = '<p title="a>b">x</p><i/><b class="a';
		expect(tagsOf(html).map((t) => [t.name, t.start, t.end])).toEqual([
			['p', 0, 14],
			['i', 20, 23],
			['b', 24, html.length]
		]);
		expect(html[14]).toBe('>');
		expect(html[23]).toBe('>');
	});

	it('takes the text of a script or style as its body and does not scan it for tags', () => {
		const tags = tagsOf('<script>a<b>c</script><style>p>q{}</style><i></i>');
		expect(tags.map((t) => [t.name, t.body])).toEqual([
			['script', 'a<b>c'],
			['style', 'p>q{}'],
			['i', undefined]
		]);
	});

	it('keeps an unterminated tag and an unterminated script from losing the page', () => {
		expect(tagsOf('<p class="a').map((t) => [t.name, t.attributes[0]?.value])).toEqual([
			['p', 'a']
		]);
		expect(tagsOf('<script>x(').map((t) => t.body)).toEqual(['x(']);
		expect(tagsOf('1 < 2 and <3').length).toBe(0);
	});

	it('keeps a `<` inside a script from reading as a tag', () => {
		const found = pageTokens('<script>if (a<b && c>d) {}</script><p></p>');
		expect(found.has('b')).toBe(true);
		expect(found.has('p')).toBe(true);
	});
});

describe('scriptTokens', () => {
	it('has every word with a lowercase copy', () => {
		expect([...scriptTokens('add("DIV"); x-y.z')].sort()).toEqual(
			['DIV', 'add', 'div', 'x-y', 'z'].sort()
		);
	});
});

describe('decodeEntities', () => {
	it('decodes the named five and numeric references and leaves the rest', () => {
		expect(decodeEntities('a&amp;b&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;&#0;')).toBe(
			'a&b<>"\'AB&nbsp;&#0;'
		);
	});
});

describe('pageAssets', () => {
	it('lists stylesheet links and external scripts, decoded', () => {
		const html = `<link rel="stylesheet" href="/a.css?x=1&amp;y=2"><link rel="preload" href="/no.css">
<link href='/b.css' REL='alternate Stylesheet'><script src="/s.js"></script><script>inline()</script>`;
		expect(pageAssets(html)).toEqual({
			styles: ['/a.css?x=1&y=2', '/b.css'],
			scripts: ['/s.js']
		});
	});
});

describe('trimCss', () => {
	const tokens = set('a', 'b', 'div', 'js-only', 'x');

	it('removes a rule whose class no page has, and names the token', () => {
		const out = trimCss('.a{x:1}\n.zz{x:2}\n.b{x:3}', tokens);
		expect(out).toEqual({ css: '.a{x:1}\n.b{x:3}', removedRules: 1, missing: ['zz'] });
	});

	it('removes a rule that needs a missing id or type, comparing types in lowercase', () => {
		const out = trimCss('#nope{a:b} TABLE td{a:b} DIV{a:b} .a #gone{a:b}', tokens);
		expect(out.css).toBe(' DIV{a:b}');
		expect(out.missing).toEqual(['gone', 'nope', 'table']);
		expect(out.removedRules).toBe(3);
	});

	it('keeps a class or id present in another case, as a quirks-mode page matches it', () => {
		const out = trimCss('.A{x:1} #X{x:2} .Js-Only{x:3} .zz{x:4}', tokens);
		expect(out).toEqual({
			css: '.A{x:1} #X{x:2} .Js-Only{x:3}',
			removedRules: 1,
			missing: ['zz']
		});
	});

	it('removes a rule inside @media and keeps the shell and the other rules', () => {
		const out = trimCss('@media (min-width:1px){.zz{a:b}.a{c:d}}', tokens);
		expect(out.css).toBe('@media (min-width:1px){.a{c:d}}');
		expect(out.removedRules).toBe(1);
	});

	it.each(['supports (display:grid)', 'layer base', 'container (min-width:1px)', 'scope (.a)'])(
		'walks into @%s',
		(head) => {
			const out = trimCss(`@${head}{.zz{a:b}.a{c:d}}`, tokens);
			expect(out.css).toBe(`@${head}{.a{c:d}}`);
		}
	);

	it('keeps the shell of a group it emptied, since an empty @layer still orders layers', () => {
		expect(trimCss('@layer base{.zz{a:b}}', tokens).css).toBe('@layer base{}');
	});

	it('keeps a rule that a script can add the class to', () => {
		expect(trimCss('.js-only{a:b}', tokens)).toEqual({
			css: '.js-only{a:b}',
			removedRules: 0,
			missing: []
		});
	});

	it('keeps :hover and ::before on a present class, and ignores them on an absent one', () => {
		const out = trimCss('.a:hover{a:b}.b::before{a:b}.zz:hover{a:b}.zz::after{a:b}', tokens);
		expect(out.css).toBe('.a:hover{a:b}.b::before{a:b}');
		expect(out.missing).toEqual(['zz']);
	});

	it('keeps the whole list when one selector may match, and removes it when none can', () => {
		expect(trimCss('.a,.zz{a:b}', tokens).css).toBe('.a,.zz{a:b}');
		const out = trimCss('.zz, .yy .a{a:b}', tokens);
		expect(out.css).toBe('');
		expect(out.missing).toEqual(['yy', 'zz']);
	});

	it('never examines the arguments of :is, :where, :not and :has', () => {
		const css = '.a:not(.zz){a:b}:is(.zz){a:b}:where(.zz){a:b}.a:has(.zz){a:b}.zz:not(.a){a:b}';
		const out = trimCss(css, tokens);
		expect(out.css).toBe('.a:not(.zz){a:b}:is(.zz){a:b}:where(.zz){a:b}.a:has(.zz){a:b}');
		expect(out.missing).toEqual(['zz']);
	});

	it('keeps attribute selectors, *, html, body, :root, & and escaped or non-ASCII names', () => {
		const css = [
			'[data-zz]{a:b}',
			'*{a:b}',
			'html{a:b}',
			'BODY .a{a:b}',
			':root{a:b}',
			'.sm\\:flex{a:b}',
			'.\\31 23{a:b}',
			'.café{a:b}',
			'a[href^="/zz"]{a:b}',
			'.a{& .zz{a:b}}'
		].join('\n');
		const out = trimCss(css, tokens);
		expect(out).toEqual({ css, removedRules: 0, missing: [] });
	});

	it('keeps a rule with a namespace prefix, which it does not read', () => {
		expect(trimCss('svg|zz{a:b}', tokens).removedRules).toBe(0);
	});

	it('still removes a rule when an escaped name sits beside a missing class', () => {
		expect(trimCss('.zz .sm\\:flex{a:b}', tokens).css).toBe('');
	});

	it.each([
		'@font-face{font-family:zz;src:url(zz.woff2)}',
		'@keyframes zz{from{a:b}to{a:c}}',
		'@import url("zz.css");',
		'@charset "utf-8";',
		'@property --zz{syntax:"*";inherits:false}',
		'@page{margin:1cm}',
		'@namespace svg url(http://www.w3.org/2000/svg);',
		'@counter-style zz{system:cyclic;symbols:"*"}',
		'@layer a,b;'
	])('keeps %s whole', (rule) => {
		expect(trimCss(`${rule}.zz{a:b}`, tokens).css).toBe(rule);
	});

	it('reads comments, strings, escapes and unquoted urls without losing its place', () => {
		const css = [
			'/* .zz{a:b} */',
			'.a::after{content:"}{ .zz"}',
			'[data-x="{"] .zz{a:b}',
			'.b{background:url(data:image/svg+xml,%3Csvg{ x)}',
			'.zz{content:"\\"}"}',
			'.a{a:b}'
		].join('\n');
		const out = trimCss(css, tokens);
		expect(out.css).toBe(
			[
				'/* .zz{a:b} */',
				'.a::after{content:"}{ .zz"}',
				'.b{background:url(data:image/svg+xml,%3Csvg{ x)}',
				'.a{a:b}'
			].join('\n')
		);
		expect(out.removedRules).toBe(2);
	});

	it('keeps a nested rule under a kept parent and drops the parent with all it holds', () => {
		const out = trimCss('.a{.zz{a:b}}.zz{.a{a:b}}', tokens);
		expect(out.css).toBe('.a{.zz{a:b}}');
	});

	it.each([
		['an unterminated comment', '.a{a:b} /* open .zz{a:b}'],
		['an unterminated block', '.a{a:b}.zz{a:b'],
		['an unterminated string', '.a{a:b}.zz{content:"x}'],
		['a stray closing brace', '.a{a:b}}.zz{a:b}'],
		['a stray declaration', '.a{a:b}color:red;.zz{a:b}'],
		['a statement with no rule', '.a{a:b}.zz;.zz{a:b}'],
		['an unclosed url', '.a{a:b}.zz{background:url(x}']
	])('keeps the rest byte for byte after %s', (_, tail) => {
		const out = trimCss(`.zz{a:b}${tail}`, tokens);
		expect(out.css).toBe(tail);
		expect(out.removedRules).toBe(1);
	});

	it('keeps an unparseable tail inside a group while trimming what came before it', () => {
		const out = trimCss('@media x{.zz{a:b}.a{a:b}}stray}.zz{a:b}', tokens);
		expect(out.css).toBe('@media x{.a{a:b}}stray}.zz{a:b}');
	});

	it('is idempotent and the identity on a sheet every token covers', () => {
		const css = '.a{a:b}\n@media x{.zz{a:b}.b .yy{a:b}}\n.zz:hover,.xx{a:b}\n.b{a:b}';
		const once = trimCss(css, tokens);
		expect(once.removedRules).toBe(3);
		expect(trimCss(once.css, tokens)).toEqual({ css: once.css, removedRules: 0, missing: [] });
		const covered = set('a', 'b', 'zz', 'yy', 'xx');
		expect(trimCss(css, covered)).toEqual({ css, removedRules: 0, missing: [] });
	});

	it('keeps the order of what it keeps', () => {
		const out = trimCss('.b{o:1}.zz{o:2}.a{o:3}.yy{o:4}.b{o:5}', tokens);
		expect(out.css).toBe('.b{o:1}.a{o:3}.b{o:5}');
	});

	it('returns an empty sheet and a sheet of only comments unchanged', () => {
		expect(trimCss('', tokens)).toEqual({ css: '', removedRules: 0, missing: [] });
		expect(trimCss('/* x */\n', tokens).css).toBe('/* x */\n');
	});
});

describe('trimKey and stripTrimParam', () => {
	it('keys a file by path and query, whatever the origin', () => {
		expect(trimKey('https://a.edu/css/x.css?delta=0&theme=t')).toBe(
			'/css/x.css?delta=0&theme=t'
		);
		expect(trimKey('/css/x.css')).toBe('/css/x.css');
		expect(trimKey('//cdn.a.edu/x.css#top')).toBe('/x.css');
	});

	it('drops spool-trim and leaves every other parameter byte for byte', () => {
		expect(stripTrimParam('?a=b%20c&spool-trim=0&d')).toBe('?a=b%20c&d');
		expect(stripTrimParam('?spool-trim=0')).toBe('');
		expect(stripTrimParam('?a=1')).toBe('?a=1');
		expect(stripTrimParam('')).toBe('');
		expect(trimKey('/x.css?spool-trim=0&v=1')).toBe('/x.css?v=1');
	});
});

describe('buildTrimManifest', () => {
	const css = '.a{c:d}.only-on-page-2{c:d}.never{c:d}.from-js{c:d}';
	const pages = ['<body class="a"></body>', '<body class="only-on-page-2"></body>'];
	const scripts = [{ url: 'https://a.edu/js/app.js?v=1', text: 'add("from-js")' }];

	it('trims against every page and script, and records hash, missing and scripts', async () => {
		const manifest = await buildTrimManifest({
			pages,
			scripts,
			styles: [{ url: 'https://a.edu/css/site.css?v=2', text: css }]
		});
		expect(manifest).toEqual({
			schema: 1,
			styles: {
				'/css/site.css?v=2': {
					source: await sourceHash(css),
					css: '.a{c:d}.only-on-page-2{c:d}.from-js{c:d}',
					missing: ['never'],
					scripts: ['/js/app.js?v=1']
				}
			}
		});
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
	});

	it('widens the tokens with the words of other-origin scripts and leaves them out of scripts', async () => {
		const manifest = await buildTrimManifest({
			pages,
			scripts,
			foreignScripts: [{ url: 'https://widgets.test/w.js', text: 'html="<i class=never>"' }],
			styles: [
				{ url: '/css/site.css', text: css },
				{ url: '/css/other.css', text: `${css}.zzz{c:d}` }
			]
		});
		expect(manifest.styles['/css/site.css']).toBeUndefined();
		expect(manifest.styles['/css/other.css']?.css).toBe(css);
		expect(manifest.styles['/css/other.css']?.missing).toEqual(['zzz']);
		expect(manifest.styles['/css/other.css']?.scripts).toEqual(['/js/app.js?v=1']);
	});

	it('hashes the UTF-8 bytes as sha256-<base64>', async () => {
		expect(await sourceHash('abc')).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
		expect(await sourceHash(new TextEncoder().encode('abc'))).toBe(await sourceHash('abc'));
	});

	it('gives no entry to a stylesheet that loses nothing, and keeps the first of a repeated URL', async () => {
		const manifest = await buildTrimManifest({
			pages,
			scripts: [],
			styles: [
				{ url: '/whole.css', text: '.a{c:d}' },
				{ url: '/dup.css', text: '.never{c:d}' },
				{ url: '/dup.css', text: '.other{c:d}.a{c:d}' }
			]
		});
		expect(Object.keys(manifest.styles)).toEqual(['/dup.css']);
		expect(manifest.styles['/dup.css']?.css).toBe('');
	});

	it('is stable: building twice gives the same manifest', async () => {
		const input = { pages, scripts, styles: [{ url: '/s.css', text: css }] };
		expect(await buildTrimManifest(input)).toEqual(await buildTrimManifest(input));
	});
});

describe('guardPage', () => {
	const manifest: TrimManifest = {
		schema: 1,
		styles: {
			'/a.css?v=1&x=2': { source: 's', css: '', missing: ['gone'], scripts: ['/app.js'] },
			'/b.css': { source: 's', css: '', missing: [], scripts: ['/app.js'] }
		}
	};
	const links =
		'<link rel="stylesheet" href="/a.css?v=1&amp;x=2"><link rel=stylesheet href=/b.css>' +
		'<link rel="stylesheet" href="/untrimmed.css"><link rel="stylesheet" href="https://cdn.test/b.css">';
	const page = (body: string, extra = '') =>
		`<html><head>${links}<script src="/app.js"></script>${extra}</head><body ${body}></body></html>`;
	const url = 'https://site.test/news';

	it('leaves a page alone when none of its tokens is missing and its scripts are known', () => {
		const html = page('class="ok"');
		expect(guardPage(html, manifest, url)).toEqual({
			html,
			fired: false,
			files: ['/a.css?v=1&x=2', '/b.css']
		});
	});

	it('fires on a missing token and rewrites only the links to trimmed files', () => {
		const guard = guardPage(page('class="gone"'), manifest, url);
		expect(guard.fired).toBe(true);
		expect(guard.reason).toBe('token');
		expect(guard.html).toBe(
			page('class="gone"').replace(
				links,
				'<link rel="stylesheet" href="/a.css?v=1&amp;x=2&amp;spool-trim=0">' +
					'<link rel=stylesheet href="/b.css?spool-trim=0">' +
					'<link rel="stylesheet" href="/untrimmed.css">' +
					'<link rel="stylesheet" href="https://cdn.test/b.css">'
			)
		);
	});

	it('fires on a missing token in another case', () => {
		const guard = guardPage(page('class="GONE"'), manifest, url);
		expect(guard.fired).toBe(true);
		expect(guard.reason).toBe('token');
	});

	it('fires on a same-origin script the manifest was not built with', () => {
		const html = page('', '<script src="/new.js?v=3"></script>');
		const guard = guardPage(html, manifest, url);
		expect(guard.fired).toBe(true);
		expect(guard.reason).toBe('script');
		expect(guard.html).toContain('href="/b.css?spool-trim=0"');
	});

	it('does not count a third-party script, which it cannot see into', () => {
		const html = page('', '<script src="https://cdn.test/x.js"></script>');
		expect(guardPage(html, manifest, url).fired).toBe(false);
	});

	it.each([
		['single-quoted', `href='/a.css?x="onload=alert(1)'`],
		['unquoted', 'href=/a.css?x="onload=alert(1)']
	])('keeps a quote in a %s href inside the attribute it writes', (_, attribute) => {
		const withQuote: TrimManifest = {
			schema: 1,
			styles: {
				'/a.css?x=%22onload=alert(1)': {
					source: 's',
					css: '',
					missing: ['gone'],
					scripts: []
				}
			}
		};
		const link = `<link rel="stylesheet" ${attribute}>`;
		const guard = guardPage(`${link}<body class="gone"></body>`, withQuote, url);
		expect(guard.fired).toBe(true);
		expect(guard.html).toBe(
			'<link rel="stylesheet" href="/a.css?x=&quot;onload=alert(1)&amp;spool-trim=0"><body class="gone"></body>'
		);
		expect(tagsOf(guard.html)[0]?.attributes.map((a) => a.name)).toEqual(['rel', 'href']);
	});

	it('puts the parameter before a fragment', () => {
		const html = '<link rel="stylesheet" href="/b.css#x"><body class="gone"></body>';
		const withB: TrimManifest = {
			schema: 1,
			styles: {
				'/b.css': { source: 's', css: '', missing: ['gone'], scripts: [] }
			}
		};
		expect(guardPage(html, withB, url).html).toContain('href="/b.css?spool-trim=0#x"');
	});

	it('reads a link with the parameter already on it as the same file', () => {
		const html = '<link rel="stylesheet" href="/b.css?spool-trim=0"><body class="gone"></body>';
		const withB: TrimManifest = {
			schema: 1,
			styles: { '/b.css': { source: 's', css: '', missing: ['gone'], scripts: [] } }
		};
		expect(guardPage(html, withB, url).files).toEqual(['/b.css']);
	});

	it('does nothing on a page that links no trimmed file', () => {
		const html = '<link rel="stylesheet" href="/untrimmed.css"><body class="gone"></body>';
		expect(guardPage(html, manifest, url)).toEqual({ html, fired: false, files: [] });
	});
});
