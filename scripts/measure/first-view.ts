import type { Browser, Request, Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	brotliCompressSync,
	brotliDecompressSync,
	deflateSync,
	gunzipSync,
	gzipSync,
	inflateRawSync,
	inflateSync,
	zstdCompressSync,
	zstdDecompressSync
} from 'node:zlib';
import { isMain, utcDate } from './lib.ts';

const HELP = `Usage: bun scripts/measure/first-view.ts record --sites FILE --out DIR [--force] [--dry-run]
       bun scripts/measure/first-view.ts record --add --sites FILE --out DIR [--reserve BYTES]
       bun scripts/measure/first-view.ts facades --corpus DIR
       node scripts/measure/first-view.ts serve --corpus DIR [--port N] [--control N]

record: loads each page once in Chromium with an empty profile, waits for load and a quiet period,
and keeps every response of the first view as the server sent it (encoded bytes, with the
content-encoding). The sites file has one site per line; words after the site are extra page paths
recorded as embed pages. The corpus is written to DIR (index.json, pages/, bodies/, tls/).
record --add records only the listed paths into an existing corpus, under its cap plus --reserve.
facades rebuilds the facade variant of every kept page's main document from its stored bytes.

serve: a local HTTPS replay of a corpus. Chromium maps every host to this server with
--host-resolver-rules. A request with no recorded response gets a 404 and is counted as missed.
The facade variant is read from the corpus; serve does not rewrite anything.`;

/** a page whose wire bytes pass this is excluded from the corpus */
export const PAGE_CAP_BYTES = 12_000_000;
/** a response longer than this is recorded as truncated and not replayed */
export const FILE_CAP_BYTES = 20_000_000;
/** the corpus stops growing at this many unique stored bytes */
export const CORPUS_CAP_BYTES = 150_000_000;
/** the wait after `load`, in which late requests are recorded and replayed */
export const QUIET_MS = 6000;
/** the replay's HTTPS port and its control port on 127.0.0.1 */
export const REPLAY_PORT = 8971;
export const CONTROL_PORT = 8972;

const NAV_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 30_000;
const INNER_CANDIDATES = 5;
export const VIEWPORT = { width: 1440, height: 900 };

export const PAGE_CLASSES = [
	'document',
	'script',
	'stylesheet',
	'image',
	'media',
	'font',
	'other'
] as const;

/** the class a request counts as, from Playwright's resource type */
export type PageClass = (typeof PAGE_CLASSES)[number];

export function classOf(resourceType: string): PageClass {
	return PAGE_CLASSES.includes(resourceType as PageClass) ? (resourceType as PageClass) : 'other';
}

/** the fresh byte count per class, zero for every class */
export const emptyBytes = (): Record<PageClass, number> =>
	Object.fromEntries(PAGE_CLASSES.map((c) => [c, 0])) as Record<PageClass, number>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** the user agent the record and the replay both send, so the page sees one browser */
