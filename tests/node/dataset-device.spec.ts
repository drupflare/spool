import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	applyChanges,
	canonicalJson,
	compileTemplate,
	defineDataset,
	digestAdd,
	digestSub,
	equivalent,
	interpretTemplate,
	PROOF_MISMATCH,
	rowHash,
	setProof,
	type Dataset,
	type DatasetResponse,
	type QueryPlan
} from '../../src/protocol/index';
import { createSpool, defineRoute, type Spool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { syncDataset, type DatasetOutcome } from '../../src/sw/dataset-sync';
import { renderLocal } from '../../src/sw/render';
import { Replica } from '../../src/sw/replica';
import {
	memoryStorage,
	type DatasetCommit,
	type DatasetStep,
	type ReplicaStorage
} from '../../src/sw/storage';
import { nav, ORIGIN, sub, syncOf } from './helpers';
import { HTML, rig } from './rig';

// #region the fixture: a directory backend with a change log, a prunable horizon and its own digest

type Row = { id: string; title: string; dept: string; status: 'draft' | 'published' };

const idOf = (n: number) => `c${String(n).padStart(5, '0')}`;
const visible = (row: Row | undefined): row is Row => row?.status === 'published';
const byId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const NAME = 'directory';

class Directory {
	rows = new Map<string, Row>();
	cursor = 0;
	floor = 0;
	events: Array<{ cursor: number; key: string }> = [];
	digest = '0'.repeat(64);
	count = 0;
	nextId: number;
	/** how many of the next proofs are wrong */
	lies = 0;
	reads: string[][] = [];

	private constructor(n: number) {
		const depts = ['cs', 'math', 'art'];
		for (let i = 0; i < n; i++) {
			const id = idOf(i);
			this.rows.set(id, {
				id,
				title: `Item ${String(i).padStart(4, '0')}`,
				dept: depts[i % 3] as string,
				status: i % 7 === 6 ? 'draft' : 'published'
			});
		}
		this.nextId = n;
	}

	static async make(n: number): Promise<Directory> {
		const dir = new Directory(n);
		const proof = await setProof(dir.visibleMap());
		dir.digest = proof.digest;
		dir.count = proof.count;
		return dir;
	}

	visibleMap(): Map<string, Row> {
		return new Map([...this.rows].filter(([, row]) => visible(row)));
	}

	visibleRows(): Row[] {
		return [...this.rows.values()].filter(visible).sort(byId);
	}

	proof() {
		if (this.lies > 0) {
			this.lies -= 1;
			const flipped = this.digest.endsWith('0') ? '1' : '0';
			return {
				kind: 'set' as const,
				count: this.count,
				digest: this.digest.slice(0, 63) + flipped
			};
		}
		return { kind: 'set' as const, count: this.count, digest: this.digest };
	}

	async put(row: Row): Promise<void> {
		const old = this.rows.get(row.id);
		if (visible(old)) {
			this.digest = digestSub(this.digest, await rowHash(old.id, old));
			this.count -= 1;
		}
		if (visible(row)) {
			this.digest = digestAdd(this.digest, await rowHash(row.id, row));
			this.count += 1;
		}
		this.rows.set(row.id, row);
		this.cursor += 1;
		this.events.push({ cursor: this.cursor, key: row.id });
	}

	edit(id: string, patch: Partial<Row>): Promise<void> {
		return this.put({ ...(this.rows.get(id) as Row), ...patch });
	}

	async remove(id: string): Promise<void> {
		await this.put({ ...(this.rows.get(id) as Row), status: 'draft' });
	}

	async add(over: Partial<Row> = {}): Promise<string> {
		const id = idOf(this.nextId++);
		await this.put({ id, title: `Added ${id}`, dept: 'cs', status: 'published', ...over });
		return id;
	}

	prune(): void {
		this.floor = this.cursor;
		this.events = [];
	}
}

function directory(dir: Directory, schema = 'v1', name = NAME): Dataset<Row> {
	return defineDataset<Row>(name, {
		scope: 'public',
		schema,
		maxRows: 100_000,
		maxBytes: 100_000_000,
		key: (row) => row.id,
		seed: (ctx) => dir.visibleRows().filter((r) => ctx.after === undefined || r.id > ctx.after),
		read: (ids) => {
			dir.reads.push([...ids]);
			return ids.flatMap((id) => {
				const row = dir.rows.get(id);
				return visible(row) ? [row] : [];
			});
		},
		changes: (since) => {
			if (since > dir.cursor) return 'reset';
			const last = new Map<string, number>();
			for (const event of dir.events)
				if (event.cursor > since) last.set(event.key, event.cursor);
			const puts: string[] = [];
			const deletes: Array<{ key: string; cursor: number }> = [];
			for (const [key, cursor] of last) {
				if (visible(dir.rows.get(key))) puts.push(key);
				else deletes.push({ key, cursor });
			}
			return { cursor: dir.cursor, puts, deletes, proof: dir.proof() };
		},
		horizon: () => dir.floor,
		head: () => ({ cursor: dir.cursor, proof: dir.proof() })
	});
}

function spoolFor(dir: Directory, schema = 'v1'): Spool {
	return createSpool({
		routes: [
			defineRoute('/directory', {
				strategy: 'template',
				template: { source: '<main>{{title}}</main>' },
				load: () => ({ title: 'directory' })
			})
		],
		store: memoryStore(),
		datasets: [directory(dir, schema), directory(dir, schema, 'other')]
	});
}

const encoder = new TextEncoder();
const bytesOf = (rows: Iterable<Row>) =>
	[...rows].reduce((n, row) => n + encoder.encode(JSON.stringify(row)).length, 0);

// #endregion

// #region the device harness: a replica over counted storage, fetching from one spool

type Harness = ReturnType<typeof device>;

function device(dir: Directory) {
	let spool = spoolFor(dir);
	const requests: string[] = [];
	/** the body of every answer, in request order */
	const bodies: string[] = [];
	const commits: DatasetCommit[] = [];
	const hashed = { calls: 0 };
	let failing: DatasetStep | undefined;
	let after: ((n: number) => Promise<void> | void) | undefined;
	let replace: ((n: number) => Response | undefined) | undefined;
	let budget: number | undefined;
	let t = 1_000;
	const raw = memoryStorage({
		failDatasetAt: (step) => failing !== undefined && failing === step
	});
	const storage: ReplicaStorage = {
		...raw,
		commitDataset: (commit) => {
			commits.push(commit);
			return raw.commitDataset(commit);
		}
	};
	const make = () =>
		new Replica(
			storage,
			'0.4.0',
			() => t,
			async (key, row) => {
				hashed.calls += 1;
				return rowHash(key, row);
			}
		);
	let replica = make();
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		requests.push(new URL(url).search);
		const n = requests.length;
		const forced = replace?.(n);
		const response = forced ?? ((await spool.respond(new Request(url, init))) as Response);
		bodies.push(await response.clone().text());
		await after?.(n);
		return response;
	};
	const sync = (name = NAME): Promise<DatasetOutcome> =>
		syncDataset(
			{
				store: replica.datasets,
				fetch,
				origin: ORIGIN,
				epoch: () => replica.epoch,
				budget: async () => budget
			},
			name
		);
	return {
		dir,
		storage,
		raw,
		requests,
		bodies,
		commits,
		hashed,
		sync,
		get replica() {
			return replica;
		},
		/** a worker restart: a new replica over the same storage */
		restart: () => void (replica = make()),
		useSpool: (next: Spool) => void (spool = next),
		fail: (step: DatasetStep | undefined) => void (failing = step),
		after: (fn: typeof after) => void (after = fn),
		replace: (fn: typeof replace) => void (replace = fn),
		budget: (value: number | undefined) => void (budget = value),
		tick: (ms: number) => void (t += ms),
		reset: () => {
			requests.length = 0;
			bodies.length = 0;
			commits.length = 0;
			hashed.calls = 0;
		}
	};
}

