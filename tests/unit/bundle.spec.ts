import { describe, expect, it } from 'vitest';
import {
	applyDelta,
	buildPack,
	bundleDigest,
	COMPACT_OVERLAY_BYTES,
	COMPACT_OVERLAY_ROWS,
	compactBundle,
	compactionDue,
	EMPTY_DIGEST,
	makeDelta,
	MAX_BUNDLE_BLOCK_BYTES,
	mergeDeltas,
	readBlock,
	readBundle,
	readFrames,
	type BundleIndex,
	type BundleRows,
	type BundleState
} from '../../src/protocol/index';
import { indexPlan, indexRowsOf, type IndexRoute } from '../../src/protocol/index-rows';

describe('index rows of one row', () => {
	const routes: IndexRoute[] = [
		{ pattern: '/items/:id', scope: 'public', family: { dataset: 'items', key: 'id' } },
		{
			pattern: '/items',
			scope: 'public',
			query: { list: 'items', dataset: 'items', filter: { title: 'string' }, sort: ['rank'] }
		},
		{ pattern: '/pairs/:a/:b', scope: 'public', family: { dataset: 'pairs', key: 'a' } },
		{ pattern: '/mine/:id', scope: 'principal', family: { dataset: 'mine', key: 'id' } }
	];
	const plan = indexPlan(routes);

	it('keeps the family routes whose pattern has no param but the key, and the query fields', () => {
		expect(plan.paths).toEqual([{ dataset: 'items', pattern: '/items/:id', key: 'id' }]);
		expect([...plan.fields]).toEqual([['items', ['title', 'rank']]]);
	});

	it('gives the path and the projected query row of a put row', () => {
		expect(
			indexRowsOf(plan, 'items', 'k1', { id: 'k1', title: 'Uno', rank: 2, note: 'x' })
		).toEqual([
			['path:items', '/items/k1', { key: 'k1' }],
			['query:items', 'k1', { title: 'Uno', rank: 2 }]
		]);
	});

	it('projects only the fields a row holds', () => {
		expect(indexRowsOf(plan, 'items', 'k2', { id: 'k2', title: 'Dos' })).toEqual([
			['path:items', '/items/k2', { key: 'k2' }],
			['query:items', 'k2', { title: 'Dos' }]
		]);
	});

	it('gives the removal of a key as null rows in the same tables', () => {
		expect(indexRowsOf(plan, 'items', 'k1')).toEqual([
			['path:items', '/items/k1', null],
			['query:items', 'k1', null]
		]);
	});

	it('gives no index row for a dataset no route indexes', () => {
		expect(indexRowsOf(plan, 'pairs', 'x', { a: 'x', b: 'y' })).toEqual([]);
		expect(indexRowsOf(plan, 'mine', 'm1', { id: 'm1' })).toEqual([]);
	});
});

const rowsOf = (count: number, tag = 'v'): BundleRows =>
	Array.from({ length: count }, (_, i) => [
		`k${String(i).padStart(5, '0')}`,
		{ id: i, title: `${tag} ${i}` }
	]);