export const userAgent = (version: string) =>
	`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

/** request headers the rig does not forward; a range is dropped so each resource is stored whole */
const DROPPED_REQUEST = new Set([
	'host',
	'connection',
	'content-length',
	'keep-alive',
	'proxy-connection',
	'te',
	'upgrade',
	'range',
	'if-range'
]);

/** what Chromium sends; the route handler's request headers leave it out, so the record adds it */
export const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

/** the headers a recorded request is forwarded to its origin with */
export function forwardHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!DROPPED_REQUEST.has(name)) out[name] = value;
	}
	out['accept-encoding'] ??= ACCEPT_ENCODING;
	return out;
}

/** response headers the replay keeps; the rest are either hop-by-hop or depend on cookies */
export const KEPT_HEADERS = [
	'content-type',
	'content-encoding',
	'cache-control',
	'access-control-allow-origin',
	'access-control-allow-credentials',
	'vary',
	'content-security-policy',
	'location'
];

/** the codings of a content-encoding value, in the order they were applied */
export function codings(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((c) => c.trim().toLowerCase())
		.filter((c) => c !== '' && c !== 'identity');
}

function decodeOne(body: Buffer, coding: string): Buffer {
	switch (coding) {
		case 'gzip':
		case 'x-gzip':
			return gunzipSync(body);
		case 'deflate':
			try {
				return inflateSync(body);
			} catch {
				return inflateRawSync(body);
			}
		case 'br':
			return brotliDecompressSync(body);
		case 'zstd':
			return zstdDecompressSync(body);
		default:
			throw new Error(`no decoder for ${coding}`);
	}
}

/** the body as the browser sees it after the content-encoding is undone */
export function decodeBody(body: Buffer, value: string | undefined): Buffer {
	let out = body;
	for (const coding of codings(value).reverse()) out = decodeOne(out, coding);
	return out;
}

/** the body encoded again with the codings of `value`, at default levels */
export function encodeBody(body: Buffer, value: string | undefined): Buffer {
	let out = body;
	for (const coding of codings(value)) {
		switch (coding) {
			case 'gzip':
			case 'x-gzip':
				out = gzipSync(out);
				break;
			case 'deflate':
				out = deflateSync(out);
				break;
			case 'br':
				out = brotliCompressSync(out);
				break;
			case 'zstd':
				out = zstdCompressSync(out);
				break;
			default:
				throw new Error(`no encoder for ${coding}`);
		}
	}
	return out;
}

/** the wire bytes of each class, and their total, over the responses a page counts */
export function classTotals(responses: readonly Pick<Stored, 'cls' | 'wireBytes'>[]): {
	classBytes: Record<PageClass, number>;
	wireBytes: number;
} {
	const classBytes = emptyBytes();
	for (const r of responses) classBytes[r.cls] += r.wireBytes;
	return { classBytes, wireBytes: Object.values(classBytes).reduce((s, v) => s + v, 0) };
}

/** the replay key of a request: method, host, path and query (no fragment, no cookie) */
export function keyOf(method: string, url: string): string {
	const u = new URL(url);
	return `${method.toUpperCase()} ${u.host}${u.pathname}${u.search}`;
}

/** the response headers a manifest keeps, duplicates joined the way HTTP joins them */
export function keptHeaders(
	pairs: ReadonlyArray<readonly [string, string]>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of pairs) {
		if (!KEPT_HEADERS.includes(name)) continue;
		out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
	}
	return out;
}

/** a response as the replay sends it */
export type Entry = {
	key: string;
	status: number;
	headers: Record<string, string>;
	body: Buffer;
	cls: PageClass;
};

/** one response as a page manifest stores it; `sha1` is null for a truncated one */
export type Stored = {
	method: string;
	url: string;
	status: number;
	headers: Record<string, string>;
	sha1: string | null;
	bytes: number;
	wireBytes: number;
	cls: PageClass;
	frame: 'main' | 'iframe';
	truncated?: true;
	extra?: true;
};

/** a page as `pages/<id>.json` stores it */
export type Manifest = {
	id: string;
	site: string;
	kind: 'home' | 'internal' | 'embed';
	url: string;
	ok: true | string;
	excluded: string | null;
	docStatus: number;
	csp: boolean;
	requests: number;
	wireBytes: number;
	classBytes: Record<PageClass, number>;
	sameOrigin: number;
	crossOrigin: number;
	iframes: { youtube: number; vimeo: number };
	/** how many iframes the facade variant rewrites; 0 when there is no facade */
	facadeRewrites: number;
	/** the body of the facade variant in `bodies/`, or null when the page has none */
	facadeSha1: string | null;
	truncated: Array<{ url: string; bytes: number }>;
	hosts: string[];
	failed: string[];
	responses: Stored[];
};

/** a page's row in `index.json`; `file` is null when the page is excluded and has no manifest */
export type IndexPage = Omit<Manifest, 'responses' | 'failed' | 'truncated'> & {
	file: string | null;
	truncated: number;
};

export type Index = {
	schema: 1;
	date: string;
	cap: { page: number; file: number; corpus: number };
	/** bytes added to the corpus cap by `record --add`; 0 for the main pass */
	reserved?: number;
	quietMs: number;
	viewport: typeof VIEWPORT;
	pages: IndexPage[];
	/** wire bytes of the kept pages */
	wireBytes: number;
	/** unique body bytes on disk, the size the corpus cap counts */
	storedBytes: number;
	sites: number;
};

// #region the replay

/** the request answered from the corpus: counts and the response to send */
export type Served = { status: number; headers: Record<string, string>; body: Buffer };

export type Stats = {
	served: Record<PageClass, number>;
	servedTotal: number;
	requests: number;
	missed: number;
	outside: number;
	missedKeys: string[];
	preflights: number;
	conditional: number;
	notModified: number;
	cpuUs: number;
};

/**
 * The entries of one page, with counters that the control port reads and resets per window. A
 * request to a host the page never used is browser traffic: it gets a 404 and counts as `outside`.
 */
export class Replay {
	private entries = new Map<string, Entry>();
	private hosts = new Set<string>();
	private served = emptyBytes();
	private requests = 0;
	private missed = 0;
	private outside = 0;
	private missedKeys: string[] = [];
	private preflights = 0;
	private conditional = 0;
	private notModified = 0;

	load(entries: Iterable<Entry>, hosts: Iterable<string>): void {
		this.entries = new Map();
		for (const entry of entries)
			if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
		this.hosts = new Set(hosts);
		this.reset();
	}

	replace(entry: Entry): void {
		this.entries.set(entry.key, entry);
	}

	reset(): void {
		this.served = emptyBytes();
		this.requests = 0;
		this.missed = 0;
		this.outside = 0;
		this.missedKeys = [];
		this.preflights = 0;
		this.conditional = 0;
		this.notModified = 0;
	}

	answer(
		method: string,
		url: string,
		requestHeaders: Record<string, string>
	): Served & { cls: PageClass | null } {
		if (method === 'OPTIONS') {
			this.preflights++;
			const origin = requestHeaders.origin ?? '*';
			return {
				status: 204,
				headers: {
					'access-control-allow-origin': origin,
					'access-control-allow-credentials': 'true',
					'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
					'access-control-allow-headers':
						requestHeaders['access-control-request-headers'] ?? '*',
					'access-control-max-age': '600'
				},
				body: Buffer.alloc(0),
				cls: null
			};
		}
		this.requests++;
		const revalidates =
			'if-none-match' in requestHeaders || 'if-modified-since' in requestHeaders;
		if (revalidates) this.conditional++;
		const key = keyOf(method, url);
		const entry = this.entries.get(key);
		if (!entry) {
			if (this.hosts.has(new URL(url).host)) {
				this.missed++;
				if (this.missedKeys.length < 50) this.missedKeys.push(key);
			} else {
				this.outside++;
			}
			return {
				status: 404,
				headers: { 'content-type': 'text/plain' },
				body: Buffer.from('not recorded'),
				cls: null
			};
		}
		this.served[entry.cls] += entry.body.length;
		if (entry.status === 304) this.notModified++;
		return { status: entry.status, headers: entry.headers, body: entry.body, cls: entry.cls };
	}

	stats(): Stats {
		const served = { ...this.served };
		const cpu = process.cpuUsage();
		return {
			served,
			servedTotal: Object.values(served).reduce((s, v) => s + v, 0),
			requests: this.requests,
			missed: this.missed,
			outside: this.outside,
			missedKeys: [...this.missedKeys],
			preflights: this.preflights,
			conditional: this.conditional,
			notModified: this.notModified,
			cpuUs: cpu.user + cpu.system
		};
	}
}

/** the stored responses of a page, with their bodies read from `bodies/` */
export function entriesOf(dir: string, responses: readonly Stored[]): Entry[] {
	const cache = new Map<string, Buffer>();
	const out: Entry[] = [];
	for (const r of responses) {
		if (r.sha1 === null) continue;
		let body = cache.get(r.sha1);
		if (!body) {
			body = readFileSync(join(dir, 'bodies', r.sha1));
			cache.set(r.sha1, body);
		}
		out.push({
			key: keyOf(r.method, r.url),
			status: r.status,
			headers: r.headers,
			body,
			cls: r.cls
		});
	}
	return out;
}

/** the entries with the main document's body replaced by a stored facade variant, or null when there is no main document */
export function withFacade(entries: readonly Entry[], mainKey: string, body: Buffer): Entry | null {
	const main = entries.find((e) => e.key === mainKey && e.cls === 'document');
	return main ? { ...main, body } : null;
}

export function readManifest(dir: string, id: string): Manifest {
	return JSON.parse(readFileSync(join(dir, 'pages', `${id}.json`), 'utf8')) as Manifest;
}

export function readIndex(dir: string): Index {
	return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Index;
}

/** the Chromium flags of a replay: every host resolves to the replay server */
export function replayArgs(port: number): string[] {
	return [`--host-resolver-rules=MAP * 127.0.0.1:${port}`, '--ignore-certificate-errors'];
}

/**
 * The Chromium flags of a warm replay: the same host mapping, but only the replay certificate is
 * accepted. Chromium's HTTP cache does not keep a new tab's responses under the blanket flag.
 */
export function warmReplayArgs(port: number, spki: string): string[] {
	return [
		`--host-resolver-rules=MAP * 127.0.0.1:${port}`,
		`--ignore-certificate-errors-spki-list=${spki}`
	];
}

/** the base64 SHA-256 of a certificate's public key, the form `--ignore-certificate-errors-spki-list` takes */
export function spkiOf(certPem: string): string {
	return createHash('sha256')
		.update(createPublicKey(certPem).export({ type: 'spki', format: 'der' }))
		.digest('base64');
}

/** the corpus pages a run measures, with the bytes the attributional figure and the fit need */
export function corpusPages(index: Index) {
	const usable = index.pages.filter((p) => p.excluded === null);
	return usable.map((p) => ({
		id: p.id,
		url: p.url,
		site: new URL(p.url).host,
		kind: p.kind,
		wireBytes: p.wireBytes,
		classBytes: p.classBytes,
		iframes: p.iframes,
		facade: p.facadeSha1 !== null && p.facadeRewrites > 0,
		requests: p.requests
	}));
}

function serve(corpus: string, port: number, control: number): void {
	const replay = new Replay();
	const cert = readFileSync(join(corpus, 'tls', 'cert.pem'));
	const key = readFileSync(join(corpus, 'tls', 'key.pem'));
	const secure = https.createServer({ key, cert }, (req, res) => {
		req.resume();
		const url = `https://${req.headers.host ?? ''}${req.url ?? '/'}`;
		const headers = Object.fromEntries(
			Object.entries(req.headers).map(([k, v]) => [
				k,
				Array.isArray(v) ? v.join(', ') : (v ?? '')
			])
		);
		const out = replay.answer(req.method ?? 'GET', url, headers);
		res.writeHead(out.status, { ...out.headers, 'content-length': String(out.body.length) });
		res.end(out.body);
	});
	const admin = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (url.pathname === '/select') {
			const id = url.searchParams.get('id') ?? '';
			const arm = url.searchParams.get('arm') ?? 'original';
			const manifest = readManifest(corpus, id);
			const entries = entriesOf(corpus, manifest.responses);
			replay.load(entries, manifest.hosts);
			const facade =
				arm === 'facade' && manifest.facadeSha1 !== null
					? withFacade(
							entries,
							keyOf('GET', manifest.url),
							readFileSync(join(corpus, 'bodies', manifest.facadeSha1))
						)
					: null;
			if (facade) replay.replace(facade);
			res.end(JSON.stringify({ id, arm, entries: entries.length, facade: facade !== null }));
			return;
		}
		if (url.pathname === '/__stats') {
			res.end(JSON.stringify(replay.stats()));
			return;
		}
		res.statusCode = 404;
		res.end('');
	});
	secure.listen(port, '127.0.0.1');
	admin.listen(control, '127.0.0.1', () => console.log(JSON.stringify({ port, control })));
}

