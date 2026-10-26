import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../../src/protocol/index';
import {
	baseMatcher,
	chooseBases,
	frameDictionaryBody,
	spoolProxy,
	type BaseCandidate,
	type DictionaryEncoder,
	type DictionaryOptions
} from '../../src/proxy/index';
import { memoryStore } from '../../src/stores/index';
import { fakeOrigin, type Reply } from './exercise';

const HOST = 'https://site.test';
const ORIGIN = 'https://origin.test';
const text = new TextEncoder();

const css = (seed: string, size = 4000) => text.encode(`.${seed}{color:red}`.repeat(size / 14));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const available = (bytes: Uint8Array) => `:${sha(bytes).toString('base64')}:`;

const CSS_REPLY = (body: Uint8Array, extra: Record<string, string> = {}): Reply => ({
	headers: {
		'content-type': 'text/css',
		'cache-control': 'public, max-age=31536000',
		etag: '"abc"',
		...extra
	},
	body
});

type Call = { dictionary: Uint8Array; input: Uint8Array; format: string };

/** an encoder that keeps a third of the bytes and records what it was asked */
function fakeEncoder() {
	const calls: Call[] = [];
	const encoder: DictionaryEncoder = async (dictionary, input, format) => {
		calls.push({ dictionary, input, format });
		return new Uint8Array(Math.floor(input.length / 3)).fill(7);
	};
	return { calls, encoder };
}

function rig(dictionary: Partial<DictionaryOptions> = {}) {
	const origin = fakeOrigin();
	const { calls, encoder } = fakeEncoder();
	const proxy = spoolProxy({
		origin: ORIGIN,
		spool: { store: memoryStore() },
		fetch: origin.fetch,
		dictionary: { encoder, ...dictionary }
	});
	const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
		proxy(new Request(`${HOST}${path}`, { ...init, headers }));
	return { ...origin, calls, encoder, proxy, call };
}

const ZERO = { registered: 0, encoded: 0, bytesIn: 0, bytesOut: 0, skipped: {} };
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const ASK = { 'accept-encoding': 'gzip, br, dcb, dcz' };

describe('registering a dictionary', () => {
	it('marks an eligible stylesheet with Use-As-Dictionary and Vary, and passes the bytes through', async () => {
		const s = rig();
		const a = css('a');
		s.replies.set('/css/a.css', CSS_REPLY(a));
		const response = await s.call('/css/a.css');
		expect(response.status).toBe(200);
		expect(response.headers.get('use-as-dictionary')).toBe(
			'match="/css/*", match-dest=("style")'
		);
		expect(response.headers.get('vary')).toBe('Accept-Encoding, Available-Dictionary');
		expect(response.headers.has('content-encoding')).toBe(false);
		expect(response.headers.get('etag')).toBe('"abc"');
		expect(await bytesOf(response)).toEqual(a);
		expect({ ...s.proxy.dictionary }).toEqual({
			...ZERO,
			registered: 1,
			skipped: { unavailable: 1 }
		});
		expect(s.calls).toHaveLength(0);
	});

	it('marks a script as a script dictionary, and the same bytes register once', async () => {
		const s = rig();
		s.replies.set('/js/app.js', {
			headers: { 'content-type': 'text/javascript; charset=utf-8' },
			body: 'console.log(1);'.repeat(40)
		});
		s.replies.set('/js/copy.js', {
			headers: { 'content-type': 'application/javascript' },
			body: 'console.log(1);'.repeat(40)
		});
		const first = await s.call('/js/app.js');
		expect(first.headers.get('use-as-dictionary')).toBe('match="/js/*", match-dest=("script")');
		await s.call('/js/copy.js');
		expect(s.proxy.dictionary.registered).toBe(1);
	});

	it('keeps the directory of a path with a query string and merges Vary into the origin value', async () => {
		const s = rig();
		s.replies.set(
			'/sites/default/files/css/css_x.css',
			CSS_REPLY(css('q'), { vary: 'Accept-Encoding, Cookie' })
		);
		const response = await s.call('/sites/default/files/css/css_x.css?delta=0&theme=t');
		expect(response.headers.get('use-as-dictionary')).toBe(
			'match="/sites/default/files/css/*", match-dest=("style")'
		);
		expect(response.headers.get('vary')).toBe('Accept-Encoding, Cookie, Available-Dictionary');
	});

	it('counts a path it cannot write as a match pattern under pattern and leaves the response alone', async () => {
		const s = rig();
		s.replies.set('/a(b)/x.css', CSS_REPLY(css('p')));
		const response = await s.call('/a(b)/x.css');
		expect(response.headers.has('use-as-dictionary')).toBe(false);
		expect({ ...s.proxy.dictionary }).toEqual({ ...ZERO, skipped: { pattern: 1 } });
	});
});

