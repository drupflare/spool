import { createServer } from 'node:http';
import { brotliCompressSync, constants } from 'node:zlib';

/** the classic scripts the page's work is split into */
export const CHUNK_PIECES = 50;

/** the file counts the same pieces are served as; each must divide the piece count */
export const CHUNK_COUNTS = [1, 5, 25, 50] as const;

/** emulated delay before each response, in ms; an L3 condition, not a network */
export const CHUNK_RTTS_MS = [0, 40] as const;

export type ChunkArm = { chunks: number; rttMs: number };

/** the eight arms of a round before rotation; the two delays alternate */
export const CHUNK_ARMS: ChunkArm[] = CHUNK_COUNTS.flatMap((chunks) =>
	CHUNK_RTTS_MS.map((rttMs) => ({ chunks, rttMs }))
);

const DATA_VALUES = 1400;

const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } };

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** one piece: an IIFE that writes a checksum into its own element, about 10 KB of source */
export function pieceSource(index: number): string {
	const next = lcg(1000 + index);
	const values = Array.from({ length: DATA_VALUES }, () => Math.floor(next() * 100000));
	return `(function () {
var e = document.getElementById('p${index}');
var d = [${values.join(', ')}];
var s = ${index};
for (var j = 0; j < d.length; j++) s = (s * 31 + d[j]) % 65521;
for (var i = 0; i < 2000; i++) s = (s + i) % 65521;
e.textContent = 'piece ${index}: ' + s;
e.setAttribute('data-checksum', String(s));
})();
`;
}

const PIECES = Array.from({ length: CHUNK_PIECES }, (_, i) => pieceSource(i));

/** the source of each file when the pieces are served as `chunks` files, consecutive pieces together */
export function chunkFiles(chunks: number): string[] {
	const per = CHUNK_PIECES / chunks;
	if (!Number.isInteger(per)) throw new RangeError(`${chunks} files do not divide the pieces`);
	return Array.from({ length: chunks }, (_, c) => PIECES.slice(c * per, (c + 1) * per).join(''));
}

/** the page for `chunks` files: one element per piece, then the script tags in order */
export function pageHtml(chunks: number): string {
	const divs = Array.from({ length: CHUNK_PIECES }, (_, i) => `<div id="p${i}"></div>`);
	const scripts = Array.from(
		{ length: chunks },
		(_, c) => `<script src="/k/${chunks}/${c}.js"></script>`
	);
	return `<!doctype html>\n<meta charset="utf-8">\n<title>chunk-split ${chunks}</title>\n${divs.join('\n')}\n${scripts.join('\n')}\n`;
}

const compress = (body: string) => brotliCompressSync(body, BROTLI);

/** the sizes of the pieces and, per file count, the source and the brotli bytes on the wire */
export function chunkSummary() {
	const sizes = PIECES.map((p) => Buffer.byteLength(p));
	const arms = Object.fromEntries(
		CHUNK_COUNTS.map((chunks) => {
			const files = chunkFiles(chunks);
			return [
				chunks,
				{
					files: chunks,
					sourceBytes: files.reduce((s, f) => s + Buffer.byteLength(f), 0),
					wireBytes: files.reduce((s, f) => s + compress(f).length, 0)
				}
			];
		})
	);
	return {
		pieces: CHUNK_PIECES,
		pieceBytes: {
			min: Math.min(...sizes),
			max: Math.max(...sizes),
			total: sizes.reduce((s, v) => s + v, 0)
		},
		arms
	};
}

type Served = { body: Buffer; type: string; cache: string };

/** every path the origin answers, with its compressed body, built once before the server listens */
export function servedFiles(): Map<string, Served> {
	const out = new Map<string, Served>();
	for (const chunks of CHUNK_COUNTS) {
		out.set(`/k/${chunks}/`, {
			body: compress(pageHtml(chunks)),
			type: 'text/html; charset=utf-8',
			cache: 'no-cache'
		});
		chunkFiles(chunks).forEach((source, c) =>
			out.set(`/k/${chunks}/${c}.js`, {
				body: compress(source),
				type: 'text/javascript; charset=utf-8',
				cache: 'max-age=31536000, immutable'
			})
		);
	}
	return out;
}

/**
 * The origin: each response waits `rttMs` (set by `/__rtt?ms=`) and is sent brotli-compressed. Counts
 * every page and file request and the bytes sent; `/__stats` reports the counters and the CPU used.
 */
export function startChunkOrigin(port: number) {
	const files = servedFiles();
	let rttMs = 0;
	let requests = 0;
	let servedTotal = 0;
	return createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (url.pathname === '/__stats') {
			const cpu = process.cpuUsage();
			res.writeHead(200, { 'content-type': 'application/json' });
			return void res.end(
				JSON.stringify({ requests, servedTotal, cpuUs: cpu.user + cpu.system })
			);
		}
		if (url.pathname === '/__rtt') {
			rttMs = Number(url.searchParams.get('ms') ?? 0);
			return void res.end();
		}
		requests++;
		const file = files.get(url.pathname);
		setTimeout(() => {
			if (!file) {
				res.writeHead(404);
				return void res.end();
			}
			servedTotal += file.body.length;
			res.writeHead(200, {
				'content-type': file.type,
				'content-encoding': 'br',
				'cache-control': file.cache,
				vary: 'accept-encoding',
				'content-length': file.body.length
			});
			res.end(file.body);
		}, rttMs);
	}).listen(port, '127.0.0.1');
}

if (process.argv[1]?.endsWith('rapl-chunk.ts')) {
	startChunkOrigin(Number(process.env.PORT ?? 8981));
	console.log('origin up chunk-split');
}