// #endregion

// #region the record

/** a raw HTTP answer as the origin sent it, with the header block's size as the client read it */
export type Raw = {
	status: number;
	headers: Array<[string, string]>;
	body: Buffer;
	headerBytes: number;
	truncated: boolean;
};

/** Node's default of 16 KiB rejects a www.youtube.com embed with "Header overflow" */
export const MAX_RESPONSE_HEADER_BYTES = 256 * 1024;

/**
 * One request to the origin with no decoding and no redirect following. The body stops at `cap`
 * bytes, and `truncated` says so.
 */
export function rawFetch(
	url: string,
	method: string,
	headers: Record<string, string>,
	payload: Buffer | undefined,
	cap: number
): Promise<Raw> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const client = target.protocol === 'http:' ? http : https;
		const sent = payload ? { ...headers, 'content-length': String(payload.length) } : headers;
		const options = { method, headers: sent, maxHeaderSize: MAX_RESPONSE_HEADER_BYTES };
		const req = client.request(target, options, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let truncated = false;
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				const pairs = res.rawHeaders.reduce<Array<[string, string]>>(
					(list, value, i, all) =>
						i % 2 === 0 ? [...list, [value.toLowerCase(), all[i + 1] ?? '']] : list,
					[]
				);
				const headerBytes =
					`HTTP/1.1 ${res.statusCode ?? 0} ${res.statusMessage ?? ''}\r\n`.length +
					pairs.reduce((s, [n, v]) => s + n.length + v.length + 4, 0) +
					2;
				resolve({
					status: res.statusCode ?? 0,
					headers: pairs,
					body: Buffer.concat(chunks),
					headerBytes,
					truncated
				});
			};
			res.on('data', (chunk: Buffer) => {
				if (truncated) return;
				const room = cap - size;
				if (chunk.length > room) {
					chunks.push(chunk.subarray(0, Math.max(0, room)));
					size = cap;
					truncated = true;
					res.destroy();
				} else {
					chunks.push(chunk);
					size += chunk.length;
				}
			});
			res.once('end', finish);
			res.once('close', finish);
			res.once('error', () => undefined);
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
		req.on('error', (error) => {
			reject(error);
		});
		if (payload) req.write(payload);
		req.end();
	});
}

