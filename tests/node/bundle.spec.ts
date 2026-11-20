import { describe, expect, it } from 'vitest';
import {
	type DatasetRow,
	defineDataset,
	defineRoute,
	MAX_BUNDLE_FRAME_BYTES,
	ProtocolError,
	readBundle
} from '../../src/protocol/index';
import { indexTables } from '../../src/server/bundle';
import { buildBundle, createSpool, memoryBundleStore } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';

const ORIGIN = new URL('https://example.test/');

describe('index tables', () => {
	const routes = [
		defineRoute('/items/:id', {
			strategy: 'data',
			load: () => ({}),
			family: { dataset: 'items', key: 'id' }
		}),
		defineRoute('/items', {
			strategy: 'data',
			load: () => ({}),
			query: { list: 'items', dataset: 'items', filter: { title: 'string' } }
		})
	];

	it('holds one path row and one query row per item, the query row projected to its fields', () => {
		const tables = {
			items: [
				['a', { id: 'a', title: 'Uno', rank: 1 }],
				['b', { id: 'b', title: 'Dos', rank: 2 }]
			] as Array<[string, DatasetRow]>
		};
		expect(indexTables(routes, tables)).toEqual({
			'path:items': [
				['/items/a', { key: 'a' }],
				['/items/b', { key: 'b' }]
			],
			'query:items': [
				['a', { title: 'Uno' }],
				['b', { title: 'Dos' }]
			]
		});
	});

	it('names both tables of a dataset that holds no rows, so the pack keeps the empty tables', () => {
		expect(indexTables(routes, { items: [] })).toEqual({ 'path:items': [], 'query:items': [] });
	});
});

function courses(rows: DatasetRow[], maxRows = 1000) {
	return defineDataset('courses', {
		scope: 'public',
		key: (row) => String(row['id']),
		seed: () => rows,
		read: async () => [],
		changes: async () => 'reset' as const,
		horizon: async () => 0,
		head: async () => ({ cursor: 0 }),
		schema: '1',
		maxRows,
		maxBytes: 1_000_000
	});
}

