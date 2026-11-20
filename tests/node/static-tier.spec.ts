import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cdnWorkerUrl } from '../../src/cdn/location';
import { fileStaticSink } from '../../src/node/listener';
import {
	bootPath,
	BUNDLE_DELTA_PREFIX,
	BUNDLE_PREFIX,
	clientPath,
	defineRoute,
	navigatePath,
	ProtocolError,
	shellHash
} from '../../src/protocol/index';
import { SW_CORE } from '../../src/server/embedded';
import { createSpool, memoryBundleStore, memoryStaticSink } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';

const ORIGIN = new URL('https://example.test/');
const CDN = 'https://cdn.example.test/spool/client.js';
const PAGE = { source: '<html><head></head><body>{{row.title}}</body></html>' };
const route = defineRoute('/p/:id', {
	strategy: 'template',
	template: PAGE,
	load: () => ({ row: { title: 'x' } })
});

function site(
	options: {
		stamp?: number | (() => number);
		bundles?: boolean;
		cdn?: boolean;
		cdnWorker?: boolean | { url: string };
		worker?: string;
		policy?: false;
	} = {}
) {
	const bundles = options.bundles === false ? undefined : memoryBundleStore();
	const spool = createSpool({
		routes: [route],
		store: memoryStore(),
		...(bundles ? { bundles } : {}),
		...(options.stamp === undefined ? {} : { stamp: options.stamp }),
		...(options.worker === undefined ? {} : { worker: options.worker }),
		...(options.cdn || options.cdnWorker
			? {
					cdn: {
						url: CDN,
						integrity: 'sha384-test',
						...(options.cdnWorker === undefined ? {} : { worker: options.cdnWorker })
					}
				}
			: {}),
		...(options.policy === false ? {} : { policy: {} })
	});
	return { spool, bundles };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('publishStatic', () => {
	it('writes the exact file list for a store with two versions', async () => {
		const { spool } = site();
		await spool.publish(ORIGIN);
		await spool.invalidate(['rows']);
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		const { version, paths } = await spool.publishStatic(sink);
		expect(version).toBe(1);
		expect([...paths].sort()).toEqual(
			[
				clientPath(VERSION),
				navigatePath(VERSION),
				'/spool-sw.js',
				`${BUNDLE_PREFIX}0`,
				`${BUNDLE_PREFIX}1`,
				`${BUNDLE_DELTA_PREFIX}0/1`,
				bootPath(VERSION, 0),
				bootPath(VERSION, 1),
				'/_headers'
			].sort()
		);
		expect([...sink.files.keys()].sort()).toEqual([...paths].sort());
	});

	it('writes the boot script for each pack it writes, with the bytes the handler serves', async () => {
		const { spool } = site();
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		const path = bootPath(VERSION, 0);
		const served = await spool.respond(new Request(new URL(path, ORIGIN)));
		expect(served?.status).toBe(200);
		expect(text(sink.files.get(path)?.bytes ?? new Uint8Array())).toBe(await served!.text());
	});

	it('writes no boot script when the site serves its runtime from a CDN', async () => {
		const { spool } = site({ cdn: true });
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		expect(sink.puts.filter((path) => path.includes('/boot/'))).toEqual([]);
	});

	describe('the site policy in the stub', () => {
		const CSP = "default-src 'self'";
		const configOf = (sink: ReturnType<typeof memoryStaticSink>) =>
			JSON.parse(
				/self\.__SPOOL_CONFIG__=(.*?);\n/s.exec(
					text(sink.files.get('/spool-sw.js')!.bytes)
				)![1]!
			) as { policy?: Array<[string, string]> };

		it('publishes a stub with no policy field when no policy is known, and says so', async () => {
			const { spool } = site({ policy: false });
			const sink = memoryStaticSink();
			const result = await spool.publishStatic(sink);
			expect(result).toMatchObject({ version: 0, policy: 'none' });
			expect(sink.files.has('/spool-sw.js')).toBe(true);
			expect(Object.hasOwn(configOf(sink), 'policy')).toBe(false);
		});

		it('writes an empty policy option as a known-empty policy', async () => {
			const { spool } = site();
			const sink = memoryStaticSink();
			const result = await spool.publishStatic(sink);
			expect(result).toMatchObject({ version: 0, policy: 'option' });
			expect(configOf(sink).policy).toEqual([]);
		});

		it('uses the policy of a page the instance already answered', async () => {
			const { spool } = site({ policy: false });
			await spool.handle(
				new Request(ORIGIN),
				() =>
					new Response('<html><head></head><body>x</body></html>', {
						headers: { 'content-type': 'text/html', 'content-security-policy': CSP }
					})
			);
			const sink = memoryStaticSink();
			const result = await spool.publishStatic(sink);
			expect(result.policy).toBe('page');
			expect(configOf(sink).policy).toEqual([['content-security-policy', CSP]]);
		});

		it('takes a policy for the call over the option and over a learned page', async () => {
			const { spool } = site();
			const sink = memoryStaticSink();
			const result = await spool.publishStatic(sink, {
				policy: { 'content-security-policy': CSP }
			});
			expect(result.policy).toBe('call');
			expect(configOf(sink).policy).toEqual([['content-security-policy', CSP]]);
		});

		it('keeps an empty policy for the call as known-empty', async () => {
			const { spool } = site({ policy: false });
			const sink = memoryStaticSink();
			await spool.publishStatic(sink, { policy: {} });
			expect(configOf(sink).policy).toEqual([]);
		});

		it('uses the fallback policy only when no option and no page gives one', async () => {
			const fallbackPolicy = { 'x-frame-options': 'DENY' };
			const none = site({ policy: false }).spool;
			const sink = memoryStaticSink();
			const result = await none.publishStatic(sink, { fallbackPolicy });
			expect(result.policy).toBe('fallback');
			expect(configOf(sink).policy).toEqual([['x-frame-options', 'DENY']]);
			const set = site().spool;
			const second = memoryStaticSink();
			expect((await set.publishStatic(second, { fallbackPolicy })).policy).toBe('option');
			expect(configOf(second).policy).toEqual([]);
		});

		it('refuses a policy for the call that names a header outside the policy list', async () => {
			const { spool } = site();
			const sink = memoryStaticSink();
			const failure = await spool
				.publishStatic(sink, { policy: { 'cache-control': 'no-store' } })
				.catch((error) => error);
			expect(failure).toBeInstanceOf(ProtocolError);
			expect(failure.code).toBe('bad-route');
			expect(sink.puts).toEqual([]);
		});
	});

	it('builds the pack at the cursor first when the call names a url', async () => {
		const { spool, bundles } = site();
		expect(await bundles!.get(0)).toBeUndefined();
		const sink = memoryStaticSink();
		const { paths } = await spool.publishStatic(sink, { url: ORIGIN });
		expect(await bundles!.get(0)).toBeDefined();
		expect(paths).toContain(`${BUNDLE_PREFIX}0`);
		const again = await spool.publishStatic(memoryStaticSink(), { url: ORIGIN });
		expect(again.paths).toContain(`${BUNDLE_PREFIX}0`);
	});

	it('ignores the url for a site with no bundles', async () => {
		const { spool } = site({ bundles: false });
		const { paths } = await spool.publishStatic(memoryStaticSink(), { url: ORIGIN });
		expect(paths).not.toContain(`${BUNDLE_PREFIX}0`);
	});

	it('writes the stub with the bytes spool.stub() serves for the same cursor', async () => {
		const { spool } = site({ stamp: 3 });
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		const stub = sink.files.get('/spool-sw.js');
		expect(stub?.contentType).toBe('text/javascript; charset=utf-8');
		expect(text(stub?.bytes ?? new Uint8Array())).toBe(await (await spool.stub()).text());
	});

	it('writes the stub bytes the handler validator hashes, so a host that hashes the file agrees', async () => {
		const { spool } = site();
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		const stub = sink.files.get('/spool-sw.js');
		const served = await spool.stub(new Request(new URL('/spool-sw.js', ORIGIN)));
		expect(served.headers.get('etag')).toBe(`"${await shellHash(text(stub!.bytes))}"`);
	});

	it('publishing again after a new version writes only the new pack files and the pointers', async () => {
		const { spool } = site();
		await spool.publish(ORIGIN);
		await spool.invalidate(['rows']);
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		sink.puts.length = 0;
		await spool.invalidate(['rows']);
		await spool.publish(ORIGIN);
		const { version } = await spool.publishStatic(sink);
		expect(version).toBe(2);
		expect([...sink.puts].sort()).toEqual(
			[
				'/spool-sw.js',
				'/_headers',
				`${BUNDLE_PREFIX}2`,
				bootPath(VERSION, 2),
				`${BUNDLE_DELTA_PREFIX}1/2`,
				`${BUNDLE_DELTA_PREFIX}0/2`
			].sort()
		);
	});

	it('writes the client, navigate script, stub and headers for a site with no bundles', async () => {
		const { spool } = site({ bundles: false });
		const sink = memoryStaticSink();
		const { paths } = await spool.publishStatic(sink);
		expect([...paths].sort()).toEqual(
			[clientPath(VERSION), navigatePath(VERSION), '/spool-sw.js', '/_headers'].sort()
		);
	});

	it('writes the headers the static host sends, with the lease in the stub rule', async () => {
		const { spool } = site();
		const sink = memoryStaticSink();
		await spool.publishStatic(sink);
		expect(text(sink.files.get('/_headers')?.bytes ?? new Uint8Array())).toBe(
			[
				'/.spool/*',
				'  Cache-Control: public, max-age=31536000, immutable',
				'',
				'/spool-sw.js',
				'  Cache-Control: max-age=86400',
				'  Service-Worker-Allowed: /',
				''
			].join('\n')
		);
	});
});

describe('publishStatic with cdn.worker', () => {
	const coreUrl = async () => cdnWorkerUrl(VERSION, await shellHash(SW_CORE));
	const serving = (body: string, status = 200) => {
		const urls: string[] = [];
		const fetcher = (async (input: string) => {
			urls.push(input);
			return new Response(body, { status });
		}) as unknown as typeof fetch;
		return { urls, fetcher };
	};

	it('writes the small stub and no core', async () => {
		const { spool } = site({ cdnWorker: true });
		await spool.publish(ORIGIN);
		const sink = memoryStaticSink();
		const { paths } = await spool.publishStatic(sink);
		const stub = text(sink.files.get('/spool-sw.js')!.bytes);
		expect(stub.slice(stub.indexOf('\n') + 1)).toBe(
			`importScripts(${JSON.stringify(await coreUrl())});`
		);
		expect(stub).toBe(await spool.stub().text());
		for (const { bytes } of sink.files.values()) {
			expect(text(bytes)).not.toContain(SW_CORE.slice(0, 200));
		}
		const plain = site({ cdn: true });
		const baseline = memoryStaticSink();
		await plain.spool.publish(ORIGIN);
		expect([...paths].sort()).toEqual(
			[...(await plain.spool.publishStatic(baseline)).paths].sort()
		);
	});

	it('reads the core before it writes anything and passes on a match', async () => {
		const { spool } = site({ cdnWorker: true });
		const read = serving(SW_CORE);
		const sink = memoryStaticSink();
		await spool.publishStatic(sink, { verifyCore: read.fetcher });
		expect(read.urls).toEqual([await coreUrl()]);
		expect(sink.puts).toContain('/spool-sw.js');
	});

	it('fails on other bytes and writes nothing', async () => {
		const { spool } = site({ cdnWorker: true });
		const sink = memoryStaticSink();
		await expect(
			spool.publishStatic(sink, { verifyCore: serving(`${SW_CORE};`).fetcher })
		).rejects.toThrow(/does not match this build/);
		await expect(
			spool.publishStatic(sink, { verifyCore: serving('', 404).fetcher })
		).rejects.toThrow(/HTTP 404/);
		expect(sink.puts).toEqual([]);
	});

	it('compares a custom worker with the bytes at its own url', async () => {
		const worker = 'self.addEventListener("fetch",()=>{});';
		const url = 'https://assets.test/mine.js';
		const { spool } = site({ worker, cdnWorker: { url } });
		const good = serving(worker);
		await spool.publishStatic(memoryStaticSink(), { verifyCore: good.fetcher });
		expect(good.urls).toEqual([url]);
		await expect(
			spool.publishStatic(memoryStaticSink(), { verifyCore: serving(SW_CORE).fetcher })
		).rejects.toThrow(/does not match this build/);
	});

	it('uses the global fetch for true and refuses verifyCore without cdn.worker', async () => {
		const read = serving(SW_CORE);
		vi.stubGlobal('fetch', read.fetcher);
		try {
			await site({ cdnWorker: true }).spool.publishStatic(memoryStaticSink(), {
				verifyCore: true
			});
			expect(read.urls).toEqual([await coreUrl()]);
		} finally {
			vi.unstubAllGlobals();
		}
		const sink = memoryStaticSink();
		await expect(
			site().spool.publishStatic(sink, { verifyCore: read.fetcher })
		).rejects.toThrow(ProtocolError);
		await expect(
			site({ cdn: true }).spool.publishStatic(sink, { verifyCore: true })
		).rejects.toThrow(/needs cdn.worker/);
		expect(sink.puts).toEqual([]);
	});

	it('makes no request of its own by default', async () => {
		const read = serving(SW_CORE);
		vi.stubGlobal('fetch', read.fetcher);
		try {
			await site({ cdnWorker: true }).spool.publishStatic(memoryStaticSink());
			expect(read.urls).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('the stamp', () => {
	const stubOf = async (stamp?: number | (() => number)) => {
		const { spool } = site(stamp === undefined ? {} : { stamp });
		return (await spool.stub()).text();
	};

	it('changes the stub bytes when the stamp changes, and not when it does not', async () => {
		const one = await stubOf(1);
		expect(await stubOf(1)).toBe(one);
		expect(await stubOf(2)).not.toBe(one);
	});

	it('takes a function, read on each stub request', async () => {
		expect(await stubOf(() => 1)).toBe(await stubOf(1));
	});

	it('leaves the stub without a stamp when no stamp is set', async () => {
		expect(await stubOf()).not.toContain('"stamp"');
	});
});

describe('the file sink', () => {
	it('writes nested paths under the directory and reports what is there', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'spool-static-'));
		try {
			const sink = fileStaticSink(dir);
			expect(await sink.has?.('/.spool/bundle/1')).toBe(false);
			await sink.put(
				'/.spool/bundle/1',
				new Uint8Array([1, 2, 3]),
				'application/octet-stream'
			);
			expect(await sink.has?.('/.spool/bundle/1')).toBe(true);
			expect([...(await readFile(join(dir, '.spool/bundle/1')))]).toEqual([1, 2, 3]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