/** the page's headers as the browser may keep them: the record sends them with the decoded body */
function browserHeaders(
	pairs: ReadonlyArray<readonly [string, string]>,
	length: number
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of pairs) {
		if (
			[
				'set-cookie',
				'connection',
				'keep-alive',
				'transfer-encoding',
				'content-length',
				'content-encoding',
				'alt-svc',
				'proxy-connection',
				'upgrade'
			].includes(name)
		)
			continue;
		out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
	}
	out['content-length'] = String(length);
	return out;
}

const YOUTUBE_EMBED = /youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,64})/;

class PageRecorder {
	readonly responses: Stored[] = [];
	readonly bodies = new Map<string, Buffer>();
	readonly failed: string[] = [];
	mainDoc: string | null = null;
	mainStatus = 0;
	mainCsp = false;
	mainEncoding: string | undefined = undefined;
}

const MAX_HOPS = 5;

/** the URL a 3xx answer points at, resolved against the request's URL, or null for any other answer */
export function redirectOf(raw: Pick<Raw, 'status' | 'headers'>, base: string): string | null {
	const location = raw.headers.find(([n]) => n === 'location')?.[1];
	if (location === undefined || raw.status < 300 || raw.status > 399) return null;
	return new URL(location, base).href;
}

/**
 * Where a navigation to `url` ends. The browser does not follow a redirect that a route fulfils, so
 * the redirects are followed here and the browser starts at the final URL.
 */
export async function finalUrl(url: string, version: string): Promise<string> {
	let current = url;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		let raw: Raw;
		try {
			raw = await rawFetch(
				current,
				'GET',
				{
					'user-agent': userAgent(version),
					accept: 'text/html,*/*;q=0.8',
					'accept-encoding': ACCEPT_ENCODING
				},
				undefined,
				65_536
			);
		} catch {
			return current;
		}
		const next = redirectOf(raw, current);
		if (next === null) return current;
		current = next;
	}
	return current;
}

/** keeps a body under its SHA-1 and returns the name it is stored by */
function storeBody(bodies: Map<string, Buffer>, body: Buffer): string {
	const sha1 = createHash('sha1').update(body).digest('hex');
	bodies.set(sha1, body);
	return sha1;
}

