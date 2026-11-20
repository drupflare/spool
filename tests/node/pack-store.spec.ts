import { describe, expect, it } from 'vitest';
import {
	buildPack,
	type BundleRows,
	type BundleState,
	COMPACT_OVERLAY_ROWS,
	defineRoute,
	makeDelta,
	mergeDeltas,
	type Ring,
	serializeRoute
} from '../../src/protocol/index';
import { createPackStore, type PackStore, QUOTA_MARGIN_BYTES } from '../../src/sw/index';
import { freshIndexedDB } from './helpers';

type Bytes = Uint8Array<ArrayBuffer>;

const keyNumber = (n: number) => `k${String(n).padStart(7, '0')}`;
/** row i has key 2i, so every odd key between two rows is absent */
const keyOf = (i: number) => keyNumber(2 * i);

/** `rows` rows of table `items`; `edit[i]` retitles row i, and `null` drops it */
function stateOf(
	rows: number,
	version = 1,
	edit: Partial<Record<number, string | null>> = {}
): BundleState {
	const held: BundleRows = [];
	for (let i = 0; i < rows; i++) {
		const title = edit[i];
		if (title === null) continue;
		held.push([keyOf(i), { id: keyOf(i), title: title ?? `Title ${i}` }]);
	}
	return { version, tables: { items: held } };
}

async function* chunked(bytes: Bytes, size = 4096): AsyncGenerator<Bytes> {
	for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

/** the source of a pack that stops with an error once half of it has been sent */
async function* cutShort(bytes: Bytes, size = 4096): AsyncGenerator<Bytes> {
	for (let at = 0; at < bytes.length; at += size) {
		if (at >= bytes.length / 2) throw new Error('link cut');
		yield bytes.slice(at, at + size);
	}
}

async function install(store: PackStore, state: BundleState) {
	const { bytes } = await buildPack(state);
	return store.installPack(chunked(bytes));
}

/** the counter values now, minus the values before `before` */
function since(store: PackStore, before: PackStore['counters']) {
	return {
		blockReads: store.counters.blockReads - before.blockReads,
		blockInflates: store.counters.blockInflates - before.blockInflates,
		overlayReads: store.counters.overlayReads - before.overlayReads
	};
}

describe('pack store install', () => {
	it('holds 1, 128, 129 and 10,000 rows in exact record counts', async () => {
		for (const rows of [1, 128, 129, 10_000]) {
			const store = createPackStore(freshIndexedDB());
			const blocks = Math.ceil(rows / 128);
			expect(await install(store, stateOf(rows))).toEqual({
				installed: true,
				version: 1,
				tables: 1,
				rows,
				blocks
			});
			expect(await store.recordCounts()).toEqual({ blocks, index: 1, overlay: 0, head: 1 });
			expect(await store.scanTable('items')).toHaveLength(rows);
		}
	});

	it('refuses a corrupted block and keeps the previous head answering', async () => {
		const factory = freshIndexedDB();
		const store = createPackStore(factory);
		await install(store, stateOf(300));
		const { bytes } = await buildPack(stateOf(300, 2, { 5: 'changed' }));
		const bad = bytes.slice();
		bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
		await expect(store.installPack(chunked(bad))).rejects.toThrow('does not match its hash');
		expect((await store.head())?.version).toBe(1);
		expect((await store.getRow('items', keyOf(5)))?.title).toBe('Title 5');
		expect(await store.recordCounts()).toEqual({ blocks: 3, index: 1, overlay: 0, head: 1 });
	});

	it('keeps the previous version readable when an install is cut short', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(1000));
		const { bytes } = await buildPack(stateOf(1000, 2, { 0: 'changed' }));
		await expect(store.installPack(cutShort(bytes))).rejects.toThrow('link cut');
		expect((await store.head())?.version).toBe(1);
		expect((await store.getRow('items', keyOf(0)))?.title).toBe('Title 0');
		expect(await store.recordCounts()).toEqual({ blocks: 8, index: 1, overlay: 0, head: 1 });
	});

	it('reads the installed version after a reload', async () => {
		const factory = freshIndexedDB();
		await install(createPackStore(factory), stateOf(200));
		const reloaded = createPackStore(factory);
		expect(await reloaded.head()).toMatchObject({ version: 1, generation: 1 });
		expect((await reloaded.getRow('items', keyOf(150)))?.title).toBe('Title 150');
	});

	it('refuses an install that would exceed the quota less the margin', async () => {
		const { bytes } = await buildPack(stateOf(50));
		const fits = bytes.length + QUOTA_MARGIN_BYTES;
		const exact = createPackStore(freshIndexedDB(), {
			estimate: async () => ({ usage: 0, quota: fits })
		});
		expect(await exact.estimateBeforeInstall(bytes.length)).toEqual({
			checked: true,
			fits: true
		});
		const short = createPackStore(freshIndexedDB(), {
			estimate: async () => ({ usage: 0, quota: fits - 1 })
		});
		expect(await short.installPack(chunked(bytes), { bytes: bytes.length })).toEqual({
			installed: false,
			fit: {
				checked: true,
				fits: false,
				bytes: bytes.length,
				usage: 0,
				quota: fits - 1
			}
		});
		expect(await short.recordCounts()).toEqual({ blocks: 0, index: 0, overlay: 0, head: 0 });
	});

	it('proceeds where the browser has no storage estimate', async () => {
		const store = createPackStore(freshIndexedDB(), { estimate: async () => undefined });
		expect(await store.estimateBeforeInstall(1 << 30)).toEqual({ checked: false, fits: true });
	});
});