describe('encoding against a dictionary', () => {
	async function twoFiles(options: Partial<DictionaryOptions> = {}) {
		const s = rig(options);
		const a = css('a', 5000);
		const b = css('b', 6000);
		s.replies.set('/css/a.css', CSS_REPLY(a));
		s.replies.set('/css/b.css', CSS_REPLY(b));
		await s.call('/css/a.css');
		return { s, a, b };
	}

	it('answers a request that names the stored dictionary with dcz, the exact header and the encoder stream', async () => {
		const { s, a, b } = await twoFiles();
		const response = await s.call('/css/b.css', {
			...ASK,
			'available-dictionary': available(a)
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-encoding')).toBe('dcz');
		expect(response.headers.has('content-length')).toBe(false);
		expect(response.headers.get('vary')).toBe('Accept-Encoding, Available-Dictionary');
		expect(response.headers.get('etag')).toBe('W/"abc"');
		expect(response.headers.get('use-as-dictionary')).toBe(
			'match="/css/*", match-dest=("style")'
		);
		const body = await bytesOf(response);
		expect([...body.subarray(0, 8)]).toEqual([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0]);
		expect(Buffer.from(body.subarray(8, 40))).toEqual(sha(a));
		expect(body.length).toBe(40 + Math.floor(b.length / 3));
		expect(s.calls).toHaveLength(1);
		expect(s.calls[0]).toMatchObject({ dictionary: a, input: b, format: 'dcz' });
		expect({ ...s.proxy.dictionary }).toEqual({
			registered: 2,
			encoded: 1,
			bytesIn: b.length,
			bytesOut: body.length,
			skipped: { unavailable: 1 }
		});
	});

	it('takes the format from the configured order among the ones the request accepts', async () => {
		const { s, a } = await twoFiles({ formats: ['dcb', 'dcz'] });
		const ask = { 'available-dictionary': available(a) };
		const both = await s.call('/css/b.css', { ...ask, 'accept-encoding': 'dcz, dcb' });
		expect(both.headers.get('content-encoding')).toBe('dcb');
		expect([...(await bytesOf(both)).subarray(0, 4)]).toEqual([0xff, 0x44, 0x43, 0x42]);
		const only = await s.call('/css/b.css', { ...ask, 'accept-encoding': 'gzip, dcz;q=0.5' });
		expect(only.headers.get('content-encoding')).toBe('dcz');
		expect(s.calls.map((c) => c.format)).toEqual(['dcb', 'dcz']);
	});

	it('serves the plain body when the coding is missing, refused with q=0 or not configured', async () => {
		const { s, a, b } = await twoFiles();
		const ask = { 'available-dictionary': available(a) };
		for (const encoding of ['gzip, br', 'dcz;q=0, br', 'dcb', '']) {
			const response = await s.call('/css/b.css', { ...ask, 'accept-encoding': encoding });
			expect(response.headers.has('content-encoding'), encoding).toBe(false);
			expect(await bytesOf(response)).toEqual(b);
		}
		expect(s.calls).toHaveLength(0);
		expect(s.proxy.dictionary.encoded).toBe(0);
	});

	it('serves the plain body for a dictionary it does not hold, or a malformed header', async () => {
		const { s, b } = await twoFiles();
		for (const value of [
			available(css('zz')),
			'junk',
			':abc:',
			`${available(b)}, ${available(b)}`
		]) {
			const response = await s.call('/css/b.css', { ...ASK, 'available-dictionary': value });
			expect(response.headers.has('content-encoding'), value).toBe(false);
			expect(await bytesOf(response)).toEqual(b);
		}
		expect(s.calls).toHaveLength(0);
	});

	it('serves the plain body and counts failed when the encoder throws, larger when it is not smaller', async () => {
		let mode: 'throw' | 'large' = 'throw';
		const encoder: DictionaryEncoder = async (_d, input) => {
			if (mode === 'throw') throw new Error('no dictionary support');
			return new Uint8Array(input.length);
		};
		const { s, a, b } = await twoFiles({ encoder });
		const ask = { ...ASK, 'available-dictionary': available(a) };
		for (const next of ['throw', 'large'] as const) {
			mode = next;
			const response = await s.call('/css/b.css', ask);
			expect(response.status).toBe(200);
			expect(response.headers.has('content-encoding')).toBe(false);
			expect(await bytesOf(response)).toEqual(b);
		}
		expect({ ...s.proxy.dictionary }.skipped).toEqual({ unavailable: 1, failed: 1, larger: 1 });
		expect(s.proxy.dictionary.encoded).toBe(0);
	});

	it('decodes with zstd and the dictionary when the encoder is a real zstd one', async () => {
		const encoder: DictionaryEncoder = async (dictionary, input) =>
			new Uint8Array(zstdCompressSync(input, { dictionary }));
		const { s, a, b } = await twoFiles({ encoder });
		const response = await s.call('/css/b.css', {
			...ASK,
			'available-dictionary': available(a)
		});
		const body = await bytesOf(response);
		expect(response.headers.get('content-encoding')).toBe('dcz');
		expect(new Uint8Array(zstdDecompressSync(body.subarray(40), { dictionary: a }))).toEqual(b);
	});

	it('drops the least recently used dictionary past cacheBytes', async () => {
		const { s, a } = await twoFiles({ cacheBytes: 6000 });
		s.replies.set('/css/c.css', CSS_REPLY(css('c', 5000)));
		await s.call('/css/c.css');
		const response = await s.call('/css/b.css', {
			...ASK,
			'available-dictionary': available(a)
		});
		expect(response.headers.has('content-encoding')).toBe(false);
		expect(s.proxy.dictionary.registered).toBe(3);
	});
});

describe('what never takes part', () => {
	const cases: Array<{
		name: string;
		path: string;
		reply?: Reply;
		headers?: Record<string, string>;
		init?: RequestInit;
		options?: Partial<DictionaryOptions>;
		skipped?: Record<string, number>;
	}> = [
		{
			name: 'Set-Cookie',
			path: '/css/a.css',
			reply: CSS_REPLY(css('a'), { 'set-cookie': 'a=1' })
		},
		{ name: 'Authorization', path: '/css/a.css', headers: { authorization: 'Basic eDp5' } },
		{
			name: 'Cache-Control: private',
			path: '/css/a.css',
			reply: CSS_REPLY(css('a'), { 'cache-control': 'private' })
		},
		{
			name: 'Cache-Control: no-store',
			path: '/css/a.css',
			reply: CSS_REPLY(css('a'), { 'cache-control': 'no-store' })
		},
		{
			name: 'a Vary on a header the body depends on',
			path: '/css/a.css',
			reply: CSS_REPLY(css('a'), { vary: 'X-Role' })
		},
		{
			name: 'a Range request',
			path: '/css/a.css',
			headers: { range: 'bytes=0-9' },
			skipped: { range: 1 }
		},
		{
			name: 'a 404',
			path: '/css/missing.css',
			reply: { ...CSS_REPLY(css('a')), status: 404 }
		},
		{
			name: 'a path that is not matched',
			path: '/img/a.png',
			reply: { headers: { 'content-type': 'text/css' }, body: css('a') }
		},
		{
			name: 'a body that is not CSS or JavaScript',
			path: '/css/a.css',
			reply: { headers: { 'content-type': 'text/plain' }, body: css('a') }
		},
		{
			name: 'a body over maxBytes',
			path: '/css/a.css',
			options: { maxBytes: 100 },
			skipped: { size: 1 }
		},
		{ name: 'a POST', path: '/css/a.css', init: { method: 'POST', body: 'x' } }
	];

	it.each(cases)('leaves $name alone and registers nothing', async (c) => {
		const s = rig(c.options);
		s.replies.set(c.path, c.reply ?? CSS_REPLY(css('a')));
		const response = await s.call(c.path, c.headers, c.init);
		expect(response.headers.has('use-as-dictionary')).toBe(false);
		expect(response.headers.has('content-encoding')).toBe(false);
		expect({ ...s.proxy.dictionary }).toEqual({ ...ZERO, skipped: c.skipped ?? {} });
	});

	it('never encodes against a dictionary a request with Authorization names', async () => {
		const s = rig();
		const a = css('a');
		s.replies.set('/css/a.css', CSS_REPLY(a));
		s.replies.set('/css/b.css', CSS_REPLY(css('b')));
		await s.call('/css/a.css');
		const response = await s.call('/css/b.css', {
			...ASK,
			authorization: 'Basic eDp5',
			'available-dictionary': available(a)
		});
		expect(response.headers.has('content-encoding')).toBe(false);
		expect(s.calls).toHaveLength(0);
	});

	it('sets nothing and counts nothing without the dictionary option', async () => {
		const origin = fakeOrigin();
		origin.replies.set('/css/a.css', CSS_REPLY(css('a')));
		const proxy = spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			fetch: origin.fetch
		});
		const response = await proxy(new Request(`${HOST}/css/a.css`));
		expect(response.headers.has('use-as-dictionary')).toBe(false);
		expect({ ...proxy.dictionary }).toEqual(ZERO);
	});
});