/**
 * Answers one request of a recorded page. Each hop of a redirect is stored as its own response, so
 * the replay can answer the same chain; the browser gets the last hop, decoded.
 */
async function recordRequest(route: Route, request: Request, rec: PageRecorder): Promise<void> {
	const url = request.url();
	if (!/^https?:\/\//.test(url)) return route.continue();
	const headers = forwardHeaders(request.headers());
	const isMainDoc = request.isNavigationRequest() && request.frame().parentFrame() === null;
	const cls = classOf(request.resourceType());
	const frame = isMainDoc ? 'main' : 'iframe';
	let target = url;
	let method = request.method();
	let payload = request.postDataBuffer() ?? undefined;
	let last: Raw | null = null;
	for (let hop = 0; hop < MAX_HOPS; hop++) {
		let raw: Raw;
		try {
			raw = await rawFetch(target, method, headers, payload, FILE_CAP_BYTES);
		} catch (error) {
			rec.failed.push(`${new URL(target).host}: ${String(error).slice(0, 120)}`);
			return route.abort('failed');
		}
		last = raw;
		const sha1 = raw.truncated ? null : storeBody(rec.bodies, raw.body);
		rec.responses.push({
			method,
			url: target,
			status: raw.status,
			headers: keptHeaders(raw.headers),
			sha1,
			bytes: raw.body.length,
			wireBytes: raw.body.length + raw.headerBytes,
			cls,
			frame,
			...(raw.truncated ? { truncated: true as const } : {})
		});
		if (raw.truncated) return route.abort('failed');
		const next = redirectOf(raw, target);
		if (next === null) break;
		target = next;
		if (method !== 'GET' && method !== 'HEAD' && raw.status < 307) {
			method = 'GET';
			payload = undefined;
		}
	}
	const final = last as Raw;
	const encoding = final.headers.find(([n]) => n === 'content-encoding')?.[1];
	let decoded: Buffer;
	try {
		decoded = decodeBody(final.body, encoding);
	} catch (error) {
		rec.failed.push(`${new URL(target).host}: ${String(error).slice(0, 120)}`);
		return route.abort('failed');
	}
	if (isMainDoc) {
		rec.mainDoc = decoded.toString('utf8');
		rec.mainStatus = final.status;
		rec.mainCsp = final.headers.some(([n]) => n === 'content-security-policy');
		rec.mainEncoding = encoding;
	}
	return route.fulfill({
		status: final.status,
		headers: browserHeaders(final.headers, decoded.length),
		body: decoded
	});
}

/**
 * The facade variant of a main document: each YouTube or Vimeo iframe the rewrite changes, encoded
 * as the original was. Null when nothing changes. Record-time only: the replay reads the result.
 */
export async function makeFacade(
	html: string,
	encoding: string | undefined,
	csp: boolean
): Promise<{ body: Buffer; rewritten: number } | null> {
	const { rewriteEmbeds } = await import('../../src/media/embeds.ts');
	const result = rewriteEmbeds(html, {}, { csp });
	if (result.rewritten === 0) return null;
	return {
		body: encodeBody(Buffer.from(result.html, 'utf8'), encoding),
		rewritten: result.rewritten
	};
}

export type Recorded = { manifest: Manifest; bodies: Map<string, Buffer>; mainDoc: string | null };

/** one page loaded cold, with its responses kept; a page over the cap or a failed load is marked excluded */
export async function recordPage(
	browser: Browser,
	version: string,
	url: string,
	id: string,
	kind: Manifest['kind']
): Promise<Recorded> {
	const context = await browser.newContext({
		serviceWorkers: 'block',
		userAgent: userAgent(version),
		viewport: VIEWPORT
	});
	const target = await finalUrl(url, version);
	const rec = new PageRecorder();
	await context.route('**/*', (route, request) => recordRequest(route, request, rec));
	const page = await context.newPage();
	let ok: true | string = true;
	try {
		await page.goto(target, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
	} catch (error) {
		ok = String(error).slice(0, 160);
	}
	let frames: string[] = [];
	if (ok === true) {
		await sleep(QUIET_MS);
		frames = await page
			.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src))
			.catch(() => []);
	}
	await context.close();
	const embedIds = new Set<string>();
	for (const frame of frames) {
		const hit = YOUTUBE_EMBED.exec(frame);
		if (hit?.[1]) embedIds.add(hit[1]);
	}
	for (const id of embedIds) {
		const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
		try {
			const raw = await rawFetch(
				thumb,
				'GET',
				{ 'user-agent': userAgent(version) },
				undefined,
				FILE_CAP_BYTES
			);
			const sha1 = storeBody(rec.bodies, raw.body);
			rec.responses.push({
				method: 'GET',
				url: thumb,
				status: raw.status,
				headers: keptHeaders(raw.headers),
				sha1,
				bytes: raw.body.length,
				wireBytes: raw.body.length + raw.headerBytes,
				cls: 'image',
				frame: 'iframe',
				extra: true
			});
		} catch (error) {
			rec.failed.push(`i.ytimg.com: ${String(error).slice(0, 120)}`);
		}
	}
	const facade =
		ok === true && rec.mainDoc !== null
			? await makeFacade(rec.mainDoc, rec.mainEncoding, rec.mainCsp)
			: null;
	const facadeSha1 = facade ? storeBody(rec.bodies, facade.body) : null;
	const manifest = manifestOf(
		rec,
		id,
		target,
		kind,
		ok,
		frames,
		facade?.rewritten ?? 0,
		facadeSha1
	);
	return { manifest, bodies: rec.bodies, mainDoc: rec.mainDoc };
}