const json = (text: string) =>
	new Response(text, { headers: { 'content-type': 'application/json' } });

/** the rows and the meta as storage holds them */
async function snapshot(storage: ReplicaStorage, name = NAME) {
	return {
		meta: (await storage.getDatasets()).filter((m) => m.name === name),
		rows: await storage.readDataset(name)
	};
}

/** the held rows equal the backend's as canonical JSON and as digest, in memory and in storage */
async function expectHeld(h: Harness, name = NAME): Promise<void> {
	const held = await h.replica.datasets.get(name);
	const expected = await setProof(h.dir.visibleMap());
	expect(held).toBeDefined();
	expect(canonicalJson((await h.replica.datasets.rows(name)) ?? [])).toBe(
		canonicalJson(h.dir.visibleRows())
	);
	expect(held?.meta.digest).toBe(expected.digest);
	expect(held?.meta.count).toBe(expected.count);
	expect(held?.meta.cursor).toBe(h.dir.cursor);
	const stored = await snapshot(h.raw, name);
	expect(stored.rows.map((r) => r.key)).toEqual(h.dir.visibleRows().map((r) => r.id));
	expect((await setProof(new Map(stored.rows.map((r) => [r.key, r.row])))).digest).toBe(
		expected.digest
	);
	expect(stored.meta[0]?.digest).toBe(expected.digest);
}

// #endregion

describe('a first load', () => {
	it('is refused as declined by a seed the server declines, and holds nothing', async () => {
		const dir = await Directory.make(300);
		const h = device(dir);
		const declined = { ...directory(dir), provision: 'auto' as const };
		h.useSpool(createSpool({ routes: [], store: memoryStore(), datasets: [declined] }));
		expect(await h.sync()).toMatchObject({ status: 'refused', reason: 'declined' });
		expect(h.requests).toHaveLength(1);
		expect(await h.replica.datasets.get(NAME)).toBeFalsy();
	});

	it('seeds in one request, holds every row, and keeps the backend digest', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		const out = await h.sync();
		const rows = dir.visibleRows();
		expect(out).toEqual({
			name: NAME,
			requests: 1,
			status: 'seeded',
			cursor: dir.cursor,
			rows: rows.length
		});
		expect(h.requests).toEqual(['?name=directory']);
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.clear).toBe(true);
		expect(h.commits[0]?.puts).toHaveLength(rows.length);
		await expectHeld(h);
		const meta = (await h.raw.getDatasets())[0];
		expect(meta).toEqual({
			name: NAME,
			schema: 'v1',
			cursor: dir.cursor,
			count: rows.length,
			digest: (await setProof(dir.visibleMap())).digest,
			bytes: bytesOf(rows),
			appliedAt: 1_000
		});
	});

	it('seeds 2,000 rows in pages of 500 and writes them in one commit', async () => {
		const dir = await Directory.make(2000);
		const h = device(dir);
		const out = await h.sync();
		const count = dir.visibleRows().length;
		expect(out).toMatchObject({
			status: 'seeded',
			rows: count,
			requests: Math.ceil(count / 500)
		});
		expect(h.requests[0]).toBe('?name=directory');
		expect(h.requests.slice(1).every((q) => q.includes('after='))).toBe(true);
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.puts).toHaveLength(count);
		await expectHeld(h);
	});

	it('loads a held dataset after a restart with no row hashed', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		h.restart();
		h.reset();
		const held = await h.replica.datasets.get(NAME);
		expect(held?.rows.size).toBe(dir.visibleRows().length);
		expect(h.hashed.calls).toBe(0);
		await expectHeld(h);
	});

	it('finds nothing to change on a second sync and only records that it looked', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		const before = await snapshot(h.raw);
		h.reset();
		h.tick(60_000);
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'current', requests: 1 });
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]).toMatchObject({ clear: false, puts: [], deletes: [] });
		const after = await snapshot(h.raw);
		expect(after.rows).toEqual(before.rows);
		expect(after.meta[0]).toEqual({ ...before.meta[0], appliedAt: 61_000 });
		expect(h.hashed.calls).toBe(0);
	});
});