describe('buildBundle and GET /.spool/bundle/<version>', () => {
	it('builds a pack from declared datasets and serves its bytes from the store', async () => {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const rows = [
			{ id: 'c2', title: 'Calculus' },
			{ id: 'c1', title: 'Intro' }
		];
		const spool = createSpool({
			routes: [],
			store: versions,
			datasets: [courses(rows)],
			bundles
		});
		const built = await buildBundle({
			store: bundles,
			datasets: [courses(rows)],
			version: await versions.cursor(),
			url: ORIGIN
		});
		const response = (await spool.respond(
			new Request(`${ORIGIN.href}.spool/bundle/${built.version}`)
		)) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		const body = new Uint8Array(await response.arrayBuffer());
		expect(body).toEqual(built.bytes);
		const { state } = await readBundle(body);
		expect(state.tables).toEqual({
			courses: [
				['c1', { id: 'c1', title: 'Intro' }],
				['c2', { id: 'c2', title: 'Calculus' }]
			]
		});
	});

	it('answers 404 for a version not held, and for a path that is not a version', async () => {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const spool = createSpool({ routes: [], store: versions, bundles });
		for (const path of ['99', 'x', '', '1/2']) {
			const response = (await spool.respond(
				new Request(`${ORIGIN.href}.spool/bundle/${path}`)
			)) as Response;
			expect(response.status, path).toBe(404);
			expect(await response.json(), path).toEqual({ error: 'no bundle' });
		}
	});

	it('answers 404 when createSpool was given no bundle store', async () => {
		const spool = createSpool({ routes: [], store: memoryStore() });
		const response = (await spool.respond(
			new Request(`${ORIGIN.href}.spool/bundle/0`)
		)) as Response;
		expect(response.status).toBe(404);
	});

	it('builds an empty pack for a site with no dataset', async () => {
		const bundles = memoryBundleStore();
		const spool = createSpool({ routes: [], store: memoryStore(), bundles });
		const built = await buildBundle({ store: bundles, datasets: [], version: 0, url: ORIGIN });
		expect(built.index.tables).toEqual([]);
		const response = (await spool.respond(
			new Request(`${ORIGIN.href}.spool/bundle/0`)
		)) as Response;
		expect(response.status).toBe(200);
		const { state } = await readBundle(new Uint8Array(await response.arrayBuffer()));
		expect(state).toEqual({ version: 0, tables: {} });
	});

	it('leaves a principal dataset out of the public pack', async () => {
		const people = defineDataset(
			'people',
			{
				scope: 'principal',
				maxStaleMs: 60_000,
				key: (row) => String(row['id']),
				seed: () => [{ id: 'p1', name: 'Ada' }],
				read: async () => [],
				changes: async () => 'reset' as const,
				horizon: async () => 0,
				head: async () => ({ cursor: 0 }),
				schema: '1',
				maxRows: 10,
				maxBytes: 10_000
			},
			{ principalDatasets: true }
		);
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [courses([{ id: 'c1' }]), people],
			version: 1,
			url: ORIGIN
		});
		expect(built.index.tables.map((table) => table.name)).toEqual(['courses']);
	});

	it('keeps a version that already holds other bytes', async () => {
		const bundles = memoryBundleStore();
		const first = [{ id: 'c1' }];
		await buildBundle({ store: bundles, datasets: [courses(first)], version: 4, url: ORIGIN });
		await buildBundle({ store: bundles, datasets: [courses(first)], version: 4, url: ORIGIN });
		await expect(
			buildBundle({
				store: bundles,
				datasets: [courses([{ id: 'c9' }])],
				version: 4,
				url: ORIGIN
			})
		).rejects.toThrow('already holds other bytes');
	});

	it('refuses a seed past the dataset row limit', async () => {
		await expect(
			buildBundle({
				store: memoryBundleStore(),
				datasets: [courses([{ id: 'c1' }, { id: 'c2' }], 1)],
				version: 1,
				url: ORIGIN
			})
		).rejects.toThrow('over the seed limit');
	});
});