async function* chunked(bytes: Uint8Array, size: number) {
	for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

describe('the pack codec', () => {
	it.each([1, 128, 129, 10_000])('round trips %i rows in blocks of 128', async (count) => {
		const state: BundleState = { version: 7, tables: { courses: rowsOf(count) } };
		const { index, bytes } = await buildPack(state);
		const back = await readBundle(bytes);
		expect(back.state).toEqual(state);
		expect(index.tables[0]?.blocks.length).toBe(Math.ceil(count / 128));
	});

	it('pins the block count and the index size of a fixed fixture', async () => {
		const state: BundleState = {
			version: 3,
			tables: { courses: rowsOf(300), path: [['/a', { id: 'a' }]] }
		};
		const { index, bytes } = await buildPack(state);
		expect(index.tables.map((t) => t.blocks.length)).toEqual([3, 1]);
		const frames = readFrames(chunked(bytes, bytes.length));
		const head = await frames.next();
		expect(head.value?.table).toBe(-1);
		expect(head.value?.payload.length).toBe(422);
	});

	it('reads a pack that arrives in 7-byte chunks as the same state', async (): Promise<void> => {
		const state: BundleState = { version: 2, tables: { courses: rowsOf(300) } };
		const { bytes } = await buildPack(state);
		const whole = await readBundle(bytes);
		const streamed = await readBundle(chunked(bytes, 7));
		expect(streamed).toEqual(whole);
	});

	it('refuses a block whose bytes were changed', async () => {
		const { bytes } = await buildPack({ version: 1, tables: { courses: rowsOf(10) } });
		const corrupt = bytes.slice();
		corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
		await expect(readBundle(corrupt)).rejects.toThrow('does not match its hash');
	});

	it('refuses a repeated key', async () => {
		const tables = { courses: [...rowsOf(2), ['k00000', { id: 9 }]] as BundleRows };
		await expect(buildPack({ version: 1, tables })).rejects.toThrow('repeats');
	});

	it('builds an empty pack for a site with no table', async () => {
		const { index, bytes } = await buildPack({ version: 0, tables: { courses: [] } });
		expect(index.tables).toEqual([]);
		expect(index.digest).toBe(EMPTY_DIGEST);
		const back = await readBundle(bytes);
		expect(back.state).toEqual({ version: 0, tables: {} });
	});
});

describe('the set digest', () => {
	it('does not depend on the order of the rows', async () => {
		const rows = rowsOf(50);
		expect(await bundleDigest({ courses: [...rows].reverse() })).toBe(
			await bundleDigest({ courses: rows })
		);
	});

	it('changes when a row changes', async () => {
		const before = await bundleDigest({ courses: rowsOf(5) });
		const after = await bundleDigest({ courses: rowsOf(5, 'w') });
		expect(after).not.toBe(before);
	});

	it('changes when only a key changes', async () => {
		const row = { to: '/x' };
		const before = await bundleDigest({ path: [['/a', row]] });
		const after = await bundleDigest({ path: [['/b', row]] });
		expect(after).not.toBe(before);
	});

	it('changes when a path entry in a second table changes', async () => {
		const courses = rowsOf(3);
		const before = await bundleDigest({ courses, path: [['/a', { id: 1 }]] });
		const after = await bundleDigest({ courses, path: [['/a', { id: 2 }]] });
		expect(after).not.toBe(before);
	});
});

const s2: BundleState = {
	version: 2,
	tables: {
		courses: rowsOf(30, 'a'),
		path: [['/a', { id: 1 }]]
	}
};

const s3: BundleState = {
	version: 3,
	tables: {
		courses: [
			...rowsOf(30, 'a').map(([key, row]) =>
				key === 'k00010'
					? ([key, { ...row, title: 'changed' }] as const)
					: ([key, row] as const)
			),
			['k00999', { id: 999 }]
		] as BundleRows,
		path: [
			['/a', { id: 1 }],
			['/b', { id: 2 }]
		]
	}
};

const s4: BundleState = {
	version: 4,
	tables: {
		courses: rowsOf(30, 'a')
			.filter(([key]) => key !== 'k00020')
			.map(([key, row]) =>
				key === 'k00010'
					? ([key, { ...row, title: 'changed' }] as const)
					: ([key, row] as const)
			) as BundleRows,
		path: [['/b', { id: 2 }]]
	}
};

const s5: BundleState = {
	version: 5,
	tables: {
		courses: [
			...rowsOf(30, 'a')
				.filter(([key]) => key !== 'k00020')
				.map(([key, row]) =>
					key === 'k00010'
						? ([key, { ...row, title: 'changed' }] as const)
						: ([key, row] as const)
				),
			['k00020', { id: 20, title: 'back' }]
		].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) as BundleRows,
		path: [['/b', { id: 22 }]]
	}
};