describe('a patch', () => {
	const seeded = async (n = 200) => {
		const dir = await Directory.make(n);
		const h = device(dir);
		await h.sync();
		h.reset();
		return { dir, h };
	};

	it('of one row is one request, one keyed read, one write and one row hash', async () => {
		const { dir, h } = await seeded();
		await dir.edit('c00001', { title: 'Edited' });
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'patched', requests: 1 });
		expect(dir.reads).toEqual([['c00001']]);
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]).toMatchObject({ clear: false, deletes: [] });
		expect(h.commits[0]?.puts.map((p) => p.key)).toEqual(['c00001']);
		expect(h.hashed.calls).toBe(1);
		await expectHeld(h);
	});

	it('of ten rows is one request and ten row hashes', async () => {
		const { dir, h } = await seeded();
		const ids = dir
			.visibleRows()
			.slice(10, 20)
			.map((r) => r.id);
		for (const id of ids) await dir.edit(id, { title: `T ${id}` });
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'patched', requests: 1 });
		expect(dir.reads).toEqual([ids]);
		expect(h.commits[0]?.puts).toHaveLength(10);
		expect(h.hashed.calls).toBe(10);
		await expectHeld(h);
	});

	it('of 1% of 1,700 rows is one request and 17 row hashes', async () => {
		const { dir, h } = await seeded(2000);
		const count = dir.visibleRows().length;
		const k = Math.round(count / 100);
		for (const row of dir.visibleRows().slice(0, k)) await dir.edit(row.id, { title: 'one' });
		const out = await h.sync();
		expect(k).toBe(17);
		expect(out).toMatchObject({ status: 'patched', requests: 1 });
		expect(h.commits[0]?.puts).toHaveLength(17);
		expect(h.hashed.calls).toBe(17);
		await expectHeld(h);
	});

	it('of a deletion writes the key, reads nothing and hashes nothing', async () => {
		const { dir, h } = await seeded();
		const id = (dir.visibleRows()[5] as Row).id;
		await dir.remove(id);
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'patched', requests: 1 });
		expect(dir.reads).toEqual([]);
		expect(h.commits[0]).toMatchObject({ clear: false, puts: [], deletes: [id] });
		expect(h.hashed.calls).toBe(0);
		await expectHeld(h);
	});

	it('after several missed revisions is one request that carries the net change', async () => {
		const { dir, h } = await seeded();
		await dir.edit('c00001', { title: 'a' });
		await dir.edit('c00001', { title: 'b' });
		await dir.edit('c00001', { title: 'c' });
		await dir.edit('c00002', { title: 'x' });
		await dir.remove('c00003');
		const added = await dir.add();
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'patched', requests: 1 });
		expect(dir.reads).toEqual([['c00001', 'c00002', added]]);
		expect(h.commits[0]?.puts.map((p) => p.key)).toEqual(['c00001', 'c00002', added]);
		expect(h.commits[0]?.deletes).toEqual(['c00003']);
		await expectHeld(h);
	});

	it('saves one hash per replaced or deleted row by keeping the held hashes', async () => {
		const { dir, h } = await seeded();
		const held = await h.replica.datasets.get(NAME);
		const rows = held?.rows as Map<string, Row>;
		const edited = { ...(rows.get('c00001') as Row), title: 'Edited' };
		await dir.edit('c00001', { title: 'Edited' });
		const response: DatasetResponse = {
			protocol: 1,
			name: NAME,
			schema: 'v1',
			cursor: dir.cursor,
			reset: false,
			puts: [{ key: 'c00001', row: edited }],
			deletes: [],
			proof: dir.proof()
		};
		let without = 0;
		let withHashes = 0;
		const meta = held?.meta.digest;
		const a = await applyChanges(rows, response, meta, {
			hash: (key, row) => ((without += 1), rowHash(key, row))
		});
		const b = await applyChanges(rows, response, meta, {
			hashes: held?.hashes as Map<string, string>,
			hash: (key, row) => ((withHashes += 1), rowHash(key, row))
		});
		expect([without, withHashes]).toEqual([2, 1]);
		expect(a.digest).toBe(b.digest);
		expect(a.matches).toBe(true);
		expect(b.matches).toBe(true);
	});
});

describe('an apply that does not finish', () => {
	const steps: DatasetStep[] = ['clear', 'deletes', 'puts', 'meta'];

	it.each(steps)(
		'of a patch interrupted at %s leaves the store as it was, then recovers',
		async (step) => {
			const dir = await Directory.make(200);
			const h = device(dir);
			await h.sync();
			const before = await snapshot(h.raw);
			const held = await h.replica.datasets.get(NAME);
			await dir.edit('c00001', { title: 'Edited' });
			await dir.remove('c00002');
			h.reset();
			h.fail(step);
			const out = await h.sync();
			expect(out).toMatchObject({ status: 'refused', reason: 'storage' });
			expect(await snapshot(h.raw)).toEqual(before);
			expect((await h.replica.datasets.get(NAME))?.meta).toEqual(held?.meta);
			h.fail(undefined);
			expect(await h.sync()).toMatchObject({ status: 'patched' });
			await expectHeld(h);
		}
	);

	it.each(steps)('of a seed interrupted at %s holds nothing, then seeds', async (step) => {
		const dir = await Directory.make(200);
		const h = device(dir);
		h.fail(step);
		expect(await h.sync()).toMatchObject({ status: 'refused', reason: 'storage' });
		expect(await snapshot(h.raw)).toEqual({ meta: [], rows: [] });
		expect(await h.replica.datasets.get(NAME)).toBeUndefined();
		h.fail(undefined);
		expect(await h.sync()).toMatchObject({ status: 'seeded' });
		await expectHeld(h);
	});

	it('applied twice leaves the rows, digest and cursor as the first apply left them', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await dir.edit('c00001', { title: 'Edited' });
		h.reset();
		await h.sync();
		const patch = h.bodies[0] as string;
		const once = await snapshot(h.raw);
		h.reset();
		h.replace(() => json(patch));
		expect(await h.sync()).toMatchObject({ status: 'current', requests: 1 });
		const twice = await snapshot(h.raw);
		expect(twice.rows).toEqual(once.rows);
		expect(twice.meta[0]).toMatchObject({
			cursor: once.meta[0]?.cursor,
			digest: once.meta[0]?.digest
		});
		await expectHeld(h);
	});

	it('answered with an older cursor than the held one writes nothing', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await dir.edit('c00001', { title: 'First' });
		h.reset();
		await h.sync();
		const old = h.bodies[0] as string;
		await dir.edit('c00002', { title: 'Second' });
		await h.sync();
		const before = await snapshot(h.raw);
		h.reset();
		h.replace(() => json(old));
		expect(await h.sync()).toMatchObject({ status: 'current', requests: 1 });
		expect(h.commits).toHaveLength(0);
		expect(await snapshot(h.raw)).toEqual(before);
	});
});

