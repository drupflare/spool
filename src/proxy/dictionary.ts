import { mergeList } from '../media/headers.js';
import { ProtocolError } from '../protocol/errors.js';
import { decline, type Gate } from './eligible.js';

/** the content codings of RFC 9842: Brotli (`dcb`) and Zstandard (`dcz`) against a dictionary */
export type DictionaryFormat = 'dcb' | 'dcz';

/**
 * Compresses `input` against `dictionary` and returns the compressed stream only. spool adds the
 * coding's header (the magic bytes and the SHA-256 of the dictionary). For `dcz` the dictionary is a
 * raw content dictionary and the window must stay at or under 8 MiB or 1.25 times the dictionary,
 * whichever is larger. For `dcb` it is a Brotli prefix dictionary. It throws for a format it cannot
 * produce, and the proxy then answers with the plain body.
 */
export type DictionaryEncoder = (
	dictionary: Uint8Array,
	input: Uint8Array,
	format: DictionaryFormat
) => Promise<Uint8Array>;

/** what `spoolProxy({ dictionary })` takes */
export type DictionaryOptions = {
	/** produces the compressed stream; see {@link DictionaryEncoder} */
	encoder: DictionaryEncoder;
	/** the paths that become and use dictionaries, tested against the pathname; default `/\.(?:css|m?js)$/i` */
	match?: RegExp;
	/**
	 * Which of those responses register as dictionaries, as a function of the pathname, a regular
	 * expression or a list of them; default every one `match` accepts. The others get no
	 * `Use-As-Dictionary`, so the browser holds only the bases you name, and they are still encoded
	 * against a base the request names.
	 */
	base?: RegExp | readonly RegExp[] | ((pathname: string) => boolean);
	/** largest body kept as a dictionary or encoded, in bytes; default 2 MiB */
	maxBytes?: number;
	/** the codings offered, in order of preference, when the request accepts them; default `['dcz']` */
	formats?: readonly DictionaryFormat[];
	/** bytes of dictionaries kept in memory, the least recently used going first; default 16 MiB */
	cacheBytes?: number;
};

/**
 * What the proxy counted since it started: `registered` is the dictionaries stored (new content
 * hashes), `encoded` the responses sent as `dcb` or `dcz`, `bytesIn` and `bytesOut` the plain and
 * encoded sizes of those responses, and `skipped` the eligible responses left plain by reason:
 * `unavailable` (the request named no dictionary the proxy holds, or accepted no coding offered),
 * `size`, `larger` (the encoded body was not smaller), `failed` (the encoder threw), `range` and
 * `pattern` (the path cannot be written as a `match` pattern).
 */
export type DictionaryStats = {
	registered: number;
	encoded: number;
	bytesIn: number;
	bytesOut: number;
	skipped: Record<string, number>;
};

const MAGIC: Record<DictionaryFormat, readonly number[]> = {
	dcb: [0xff, 0x44, 0x43, 0x42],
	dcz: [0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]
};

const DEFAULT_MATCH = /\.(?:css|m?js)$/i;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024;
const SAFE_DIRECTORY = /^[A-Za-z0-9/_.~%-]*$/;
const AVAILABLE = /^:([A-Za-z0-9+/]{43}=):$/;