describe('pack store lookups', () => {
	it('reads one block per cold lookup, none on a cache hit, and none outside every block', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(2000));
		let before = { ...store.counters };

		// block 10 holds rows 1280 to 1407; key 2567 sits between two of its rows
		expect(await store.getRow('items', keyNumber(2567))).toBeUndefined();
		expect(since(store, before)).toEqual({ blockReads: 1, blockInflates: 1, overlayReads: 1 });

		before = { ...store.counters };
		expect((await store.getRow('items', keyOf(1283)))?.title).toBe('Title 1283');
		expect(since(store, before)).toEqual({ blockReads: 0, blockInflates: 0, overlayReads: 1 });

		// block 10 ends at key 2814 and block 11 starts at key 2816; 2815 lies in the gap
		before = { ...store.counters };
		expect(await store.getRow('items', keyNumber(2815))).toBeUndefined();
		expect(since(store, before)).toEqual({ blockReads: 0, blockInflates: 0, overlayReads: 1 });

		before = { ...store.counters };
		expect(await store.getRow('items', 'a')).toBeUndefined();
		expect(since(store, before)).toEqual({ blockReads: 0, blockInflates: 0, overlayReads: 1 });

		before = { ...store.counters };
		expect((await store.getRow('items', keyOf(1900)))?.title).toBe('Title 1900');
		expect(since(store, before)).toEqual({ blockReads: 1, blockInflates: 1, overlayReads: 1 });

		before = { ...store.counters };
		expect(await store.getRow('missing', keyOf(3))).toBeUndefined();
		expect(since(store, before)).toEqual({ blockReads: 0, blockInflates: 0, overlayReads: 1 });
	});
});