describe('a reset, a new schema and a proof that fails', () => {
	it('reseeds in one commit when the device is past the horizon', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await dir.edit('c00001', { title: 'Edited' });
		await dir.edit('c00002', { title: 'Edited' });
		dir.prune();
		await dir.edit('c00004', { title: 'After the horizon' });
		h.reset();
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'reseeded', requests: 1 });
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.clear).toBe(true);
		await expectHeld(h);
	});

	it('reseeds only the dataset whose schema changed', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await h.sync('other');
		const other = await snapshot(h.raw, 'other');
		h.reset();
		h.useSpool(spoolFor(dir, 'v2'));
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'reseeded', requests: 1 });
		expect((await h.raw.getDatasets()).find((m) => m.name === NAME)?.schema).toBe('v2');
		expect(await snapshot(h.raw, 'other')).toEqual(other);
		expect(h.commits.map((c) => c.name)).toEqual([NAME]);
		await expectHeld(h);
	});

	it('clears the dataset and reseeds once when a patch fails its proof', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await dir.edit('c00001', { title: 'Edited' });
		dir.lies = 1;
		h.reset();
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'reseeded', requests: 2 });
		expect(h.requests[0]).toContain('since=');
		expect(h.requests[1]).toBe('?name=directory');
		expect(h.commits.map((c) => [c.clear, c.meta === null])).toEqual([
			[true, true],
			[true, false]
		]);
		await expectHeld(h);
	});

	const kinds = (h: Harness) => h.requests.map((q) => (q.includes('since=') ? 'patch' : 'seed'));

	it('stops after one reseed and its repair patch when a held dataset keeps failing its proof', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await dir.edit('c00001', { title: 'Edited' });
		dir.lies = 100;
		h.reset();
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'refused', reason: 'proof', requests: 3 });
		expect(kinds(h)).toEqual(['patch', 'seed', 'patch']);
		expect(await snapshot(h.raw)).toEqual({ meta: [], rows: [] });
		dir.lies = 0;
		expect(await h.sync()).toMatchObject({ status: 'seeded' });
		await expectHeld(h);
	});

	it('stops after one repair patch and one reseed when a first seed keeps failing its proof', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		dir.lies = 100;
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'refused', reason: 'proof', requests: 4 });
		expect(kinds(h)).toEqual(['seed', 'patch', 'seed', 'patch']);
		expect(h.commits).toEqual([]);
	});

	it('repairs a seed whose rows moved between pages with one patch from the first cursor', async () => {
		const dir = await Directory.make(2000);
		const h = device(dir);
		const first = dir.visibleRows()[3] as Row;
		const gone = dir.visibleRows()[4] as Row;
		const before = dir.visibleRows().length;
		h.after(async (n) => {
			if (n !== 1) return;
			await dir.edit(first.id, { title: 'Moved during the seed' });
			await dir.remove(gone.id);
			await dir.add();
		});
		const out = await h.sync();
		// page 1 holds 500 old rows; the rest, plus the added row, come after it
		const pages = 1 + Math.ceil((before - 500 + 1) / 500);
		expect(out).toMatchObject({ status: 'seeded' });
		expect(h.requests.filter((q) => q.includes('since=')).length).toBe(1);
		expect(h.requests.at(-1)).toContain('since=0');
		expect(h.requests).toHaveLength(pages + 1);
		await expectHeld(h);
		expect(((await h.replica.datasets.get(NAME))?.rows.get(first.id) as Row).title).toBe(
			'Moved during the seed'
		);
		expect((await h.replica.datasets.get(NAME))?.rows.has(gone.id)).toBe(false);
	});
});

describe('a store that lost rows, a wipe, and a budget', () => {
	it('detects missing rows on load, clears only that dataset and reseeds it', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		await h.sync();
		await h.sync('other');
		const meta = (await h.raw.getDatasets()).find((m) => m.name === NAME);
		await h.raw.commitDataset({
			name: NAME,
			meta: meta ?? null,
			clear: false,
			puts: [],
			deletes: ['c00001', 'c00002']
		});
		const other = await snapshot(h.raw, 'other');
		h.restart();
		h.reset();
		expect(await h.replica.datasets.get(NAME)).toBeUndefined();
		expect(h.replica.datasets.evicted).toBe(1);
		expect(await snapshot(h.raw)).toEqual({ meta: [], rows: [] });
		expect(await snapshot(h.raw, 'other')).toEqual(other);
		expect(await h.sync()).toMatchObject({ status: 'seeded', requests: 1 });
		await expectHeld(h);
	});

	it('wipes the datasets of a v0.3 replica on first load, and keeps them through a vector reset', async () => {
		const dir = await Directory.make(200);
		const storage = memoryStorage();
		const old = new Replica(storage, '0.3.0');
		await old.load();
		await syncDataset(
			{
				store: old.datasets,
				fetch: async (url, init) =>
					(await spoolFor(dir).respond(new Request(url, init))) as Response,
				origin: ORIGIN,
				epoch: () => old.epoch,
				budget: async () => undefined
			},
			NAME
		);
		expect((await storage.getDatasets()).map((m) => m.name)).toEqual([NAME]);
		const next = new Replica(storage, '0.4.0');
		await next.load();
		expect(await storage.getDatasets()).toEqual([]);
		expect(await storage.readDataset(NAME)).toEqual([]);

		const same = new Replica(storage, '0.4.0');
		await same.load();
		await syncDataset(
			{
				store: same.datasets,
				fetch: async (url, init) =>
					(await spoolFor(dir).respond(new Request(url, init))) as Response,
				origin: ORIGIN,
				epoch: () => same.epoch,
				budget: async () => undefined
			},
			NAME
		);
		await same.applySync(syncOf({ reset: true, cursor: 9 }));
		expect((await storage.getDatasets()).map((m) => m.name)).toEqual([NAME]);
		await same.wipe();
		expect(await storage.getDatasets()).toEqual([]);
		expect(await storage.readDataset(NAME)).toEqual([]);
	});

	it('drops a seed whose pages were still arriving when the replica was wiped', async () => {
		const dir = await Directory.make(2000);
		const h = device(dir);
		h.after(async (n) => {
			if (n === 2) await h.replica.wipe();
		});
		const out = await h.sync();
		expect(out).toMatchObject({ status: 'refused', reason: 'epoch', requests: 2 });
		expect(await snapshot(h.raw)).toEqual({ meta: [], rows: [] });
		expect(h.commits).toEqual([]);
	});

	it('drops a commit that reaches storage after a wipe', async () => {
		const dir = await Directory.make(200);
		const h = device(dir);
		const staging = h.replica.datasets.stage(NAME);
		const epoch = h.replica.epoch;
		await h.replica.wipe();
		expect(await h.replica.datasets.commit(staging, { cursor: 1, schema: 'v1' }, epoch)).toBe(
			false
		);
		expect(await snapshot(h.raw)).toEqual({ meta: [], rows: [] });
	});

	it('holds a seed that fits the budget exactly and refuses one byte less', async () => {
		const dir = await Directory.make(2000);
		const total = bytesOf(dir.visibleRows());
		const pages = Math.ceil(dir.visibleRows().length / 500);
		const exact = device(dir);
		exact.budget(total);
		expect(await exact.sync()).toMatchObject({ status: 'seeded', requests: pages });
		const short = device(dir);
		short.budget(total - 1);
		expect(await short.sync()).toMatchObject({
			status: 'refused',
			reason: 'budget',
			requests: pages
		});
		expect(await snapshot(short.raw)).toEqual({ meta: [], rows: [] });
	});

	it('stops at the first page that goes over the budget', async () => {
		const dir = await Directory.make(2000);
		const h = device(dir);
		h.budget(1000);
		expect(await h.sync()).toMatchObject({ status: 'refused', reason: 'budget', requests: 1 });
		expect(h.commits).toEqual([]);
	});
});