describe('option validation and framing', () => {
	const bad = (dictionary: Partial<DictionaryOptions>) => () =>
		spoolProxy({
			origin: ORIGIN,
			spool: { store: memoryStore() },
			dictionary: { encoder: fakeEncoder().encoder, ...dictionary }
		});

	it('refuses a value out of range with a bad-route error', () => {
		expect(bad({ maxBytes: 0 })).toThrow(ProtocolError);
		expect(bad({ maxBytes: 1.5 })).toThrow(/maxBytes/);
		expect(bad({ cacheBytes: 0 })).toThrow(/cacheBytes/);
		expect(bad({ formats: [] })).toThrow(/formats/);
		expect(bad({ formats: ['gzip' as 'dcz'] })).toThrow(/formats/);
		expect(bad({ formats: ['dcb', 'dcz'], maxBytes: 1, cacheBytes: 1 })).not.toThrow();
	});

	it('frames a body as the magic bytes, the hash and the stream', () => {
		const hash = new Uint8Array(32).fill(9);
		const stream = Uint8Array.of(1, 2, 3);
		expect([...frameDictionaryBody('dcb', hash, stream)]).toEqual([
			0xff,
			0x44,
			0x43,
			0x42,
			...hash,
			1,
			2,
			3
		]);
		expect(frameDictionaryBody('dcz', hash, stream)).toHaveLength(8 + 32 + 3);
	});

	it('lets the match option choose the paths, and resets a global regex between requests', async () => {
		const s = rig({ match: /\/theme\/.*\.css$/g });
		s.replies.set('/theme/a.css', CSS_REPLY(css('a')));
		s.replies.set('/css/a.css', CSS_REPLY(css('a')));
		for (let i = 0; i < 3; i++) {
			expect((await s.call('/theme/a.css')).headers.has('use-as-dictionary')).toBe(true);
		}
		expect((await s.call('/css/a.css')).headers.has('use-as-dictionary')).toBe(false);
	});

	it.each([
		['a function', (pathname: string) => pathname === '/css/a.css'],
		['a regular expression', /\/a\.css$/],
		['a global regular expression', /\/a\.css$/g],
		['a list', [/nothing/, /\/a\.css$/]]
	])('registers only the responses base names, given %s', async (_name, base) => {
		const s = rig({ base });
		const a = css('a');
		const b = css('b');
		s.replies.set('/css/a.css', CSS_REPLY(a));
		s.replies.set('/css/b.css', CSS_REPLY(b));
		for (let i = 0; i < 2; i++) {
			const named = await s.call('/css/a.css');
			expect(named.headers.get('use-as-dictionary')).toBe(
				'match="/css/*", match-dest=("style")'
			);
			const other = await s.call('/css/b.css');
			expect(other.headers.has('use-as-dictionary')).toBe(false);
			expect(other.headers.get('vary')).toBe('Accept-Encoding, Available-Dictionary');
		}
		expect(s.proxy.dictionary.registered).toBe(1);
		const encoded = await s.call('/css/b.css', {
			...ASK,
			'available-dictionary': available(a)
		});
		expect(encoded.headers.get('content-encoding')).toBe('dcz');
		const unnamed = await s.call('/css/a.css', {
			...ASK,
			'available-dictionary': available(b)
		});
		expect(unnamed.headers.has('content-encoding')).toBe(false);
		expect(s.proxy.dictionary.encoded).toBe(1);
	});
});