/** the body of a `dcb` or `dcz` response: the coding's magic bytes, the dictionary's SHA-256, then the stream */
export function frameDictionaryBody(
	format: DictionaryFormat,
	hash: Uint8Array,
	stream: Uint8Array
): Uint8Array {
	const magic = MAGIC[format];
	const out = new Uint8Array(magic.length + hash.length + stream.length);
	out.set(magic, 0);
	out.set(hash, magic.length);
	out.set(stream, magic.length + hash.length);
	return out;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/** the codings `Accept-Encoding` lists with a quality above zero, lowercase */
function accepted(header: string | null): Set<string> {
	const out = new Set<string>();
	for (const part of (header ?? '').split(',')) {
		const [token, ...params] = part.trim().toLowerCase().split(';');
		const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
		if (token && !(q !== undefined && Number(q.slice(2)) === 0)) out.add(token.trim());
	}
	return out;
}

function kindOf(response: Response): 'style' | 'script' | null {
	const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
	if (type === 'text/css') return 'style';
	if (type === 'text/javascript' || type === 'application/javascript') return 'script';
	return null;
}

/** the state `spoolProxy` keeps for `dictionary`: checked options, the dictionaries and the counters */
export type Dictionaries = {
	readonly stats: DictionaryStats;
	/** whether a response could take part, by its content type and the request's method and path */
	applies(request: Request, response: Response): boolean;
	/** answers one origin response for `request`, registering it and encoding it when the request names a stored dictionary */
	apply(request: Request, response: Response): Promise<Response>;
};

/** applies the defaults and checks the values; `ProtocolError('bad-route')` for one out of range */
export function createDictionaries(options: DictionaryOptions, gate: Gate): Dictionaries {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
	const formats = options.formats ?? ['dcz'];
	const match = options.match ?? DEFAULT_MATCH;
	const { base } = options;
	const isBase =
		base === undefined
			? () => true
			: typeof base === 'function'
				? base
				: (pathname: string) =>
						([] as RegExp[]).concat(base).some((pattern) => {
							pattern.lastIndex = 0;
							return pattern.test(pathname);
						});
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new ProtocolError('bad-route', 'dictionary maxBytes must be a positive integer');
	}
	if (!Number.isInteger(cacheBytes) || cacheBytes < 1) {
		throw new ProtocolError('bad-route', 'dictionary cacheBytes must be a positive integer');
	}
	if (formats.length === 0 || formats.some((f) => f !== 'dcb' && f !== 'dcz')) {
		throw new ProtocolError('bad-route', `dictionary formats must list 'dcb' or 'dcz'`);
	}
	const stats: DictionaryStats = {
		registered: 0,
		encoded: 0,
		bytesIn: 0,
		bytesOut: 0,
		skipped: {}
	};
	const held = new Map<string, Uint8Array>();
	let size = 0;

	const skip = (why: string) => void (stats.skipped[why] = (stats.skipped[why] ?? 0) + 1);

	function touch(key: string, body: Uint8Array): void {
		held.delete(key);
		held.set(key, body);
	}

	function remember(key: string, bytes: Uint8Array): void {
		const body = held.get(key);
		if (body) return touch(key, body);
		held.set(key, bytes);
		size += bytes.length;
		stats.registered++;
		for (const [oldest, body] of held) {
			if (size <= cacheBytes || held.size === 1) break;
			held.delete(oldest);
			size -= body.length;
		}
	}

	function applies(request: Request, response: Response): boolean {
		if (request.method !== 'GET' || response.status !== 200) return false;
		match.lastIndex = 0;
		if (!match.test(new URL(request.url).pathname)) return false;
		return kindOf(response) !== null;
	}

	return {
		stats,
		applies,
		async apply(request, response) {
			const url = new URL(request.url);
			const auth = new Headers();
			if (request.headers.has('authorization')) auth.set('authorization', 'x');
			const why = decline(
				{
					method: 'GET',
					search: '',
					requestHeaders: auth,
					response,
					tags: [],
					data: true,
					principal: false
				},
				gate
			);
			if (why !== null) return response;
			const declared = Number(response.headers.get('content-length'));
			if (request.headers.has('range')) {
				skip('range');
				return response;
			}
			if (Number.isFinite(declared) && declared > maxBytes) {
				skip('size');
				return response;
			}
			const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
			if (!SAFE_DIRECTORY.test(directory)) {
				skip('pattern');
				return response;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const headers = new Headers(response.headers);
			const plain = () =>
				new Response(bytes as BodyInit, {
					status: 200,
					statusText: response.statusText,
					headers
				});
			if (bytes.length === 0 || bytes.length > maxBytes) {
				skip('size');
				return plain();
			}
			const hash = await sha256(bytes);
			const key = AVAILABLE.exec(request.headers.get('available-dictionary') ?? '')?.[1];
			const dictionary = key === undefined ? undefined : held.get(key);
			if (key !== undefined && dictionary) touch(key, dictionary);
			mergeList(headers, 'vary', ['Accept-Encoding', 'Available-Dictionary']);
			if (isBase(url.pathname)) {
				headers.set(
					'use-as-dictionary',
					`match="${directory}*", match-dest=("${kindOf(response)}")`
				);
				remember(toBase64(hash), bytes);
			}
			if (!dictionary) {
				skip('unavailable');
				return plain();
			}
			const wanted = accepted(request.headers.get('accept-encoding'));
			const format = formats.find((f) => wanted.has(f));
			if (!format) {
				skip('unavailable');
				return plain();
			}
			let framed: Uint8Array;
			try {
				const stream = await options.encoder(dictionary, bytes, format);
				framed = frameDictionaryBody(format, await sha256(dictionary), stream);
			} catch {
				skip('failed');
				return plain();
			}
			if (framed.length >= bytes.length) {
				skip('larger');
				return plain();
			}
			headers.set('content-encoding', format);
			headers.delete('content-length');
			const etag = headers.get('etag');
			if (etag && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
			stats.encoded++;
			stats.bytesIn += bytes.length;
			stats.bytesOut += framed.length;
			return new Response(framed as BodyInit, {
				status: 200,
				statusText: response.statusText,
				headers
			});
		}
	};
}