// #region a worker answering from held rows

const SCHEMA = {
	list: 'items',
	dataset: NAME,
	filter: { dept: 'string' as const },
	sort: ['title'],
	pageSize: 10
};

const browse = (rows: Row[], search: string) => {
	const params = new URLSearchParams(search);
	let items = rows;
	const dept = params.get('dept');
	if (dept) items = items.filter((r) => r.dept === dept);
	const sort = params.get('sort');
	if (sort === '-title')
		items = [...items].sort((a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0));
	const page = Number(params.get('page') ?? '1');
	const pages = Math.max(1, Math.ceil(items.length / 10));
	return { items: items.slice((page - 1) * 10, page * 10), total: items.length, page, pages };
};

async function queryRig(provision?: 'auto') {
	const dir = await Directory.make(300);
	const apps: string[] = [];
	const app = (request: Request): Response => {
		const url = new URL(request.url);
		apps.push(url.pathname + url.search);
		const shaped = browse(dir.visibleRows(), url.search);
		if (url.pathname === '/api/directory' || url.pathname === '/api/hard') {
			const body = {
				title: 'directory',
				items: shaped.items,
				query: { total: shaped.total, page: shaped.page, pages: shaped.pages }
			};
			return new Response(JSON.stringify(body), {
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.pathname === '/browse') {
			const list = shaped.items.map((r) => `<i>${r.id}</i>`).join('');
			return new Response(
				`<html><head></head><body>${list}<p>${shaped.total}/${shaped.page}</p></body></html>`,
				{ headers: HTML }
			);
		}
		const person = /^\/person\/(.+)$/.exec(url.pathname)?.[1];
		if (person) {
			const row = dir.rows.get(person) as Row;
			return new Response(`<html><head></head><body><h1>${row.title}</h1></body></html>`, {
				headers: HTML
			});
		}
		return new Response('missing', { status: 404, headers: HTML });
	};
	const r = rig({
		routes: [
			// a whole-body data route ties its own v0.3 control, so the default priors decline it
			defineRoute('/api/directory', {
				strategy: 'data',
				query: SCHEMA,
				provision: { reuse: 1, futureViews: 5 },
				load: () => ({ title: 'directory' })
			}),
			defineRoute('/api/hard', {
				strategy: 'data',
				query: SCHEMA,
				provision: { reuse: 1, futureViews: 5 },
				freshness: { maxStale: 60, mode: 'hard' },
				load: () => ({ title: 'directory' })
			}),
			defineRoute('/browse', {
				strategy: 'template',
				query: SCHEMA,
				template: {
					source: '<html><head></head><body>{{#each items}}<i>{{id}}</i>{{/each}}<p>{{query.total}}/{{query.page}}</p></body></html>'
				},
				load: () => ({ title: 'directory' })
			}),
			defineRoute('/person/:id', {
				strategy: 'template',
				template: {
					source: '<html><head></head><body><h1>{{person.title}}</h1></body></html>'
				},
				load: (ctx) => ({ person: ctx.row(NAME, ctx.params['id'] as string) })
			})
		],
		app,
		spool: { datasets: [{ ...directory(dir), ...(provision ? { provision } : {}) }] }
	});
	const get = async (r2: typeof r, path: string, target = r2.runtime) =>
		(await r2.drive(sub(path), target)).text();
	return { dir, r, app, apps, get };
}

describe('a route that answers queries from the rows the device holds', () => {
	it('seeds on its second sight and then answers with zero server requests, as the server does', async () => {
		const { dir, r, app, get } = await queryRig();
		await get(r, '/api/directory');
		expect(r.log).toEqual(['GET /api/directory', 'GET /.spool/artifact']);
		r.reset();
		await get(r, '/api/directory');
		expect([...r.log].sort()).toEqual(['GET /.spool/dataset', 'GET /api/directory']);
		expect((await r.runtime.replica.datasets.get(NAME))?.meta.count).toBe(
			dir.visibleRows().length
		);

		r.reset();
		const path = '/api/directory?dept=cs&sort=-title&page=2';
		const local = await get(r, path);
		expect(r.log).toEqual([]);
		const network = await (await app(new Request(`${ORIGIN}${path}`))).text();
		expect(local).toBe(network);
		expect(JSON.parse(local).items).toHaveLength(10);
		expect(JSON.parse(local).query).toEqual({
			total: dir.visibleRows().filter((x) => x.dept === 'cs').length,
			page: 2,
			pages: Math.ceil(dir.visibleRows().filter((x) => x.dept === 'cs').length / 10)
		});
	});

	it('renders a template route from the rows, equal to the server page', async () => {
		const { r, app } = await queryRig();
		await r.visit('/browse');
		await r.visit('/browse');
		r.reset();
		const path = '/browse?dept=math&page=3';
		const local = await r.visit(path);
		expect(r.log).toEqual([]);
		const network = await (await r.spool.handle(nav(path), app)).text();
		const verdict = equivalent(local, network);
		expect(verdict.equal, verdict.equal ? '' : verdict.reason).toBe(true);
	});

	it('goes to the network for a query the schema does not declare, with the rows held', async () => {
		const { r, apps } = await queryRig();
		await r.visit('/browse');
		await r.visit('/browse');
		r.reset();
		apps.length = 0;
		await r.visit('/browse?unknown=1');
		expect(r.log).toEqual(['GET /browse']);
		expect(apps).toEqual(['/browse?unknown=1']);
	});

	it('serves the old rows once after the freshness bound and then the patched ones, with one dataset request', async () => {
		const { dir, r, get } = await queryRig();
		await get(r, '/api/directory');
		await get(r, '/api/directory');
		const path = '/api/directory?dept=cs&sort=-title';
		const before = await get(r, path);
		const target = dir
			.visibleRows()
			.filter((x) => x.dept === 'cs')
			.at(-1) as Row;
		await dir.edit(target.id, { title: 'Zzz last' });
		r.advance(901);
		r.reset();
		const stale = await get(r, path);
		expect(stale).toBe(before);
		expect(r.log).toEqual([]);
		await r.visit('/nowhere');
		expect(r.log.sort()).toEqual(['GET /.spool/dataset', 'GET /.spool/sync', 'GET /nowhere']);
		r.reset();
		const fresh = await get(r, path);
		expect(r.log).toEqual([]);
		expect(JSON.parse(fresh).items[0].title).toBe('Zzz last');
	});

	it('syncs a deferred dataset from a local view once the lease has passed, in one request', async () => {
		const { dir, r, get } = await queryRig();
		await get(r, '/api/directory');
		await get(r, '/api/directory');
		const path = '/api/directory?dept=cs&sort=-title';
		await get(r, path);
		const target = dir
			.visibleRows()
			.filter((x) => x.dept === 'cs')
			.at(-1) as Row;
		await dir.edit(target.id, { title: 'Zzz last' });
		r.advance(86_400 - 1);
		r.reset();
		await get(r, path);
		expect(r.log).toEqual([]);

		r.advance(1);
		await get(r, path);
		await get(r, path);
		expect(r.log.filter((entry) => entry.startsWith('GET /.spool/')).sort()).toEqual([
			'GET /.spool/dataset',
			'GET /.spool/sync'
		]);
		r.reset();
		expect(JSON.parse(await get(r, path)).items[0].title).toBe('Zzz last');
		expect(r.log).toEqual([]);
	});

	it('syncs a hard route before it answers, and shows the old rows when the network is down', async () => {
		const { dir, r, get } = await queryRig();
		await get(r, '/api/hard');
		await get(r, '/api/hard');
		const path = '/api/hard?dept=art&sort=-title';
		const before = await get(r, path);
		await dir.edit(
			(
				dir
					.visibleRows()
					.filter((x) => x.dept === 'art')
					.at(-1) as Row
			).id,
			{ title: 'Zzz' }
		);
		r.advance(61);
		r.reset();
		const fresh = await get(r, path);
		expect(r.log).toEqual(['GET /.spool/sync', 'GET /.spool/dataset']);
		expect(JSON.parse(fresh).items[0].title).toBe('Zzz');

		await dir.edit(
			(
				dir
					.visibleRows()
					.filter((x) => x.dept === 'art')
					.at(-1) as Row
			).id,
			{ title: 'Zzzz' }
		);
		r.advance(61);
		r.reset();
		r.offline(true);
		const offline = await get(r, path);
		r.offline(false);
		expect(offline).toBe(fresh);
		expect(before).not.toBe(fresh);
	});

	it('keeps a page with a row reference and resolves the row again after a patch, with no artifact request', async () => {
		const { dir, r } = await queryRig();
		await r.visit('/person/c00001');
		r.reset();
		await r.visit('/person/c00001');
		expect([...r.log].sort()).toEqual(['GET /.spool/dataset', 'GET /person/c00001']);
		expect(await r.runtime.replica.ids()).toEqual(['/person/c00001']);

		r.reset();
		expect(await r.visit('/person/c00001')).toContain(
			`<h1>${(dir.rows.get('c00001') as Row).title}</h1>`
		);
		expect(r.log).toEqual([]);

		await dir.edit('c00001', { title: 'Renamed' });
		r.advance(901);
		r.reset();
		await r.visit('/person/c00001');
		expect(r.log).toEqual([]);
		await r.visit('/nowhere');
		expect(r.log.sort()).toEqual(['GET /.spool/dataset', 'GET /.spool/sync', 'GET /nowhere']);
		expect(r.urls.some((u) => u.includes('/.spool/artifact'))).toBe(false);
		r.reset();
		expect(await r.visit('/person/c00001')).toContain('<h1>Renamed</h1>');
		expect(r.log).toEqual([]);
	});

	it('drops a page whose row left the dataset, and no other page', async () => {
		const { dir, r } = await queryRig();
		for (const id of ['c00001', 'c00002']) {
			await r.visit(`/person/${id}`);
			await r.visit(`/person/${id}`);
		}
		await r.visit('/person/c00001');
		await r.visit('/person/c00002');
		expect((await r.runtime.replica.ids()).sort()).toEqual([
			'/person/c00001',
			'/person/c00002'
		]);
		await dir.remove('c00001');
		r.advance(901);
		await r.visit('/person/c00001');
		await r.visit('/nowhere');
		await r.visit('/person/c00002');
		expect(await r.runtime.replica.ids()).toEqual(['/person/c00002']);
	});

	it('refuses a seed over the budget, counts it, and does not ask again', async () => {
		const { r } = await queryRig();
		const runtime = r.make({ estimate: async () => ({ quota: 1000, usage: 0 }) });
		await r.drive(sub('/api/directory'), runtime);
		await r.drive(sub('/api/directory'), runtime);
		await r.drive(sub('/api/directory'), runtime);
		await r.drive(sub('/api/directory'), runtime);
		const status = await runtime.message({ type: 'spool:datasets' });
		expect(status).toMatchObject({
			type: 'spool:datasets',
			datasets: [],
			refused: { directory: 'budget' },
			outcomes: { 'directory:refused:budget': 1 }
		});
	});

	it('refuses a seed the server declines as declined, counts it once, and does not ask again', async () => {
		const { r } = await queryRig('auto');
		const runtime = r.make();
		for (let i = 0; i < 4; i++) await r.drive(sub('/api/directory'), runtime);
		const status = await runtime.message({ type: 'spool:datasets' });
		expect(status).toMatchObject({
			type: 'spool:datasets',
			datasets: [],
			refused: { directory: 'declined' },
			declined: { directory: 'native' },
			outcomes: { 'directory:refused:declined': 1 }
		});
	});

	it('sends a view after a declined dataset to the network, with no artifact or dataset request', async () => {
		const { r } = await queryRig('auto');
		const runtime = r.make();
		await r.drive(sub('/api/directory'), runtime);
		await r.drive(sub('/api/directory'), runtime);
		r.reset();
		await r.drive(sub('/api/directory'), runtime);
		expect(r.log).toEqual(['GET /api/directory']);
	});

	it('answers a navigation to a route whose dataset was declined with the v0.3 requests, and no dataset request', async () => {
		const { r } = await queryRig('auto');
		const runtime = r.make();
		for (let i = 0; i < 4; i++) await r.drive(sub('/api/directory'), runtime);
		r.reset();
		await r.visit('/browse', runtime);
		expect(r.log).toEqual(['GET /browse', 'GET /.spool/artifact']);
	});

	it('tells the pages once, after the first dataset is held, to ask for persistent storage', async () => {
		const { r } = await queryRig();
		const told: unknown[] = [];
		const runtime = r.make({
			broadcast: (message) => {
				if ((message as { type?: string }).type === 'spool:persist') told.push(message);
			}
		});
		await r.drive(sub('/api/directory'), runtime);
		expect(told).toEqual([]);
		await r.drive(sub('/api/directory'), runtime);
		expect(told).toEqual([{ type: 'spool:persist' }]);
		r.advance(901);
		await r.drive(sub('/api/directory'), runtime);
		await r.drive(sub('/api/directory'), runtime);
		expect(told).toEqual([{ type: 'spool:persist' }]);
		await runtime.message({ type: 'spool:persisted', granted: true });
		expect(await runtime.message({ type: 'spool:datasets' })).toMatchObject({
			persisted: true
		});
	});
});

// #endregion

describe('declaring the rows a query route answers from', () => {
	type Item = { id: string; dept: string };
	const items: Item[] = [
		{ id: 'a', dept: 'cs' },
		{ id: 'b', dept: 'math' },
		{ id: 'c', dept: 'cs' }
	];
	const KEYED = { list: 'items', key: 'id', filter: { dept: 'string' as const } };
	const template = {
		source: '<html><head></head><body>{{#each items}}<i>{{id}}</i>{{/each}}<p>{{query.total}}</p></body></html>'
	};

	const keyed = (list: Item[] = items, proofOf: Item[] = items) =>
		createSpool({
			routes: [
				defineRoute('/keyed', {
					strategy: 'template',
					template,
					query: KEYED,
					provision: { reuse: 1, futureViews: 1000 },
					load: async () => ({
						items: list,
						proof: await setProof(new Map(proofOf.map((i) => [i.id, i])))
					})
				})
			],
			store: memoryStore()
		});

	const artifactOf = (spool: Spool) =>
		spool.respond(new Request(`${ORIGIN}/.spool/artifact?path=%2Fkeyed`)) as Promise<Response>;

	it('builds a route whose list carries a set proof once the schema names the key field', async () => {
		const response = await artifactOf(keyed());
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { body: { data: { proof: { kind: string } } } }).body.data
				.proof.kind
		).toBe('set');
	});

	it('refuses a list that does not match its set proof', async () => {
		const response = await artifactOf(keyed(items, items.slice(0, 2)));
		expect(response.status).toBe(400);
	});

	it('lets the worker answer a query from the keyed list, and refuses it when the list was altered', async () => {
		const spool = keyed();
		const config = spool.config;
		const route = config.routes[0] as never;
		const data = JSON.parse(
			JSON.stringify(
				((await (await artifactOf(spool)).json()) as { body: { data: unknown } }).body.data
			)
		);
		const stored = (over: unknown) =>
			({
				protocol: 1,
				id: '/keyed',
				scope: 'public',
				strategy: 'template',
				deps: [],
				vector: 0,
				body: { data: over }
			}) as never;
		const html = await renderLocal(config, route, stored(data), {}, '?dept=cs');
		expect(html).toMatchObject({ ok: true });
		expect(html.ok && html.html).toContain('<i>a</i><i>c</i><p>2</p>');
		const altered = { ...data, items: [...data.items, { id: 'd', dept: 'cs' }] };
		expect(await renderLocal(config, route, stored(altered), {}, '?dept=cs')).toEqual({
			ok: false,
			reason: PROOF_MISMATCH
		});
		const unkeyed = { ...data, items: data.items.map((i: Item) => ({ dept: i.dept })) };
		expect(await renderLocal(config, route, stored(unkeyed), {}, '?dept=cs')).toEqual({
			ok: false,
			reason: PROOF_MISMATCH
		});
	});

	it('refuses a route that names both a key and a dataset, a bad dataset name and an empty key', () => {
		const bad = (query: unknown) => () =>
			defineRoute('/x', { strategy: 'data', load: () => ({}), query } as never);
		expect(bad({ list: 'a', key: 'id', dataset: NAME })).toThrow('exclusive');
		expect(bad({ list: 'a', dataset: 'has/slash' })).toThrow('query.dataset');
		expect(bad({ list: 'a', key: '' })).toThrow('query.key');
		expect(bad({ list: 'a', dataset: NAME })).not.toThrow();
	});

	it('refuses a spool whose route names a dataset it does not serve, and an artifact whose row ref has none', async () => {
		const route = defineRoute('/x', {
			strategy: 'data',
			load: () => ({}),
			query: { list: 'items', dataset: 'missing' }
		});
		expect(() => createSpool({ routes: [route], store: memoryStore() })).toThrow(
			'query.dataset "missing" is not declared'
		);
		const orphan = createSpool({
			routes: [
				defineRoute('/p', {
					strategy: 'template',
					template: { source: '<main>{{person.id}}</main>' },
					provision: { reuse: 1, futureViews: 1000 },
					load: (ctx) => ({ person: ctx.row('nowhere', 'k') })
				})
			],
			store: memoryStore()
		});
		const response = (await orphan.respond(
			new Request(`${ORIGIN}/.spool/artifact?path=%2Fp`)
		)) as Response;
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			'row nowhere/k of no dataset here'
		);
	});
});