describe('deltas', () => {
	it('lists the rows a change puts and the keys it removes', async () => {
		const delta = await makeDelta(s3, s4);
		expect(delta.from).toBe(3);
		expect(delta.to).toBe(4);
		expect(delta.tables['courses']?.deletes).toEqual(['k00020', 'k00999']);
		expect(delta.tables['courses']?.puts.map(([key]) => key)).toEqual([]);
		expect(delta.tables['path']?.deletes).toEqual(['/a']);
	});

	it('applies a delta to the state at its from version', async () => {
		const applied = await applyDelta(s3, await makeDelta(s3, s4));
		expect(applied).toEqual(s4);
	});

	it('merges the deltas from 2 to 5 into one equal to applying them in order', async () => {
		const deltas = [await makeDelta(s2, s3), await makeDelta(s3, s4), await makeDelta(s4, s5)];
		let inOrder: BundleState = s2;
		for (const delta of deltas) inOrder = await applyDelta(inOrder, delta);
		const merged = mergeDeltas(deltas);
		expect(merged.from).toBe(2);
		expect(merged.to).toBe(5);
		expect(merged.digest).toBe(await bundleDigest(s5.tables));
		expect(await applyDelta(s2, merged)).toEqual(s5);
		expect(inOrder).toEqual(s5);
	});

	it('merges a tombstone that removes a row the base never held', async () => {
		const merged = mergeDeltas([await makeDelta(s2, s3), await makeDelta(s3, s4)]);
		expect(merged.tables['courses']?.deletes).toContain('k00999');
		expect(merged.tables['courses']?.puts.some(([key]) => key === 'k00999')).toBe(false);
	});

	it('refuses deltas that do not chain', async () => {
		const gap = [await makeDelta(s2, s3), await makeDelta(s4, s5)];
		expect(() => mergeDeltas(gap)).toThrow('do not chain');
	});

	it('refuses a base at another version', async () => {
		await expect(applyDelta(s2, await makeDelta(s3, s4))).rejects.toThrow('starts at 3');
	});

	it('refuses a delta whose path entry key was corrupted', async () => {
		const delta = await makeDelta(s3, s4);
		const bad = structuredClone(delta);
		bad.tables = { ...bad.tables, path: { puts: [['/evil', { id: 2 }]], deletes: ['/a'] } };
		await expect(applyDelta(s3, bad)).rejects.toThrow('digest');
	});

	it('decides compaction by the row and byte thresholds', async () => {
		const small = await makeDelta(
			{ version: 1, tables: {} },
			{ version: 2, tables: { t: rowsOf(3) } }
		);
		expect(compactionDue(small)).toBe(false);
		const many = await makeDelta(
			{ version: 1, tables: {} },
			{ version: 2, tables: { t: rowsOf(COMPACT_OVERLAY_ROWS + 1) } }
		);
		expect(compactionDue(many)).toBe(true);
		const wide = await makeDelta(
			{ version: 1, tables: {} },
			{ version: 2, tables: { t: [['k', { text: 'x'.repeat(COMPACT_OVERLAY_BYTES) }]] } }
		);
		expect(compactionDue(wide)).toBe(true);
	});
});

describe('compaction', () => {
	it('folds an overlay into the base pack to the bytes of a pack built from scratch', async () => {
		const { bytes: base } = await buildPack(s2, 128);
		const overlay = await makeDelta(s2, s5);
		const compacted = await compactBundle(base, overlay);
		const scratch = await buildPack(s5, 128);
		expect(compacted.bytes).toEqual(scratch.bytes);
		expect(compacted.index).toEqual(scratch.index);
	});
});

function frameOf(table: number, ordinal: number, payload: Uint8Array<ArrayBuffer>) {
	const header = new TextEncoder().encode(
		JSON.stringify({ table, ordinal, bytes: payload.length })
	);
	const out = new Uint8Array(4 + header.length + payload.length);
	new DataView(out.buffer).setUint32(0, header.length);
	out.set(header, 4);
	out.set(payload, 4 + header.length);
	return out;
}

/** the pack with its index frame's digest replaced, so only the set digest can refuse it */
async function withDigest(bytes: Uint8Array<ArrayBuffer>, digest: string) {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	for await (const frame of readFrames(chunked(bytes, bytes.length))) {
		let payload = frame.payload;
		if (frame.table === -1) {
			const index = JSON.parse(new TextDecoder().decode(payload));
			const text = JSON.stringify({ ...index, digest });
			payload = new Uint8Array(new TextEncoder().encode(text));
		}
		parts.push(frameOf(frame.table, frame.ordinal, payload));
	}
	return new Uint8Array(await new Blob(parts).arrayBuffer());
}