describe('pack store deltas', () => {
	it('lays the changed rows and tombstones over the blocks', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		const next = stateOf(300, 2, { 7: 'changed', 9: null });
		await store.applyDelta(await makeDelta(stateOf(300), next));
		expect(await store.recordCounts()).toEqual({ blocks: 3, index: 1, overlay: 2, head: 1 });
		expect((await store.head())?.version).toBe(2);
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('changed');

		const before = { ...store.counters };
		expect(await store.getRow('items', keyOf(9))).toBeUndefined();
		expect(since(store, before)).toEqual({ blockReads: 0, blockInflates: 0, overlayReads: 1 });
		expect(await store.scanTable('items')).toHaveLength(299);
	});

	it('refuses a delta whose digest is wrong, and writes nothing', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		const delta = await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' }));
		await expect(store.applyDelta({ ...delta, digest: '1'.repeat(64) })).rejects.toThrow(
			'does not match the delta'
		);
		expect(await store.recordCounts()).toEqual({ blocks: 3, index: 1, overlay: 0, head: 1 });
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('Title 7');
	});

	it('refuses a delta that starts at another version', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		const delta = await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' }));
		await expect(store.applyDelta({ ...delta, from: 3 })).rejects.toThrow(
			'the delta starts at 3'
		);
	});

	it('a merged delta equals the same deltas applied in order', async () => {
		const s1 = stateOf(300);
		const s2 = stateOf(300, 2, { 7: 'a' });
		const s3 = stateOf(300, 3, { 7: 'b', 9: null, 11: 'c' });
		const d12 = await makeDelta(s1, s2);
		const d23 = await makeDelta(s2, s3);

		const inOrder = createPackStore(freshIndexedDB());
		await install(inOrder, s1);
		await inOrder.applyDelta(d12);
		await inOrder.applyDelta(d23);

		const merged = createPackStore(freshIndexedDB());
		await install(merged, s1);
		await merged.applyDelta(mergeDeltas([d12, d23]));

		expect(await merged.scanTable('items')).toEqual(s3.tables.items);
		expect(await merged.scanTable('items')).toEqual(await inOrder.scanTable('items'));
		expect((await merged.head())?.digest).toBe((await inOrder.head())?.digest);
	});
});

describe('pack store compaction', () => {
	it('folds an overlay past the threshold into new blocks with the same answers', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(2000));
		const edit: Partial<Record<number, string | null>> = {};
		for (let i = 0; i <= COMPACT_OVERLAY_ROWS; i++) edit[i] = `Edited ${i}`;
		const v2 = stateOf(2000, 2, edit);
		await store.applyDelta(await makeDelta(stateOf(2000), v2));
		expect((await store.recordCounts()).overlay).toBe(COMPACT_OVERLAY_ROWS + 1);

		const sample = [0, 500, 1000, 1001, 1999];
		const before = await Promise.all(sample.map((i) => store.getRow('items', keyOf(i))));
		expect(await store.compact()).toBe(true);
		expect(await store.recordCounts()).toEqual({ blocks: 16, index: 1, overlay: 0, head: 1 });
		expect(await Promise.all(sample.map((i) => store.getRow('items', keyOf(i))))).toEqual(
			before
		);
		expect(await store.scanTable('items')).toEqual(v2.tables.items);
		expect((await store.head())?.generation).toBe(2);

		await store.applyDelta(await makeDelta(v2, stateOf(2000, 3, { ...edit, 5: 'x' })));
		expect(await store.compact()).toBe(false);
		expect((await store.recordCounts()).overlay).toBe(1);
	});
});

describe('pack store routes', () => {
	const template = { source: '<p>{{row.title}}</p>' };

	it('replaces the held routes and keeps the order they were put in', async () => {
		const store = createPackStore(freshIndexedDB());
		expect(await store.getRoutes()).toEqual([]);
		const first = [
			serializeRoute(
				defineRoute('/b/:id', { strategy: 'template', template, load: () => ({}) })
			),
			serializeRoute(defineRoute('/a', { strategy: 'template', template, load: () => ({}) }))
		];
		await store.putRoutes(first);
		expect(await store.getRoutes()).toEqual(first);
		await store.putRoutes([
			serializeRoute(defineRoute('/c', { strategy: 'template', template, load: () => ({}) }))
		]);
		expect((await store.getRoutes()).map((route) => route.pattern)).toEqual(['/c']);
	});

	it('returns a family route with its binding and its navigation option', async () => {
		const store = createPackStore(freshIndexedDB());
		const held = serializeRoute(
			defineRoute('/courses/:id', {
				strategy: 'template',
				template,
				family: { dataset: 'courses', key: 'id' },
				navigation: 'document'
			})
		);
		await store.putRoutes([held]);
		expect(await store.getRoutes()).toEqual([held]);
		expect(held).toMatchObject({
			family: { dataset: 'courses', key: 'id' },
			navigation: 'document'
		});
	});
});