describe('path and query index tables', () => {
	const rows = [
		{ id: 'c2', title: 'Calculus', credits: 4 },
		{ id: 'c1', title: 'Intro', credits: 3 }
	];
	const family = defineRoute('/courses/:id', {
		strategy: 'projection',
		family: { dataset: 'courses', key: 'id' }
	});
	const list = defineRoute('/courses', {
		strategy: 'data',
		load: () => ({}),
		query: { list: 'courses', dataset: 'courses', filter: { title: 'string' }, sort: ['title'] }
	});

	it('adds a path table for a family route and a query table for a query route', async () => {
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [courses(rows)],
			routes: [family, list],
			version: 1,
			url: ORIGIN
		});
		expect(built.index.tables.map((t) => [t.name, t.rows, t.blocks.length])).toEqual([
			['courses', 2, 1],
			['path:courses', 2, 1],
			['query:courses', 2, 1]
		]);
		const { state } = await readBundle(built.bytes);
		expect(state.tables['path:courses']).toEqual([
			['/courses/c1', { key: 'c1' }],
			['/courses/c2', { key: 'c2' }]
		]);
		expect(state.tables['query:courses']).toEqual([
			['c1', { title: 'Intro' }],
			['c2', { title: 'Calculus' }]
		]);
	});

	it('leaves out a family route whose pattern has a param other than its key', async () => {
		const tab = defineRoute('/courses/:id/:tab', {
			strategy: 'projection',
			family: { dataset: 'courses', key: 'id' }
		});
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [courses(rows)],
			routes: [tab],
			version: 1,
			url: ORIGIN
		});
		expect(built.index.tables.map((t) => t.name)).toEqual(['courses']);
	});

	it('leaves out a plan query and a principal route', async () => {
		const plan = defineRoute('/plan', {
			strategy: 'data',
			load: () => ({}),
			query: {
				list: 'courses',
				dataset: 'courses',
				plan: { from: ['id', 'title'], pageSize: 10, limit: 100 }
			}
		});
		const people = defineDataset(
			'people',
			{
				scope: 'principal',
				maxStaleMs: 60_000,
				key: (row) => String(row['id']),
				seed: () => [{ id: 'p1' }],
				read: async () => [],
				changes: async () => 'reset' as const,
				horizon: async () => 0,
				head: async () => ({ cursor: 0 }),
				schema: '1',
				maxRows: 10,
				maxBytes: 10_000
			},
			{ principalDatasets: true }
		);
		const me = defineRoute('/me', {
			strategy: 'data',
			scope: 'principal',
			load: () => ({}),
			query: { list: 'people', dataset: 'people', sort: ['id'] }
		});
		const built = await buildBundle({
			store: memoryBundleStore(),
			datasets: [courses(rows), people],
			routes: [plan, me],
			version: 1,
			url: ORIGIN
		});
		expect(built.index.tables.map((t) => t.name)).toEqual(['courses']);
	});

	it('refuses a family route whose dataset the pack does not hold', async () => {
		await expect(
			buildBundle({
				store: memoryBundleStore(),
				datasets: [],
				routes: [family],
				version: 1,
				url: ORIGIN
			})
		).rejects.toMatchObject({ code: 'bad-bundle' });
	});

	it('refuses an index table whose name a dataset already holds', async () => {
		await expect(
			buildBundle({
				store: memoryBundleStore(),
				datasets: [courses(rows), { ...courses(rows), name: 'path:courses' }],
				routes: [family],
				version: 1,
				url: ORIGIN
			})
		).rejects.toMatchObject({ code: 'bad-bundle' });
	});
});

describe('spool.publish', () => {
	const rows = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, title: `Course ${id}` }));

	it('builds the pack at the store cursor and returns its version and byte length', async () => {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		await versions.bump(['start']);
		const spool = createSpool({
			routes: [],
			store: versions,
			datasets: [courses(rows)],
			bundles
		});
		const out = await spool.publish(ORIGIN);
		expect(out.version).toBe(await versions.cursor());
		const bytes = (await bundles.get(out.version)) as Uint8Array<ArrayBuffer>;
		expect(out.bytes).toBe(bytes.byteLength);
		const { state } = await readBundle(bytes);
		expect(state.tables['courses']).toEqual(rows.map((row) => [row.id, row]));
	});

	it('returns the same version and writes the pack once when called again', async () => {
		const held = memoryBundleStore();
		let writes = 0;
		const bundles = {
			get: held.get,
			put: async (version: number, bytes: Uint8Array<ArrayBuffer>) => {
				writes += 1;
				await held.put(version, bytes);
			}
		};
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [courses(rows)],
			bundles
		});
		const first = await spool.publish(ORIGIN);
		expect(await spool.publish(ORIGIN)).toEqual(first);
		expect(writes).toBe(1);
	});

	it('refuses a changed dataset at a cursor that already holds a pack', async () => {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const first = createSpool({
			routes: [],
			store: versions,
			datasets: [courses(rows)],
			bundles
		});
		await first.publish(ORIGIN);
		const changed = createSpool({
			routes: [],
			store: versions,
			datasets: [courses(rows.slice(1))],
			bundles
		});
		await expect(changed.publish(ORIGIN)).rejects.toMatchObject({ code: 'bad-bundle' });
	});

	it('refuses with a ProtocolError when createSpool was given no bundle store', async () => {
		const spool = createSpool({ routes: [], store: memoryStore(), datasets: [courses(rows)] });
		const error = await spool.publish(ORIGIN).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProtocolError);
		expect(error).toMatchObject({ code: 'bad-bundle' });
	});

	it('cuts blocks of the bundle option blockRows', async () => {
		const bundles = memoryBundleStore();
		const blockRows = 2;
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [courses(rows)],
			bundles,
			bundle: { blockRows }
		});
		const { version } = await spool.publish(ORIGIN);
		const { index } = await readBundle((await bundles.get(version)) as Uint8Array<ArrayBuffer>);
		expect(index.tables.map((table) => table.blocks.length)).toEqual([
			Math.ceil(rows.length / blockRows)
		]);
	});

	it('refuses a block over the bundle option maxBytes', async () => {
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [courses(rows)],
			bundles: memoryBundleStore(),
			bundle: { maxBytes: 1 }
		});
		await expect(spool.publish(ORIGIN)).rejects.toMatchObject({ code: 'bad-bundle' });
	});

	it('refuses bundle options a reader would not accept', () => {
		const base = {
			routes: [],
			store: memoryStore(),
			datasets: [courses(rows)],
			bundles: memoryBundleStore()
		};
		for (const bundle of [
			{ blockRows: 0 },
			{ blockRows: 1.5 },
			{ maxBytes: 0 },
			{ maxBytes: MAX_BUNDLE_FRAME_BYTES + 1 }
		]) {
			expect(() => createSpool({ ...base, bundle }), JSON.stringify(bundle)).toThrow(
				ProtocolError
			);
		}
	});
});