// #region a template renders rows a plan answers from the held datasets

const PLAN: QueryPlan = {
	from: ['id', 'dept'],
	join: [{ dataset: 'other', on: ['id', null], type: 'left', as: 'o', fields: ['title'] }],
	where: [{ field: 'dept', op: 'eq', param: 'dept', type: 'string' }],
	group: { by: ['dept'], aggregates: { n: 'count', t: { min: 'o.title' } } },
	pageSize: 10,
	limit: 100
};
const PLAN_SOURCE =
	'<main>{{#each rows}}<i>{{dept}} {{n}} {{t}}</i>{{/each}}<p>{{query.total}}</p></main>';
const planTemplate = compileTemplate({ source: PLAN_SOURCE });

/** the page the template makes of the rows, as the device must produce it */
const planPage = (rows: unknown[]) =>
	interpretTemplate(planTemplate, {
		title: 'directory',
		rows,
		query: { total: rows.length, page: 1, pages: 1 }
	});

/** the group rows of the plan, as SQLite gives them for the visible rows of the directory */
function planOracle(dir: Directory, dept?: string): unknown[] {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE base (id, dept, title)');
	db.exec('CREATE TABLE other (id, dept, title)');
	const insertBase = db.prepare('INSERT INTO base VALUES (?,?,?)');
	const insertOther = db.prepare('INSERT INTO other VALUES (?,?,?)');
	for (const row of dir.visibleRows()) {
		insertBase.run(row.id, row.dept, row.title);
		insertOther.run(row.id, row.dept, row.title);
	}
	const where = dept === undefined ? '' : 'WHERE b.dept = ?';
	const args = dept === undefined ? [] : [dept];
	const rows = db
		.prepare(
			`SELECT b.dept AS dept, COUNT(*) AS n, MIN(o.title) AS t FROM base b LEFT JOIN other o ON o.id = b.id ${where} GROUP BY b.dept ORDER BY b.dept`
		)
		.all(...args);
	db.close();
	return rows;
}