describe('pack store predicted rows', () => {
	const predictedRow = (key: number, title: string) => ({ id: keyOf(key), title });

	it('reads a predicted row and a predicted delete at once, without moving the version', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		const before = await store.head();
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: [['items', keyOf(9)]]
		});
		const head = await store.head();
		expect(head).toEqual({ ...before, unconfirmed: 2 });
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('predicted');
		expect(await store.getRow('items', keyOf(9))).toBeUndefined();
		expect(await store.scanTable('items')).toHaveLength(299);
		expect((await store.scanTable('items'))[7]).toEqual([
			keyOf(7),
			predictedRow(7, 'predicted')
		]);
	});

	it('a covering delta confirms the predicted rows it names', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		await store.applyDelta(await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' })));
		expect((await store.head())?.unconfirmed).toBe(0);
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('changed');
	});

	it('a delta that does not cover a predicted row drops it when it moves the version', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(5), predictedRow(5, 'predicted')]],
			deletes: []
		});
		await store.applyDelta(await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' })));
		expect((await store.head())?.unconfirmed).toBe(0);
		expect((await store.getRow('items', keyOf(5)))?.title).toBe('Title 5');
	});

	it('a predicted delete hides a block row until a covering delta confirms it', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({ puts: [], deletes: [['items', keyOf(9)]] });
		expect(await store.getRow('items', keyOf(9))).toBeUndefined();
		expect(await store.scanTable('items')).toHaveLength(299);
		await store.applyDelta(await makeDelta(stateOf(300), stateOf(300, 2, { 9: null })));
		expect((await store.head())?.unconfirmed).toBe(0);
		expect(await store.getRow('items', keyOf(9))).toBeUndefined();
		expect(await store.scanTable('items')).toHaveLength(299);
	});

	it('a delta never reads a predicted row as the base it checks against', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		const delta = await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' }));
		await expect(store.applyDelta(delta)).resolves.toBeUndefined();
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('changed');
	});

	it('an install of a new pack clears every predicted row', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: [['items', keyOf(9)]]
		});
		await install(store, stateOf(300, 5));
		expect((await store.head())?.unconfirmed).toBe(0);
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('Title 7');
		expect((await store.getRow('items', keyOf(9)))?.title).toBe('Title 9');
	});

	it('does not compact while a predicted row waits for its delta', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		expect(await store.compact()).toBe(false);
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('predicted');
	});

	it('writes nothing when no pack is held', async () => {
		const store = createPackStore(freshIndexedDB());
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		expect(await store.head()).toBeUndefined();
		expect(await store.getRow('items', keyOf(7))).toBeUndefined();
	});

	it('confirms the predicted rows at the version and digest the server names', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		const { digest } = await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'predicted' }));
		await store.confirmPredicted(2, digest);
		expect(await store.head()).toEqual(expect.objectContaining({ version: 2, unconfirmed: 0 }));
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('predicted');
	});

	it('refuses a digest the predicted rows do not reach, and keeps them', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: []
		});
		const { digest } = await makeDelta(stateOf(300), stateOf(300, 2, { 7: 'changed' }));
		await expect(store.confirmPredicted(2, digest)).rejects.toThrow();
		expect(await store.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 1 }));
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('predicted');
	});

	it('drops the predicted rows without moving the version', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		await store.applyPredicted({
			puts: [['items', keyOf(7), predictedRow(7, 'predicted')]],
			deletes: [['items', keyOf(9)]]
		});
		await store.dropPredicted();
		expect(await store.head()).toEqual(expect.objectContaining({ version: 1, unconfirmed: 0 }));
		expect((await store.getRow('items', keyOf(7)))?.title).toBe('Title 7');
		expect((await store.getRow('items', keyOf(9)))?.title).toBe('Title 9');
	});

	it('confirms the index rows a POST and a DELETE predict at the digest of the state they reach', async () => {
		const indexed = (keys: number[], version: number): BundleState => {
			const rows = keys.map((i) => ({ id: keyOf(i), title: `Title ${i}` }));
			return {
				version,
				tables: {
					items: rows.map((row): BundleRows[number] => [row.id, row]),
					'path:items': rows.map((row): BundleRows[number] => [
						`/items/${row.id}`,
						{ key: row.id }
					]),
					'query:items': rows.map((row): BundleRows[number] => [
						row.id,
						{ title: row.title }
					])
				}
			};
		};
		const store = createPackStore(freshIndexedDB());
		await install(store, indexed([0, 1, 2], 1));
		const grown = await buildPack(indexed([0, 1, 2, 3], 2));
		await store.applyPredicted({
			puts: [
				['items', keyOf(3), { id: keyOf(3), title: 'Title 3' }],
				['path:items', `/items/${keyOf(3)}`, { key: keyOf(3) }],
				['query:items', keyOf(3), { title: 'Title 3' }]
			],
			deletes: []
		});
		await store.confirmPredicted(2, grown.index.digest);
		expect(await store.head()).toEqual(
			expect.objectContaining({ version: 2, digest: grown.index.digest, unconfirmed: 0 })
		);
		expect(await store.getRow('path:items', `/items/${keyOf(3)}`)).toEqual({ key: keyOf(3) });

		const shrunk = await buildPack(indexed([1, 2, 3], 3));
		await store.applyPredicted({
			puts: [],
			deletes: [
				['items', keyOf(0)],
				['path:items', `/items/${keyOf(0)}`],
				['query:items', keyOf(0)]
			]
		});
		await store.confirmPredicted(3, shrunk.index.digest);
		expect(await store.head()).toEqual(
			expect.objectContaining({ version: 3, digest: shrunk.index.digest, unconfirmed: 0 })
		);
		expect(await store.getRow('path:items', `/items/${keyOf(0)}`)).toBeUndefined();
	});
});

