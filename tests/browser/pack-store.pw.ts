import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { arch, platform } from 'node:os';

type Win = {
	protocol: typeof import('../../src/protocol/index');
	pack: typeof import('../../src/sw/pack/store');
};

const SIZES = [10_000, 100_000];
const READS = 1000;
const EDITS = 100;
const BLOCK_ROWS = 128;

/** the module as one browser file, bundled from the working tree by bun */
function bundle(entry: string): string {
	const built = spawnSync('bun', ['build', entry, '--target', 'browser', '--format', 'esm'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (built.status !== 0) throw new Error(`bun build ${entry} failed: ${built.stderr}`);
	return built.stdout;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>pack store</title><script type="module">
import * as protocol from '/protocol.js';
import * as pack from '/pack.js';
window.protocol = protocol;
window.pack = pack;
</script>`;

let server: Server;
let origin: string;

test.beforeAll(async () => {
	const files: Record<string, string> = {
		'/protocol.js': bundle('src/protocol/index.ts'),
		'/pack.js': bundle('src/sw/pack/store.ts')
	};
	server = createServer((request, response) => {
		const body = files[request.url ?? ''];
		response.setHeader('content-type', body ? 'text/javascript' : 'text/html');
		response.end(body ?? PAGE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

for (const rows of SIZES) {
	test(`installs ${rows} rows, reads, applies a delta and reads after a reload`, async ({
		page
	}, testInfo) => {
		test.setTimeout(300_000);
		await page.goto(origin + '/');
		await page.waitForFunction(() => 'pack' in window);

		const install = await page.evaluate(
			async ({ rows, reads, edits }) => {
				const { protocol, pack } = window as unknown as Win;
				const keyOf = (i: number) => `k${String(2 * i).padStart(7, '0')}`;
				const stateOf = (version: number, changed: number) => {
					const held: Array<[string, Record<string, string>]> = [];
					for (let i = 0; i < rows; i++) {
						const title = i < changed ? `Edited ${i}` : `Title ${i}`;
						held.push([keyOf(i), { id: keyOf(i), title }]);
					}
					return { version, tables: { items: held } };
				};
				async function* chunks(bytes: Uint8Array<ArrayBuffer>, size = 65536) {
					for (let at = 0; at < bytes.length; at += size)
						yield bytes.slice(at, at + size);
				}

				const store = pack.createPackStore(indexedDB);
				const v1 = stateOf(1, 0);
				const { bytes } = await protocol.buildPack(v1);
				const started = performance.now();
				const outcome = await store.installPack(chunks(bytes), { bytes: bytes.length });
				const installMs = performance.now() - started;
				const recordCounts = await store.recordCounts();
				const usage = await navigator.storage?.estimate?.();

				let seed = 12345;
				const random = () => {
					seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
					return seed;
				};
				const before = { ...store.counters };
				const lookupStart = performance.now();
				let matches = 0;
				for (let n = 0; n < reads; n++) {
					const i = random() % rows;
					const row = await store.getRow('items', keyOf(i));
					if (row?.title === `Title ${i}`) matches++;
				}
				const lookupMs = performance.now() - lookupStart;
				const during = {
					blockReads: store.counters.blockReads - before.blockReads,
					blockInflates: store.counters.blockInflates - before.blockInflates,
					overlayReads: store.counters.overlayReads - before.overlayReads
				};

				const v2 = stateOf(2, edits);
				const delta = await protocol.makeDelta(v1, v2);
				const deltaStart = performance.now();
				await store.applyDelta(delta);
				const deltaMs = performance.now() - deltaStart;
				const afterDelta = await store.recordCounts();
				let editedMatches = 0;
				for (let i = 0; i < edits; i++) {
					const row = await store.getRow('items', keyOf(i));
					if (row?.title === `Edited ${i}`) editedMatches++;
				}
				return {
					outcome,
					recordCounts,
					installMs,
					usage,
					matches,
					lookupMs,
					during,
					deltaPuts: delta.tables['items']?.puts.length ?? 0,
					deltaMs,
					afterDelta,
					editedMatches
				};
			},
			{ rows, reads: READS, edits: EDITS }
		);

		const blocks = Math.ceil(rows / BLOCK_ROWS);
		expect(install.outcome).toEqual({
			installed: true,
			version: 1,
			tables: 1,
			rows,
			blocks
		});
		expect(install.recordCounts).toEqual({ blocks, index: 1, overlay: 0, head: 1 });
		expect(install.matches).toBe(READS);
		// random keys may share a block, so reads are at most one per lookup and inflates match reads
		expect(install.during.blockReads).toBeLessThanOrEqual(READS);
		expect(install.during.blockInflates).toBe(install.during.blockReads);
		expect(install.during.overlayReads).toBe(READS);
		expect(install.deltaPuts).toBe(EDITS);
		expect(install.afterDelta).toEqual({ blocks, index: 1, overlay: EDITS, head: 1 });
		expect(install.editedMatches).toBe(EDITS);

		// a new document reads the same pack and overlay from IndexedDB
		await page.waitForTimeout(1500);
		await page.reload();
		await page.waitForFunction(() => 'pack' in window);
		const reloaded = await page.evaluate(
			async ({ rows, edits }) => {
				const { pack } = window as unknown as Win;
				const keyOf = (i: number) => `k${String(2 * i).padStart(7, '0')}`;
				const store = pack.createPackStore(indexedDB);
				let editedMatches = 0;
				for (let i = 0; i < edits; i++) {
					const row = await store.getRow('items', keyOf(i));
					if (row?.title === `Edited ${i}`) editedMatches++;
				}
				const last = await store.getRow('items', keyOf(rows - 1));
				return {
					version: (await store.head())?.version,
					recordCounts: await store.recordCounts(),
					editedMatches,
					lastTitle: last?.title
				};
			},
			{ rows, edits: EDITS }
		);
		expect(reloaded.version).toBe(2);
		expect(reloaded.recordCounts).toEqual(install.afterDelta);
		expect(reloaded.editedMatches).toBe(EDITS);
		expect(reloaded.lastTitle).toBe(`Title ${rows - 1}`);

		// L1 readings, printed and not asserted
		console.log(
			JSON.stringify({
				layer: 'L1',
				project: testInfo.project.name,
				platform: platform(),
				arch: arch(),
				rows,
				installMs: Math.round(install.installMs),
				lookupMsPerView: Number((install.lookupMs / READS).toFixed(3)),
				deltaMs: Math.round(install.deltaMs),
				usage: install.usage
			})
		);
	});
}
