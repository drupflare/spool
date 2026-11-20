import { describe, expect, it } from 'vitest';
import { probeCache, shouldForward, timingHit } from '../../src/sw/probe';

const URL_ = 'https://site.test/.spool/1/client.js';
const ok = () => Promise.resolve(new Response('js', { status: 200 }));
const timing = (encodedBodySize: number) => () => ({ encodedBodySize });

describe('the cache probe interpretation', () => {
	it('reads a zero body size as a disk hit', () => {
		expect(timingHit({ encodedBodySize: 0 })).toBe('hit');
	});

	it('reads a body size above zero as a miss (Linux ignores only-if-cached)', () => {
		expect(timingHit({ encodedBodySize: 4096 })).toBe('miss');
	});

	it('reads a missing timing entry as a miss', () => {
		expect(timingHit(undefined)).toBe('miss');
	});

	it('reads a rejected fetch as a miss (macOS rejects a cache miss)', async () => {
		const reject = () => Promise.reject(new TypeError('network error'));
		expect(await probeCache(URL_, reject, timing(0))).toBe('miss');
	});

	it('reads a non-ok answer as a miss even when the timing shows zero', async () => {
		const gone = () => Promise.resolve(new Response('gone', { status: 404 }));
		expect(await probeCache(URL_, gone, timing(0))).toBe('miss');
	});

	it('reads a successful fetch with zero body bytes as a hit', async () => {
		expect(await probeCache(URL_, ok, timing(0))).toBe('hit');
	});

	it('reads a successful fetch with body bytes as a miss', async () => {
		expect(await probeCache(URL_, ok, timing(4096))).toBe('miss');
	});

	it('asks for the cache only, on the same origin, and reads the timing of that URL', async () => {
		const asked: Array<[string, RequestInit]> = [];
		const seen: string[] = [];
		const fetcher = (input: string, init: RequestInit) => {
			asked.push([input, init]);
			return ok();
		};
		const read = (url: string) => {
			seen.push(url);
			return { encodedBodySize: 0 };
		};
		expect(await probeCache(URL_, fetcher, read)).toBe('hit');
		expect(asked).toEqual([[URL_, { cache: 'only-if-cached', mode: 'same-origin' }]]);
		expect(seen).toEqual([URL_]);
	});
});

describe('shouldForward', () => {
	it('forwards after a hit only', () => {
		expect(shouldForward('hit')).toBe(true);
		expect(shouldForward('miss')).toBe(false);
	});

	it('does not forward before the probe answers', () => {
		expect(shouldForward(undefined)).toBe(false);
	});
});