describe('the stub pack and GET /.spool/bundle/delta/<from>/<to>', () => {
	/** the config object the stub's first line carries */
	async function stubConfig(spool: { stub(): Response }) {
		const text = await spool.stub().text();
		const start = 'self.__SPOOL_CONFIG__=';
		return JSON.parse(text.slice(start.length, text.indexOf(';\n'))) as {
			runtime: string;
			pack?: { version: number; digest: string; deltas: Array<{ from: number; to: number }> };
		};
	}

	async function twoPacks(before: DatasetRow[], after: DatasetRow[]) {
		const store = memoryStore();
		const bundles = memoryBundleStore();
		await store.bump(['start']);
		const to = await store.cursor();
		await buildBundle({
			store: bundles,
			datasets: [courses(before)],
			version: to - 1,
			url: ORIGIN
		});
		await buildBundle({ store: bundles, datasets: [courses(after)], version: to, url: ORIGIN });
		const spool = createSpool({ routes: [], store, bundles });
		return { spool, to };
	}

	it('carries the pack of the cursor and the delta from the one before it', async () => {
		const { spool, to } = await twoPacks([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]);
		const config = await stubConfig(spool);
		expect(config.pack?.version).toBe(to);
		expect(config.pack?.deltas.map((d) => [d.from, d.to])).toEqual([[to - 1, to]]);
		expect(config.runtime).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('leaves out a delta past the inline byte limit', async () => {
		const big = 'y'.repeat(20_000);
		const { spool, to } = await twoPacks([{ id: 'a', title: 'x' }], [{ id: 'a', title: big }]);
		const config = await stubConfig(spool);
		expect(config.pack?.version).toBe(to);
		expect(config.pack?.deltas).toEqual([]);
	});

	it('answers the delta between two held packs as JSON, and 404 otherwise', async () => {
		const { spool, to } = await twoPacks([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]);
		const path = `/.spool/bundle/delta/${to - 1}/${to}`;
		const answer = await spool.respond(new Request(`https://example.test${path}`));
		expect(answer?.status).toBe(200);
		expect(answer?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		const delta = (await answer?.json()) as { from: number; to: number; tables: any };
		expect([delta.from, delta.to]).toEqual([to - 1, to]);
		expect(delta.tables['courses'].puts.map(([key]: [string]) => key)).toEqual(['b']);
		for (const missing of [
			`/.spool/bundle/delta/${to}/${to - 1}`,
			`/.spool/bundle/delta/0/99`
		]) {
			const refused = await spool.respond(new Request(`https://example.test${missing}`));
			expect(refused?.status).toBe(404);
		}
	});
});