describe('choosing bases from a crawl', () => {
	const candidate = (path: string, kind: BaseCandidate['kind'] = 'style', plain = 100) => ({
		url: `${HOST}${path}`,
		kind,
		plain
	});
	/** a delta table: each entry is [file, dictionary, delta] over candidate indexes */
	const table = (entries: Array<[number, number, number]>) => {
		const sizes = new Map(entries.map(([f, c, d]): [string, number] => [`${f}|${c}`, d]));
		return (f: number, c: number) => sizes.get(`${f}|${c}`) as number;
	};

	it('picks the member with the smallest sum of deltas and reports the mean of the others', async () => {
		const files = ['a', 'b', 'c', 'd'].map((n) => candidate(`/css/${n}.css`));
		const delta = table([
			[0, 1, 50],
			[0, 2, 10],
			[0, 3, 60],
			[1, 0, 40],
			[1, 2, 20],
			[1, 3, 60],
			[2, 0, 40],
			[2, 1, 50],
			[2, 3, 60],
			[3, 0, 40],
			[3, 1, 50],
			[3, 2, 30]
		]);
		expect(await chooseBases(files, delta)).toEqual([
			{ kind: 'style', directory: '/css/', url: `${HOST}/css/c.css`, files: 4, meanDelta: 20 }
		]);
	});

	it('breaks a tie toward the URL that sorts first, whatever the input order', async () => {
		const files = [candidate('/css/c.css'), candidate('/css/a.css'), candidate('/css/b.css')];
		const flat = () => 30;
		const forward = await chooseBases(files, flat);
		expect(forward).toEqual([
			{ kind: 'style', directory: '/css/', url: `${HOST}/css/a.css`, files: 3, meanDelta: 30 }
		]);
		expect(await chooseBases([...files].reverse(), flat)).toEqual(forward);
	});

	it('gives each directory and kind its own choice, sorted, and no base to a lone file', async () => {
		const files = [
			candidate('/theme/y.css'),
			candidate('/js/lib.js', 'script'),
			candidate('/solo/one.js', 'script'),
			candidate('/css/b.css'),
			candidate('/theme/x.css'),
			candidate('/css/a.css'),
			candidate('/js/app.js', 'script'),
			candidate('/css/b.js', 'script'),
			candidate('/css/a.js', 'script')
		];
		expect(await chooseBases(files, () => 10)).toEqual([
			{
				kind: 'script',
				directory: '/css/',
				url: `${HOST}/css/a.js`,
				files: 2,
				meanDelta: 10
			},
			{
				kind: 'style',
				directory: '/css/',
				url: `${HOST}/css/a.css`,
				files: 2,
				meanDelta: 10
			},
			{
				kind: 'script',
				directory: '/js/',
				url: `${HOST}/js/app.js`,
				files: 2,
				meanDelta: 10
			},
			{
				kind: 'style',
				directory: '/theme/',
				url: `${HOST}/theme/x.css`,
				files: 2,
				meanDelta: 10
			}
		]);
	});

	it('caps each member at its plain size, so a poor delta cannot make a base', async () => {
		const delta = table([
			[0, 1, 90],
			[2, 1, 30],
			[0, 2, 25],
			[1, 2, 40],
			[1, 0, 40],
			[2, 0, 40]
		]);
		const capped = [
			candidate('/css/a.css', 'style', 20),
			candidate('/css/b.css'),
			candidate('/css/c.css')
		];
		expect(await chooseBases(capped, delta)).toEqual([
			{ kind: 'style', directory: '/css/', url: `${HOST}/css/b.css`, files: 3, meanDelta: 25 }
		]);
		const uncapped = [
			candidate('/css/a.css', 'style', 1000),
			candidate('/css/b.css'),
			candidate('/css/c.css')
		];
		expect(await chooseBases(uncapped, delta)).toEqual([
			{
				kind: 'style',
				directory: '/css/',
				url: `${HOST}/css/c.css`,
				files: 3,
				meanDelta: 32.5
			}
		]);
	});

	it('awaits an async delta, asks for each ordered pair of a group once and never for a lone file', async () => {
		let calls = 0;
		const delta = async () => {
			calls++;
			return 30;
		};
		const files = [
			candidate('/css/a.css'),
			candidate('/css/b.css'),
			candidate('/css/c.css'),
			candidate('/solo/x.css')
		];
		expect(await chooseBases(files, delta)).toEqual([
			{ kind: 'style', directory: '/css/', url: `${HOST}/css/a.css`, files: 3, meanDelta: 30 }
		]);
		expect(calls).toBe(6);
		calls = 0;
		expect(await chooseBases([candidate('/solo/x.css')], delta)).toEqual([]);
		expect(calls).toBe(0);
	});

	it('matches the exact pathnames of the chosen bases and ignores their query strings', () => {
		const matcher = baseMatcher([
			{
				kind: 'style',
				directory: '/css/',
				url: `${HOST}/css/a.css?v=3`,
				files: 2,
				meanDelta: 10
			},
			{ kind: 'script', directory: '/js/', url: `${HOST}/js/app.js`, files: 2, meanDelta: 10 }
		]);
		expect(['/css/a.css', '/js/app.js'].map((p) => matcher(p))).toEqual([true, true]);
		const others = ['/css/b.css', '/css/a.css/', '/css/a.css.map', '/js/app.js/', '/css/', '/'];
		expect(others.map((p) => matcher(p))).toEqual([false, false, false, false, false, false]);
	});

	it('registers only the chosen base when its matcher is the dictionary base', async () => {
		const choices = await chooseBases(
			[candidate('/css/a.css'), candidate('/css/b.css')],
			table([
				[1, 0, 10],
				[0, 1, 50]
			])
		);
		const s = rig({ base: baseMatcher(choices) });
		s.replies.set('/css/a.css', CSS_REPLY(css('a')));
		s.replies.set('/css/b.css', CSS_REPLY(css('b')));
		const base = await s.call('/css/a.css');
		expect(base.headers.get('use-as-dictionary')).toBe('match="/css/*", match-dest=("style")');
		const other = await s.call('/css/b.css');
		expect(other.headers.has('use-as-dictionary')).toBe(false);
		expect(s.proxy.dictionary.registered).toBe(1);
	});
});