function manifestOf(
	rec: PageRecorder,
	id: string,
	url: string,
	kind: Manifest['kind'],
	ok: true | string,
	frames: readonly string[],
	facadeRewrites: number,
	facadeSha1: string | null
): Manifest {
	const real = rec.responses.filter((r) => !r.extra);
	const { classBytes, wireBytes } = classTotals(real);
	const host = new URL(url).host;
	const sameOrigin = real.filter((r) => new URL(r.url).host === host).length;
	const docOk = rec.mainStatus === 200;
	const excluded =
		ok !== true
			? `load failed: ${ok}`
			: !docOk
				? `main document HTTP ${rec.mainStatus}`
				: wireBytes > PAGE_CAP_BYTES
					? `over 12 MB on the wire (${wireBytes} B)`
					: null;
	return {
		id,
		site: new URL(url).origin,
		kind,
		url,
		ok,
		excluded,
		docStatus: rec.mainStatus,
		csp: rec.mainCsp,
		requests: real.length,
		wireBytes,
		classBytes,
		sameOrigin,
		crossOrigin: real.length - sameOrigin,
		iframes: {
			youtube: frames.filter((f) => /youtube(?:-nocookie)?\.com\/embed\//.test(f)).length,
			vimeo: frames.filter((f) => /player\.vimeo\.com\/video\//.test(f)).length
		},
		facadeRewrites,
		facadeSha1,
		truncated: real.filter((r) => r.truncated).map((r) => ({ url: r.url, bytes: r.bytes })),
		hosts: [...new Set(rec.responses.map((r) => new URL(r.url).host))],
		failed: rec.failed,
		responses: rec.responses
	};
}

/** a generated self-signed certificate for the replay, kept with the corpus; never used outside it */
export function ensureTls(dir: string): void {
	const tls = join(dir, 'tls');
	if (existsSync(join(tls, 'cert.pem')) && existsSync(join(tls, 'key.pem'))) return;
	mkdirSync(tls, { recursive: true });
	const made = spawnSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			join(tls, 'key.pem'),
			'-out',
			join(tls, 'cert.pem'),
			'-days',
			'30',
			'-subj',
			'/CN=spool-replay'
		],
		{ stdio: 'ignore' }
	);
	if (made.status !== 0) throw new Error('openssl could not make the replay certificate');
}

/** the sites file: one site per line, optional extra page paths after it */
export function parseSites(text: string): Array<{ site: string; paths: string[] }> {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const [site = '', ...paths] = line.split(/\s+/);
			return { site: new URL(site).origin + '/', paths };
		});
}

/** the corpus being written: its rows, the bodies stored so far, and the cap they must stay under */
type Ledger = {
	out: string;
	cap: number;
	rows: IndexPage[];
	stored: Set<string>;
	storedBytes: number;
	wireBytes: number;
	hosts: Set<string>;
};

/** keeps a recorded page if its bodies fit under the ledger's cap; every page gets a row either way */
function admit(ledger: Ledger, recorded: Recorded): boolean {
	const m = recorded.manifest;
	if (m.excluded === null) {
		const fresh = [...recorded.bodies].filter(([hash]) => !ledger.stored.has(hash));
		const added = fresh.reduce((s, [, body]) => s + body.length, 0);
		if (ledger.storedBytes + added > ledger.cap) {
			m.excluded = `corpus cap: ${ledger.storedBytes + added} B of unique bodies would pass ${ledger.cap} B`;
		} else {
			ledger.storedBytes += added;
			ledger.wireBytes += m.wireBytes;
			for (const [hash, body] of fresh) {
				ledger.stored.add(hash);
				writeFileSync(join(ledger.out, 'bodies', hash), body);
			}
			writeFileSync(join(ledger.out, 'pages', `${m.id}.json`), `${JSON.stringify(m)}\n`);
			ledger.hosts.add(m.site);
		}
	}
	ledger.rows.push(summaryOf(m));
	return m.excluded === null;
}