describe('the block cap', () => {
	const cap = MAX_BUNDLE_BLOCK_BYTES;
	const urlHash = async (bytes: Uint8Array<ArrayBuffer>) => {
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		return btoa(String.fromCharCode(...digest))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	};
	const gzipOf = async (text: string): Promise<Uint8Array<ArrayBuffer>> =>
		new Uint8Array(
			await new Response(
				new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
			).arrayBuffer()
		);
	/** a row list whose JSON text is exactly `bytes` long */
	const rowListOf = (bytes: number) => {
		const empty = JSON.stringify([['k', { b: '' }]]).length;
		return JSON.stringify([['k', { b: 'x'.repeat(bytes - empty) }]]);
	};
	/** one block whose index hash matches its payload, so only the block's own checks can refuse it */
	async function oneBlock(payload: Uint8Array<ArrayBuffer>) {
		const index: BundleIndex = {
			version: 1,
			codec: 'gzip',
			blockRows: 128,
			digest: '0'.repeat(64),
			tables: [{ name: 'items', rows: 1, first: 'k', blocks: [await urlHash(payload)] }]
		};
		return { index, block: { table: 0, ordinal: 0, payload } };
	}
	/** the gzip bytes with the trailer's size field set to `size` */
	function withDeclaredSize(gz: Uint8Array<ArrayBuffer>, size: number) {
		const out = gz.slice();
		new DataView(out.buffer).setUint32(out.length - 4, size, true);
		return out;
	}

	it('reads a block that inflates to exactly the cap', async () => {
		const { index, block } = await oneBlock(await gzipOf(rowListOf(cap)));
		expect(await readBlock(index, block)).toHaveLength(1);
	});

	it('refuses a block that inflates one byte past the cap', async () => {
		const { index, block } = await oneBlock(await gzipOf(rowListOf(cap + 1)));
		await expect(readBlock(index, block)).rejects.toThrow('over the block cap');
	});

	it('refuses a block whose trailer declares more than the cap before it inflates', async () => {
		const { index, block } = await oneBlock(await gzipOf(rowListOf(2 * cap)));
		await expect(readBlock(index, block)).rejects.toThrow('declares');
	});

	it('refuses a block whose trailer declares less than it inflates to', async () => {
		const gz = withDeclaredSize(await gzipOf(rowListOf(2 * cap)), 16);
		const { index, block } = await oneBlock(gz);
		// workerd reports the trailer before the overflow chunk arrives; node streams the count (node.spec)
		await expect(readBlock(index, block)).rejects.toThrow(/does not decode|over the block cap/);
	});

	it('refuses to build a block over the cap, since readers would refuse it', async () => {
		const state: BundleState = {
			version: 1,
			tables: { items: [['k', { b: 'x'.repeat(cap) }]] }
		};
		await expect(buildPack(state)).rejects.toThrow('block cap');
	});
});

describe('the frame cap and index corruption', () => {
	it('refuses a header that claims 4 GiB before it reads the payload', async () => {
		const header = new TextEncoder().encode(
			JSON.stringify({ table: 0, ordinal: 0, bytes: 2 ** 32 })
		);
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, header.length);
		let asked = false;
		async function* source() {
			yield new Uint8Array([...prefix, ...header]);
			asked = true;
		}
		await expect(readFrames(source()).next()).rejects.toThrow('frame cap');
		expect(asked).toBe(false);
	});

	it('refuses a block over a lower frame cap the caller names', async () => {
		const { bytes } = await buildPack({ version: 1, tables: { courses: rowsOf(10) } });
		await expect(readBundle(bytes, 16)).rejects.toThrow('frame cap');
	});

	it('refuses to build a block over the frame cap, since readers would refuse it', async () => {
		const state: BundleState = { version: 1, tables: { courses: rowsOf(10) } };
		await expect(buildPack(state, 128, 16)).rejects.toThrow('frame cap');
	});

	it('refuses a corrupted path entry whose block hashes still match', async () => {
		const honest = await buildPack({
			version: 2,
			tables: { courses: rowsOf(3), path: [['/a', { id: 1 }]] }
		});
		const corrupt = await buildPack({
			version: 2,
			tables: { courses: rowsOf(3), path: [['/evil', { id: 1 }]] }
		});
		const spliced = await withDigest(corrupt.bytes, honest.index.digest);
		await expect(readBundle(spliced)).rejects.toThrow('the set digest does not match');
	});
});