describe('pack store ring', () => {
	const template = { source: '<p>{{row.title}}</p>' };
	const ringOf = async (
		version: number,
		rows: number,
		extra: Partial<Ring> = {}
	): Promise<Ring> => {
		const state = stateOf(rows, version);
		const { index } = await buildPack(state);
		return {
			protocol: 1,
			version,
			digest: index.digest,
			routes: [],
			templates: {},
			tables: { items: (state.tables['items'] ?? []).slice(0, 2) },
			complete: false,
			bootstrap: 'second-view',
			worker: 'auto',
			...extra
		};
	};

	it('answers a ring row from a partial head and misses another key', async () => {
		const store = createPackStore(freshIndexedDB());
		const route = serializeRoute(
			defineRoute('/items/:id', {
				strategy: 'template',
				template,
				family: { dataset: 'items', key: 'id' }
			})
		);
		const ring = await ringOf(1, 300, { routes: [route] });
		expect(await store.installRing(ring)).toEqual({
			installed: true,
			version: 1,
			rows: 2,
			complete: false
		});
		expect(await store.getRow('items', keyOf(0))).toEqual({ id: keyOf(0), title: 'Title 0' });
		expect(await store.getRow('items', keyOf(5))).toBeUndefined();
		expect((await store.head())?.partial).toBe(true);
		expect(await store.scanTable('items')).toEqual(ring.tables['items']);
		expect(await store.getRoutes()).toEqual([route]);
	});

	it('replaces a partial head with an installed pack of the same version and clears the ring rows', async () => {
		const store = createPackStore(freshIndexedDB());
		await store.installRing(await ringOf(1, 300));
		expect(await install(store, stateOf(300))).toMatchObject({ installed: true, version: 1 });
		expect((await store.head())?.partial).toBeUndefined();
		expect((await store.recordCounts()).overlay).toBe(0);
		expect(await store.getRow('items', keyOf(5))).toEqual({ id: keyOf(5), title: 'Title 5' });
	});

	it('refuses a ring older than the held pack and keeps the pack', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300, 2));
		expect(await store.installRing(await ringOf(1, 300))).toEqual({
			installed: false,
			reason: 'older'
		});
		expect((await store.head())?.version).toBe(2);
		expect(await store.getRow('items', keyOf(5))).toEqual({ id: keyOf(5), title: 'Title 5' });
	});

	it('keeps a complete pack of the same version and does not turn it partial', async () => {
		const store = createPackStore(freshIndexedDB());
		await install(store, stateOf(300));
		expect(await store.installRing(await ringOf(1, 300))).toEqual({
			installed: false,
			reason: 'held'
		});
		expect((await store.head())?.partial).toBeUndefined();
		expect(await store.getRow('items', keyOf(5))).toEqual({ id: keyOf(5), title: 'Title 5' });
	});

	it('refuses a complete ring whose digest does not match its rows', async () => {
		const store = createPackStore(freshIndexedDB());
		const ring = await ringOf(1, 300, { complete: true, tables: stateOf(300).tables });
		await expect(store.installRing({ ...ring, digest: '0'.repeat(64) })).rejects.toThrow(
			'does not match'
		);
		expect(await store.head()).toBeUndefined();
	});

	it('installs a complete ring with its rows as a normal head', async () => {
		const store = createPackStore(freshIndexedDB());
		const ring = await ringOf(1, 300, { complete: true, tables: stateOf(300).tables });
		expect(await store.installRing(ring)).toEqual({
			installed: true,
			version: 1,
			rows: 300,
			complete: true
		});
		expect((await store.head())?.partial).toBeUndefined();
		expect(await store.getRow('items', keyOf(299))).toEqual({
			id: keyOf(299),
			title: 'Title 299'
		});
	});

	it('refuses to compact or apply a delta over a partial head', async () => {
		const store = createPackStore(freshIndexedDB());
		await store.installRing(await ringOf(1, 300));
		expect(await store.compact()).toBe(false);
		await expect(
			store.applyDelta({ from: 1, to: 2, digest: '0'.repeat(64), tables: {} })
		).rejects.toThrow('partial');
	});

	it('keeps the templates of a partial ring beside its routes', async () => {
		const store = createPackStore(freshIndexedDB());
		const declared = defineRoute('/items/:id', {
			strategy: 'template',
			template,
			family: { dataset: 'items', key: 'id' }
		});
		const route = serializeRoute(declared);
		const templates = {
			[route.pattern]: declared.template as NonNullable<typeof declared.template>
		};
		await store.installRing(await ringOf(1, 300, { routes: [route], templates }));
		expect(await store.getTemplates()).toEqual(templates);
		expect(await store.getRoutes()).toEqual([route]);
		await store.putRoutes([route]);
		expect(await store.getTemplates()).toEqual({});
	});

	it('keeps the templates of a complete ring as a normal head', async () => {
		const store = createPackStore(freshIndexedDB());
		const declared = defineRoute('/items/:id', {
			strategy: 'template',
			template,
			family: { dataset: 'items', key: 'id' }
		});
		const route = serializeRoute(declared);
		const templates = {
			[route.pattern]: declared.template as NonNullable<typeof declared.template>
		};
		await store.installRing(
			await ringOf(1, 300, {
				complete: true,
				tables: stateOf(300).tables,
				routes: [route],
				templates
			})
		);
		expect(await store.getTemplates()).toEqual(templates);
	});
});