function writeIndex(ledger: Ledger): void {
	const index: Index = {
		schema: 1,
		date: utcDate(),
		cap: { page: PAGE_CAP_BYTES, file: FILE_CAP_BYTES, corpus: CORPUS_CAP_BYTES },
		reserved: ledger.cap - CORPUS_CAP_BYTES,
		quietMs: QUIET_MS,
		viewport: VIEWPORT,
		pages: ledger.rows,
		wireBytes: ledger.wireBytes,
		storedBytes: ledger.storedBytes,
		sites: ledger.hosts.size
	};
	writeFileSync(join(ledger.out, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
	console.log(
		JSON.stringify({
			kept: ledger.rows.filter((r) => r.excluded === null).length,
			excluded: ledger.rows.filter((r) => r.excluded !== null).length,
			sites: ledger.hosts.size,
			wireBytes: ledger.wireBytes,
			storedBytes: ledger.storedBytes,
			index: join(ledger.out, 'index.json')
		})
	);
}

/**
 * Records every page of a sites file into `out`. A page is kept when its own wire bytes pass the
 * page cap and its unique bodies fit under the corpus cap; a kept page writes its manifest and any
 * body not stored yet. Every page, kept or not, gets a row in `index.json`.
 */
async function recordCorpus(sites: string, out: string, force: boolean): Promise<void> {
	const indexPath = join(out, 'index.json');
	if (existsSync(indexPath) && !force)
		throw new Error(`${indexPath} exists; pass --force to replace it`);
	mkdirSync(join(out, 'bodies'), { recursive: true });
	mkdirSync(join(out, 'pages'), { recursive: true });
	ensureTls(out);
	const { chromium } = await import('@playwright/test');
	const { internalLinks } = await import('./payload.ts');
	const browser = await chromium.launch({ channel: 'chromium' });
	const version = browser.version();
	const ledger: Ledger = {
		out,
		cap: CORPUS_CAP_BYTES,
		rows: [],
		stored: new Set(),
		storedBytes: 0,
		wireBytes: 0,
		hosts: new Set()
	};
	const capped = (id: string, url: string, kind: Manifest['kind']): void => {
		ledger.rows.push({
			...summaryOf(
				emptyManifest(id, url, kind, `corpus cap reached at ${ledger.storedBytes} B`)
			),
			file: null
		});
	};
	for (const { site, paths } of parseSites(readFileSync(sites, 'utf8'))) {
		const label = new URL(site).host.replace(/^www\./, '');
		let mainDoc: string | null = null;
		if (ledger.storedBytes < ledger.cap) {
			const home = await recordPage(browser, version, site, `${label}-1`, 'home');
			admit(ledger, home);
			mainDoc = home.mainDoc;
			if (home.manifest.excluded !== null)
				console.error(`${site} home: ${home.manifest.excluded}`);
		} else capped(`${label}-1`, site, 'home');
		const candidates =
			mainDoc === null ? [] : internalLinks(mainDoc, site).slice(0, INNER_CANDIDATES);
		let innerDone = false;
		for (const path of candidates) {
			const url = new URL(path, site).href;
			if (ledger.storedBytes >= ledger.cap) {
				if (!innerDone) capped(`${label}-2`, url, 'internal');
				break;
			}
			const inner = await recordPage(browser, version, url, `${label}-2`, 'internal');
			if (admit(ledger, inner)) {
				innerDone = true;
				break;
			}
			console.error(`${url}: ${inner.manifest.excluded}; trying the next link`);
		}
		for (const [i, path] of paths.entries()) {
			const url = new URL(path, site).href;
			const id = `${label}-${i + 3}`;
			if (ledger.storedBytes >= ledger.cap) capped(id, url, 'embed');
			else {
				const embed = await recordPage(browser, version, url, id, 'embed');
				if (!admit(ledger, embed)) console.error(`${url}: ${embed.manifest.excluded}`);
			}
		}
		console.error(
			`done ${site}; ${ledger.hosts.size} sites, ${ledger.storedBytes} stored bytes`
		);
	}
	await browser.close();
	writeIndex(ledger);
}

/**
 * Adds pages to an existing corpus, under its cap plus `reserve` bytes. Only the paths in the sites
 * file are recorded (no home or inner page). A page already kept is skipped; a page refused only by
 * the cap is recorded again under a new id; any other refusal stays as it was.
 */
async function recordAdditional(sites: string, out: string, reserve: number): Promise<void> {
	const index = readIndex(out);
	const bodies = join(out, 'bodies');
	const stored = new Set(readdirSync(bodies));
	const storedBytes = [...stored].reduce((s, h) => s + statSync(join(bodies, h)).size, 0);
	const ledger: Ledger = {
		out,
		cap: CORPUS_CAP_BYTES + reserve,
		rows: [...index.pages],
		stored,
		storedBytes,
		wireBytes: index.wireBytes,
		hosts: new Set(index.pages.filter((p) => p.excluded === null).map((p) => p.site))
	};
	const taken = new Set(index.pages.map((p) => p.id));
	const freshId = (label: string): string => {
		for (let k = 1; ; k++) {
			const id = `${label}-s${k}`;
			if (!taken.has(id)) {
				taken.add(id);
				return id;
			}
		}
	};
	const { chromium } = await import('@playwright/test');
	const browser = await chromium.launch({ channel: 'chromium' });
	const version = browser.version();
	for (const { site, paths } of parseSites(readFileSync(sites, 'utf8'))) {
		const label = new URL(site).host.replace(/^www\./, '');
		for (const path of paths) {
			const url = new URL(path, site).href;
			const existing = ledger.rows.find((r) => r.url === url);
			if (existing && existing.excluded === null) {
				console.error(`${url}: already kept`);
				continue;
			}
			if (existing && !existing.excluded?.startsWith('corpus cap')) {
				console.error(`${url}: kept out earlier (${existing.excluded}); not retried`);
				continue;
			}
			if (existing) ledger.rows = ledger.rows.filter((r) => r !== existing);
			const recorded = await recordPage(browser, version, url, freshId(label), 'embed');
			const kept = admit(ledger, recorded);
			console.error(`${url}: ${kept ? 'kept' : recorded.manifest.excluded}`);
		}
	}
	await browser.close();
	writeIndex(ledger);
}

/**
 * Builds the facade variant of every kept page's main document from its stored bytes, and records it
 * in the page's manifest and index row. Idempotent: pages are rebuilt from their stored bodies.
 */
async function buildFacades(corpus: string): Promise<void> {
	const index = readIndex(corpus);
	for (const row of index.pages) {
		if (row.excluded !== null) continue;
		const manifest = readManifest(corpus, row.id);
		const main = manifest.responses
			.filter(
				(r) =>
					r.frame === 'main' &&
					r.cls === 'document' &&
					r.sha1 !== null &&
					r.status === 200
			)
			.pop();
		let facade: { body: Buffer; rewritten: number } | null = null;
		if (main?.sha1) {
			const raw = readFileSync(join(corpus, 'bodies', main.sha1));
			const html = decodeBody(raw, main.headers['content-encoding']).toString('utf8');
			facade = await makeFacade(html, main.headers['content-encoding'], manifest.csp);
		}
		const facadeSha1 = facade ? createHash('sha1').update(facade.body).digest('hex') : null;
		if (facade && facadeSha1) writeFileSync(join(corpus, 'bodies', facadeSha1), facade.body);
		manifest.facadeSha1 = facadeSha1;
		manifest.facadeRewrites = facade?.rewritten ?? 0;
		writeFileSync(join(corpus, 'pages', `${row.id}.json`), `${JSON.stringify(manifest)}\n`);
		row.facadeSha1 = facadeSha1;
		row.facadeRewrites = manifest.facadeRewrites;
		console.error(`${row.id}: ${manifest.facadeRewrites} facade rewrites`);
	}
	const bodies = join(corpus, 'bodies');
	index.storedBytes = readdirSync(bodies).reduce((s, h) => s + statSync(join(bodies, h)).size, 0);
	writeFileSync(join(corpus, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`);
	const kept = index.pages.filter((p) => p.excluded === null);
	console.log(
		JSON.stringify({
			kept: kept.length,
			facadePages: kept.filter((p) => p.facadeRewrites > 0).length,
			storedBytes: index.storedBytes
		})
	);
}

function emptyManifest(
	id: string,
	url: string,
	kind: Manifest['kind'],
	excluded: string
): Manifest {
	return {
		id,
		site: new URL(url).origin,
		kind,
		url,
		ok: true,
		excluded,
		docStatus: 0,
		csp: false,
		requests: 0,
		wireBytes: 0,
		classBytes: emptyBytes(),
		sameOrigin: 0,
		crossOrigin: 0,
		iframes: { youtube: 0, vimeo: 0 },
		facadeRewrites: 0,
		facadeSha1: null,
		truncated: [],
		hosts: [],
		failed: [],
		responses: []
	};
}

function summaryOf(m: Manifest): IndexPage {
	const { responses: _responses, failed: _failed, truncated, ...rest } = m;
	return {
		...rest,
		truncated: truncated.length,
		file: m.excluded === null ? `pages/${m.id}.json` : null
	};
}

// #endregion

export function parse(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			sites: { type: 'string' },
			out: { type: 'string' },
			corpus: { type: 'string' },
			port: { type: 'string', default: String(REPLAY_PORT) },
			control: { type: 'string', default: String(CONTROL_PORT) },
			add: { type: 'boolean', default: false },
			reserve: { type: 'string', default: '60000000' },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false }
		}
	});
	return {
		command: positionals[0],
		sites: values.sites,
		out: values.out,
		corpus: values.corpus,
		port: Number(values.port),
		control: Number(values.control),
		add: values.add as boolean,
		reserve: Number(values.reserve),
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help || !args.command) {
		console.log(HELP);
	} else if (args.command === 'record') {
		if (!args.sites || !args.out) throw new Error('record needs --sites and --out');
		if (args.dryRun) {
			console.log(
				JSON.stringify(
					{
						command: 'record',
						add: args.add,
						sites: parseSites(readFileSync(args.sites, 'utf8')).length,
						out: args.out,
						index: join(args.out, 'index.json'),
						caps: {
							page: PAGE_CAP_BYTES,
							file: FILE_CAP_BYTES,
							corpus: CORPUS_CAP_BYTES,
							reserve: args.add ? args.reserve : 0
						},
						quietMs: QUIET_MS
					},
					null,
					2
				)
			);
		} else if (args.add) {
			await recordAdditional(args.sites, args.out, args.reserve);
		} else {
			await recordCorpus(args.sites, args.out, args.force);
		}
	} else if (args.command === 'facades') {
		if (!args.corpus) throw new Error('facades needs --corpus');
		await buildFacades(args.corpus);
	} else if (args.command === 'serve') {
		if (!args.corpus) throw new Error('serve needs --corpus');
		serve(args.corpus, args.port, args.control);
	} else {
		throw new Error(`unknown command ${args.command}; use record, facades or serve`);
	}
}