async function planRig() {
	const dir = await Directory.make(300);
	const app = (request: Request): Response => {
		const url = new URL(request.url);
		if (url.pathname !== '/plan')
			return new Response('missing', { status: 404, headers: HTML });
		const dept = url.searchParams.get('dept') ?? undefined;
		return new Response(planPage(planOracle(dir, dept)), { headers: HTML });
	};
	const r = rig({
		routes: [
			defineRoute('/plan', {
				strategy: 'template',
				query: { list: 'rows', dataset: NAME, plan: PLAN },
				template: { source: PLAN_SOURCE },
				load: () => ({ title: 'directory' })
			})
		],
		app,
		spool: { datasets: [directory(dir), directory(dir, 'v1', 'other')] }
	});
	await r.make({ config: { ...r.spool.config, policy: [] } }).activate();
	return { dir, r };
}

describe('a template route whose rows a plan answers from the held datasets', () => {
	it('refuses a spool whose plan joins a dataset it does not serve', async () => {
		const dir = await Directory.make(10);
		expect(() =>
			createSpool({
				routes: [
					defineRoute('/plan', {
						strategy: 'template',
						query: { list: 'rows', dataset: NAME, plan: PLAN },
						template: { source: PLAN_SOURCE },
						load: () => ({})
					})
				],
				datasets: [directory(dir)],
				store: memoryStore()
			})
		).toThrow('join dataset "other" is not declared');
	});

	it('renders the oracle rows with zero requests when filtered; a bare URL goes to the origin', async () => {
		const { dir, r } = await planRig();
		await r.visit('/plan?dept=math');
		await r.visit('/plan?dept=math');
		r.reset();
		const math = await r.visit('/plan?dept=math');
		expect(r.log).toEqual([]);
		expect(math).toContain(planPage(planOracle(dir, 'math')));
		r.reset();
		const all = await r.visit('/plan');
		expect(r.log).toEqual(['GET /plan']);
		expect(all).toContain(planPage(planOracle(dir)));
		expect(planOracle(dir)).toHaveLength(3);
	});

	it('answers from the patched rows once a patch lands, and not from the rows it replaced', async () => {
		const { dir, r } = await planRig();
		await r.visit('/plan?dept=cs');
		await r.visit('/plan?dept=cs');
		const before = await r.visit('/plan?dept=cs');
		const target = dir.visibleRows().find((row) => row.dept === 'cs') as Row;
		await dir.edit(target.id, { title: 'AAA first' });
		r.advance(901);
		await r.visit('/plan?dept=cs');
		await r.visit('/plan?dept=cs&unknown=1');
		r.reset();
		const after = await r.visit('/plan?dept=cs');
		expect(r.log).toEqual([]);
		expect(after).not.toBe(before);
		expect(after).toContain(planPage(planOracle(dir, 'cs')));
		expect(after).toContain('AAA first');
	});

	it('leaves a row out of the group it left when its department changes', async () => {
		const { dir, r } = await planRig();
		await r.visit('/plan?dept=cs');
		await r.visit('/plan?dept=cs');
		await r.visit('/plan?dept=art');
		await r.visit('/plan?dept=art');
		const moved = dir.visibleRows().find((row) => row.dept === 'cs') as Row;
		await dir.edit(moved.id, { dept: 'art' });
		r.advance(901);
		await r.visit('/plan?dept=cs');
		await r.visit('/plan?dept=art');
		await r.visit('/plan?dept=cs&unknown=1');
		r.reset();
		const cs = await r.visit('/plan?dept=cs');
		expect(r.log).toEqual([]);
		expect(cs).toContain(planPage(planOracle(dir, 'cs')));
		r.reset();
		const art = await r.visit('/plan?dept=art');
		expect(r.log).toEqual([]);
		expect(art).toContain(planPage(planOracle(dir, 'art')));
	});

	it('renders a joined field by its dotted name, and empty for a left join with no match', async () => {
		const dir = await Directory.make(300);
		const other = await Directory.make(300);
		await other.remove('c00000');
		await other.remove('c00003');
		const source = '<main>{{#each rows}}<i>{{id}} {{o.title}}</i>{{/each}}</main>';
		const joined: QueryPlan = {
			from: ['id', 'dept'],
			join: [
				{ dataset: 'other', on: ['id', null], type: 'left', as: 'o', fields: ['title'] }
			],
			pageSize: 10,
			limit: 1000
		};
		const r = rig({
			routes: [
				defineRoute('/joined', {
					strategy: 'template',
					query: { list: 'rows', dataset: NAME, plan: joined },
					template: { source },
					load: () => ({ title: 'directory' })
				})
			],
			app: () => {
				const rows = dir
					.visibleRows()
					.slice(0, 10)
					.map((row) => {
						const theirs = other.rows.get(row.id);
						return {
							id: row.id,
							dept: row.dept,
							o: { title: visible(theirs) ? theirs.title : null }
						};
					});
				return new Response(
					interpretTemplate(compileTemplate({ source }), { title: 'directory', rows }),
					{
						headers: HTML
					}
				);
			},
			spool: { datasets: [directory(dir), directory(other, 'v1', 'other')] }
		});
		r.reset();
		const page = await r.visit('/joined');
		expect([...r.log].sort()).toEqual(['GET /.spool/artifact', 'GET /joined']);
		expect(page).toContain('<i>c00001 Item 0001</i>');
		expect(page).toContain('<i>c00000 </i>');
		expect(page).toContain('<i>c00003 </i>');
	});
});

// #endregion
