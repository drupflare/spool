import {
	makeDelta,
	readBundle,
	type BundleDelta,
	type BundleIndex,
	type BundleState
} from '../protocol/bundle.js';
import type { StubPack, SwConfig } from '../protocol/config.js';
import { shellHash } from '../protocol/hash.js';
import type { BundleStore } from './bundle.js';
import { SW_CORE } from './embedded.js';
import { json } from './sync.js';

/** the most versions back a worker script carries a delta from */
export const STUB_DELTAS = 4;

/** the most bytes of inline deltas a worker script carries; past it a device fetches one delta */
export const STUB_DELTA_BYTES = 16_384;

const encoder = new TextEncoder();

/** the worker script: the config as data, then the shared core or the site's own bundle */
export function workerScript(config: SwConfig, core: string = SW_CORE): string {
	return `self.__SPOOL_CONFIG__=${JSON.stringify(config)};\n${core}`;
}

/** the line that stands in for the core in a stub whose core is served from `url` */
export function workerImport(url: string): string {
	return `importScripts(${JSON.stringify(url)});`;
}

/**
 * Reads `url` and throws unless its bytes hash to `expected`, the `shellHash` of the core the stub
 * names. A script imported by a worker has no integrity check in the browser, so this is the one
 * place the bytes are compared with the build.
 */
export async function checkCore(
	url: string,
	expected: string,
	fetcher: typeof fetch
): Promise<void> {
	const response = await fetcher(url, { headers: { 'accept-encoding': 'identity' } });
	if (response.status !== 200) {
		throw new Error(`cannot read the worker core at ${url} (HTTP ${response.status})`);
	}
	const got = await shellHash(await response.text());
	if (got !== expected) {
		throw new Error(
			`the worker core at ${url} does not match this build (expected ${expected}, got ${got})`
		);
	}
}

/**
 * The `/spool-sw.js` response. `script` is awaited while the body streams, so the body can read the
 * store. The script lives for `maxAge` seconds in the browser's cache, which is the lease: a check
 * inside it is answered locally, and a deploy or a new version is picked up after it.
 */
export function workerResponse(script: () => Promise<string>, maxAge: number): Response {
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode(await script()));
			controller.close();
		}
	});
	return new Response(body, { headers: workerHeaders(maxAge) });
}

function workerHeaders(maxAge: number): Record<string, string> {
	return {
		'content-type': 'text/javascript; charset=utf-8',
		'cache-control': `max-age=${maxAge}`,
		'service-worker-allowed': '/'
	};
}

/** the strong validator of a worker script: the hash of its exact bytes, quoted */
export async function workerEtag(text: string): Promise<string> {
	return `"${await shellHash(text)}"`;
}

/** whether an `If-None-Match` value names `etag`; weak comparison, so a `W/` copy a proxy made matches */
export function matchesEtag(header: string | null, etag: string): boolean {
	if (!header) return false;
	const tag = (value: string) => value.trim().replace(/^W\//, '');
	return header.split(',').some((value) => tag(value) === '*' || tag(value) === tag(etag));
}

/**
 * The `/spool-sw.js` response to `request`, with an `ETag`. A matching `If-None-Match` gets a `304`
 * with the same headers and no body, so a re-check after the lease costs a few hundred bytes when the
 * script is unchanged. `HEAD` gets the headers alone. The script is read whole, once per version.
 */
export async function workerReply(
	request: Request,
	script: () => Promise<{ text: string; etag: string }>,
	maxAge: number
): Promise<Response> {
	const { text, etag } = await script();
	const headers = { ...workerHeaders(maxAge), etag };
	if (matchesEtag(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(request.method === 'HEAD' ? null : text, { headers });
}

/** a pack read from the store: its index and its state */
type ReadPack = { index: BundleIndex; state: BundleState };

/** the packs of one store, read once per version; a version's bytes never change */
export type PackReader = {
	/** the pack a worker script carries for `version`, or undefined when no pack is held for it */
	stub(version: number): Promise<StubPack | undefined>;
	/** the delta from `from` to `to`, or undefined unless both are held and `from` is older */
	delta(from: number, to: number): Promise<BundleDelta | undefined>;
};

/** a reader over `bundles`; its memo keeps every pack it has read, so a long-lived site holds them all */
export function packReader(bundles: BundleStore): PackReader {
	const read = new Map<number, Promise<ReadPack>>();
	async function packAt(version: number): Promise<ReadPack | undefined> {
		if (version < 0) return undefined;
		const held = read.get(version);
		if (held) return held;
		const bytes = await bundles.get(version);
		if (bytes === undefined) return undefined;
		const pack = readBundle(bytes);
		read.set(version, pack);
		return pack;
	}
	return {
		async stub(version) {
			const to = await packAt(version);
			if (!to) return undefined;
			const deltas: BundleDelta[] = [];
			let bytes = 0;
			for (let back = 1; back <= STUB_DELTAS; back++) {
				const from = await packAt(version - back);
				if (!from) continue;
				const delta = await makeDelta(from.state, to.state);
				const size = encoder.encode(JSON.stringify(delta)).length;
				if (bytes + size > STUB_DELTA_BYTES) break;
				bytes += size;
				deltas.push(delta);
			}
			return { version, digest: to.index.digest, deltas };
		},
		async delta(from, to) {
			if (from >= to) return undefined;
			const base = await packAt(from);
			const target = await packAt(to);
			if (!base || !target) return undefined;
			return makeDelta(base.state, target.state);
		}
	};
}

/** the response to `GET /.spool/bundle/delta/<from>/<to>`: the delta as JSON, or 404 for a pair not held */
export async function respondDelta(
	reader: PackReader | undefined,
	path: string
): Promise<Response> {
	const match = /^(\d{1,15})\/(\d{1,15})$/.exec(path);
	const delta =
		reader && match ? await reader.delta(Number(match[1]), Number(match[2])) : undefined;
	if (!delta) return json({ error: 'no delta' }, 404);
	return new Response(JSON.stringify(delta), {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
}
