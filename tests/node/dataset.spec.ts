import { describe, expect, it } from 'vitest';
import {
	applyChanges,
	canonicalJson,
	datasetProof,
	defineDataset,
	digestAdd,
	digestSub,
	EMPTY_DIGEST,
	encodeDatasetRequest,
	parseArtifact,
	parseDatasetRequest,
	parseDatasetResponse,
	ProtocolError,
	rowHash,
	setProof,
	verifyProof,
	type Dataset,
	type DatasetRequest,
	type DatasetResponse,
	type QuerySchema
} from '../../src/protocol/index';
import { answerDataset } from '../../src/server/dataset';
import { createSpool, defineRoute, type Spool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { Graph } from '../../src/sw/graph/index';
import { memoryStorage } from '../../src/sw/storage';

// #region the fixture: a course-and-event directory with an in-memory backend

type Row = {
	id: string;
	title: string;
	kind: 'course' | 'event';
	dept: string;
	status: 'draft' | 'published';
	version: number;
};

function lcg(seed: number) {
	let state = (seed % 2_147_483_646) + 1;
	return () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;
}

const visible = (row: Row | undefined): row is Row => row?.status === 'published';
const byId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const idOf = (n: number) => `c${String(n).padStart(5, '0')}`;

/** the backend: rows, a cursor, a change log it can prune, and a digest it keeps as rows change */
class Directory {
	rows = new Map<string, Row>();
	cursor = 0;
	floor = 0;
	events: Array<{ cursor: number; key: string }> = [];
	digest = EMPTY_DIGEST;
	count = 0;
	nextId: number;
	seeds = 0;
	reads: string[][] = [];
	loads = 0;
	readonly next: () => number;

	private constructor(n: number, seed: number) {
		this.next = lcg(seed);
		const depts = ['cs', 'math', 'art'];
		for (let i = 0; i < n; i++) {
			const id = idOf(i);
			this.rows.set(id, {
				id,
				title: `Item ${i} ${Math.floor(this.next() * 1e6).toString(36)}`,
				kind: this.next() < 0.5 ? 'course' : 'event',
				dept: depts[Math.floor(this.next() * depts.length)] as string,
				status: this.next() < 0.85 ? 'published' : 'draft',
				version: 1
			});
		}
		this.nextId = n;
	}

	static async make(n: number, seed: number): Promise<Directory> {
		const dir = new Directory(n, seed);
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

	async edit(id: string, patch: Partial<Row>): Promise<void> {
		await this.put({ ...(this.rows.get(id) as Row), ...patch });
	}

	async remove(id: string): Promise<void> {
		const old = this.rows.get(id);
		if (visible(old)) {
			this.digest = digestSub(this.digest, await rowHash(id, old));
			this.count -= 1;
		}
		this.rows.delete(id);
		this.cursor += 1;
		this.events.push({ cursor: this.cursor, key: id });
	}

	async add(over: Partial<Row> = {}): Promise<string> {
		const id = idOf(this.nextId++);
		await this.put({
			id,
			title: `Added ${id}`,
			kind: 'event',
			dept: 'cs',
			status: 'published',
			version: 1,
			...over
		});
		return id;
	}

	prune(): void {
		this.floor = this.cursor;
		this.events = [];
	}

	ids(status: Row['status']): string[] {
		return [...this.rows.values()]
			.filter((r) => r.status === status)
			.map((r) => r.id)
			.sort();
	}
}

type Options = {
	proofs?: boolean;
	schema?: string;
	pageSize?: number;
	maxRows?: number;
	maxBytes?: number;
	provision?: 'always' | 'auto';
};

function directory(dir: Directory, options: Options = {}): Dataset<Row> {
	const { proofs = true, schema = 'v1', pageSize = 100 } = options;
	return defineDataset<Row>('directory', {
		scope: 'public',
		schema,
		maxRows: options.maxRows ?? 100_000,
		maxBytes: options.maxBytes ?? 100_000_000,
		provision: options.provision,
		key: (row) => row.id,
		seed: (ctx) => {
			dir.seeds += 1;
			const rows = dir
				.visibleRows()
				.filter((r) => ctx.after === undefined || r.id > ctx.after);
			return (async function* () {
				for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize);
			})();
		},
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
			return { cursor: dir.cursor, puts, deletes, ...(proofs ? { proof: dir.proof() } : {}) };
		},
		horizon: () => dir.floor,
		head: () => ({ cursor: dir.cursor, ...(proofs ? { proof: dir.proof() } : {}) })
	});
}

function spoolFor(dir: Directory, options: Options = {}): Spool {
	return createSpool({
		routes: [
			defineRoute('/directory', {
				strategy: 'template',
				template: { source: '<main>{{title}}</main>' },
				load: () => {
					dir.loads += 1;
					return { title: 'directory' };
				}
			})
		],
		store: memoryStore(),
		datasets: [directory(dir, options)]
	});
}

const NAME = 'directory';

async function rawAsk(spool: Spool, request: DatasetRequest): Promise<Response> {
	const url = `https://site.test/.spool/dataset?${encodeDatasetRequest(request)}`;
	return (await spool.respond(new Request(url))) as Response;
}

async function ask(spool: Spool, request: DatasetRequest): Promise<DatasetResponse> {
	const response = await rawAsk(spool, request);
	expect(response.status).toBe(200);
	return parseDatasetResponse(await response.json());
}

/** what a device holds: its rows, their digest, and the cursor and schema it was seeded at */
type Device = { rows: Map<string, Row>; digest: string; cursor?: number; schema?: string };
const blank = (): Device => ({ rows: new Map(), digest: EMPTY_DIGEST });

/** one sync as a device does it: a patch when it holds a cursor, else a seed, following `next` */
async function sync(spool: Spool, device: Device, limit?: number): Promise<DatasetResponse[]> {
	const paging = limit === undefined ? {} : { limit };
	const first = await ask(
		spool,
		device.cursor === undefined
			? { name: NAME, ...paging }
			: { name: NAME, since: device.cursor, schema: device.schema as string, ...paging }
	);
	const log = [first];
	let response = first;
	for (;;) {
		const applied = await applyChanges(device.rows, response, device.digest);
		device.rows = applied.rows as Map<string, Row>;
		device.digest = applied.digest;
		if (response.next === undefined) {
			expect(applied.matches).toBe(true);
			break;
		}
		response = await ask(spool, { name: NAME, after: response.next, ...paging });
		log.push(response);
	}
	device.cursor = first.cursor;
	device.schema = first.schema;
	return log;
}

const sorted = (rows: Iterable<Row>) => [...rows].sort(byId);

/** the device equals the backend as canonical JSON and as digest */
async function expectInSync(dir: Directory, device: Device): Promise<void> {
	expect(canonicalJson(sorted(device.rows.values()))).toBe(canonicalJson(dir.visibleRows()));
	const expected = await setProof(dir.visibleMap());
	expect(device.digest).toBe(expected.digest);
	expect(device.rows.size).toBe(expected.count);
}

const totals = (log: DatasetResponse[]) => ({
	puts: log.reduce((n, r) => n + r.puts.length, 0),
	deletes: log.reduce((n, r) => n + r.deletes.length, 0)
});

// #endregion

describe('a dataset load', () => {
	it('seeds 200 rows in one page that carries the proof', async () => {
		const dir = await Directory.make(200, 1);
		const spool = spoolFor(dir);
		const device = blank();
		const log = await sync(spool, device);
		expect(log).toHaveLength(1);
		expect(log[0]?.reset).toBe(true);
		expect(log[0]?.puts).toHaveLength(dir.visibleRows().length);
		expect(log[0]?.deletes).toEqual([]);
		expect(log[0]?.next).toBeUndefined();
		expect(log[0]?.proof).toEqual(await setProof(dir.visibleMap()));
		expect(dir.seeds).toBe(1);
		await expectInSync(dir, device);
	});

	it('seeds 2,000 rows in pages of 500, with the proof on the last page only', async () => {
		const dir = await Directory.make(2000, 2);
		const spool = spoolFor(dir);
		const device = blank();
		const log = await sync(spool, device);
		const count = dir.visibleRows().length;
		expect(log).toHaveLength(Math.ceil(count / 500));
		expect(log.slice(0, -1).every((r) => r.proof === undefined && r.next !== undefined)).toBe(
			true
		);
		expect(log.at(-1)?.proof?.count).toBe(count);
		expect(log.map((r) => r.after)).toEqual([
			undefined,
			...log.slice(0, -1).map((r) => r.next)
		]);
		expect(log.every((r) => r.cursor === dir.cursor)).toBe(true);
		expect(totals(log).puts).toBe(count);
		expect(dir.seeds).toBe(log.length);
		await expectInSync(dir, device);
	});

	it('answers a second load with nothing changed with no puts, no deletes and the same digest', async () => {
		const dir = await Directory.make(200, 3);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const digest = device.digest;
		const log = await sync(spool, device);
		expect(log).toHaveLength(1);
		expect(totals(log)).toEqual({ puts: 0, deletes: 0 });
		expect(log[0]?.reset).toBe(false);
		expect(log[0]?.proof?.digest).toBe(digest);
		expect(device.digest).toBe(digest);
		expect(dir.reads).toEqual([]);
	});

	it('patches one changed row with that row alone, one keyed read and no route load', async () => {
		const dir = await Directory.make(200, 4);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const seeds = dir.seeds;
		const id = dir.ids('published')[7] as string;
		await dir.edit(id, { title: 'Changed', version: 2 });
		const log = await sync(spool, device);
		expect(totals(log)).toEqual({ puts: 1, deletes: 0 });
		expect(log[0]?.puts[0]).toEqual({ key: id, row: dir.rows.get(id) });
		expect(dir.reads).toEqual([[id]]);
		expect(dir.loads).toBe(0);
		expect(dir.seeds).toBe(seeds);
		await expectInSync(dir, device);
	});

	it('patches ten changed rows with exactly those ids read', async () => {
		const dir = await Directory.make(200, 5);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const ids = dir.ids('published').slice(20, 30);
		for (const id of ids) await dir.edit(id, { title: `T ${id}`, version: 2 });
		const log = await sync(spool, device);
		expect(totals(log)).toEqual({ puts: 10, deletes: 0 });
		expect(dir.reads).toEqual([ids]);
		expect(dir.loads).toBe(0);
		await expectInSync(dir, device);
	});

	it('sends a deletion as the key and its cursor, with no read', async () => {
		const dir = await Directory.make(200, 6);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const id = dir.ids('published')[3] as string;
		await dir.remove(id);
		const log = await sync(spool, device);
		expect(log[0]?.puts).toEqual([]);
		expect(log[0]?.deletes).toEqual([{ key: id, cursor: dir.cursor }]);
		expect(dir.reads).toEqual([]);
		expect(device.rows.has(id)).toBe(false);
		await expectInSync(dir, device);
	});

	it('gives a device that missed several revisions the union once', async () => {
		const dir = await Directory.make(200, 7);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const [a, b, c] = dir.ids('published').slice(0, 3) as [string, string, string];
		for (const n of [2, 3, 4]) await dir.edit(a, { title: `A${n}`, version: n });
		for (const n of [2, 3]) await dir.edit(b, { title: `B${n}`, version: n });
		await dir.remove(c);
		const d = await dir.add();
		const log = await sync(spool, device);
		expect(log[0]?.puts.map((p) => p.key)).toEqual([a, b, d]);
		expect(log[0]?.deletes).toEqual([{ key: c, cursor: dir.cursor - 1 }]);
		expect(dir.reads).toEqual([[a, b, d]]);
		expect(log[0]?.puts.find((p) => p.key === a)?.row.title).toBe('A4');
		await expectInSync(dir, device);
	});

	it('serves a repeated since the same body and converges on a stale one applied late', async () => {
		const dir = await Directory.make(200, 8);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const c0 = device.cursor as number;
		const [a, b] = dir.ids('published') as [string, string];
		await dir.edit(a, { title: 'A', version: 2 });
		const c1 = dir.cursor;
		await dir.edit(b, { title: 'B', version: 2 });

		const request = { name: NAME, since: c0, schema: 'v1' };
		const one = await ask(spool, request);
		expect(await ask(spool, request)).toEqual(one);
		const stale = await ask(spool, { ...request, since: c1 });
		expect(stale.puts.map((p) => p.key)).toEqual([b]);

		const early = await applyChanges(device.rows, stale, device.digest);
		expect(early.matches).toBe(false);
		const full = await applyChanges(early.rows, one, early.digest);
		expect(full.matches).toBe(true);
		const again = await applyChanges(full.rows, stale, full.digest);
		expect(again.matches).toBe(true);
		const twice = await applyChanges(again.rows, one, again.digest);
		expect(twice.matches).toBe(true);
		expect(twice.digest).toBe(full.digest);

		const current = await ask(spool, { ...request, since: dir.cursor });
		expect(totals([current])).toEqual({ puts: 0, deletes: 0 });
		expect(current.reset).toBe(false);
	});

	it('resets a since ahead of the backend', async () => {
		const dir = await Directory.make(50, 9);
		const spool = spoolFor(dir);
		const response = await ask(spool, { name: NAME, since: dir.cursor + 5, schema: 'v1' });
		expect(response.reset).toBe(true);
		expect(response.puts).toHaveLength(dir.visibleRows().length);
	});

	it('resets a since older than the horizon, and patches one at the horizon', async () => {
		const dir = await Directory.make(200, 10);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const old = device.cursor as number;
		await dir.edit(dir.ids('published')[0] as string, { title: 'X', version: 2 });
		await dir.edit(dir.ids('published')[1] as string, { title: 'Y', version: 2 });
		dir.prune();
		const atHorizon = await ask(spool, { name: NAME, since: dir.cursor, schema: 'v1' });
		expect(atHorizon.reset).toBe(false);
		const log = await sync(spool, device);
		expect(log[0]?.reset).toBe(true);
		expect(old).toBeLessThan(dir.floor);
		expect(device.cursor).toBe(dir.cursor);
		await expectInSync(dir, device);
	});

	it('resets every device when the schema version differs', async () => {
		const dir = await Directory.make(200, 11);
		const device = blank();
		await sync(spoolFor(dir, { schema: 'v1' }), device);
		const next = spoolFor(dir, { schema: 'v2' });
		const log = await sync(next, device);
		expect(log[0]?.reset).toBe(true);
		expect(log[0]?.schema).toBe('v2');
		expect(device.schema).toBe('v2');
		await expectInSync(dir, device);
	});

	it('sends a row that moves into scope with its version unchanged as a put', async () => {
		const dir = await Directory.make(200, 12);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const id = dir.ids('draft')[0] as string;
		await dir.edit(id, { status: 'published' });
		expect(dir.rows.get(id)?.version).toBe(1);
		const log = await sync(spool, device);
		expect(log[0]?.puts).toEqual([{ key: id, row: dir.rows.get(id) }]);
		expect(log[0]?.deletes).toEqual([]);
		await expectInSync(dir, device);
	});

	it('sends a row that moves out of scope with its version unchanged as a delete', async () => {
		const dir = await Directory.make(200, 13);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const id = dir.ids('published')[5] as string;
		await dir.edit(id, { status: 'draft' });
		const log = await sync(spool, device);
		expect(log[0]?.puts).toEqual([]);
		expect(log[0]?.deletes).toEqual([{ key: id, cursor: dir.cursor }]);
		expect(device.rows.has(id)).toBe(false);
		await expectInSync(dir, device);
	});

	it('turns a put the backend can no longer read into a delete at the new cursor', async () => {
		const dir = await Directory.make(60, 14);
		const base = directory(dir);
		const racing = defineDataset<Row>(NAME, {
			...base,
			changes: async (since, ctx) => {
				const found = await base.changes(since, ctx);
				if (found === 'reset') return found;
				const id = dir.ids('published')[0] as string;
				await dir.remove(id);
				return { ...found, puts: [id] };
			}
		});
		const spool = createSpool({ routes: [], store: memoryStore(), datasets: [racing] });
		const gone = dir.ids('published')[0] as string;
		const response = await ask(spool, { name: NAME, since: 0, schema: 'v1' });
		expect(response.puts).toEqual([]);
		expect(response.deletes).toEqual([{ key: gone, cursor: response.cursor }]);
	});
});

describe('seed paging and limits', () => {
	it('pages by key with limit and after, and the last page has the proof', async () => {
		const dir = await Directory.make(120, 20);
		const spool = spoolFor(dir);
		const rows = dir.visibleRows();
		const first = await ask(spool, { name: NAME, limit: 50 });
		expect(first.puts.map((p) => p.key)).toEqual(rows.slice(0, 50).map((r) => r.id));
		expect(first.next).toBe(rows[49]?.id);
		expect(first.proof).toBeUndefined();
		const second = await ask(spool, { name: NAME, after: first.next, limit: 50 });
		expect(second.after).toBe(first.next);
		expect(second.puts.map((p) => p.key)).toEqual(rows.slice(50, 100).map((r) => r.id));
		const last = await ask(spool, { name: NAME, after: second.next, limit: 50 });
		expect(last.puts.map((p) => p.key)).toEqual(rows.slice(100).map((r) => r.id));
		expect(last.next).toBeUndefined();
		expect(last.proof).toEqual(await setProof(dir.visibleMap()));
	});

	it('builds the last-page proof by one full read when the backend keeps none', async () => {
		const dir = await Directory.make(120, 21);
		const spool = spoolFor(dir, { proofs: false });
		const device = blank();
		const log = await sync(spool, device, 50);
		expect(log).toHaveLength(Math.ceil(dir.visibleRows().length / 50));
		expect(dir.seeds).toBe(log.length + 1);
		await expectInSync(dir, device);
	});

	it('builds the patch proof by one full read when the backend keeps none', async () => {
		const dir = await Directory.make(120, 22);
		const spool = spoolFor(dir, { proofs: false });
		const device = blank();
		await sync(spool, device);
		expect(dir.seeds).toBe(1);
		await dir.edit(dir.ids('published')[0] as string, { title: 'Z', version: 2 });
		await sync(spool, device);
		expect(dir.seeds).toBe(2);
		await expectInSync(dir, device);
	});

	it('takes a seed of exactly maxRows and refuses one row over', async () => {
		const dir = await Directory.make(200, 23);
		const count = dir.visibleRows().length;
		const context = {
			request: new Request('https://site.test/'),
			url: new URL('https://site.test/')
		};
		await expect(
			answerDataset(directory(dir, { maxRows: count }), { name: NAME }, context)
		).resolves.toMatchObject({ reset: true });
		const refused = answerDataset(
			directory(dir, { maxRows: count - 1 }),
			{ name: NAME },
			context
		);
		await expect(refused).rejects.toMatchObject({ code: 'dataset-limit' });
		await expect(refused).rejects.toBeInstanceOf(ProtocolError);
	});

	it('refuses by maxRows from the backend proof on any page, scanning nothing', async () => {
		const dir = await Directory.make(200, 24);
		const count = dir.visibleRows().length;
		const small = directory(dir, { maxRows: count - 1 });
		const context = {
			request: new Request('https://site.test/'),
			url: new URL('https://site.test/')
		};
		await expect(
			answerDataset(small, { name: NAME, after: idOf(10) }, context)
		).rejects.toMatchObject({ code: 'dataset-limit' });
		expect(dir.seeds).toBe(0);
	});

	it('takes a seed of exactly maxBytes and refuses one byte over', async () => {
		const dir = await Directory.make(200, 25);
		const bytes = dir
			.visibleRows()
			.reduce((n, row) => n + new TextEncoder().encode(JSON.stringify(row)).length, 0);
		const context = {
			request: new Request('https://site.test/'),
			url: new URL('https://site.test/')
		};
		await expect(
			answerDataset(directory(dir, { maxBytes: bytes }), { name: NAME }, context)
		).resolves.toMatchObject({ reset: true });
		await expect(
			answerDataset(directory(dir, { maxBytes: bytes - 1 }), { name: NAME }, context)
		).rejects.toMatchObject({ code: 'dataset-limit' });
	});

	it('answers a refusal as 400 with the message', async () => {
		const dir = await Directory.make(200, 26);
		const spool = spoolFor(dir, { maxRows: 5 });
		const response = await rawAsk(spool, { name: NAME });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			'a seed over 5 rows'
		);
	});

	it('refuses a seed whose rows are out of key order', async () => {
		const dir = await Directory.make(10, 27);
		const base = directory(dir);
		const backwards = defineDataset<Row>(NAME, {
			...base,
			seed: () => [...dir.visibleRows()].reverse()
		});
		const spool = createSpool({ routes: [], store: memoryStore(), datasets: [backwards] });
		const response = await rawAsk(spool, { name: NAME });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain('ascending');
	});
});

describe('the set proof', () => {
	async function patch() {
		const dir = await Directory.make(200, 30);
		const spool = spoolFor(dir);
		const device = blank();
		await sync(spool, device);
		const published = dir.ids('published');
		await dir.edit(published[0] as string, { title: 'One', version: 2 });
		await dir.edit(published[1] as string, { title: 'Two', version: 2 });
		await dir.remove(published[2] as string);
		await dir.remove(published[3] as string);
		const response = await ask(spool, { name: NAME, since: device.cursor, schema: 'v1' });
		return { device, response };
	}

	it('verifies an untouched patch', async () => {
		const { device, response } = await patch();
		expect(response.puts).toHaveLength(2);
		expect(response.deletes).toHaveLength(2);
		const applied = await applyChanges(device.rows, response, device.digest);
		expect(applied.matches).toBe(true);
	});

	it('detects a dropped put', async () => {
		const { device, response } = await patch();
		const broken = structuredClone(response);
		broken.puts.pop();
		expect((await applyChanges(device.rows, broken, device.digest)).matches).toBe(false);
	});

	it('detects a dropped delete', async () => {
		const { device, response } = await patch();
		const broken = structuredClone(response);
		broken.deletes.pop();
		expect((await applyChanges(device.rows, broken, device.digest)).matches).toBe(false);
	});

	it('detects a flipped byte in a row', async () => {
		const { device, response } = await patch();
		const broken = structuredClone(response);
		const row = (broken.puts[0] as unknown as { row: Row }).row;
		row.title = `${row.title.slice(0, -1)}${row.title.endsWith('a') ? 'b' : 'a'}`;
		expect((await applyChanges(device.rows, broken, device.digest)).matches).toBe(false);
	});

	it('computes the digest without a held one, and leaves the input map alone', async () => {
		const { device, response } = await patch();
		const before = canonicalJson(sorted(device.rows.values()));
		const applied = await applyChanges(device.rows, response);
		expect(applied.matches).toBe(true);
		expect(applied.digest).toBe(
			(await applyChanges(device.rows, response, device.digest)).digest
		);
		expect(canonicalJson(sorted(device.rows.values()))).toBe(before);
	});

	it('does not depend on row order, and adding then subtracting a hash is the identity', async () => {
		const rows = [...(await Directory.make(20, 31)).visibleMap()];
		const forward = await setProof(new Map(rows));
		const backward = await setProof(new Map([...rows].reverse()));
		expect(backward).toEqual(forward);
		const hash = await rowHash('x', { a: 1 });
		expect(digestSub(digestAdd(forward.digest, hash), hash)).toBe(forward.digest);
		expect(digestSub(EMPTY_DIGEST, hash)).toMatch(/^[0-9a-f]{64}$/);
		expect(digestAdd(digestSub(EMPTY_DIGEST, hash), hash)).toBe(EMPTY_DIGEST);
	});

	it('dispatches verifyProof on kind: set needs keys, ordered does not', async () => {
		const schema: QuerySchema = { list: 'rows' };
		const rows = [
			{ id: 'a', n: 1 },
			{ id: 'b', n: 2 }
		];
		const keyOf = (row: Record<string, unknown>) => row['id'] as string;
		const set = await setProof(new Map(rows.map((r) => [r.id, r])));
		expect(await verifyProof(schema, { rows, proof: set }, keyOf)).toBe(true);
		expect(await verifyProof(schema, { rows: [...rows].reverse(), proof: set }, keyOf)).toBe(
			true
		);
		expect(await verifyProof(schema, { rows, proof: set })).toBe(false);
		expect(
			await verifyProof(
				schema,
				{
					rows: [
						{ id: 'a', n: 1 },
						{ id: 'b', n: 3 }
					],
					proof: set
				},
				keyOf
			)
		).toBe(false);
		expect(await verifyProof(schema, { rows: rows.slice(1), proof: set }, keyOf)).toBe(false);
		expect(await verifyProof(schema, { rows: [rows[0], rows[0]], proof: set }, keyOf)).toBe(
			false
		);
		expect(await verifyProof(schema, { rows, proof: { ...set, kind: 'other' } }, keyOf)).toBe(
			false
		);
	});

	it('still verifies the v0.3 ordered proof, with or without a kind', async () => {
		const schema: QuerySchema = { list: 'rows' };
		const rows = [{ a: 1 }, { a: 2 }];
		const proof = await datasetProof(rows);
		expect(proof).not.toHaveProperty('kind');
		expect(await verifyProof(schema, { rows, proof })).toBe(true);
		expect(await verifyProof(schema, { rows, proof: { ...proof, kind: 'ordered' } })).toBe(
			true
		);
		expect(await verifyProof(schema, { rows: [...rows].reverse(), proof })).toBe(false);
	});
});

describe("provision: 'auto' on the seed", () => {
	const seed = async (spool: Spool) =>
		(await spool.respond(
			new Request(`https://site.test/.spool/dataset?name=${NAME}`)
		)) as Response;

	it('refuses the seed with 409 and the control that bound at the default priors', async () => {
		const dir = await Directory.make(100, 3);
		await dir.put({ ...(dir.visibleRows()[0] as Row), title: 'changed once' });
		await dir.put({ ...(dir.visibleRows()[1] as Row), title: 'changed twice' });
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [directory(dir, { provision: 'auto' })]
		});
		const reply = await seed(spool);
		expect(reply.status).toBe(409);
		expect(reply.headers.get('spool-provision')).toBe('declined');
		expect(reply.headers.get('spool-provision-reason')).toBe('native');
		expect(await reply.json()).toEqual({ error: 'declined', controls: 'native' });
	});

	it('answers the seed when its priors make the dataset beat both controls', async () => {
		const dir = await Directory.make(100, 3);
		await dir.put({ ...(dir.visibleRows()[0] as Row), title: 'changed once' });
		await dir.put({ ...(dir.visibleRows()[1] as Row), title: 'changed twice' });
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [directory(dir, { provision: 'auto' })],
			provision: { reuse: 1, futureViews: 1000 }
		});
		const reply = await seed(spool);
		expect(reply.status).toBe(200);
		expect(await reply.json()).toMatchObject({ reset: true, name: NAME });
	});

	it("answers every seed of a dataset that says 'always', at the default priors", async () => {
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [directory(await Directory.make(100, 3), { provision: 'always' })]
		});
		expect((await seed(spool)).status).toBe(200);
	});

	it('refuses a provision value that is neither always nor auto', async () => {
		const dir = await Directory.make(1, 0);
		expect(() => directory(dir, { provision: 'sometimes' as never })).toThrow(
			/provision must be "always" or "auto"/
		);
	});

	it("holds a seed to the dataset's maxBytes, and not to the maxBytes of a route that reads it", async () => {
		const route = defineRoute('/list', {
			strategy: 'template',
			template: { source: '<main></main>' },
			query: { list: 'rows', dataset: NAME },
			provision: { maxBytes: 10 },
			depends: () => ['dataset'],
			load: () => ({ rows: [] })
		});
		const served = createSpool({
			routes: [route],
			store: memoryStore(),
			datasets: [directory(await Directory.make(3, 4))]
		});
		const page = await served.respond(
			new Request('https://site.test/.spool/artifact?path=/list')
		);
		expect(page?.status).toBe(200);
		const capped = createSpool({
			routes: [],
			store: memoryStore(),
			datasets: [directory(await Directory.make(3, 4), { maxBytes: 10 })]
		});
		expect((await seed(capped)).status).toBe(400);
	});
});

describe('the dataset declaration and the wire', () => {
	const base = async () => directory(await Directory.make(1, 0));

	it('refuses a principal dataset and names the missing flag', async () => {
		const declaration = { ...(await base()), scope: 'principal' as never };
		expect(() => defineDataset('x', declaration)).toThrow(/principal datasets flag/);
		try {
			defineDataset('x', declaration);
		} catch (error) {
			expect((error as ProtocolError).code).toBe('bad-dataset');
		}
	});

	it('refuses a bad name, a missing function and a bad limit', async () => {
		const good = await base();
		expect(() => defineDataset('', good)).toThrow(ProtocolError);
		expect(() => defineDataset('a b', good)).toThrow(ProtocolError);
		expect(() => defineDataset('x', { ...good, read: undefined as never })).toThrow(/read/);
		expect(() => defineDataset('x', { ...good, schema: '' })).toThrow(/schema/);
		expect(() => defineDataset('x', { ...good, maxRows: 0 })).toThrow(/maxRows/);
		expect(() => defineDataset('x', { ...good, maxBytes: 1.5 })).toThrow(/maxBytes/);
	});

	it('refuses two datasets with one name', async () => {
		const dir = await Directory.make(5, 40);
		expect(() =>
			createSpool({
				routes: [],
				store: memoryStore(),
				datasets: [directory(dir), directory(dir)]
			})
		).toThrow(/declared twice/);
	});

	it('answers no-store JSON, 404 for an unknown name and 400 for a bad request', async () => {
		const dir = await Directory.make(20, 41);
		const spool = spoolFor(dir);
		const ok = await rawAsk(spool, { name: NAME });
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(ok.headers.get('content-type')).toBe('application/json');
		expect(ok.headers.get('spool-protocol')).toBe('1');
		expect((await rawAsk(spool, { name: 'nope' })).status).toBe(404);
		expect((await rawAsk(spool, { name: NAME, since: 1 })).status).toBe(400);
		const post = await spool.respond(
			new Request('https://site.test/.spool/dataset?name=directory', { method: 'POST' })
		);
		expect(post?.status).toBe(404);
	});

	it('round-trips a request and refuses malformed ones', () => {
		const full = { name: 'a', since: 3, schema: 'v1', limit: 10 };
		expect(parseDatasetRequest(new URLSearchParams(encodeDatasetRequest(full)))).toEqual(full);
		const paged = { name: 'a', after: 'k/1', limit: 10 };
		expect(parseDatasetRequest(new URLSearchParams(encodeDatasetRequest(paged)))).toEqual(
			paged
		);
		const refuse = (query: string) => () => parseDatasetRequest(new URLSearchParams(query));
		expect(refuse('')).toThrow(ProtocolError);
		expect(refuse('name=a&since=x&schema=v')).toThrow(/since/);
		expect(refuse('name=a&since=1')).toThrow(/schema/);
		expect(refuse('name=a&since=1&schema=v&after=k')).toThrow(/exclusive/);
		expect(refuse('name=a&limit=0')).toThrow(/limit/);
		expect(parseDatasetRequest(new URLSearchParams('name=a&limit=999999999')).limit).toBe(5000);
	});

	it('validates a response and requires a proof when there is no next page', () => {
		const ok = {
			protocol: 1,
			name: 'a',
			schema: 'v1',
			cursor: 2,
			reset: false,
			puts: [{ key: 'k', row: { id: 'k' } }],
			deletes: [{ key: 'j', cursor: 2 }],
			proof: { kind: 'set', count: 1, digest: EMPTY_DIGEST }
		};
		expect(parseDatasetResponse(ok).puts).toHaveLength(1);
		const paged = { ...ok, reset: true, next: 'k' } as Record<string, unknown>;
		delete paged['proof'];
		expect(parseDatasetResponse(paged).next).toBe('k');
		const refuse = (value: unknown) => () => parseDatasetResponse(value);
		expect(refuse({ ...ok, protocol: 2 })).toThrow(ProtocolError);
		expect(refuse({ ...ok, cursor: -1 })).toThrow(/cursor/);
		expect(refuse({ ...ok, puts: [{ key: 'k' }] })).toThrow(/put/);
		expect(refuse({ ...ok, deletes: [{ key: 'j' }] })).toThrow(/delete/);
		expect(refuse({ ...ok, proof: { kind: 'set', count: 1, digest: 'x' } })).toThrow(/proof/);
		expect(refuse({ ...paged, next: undefined })).toThrow(/proof/);
		expect(refuse(null)).toThrow(ProtocolError);
	});

	it('refuses a changes feed that names a key as both a put and a delete', async () => {
		const dir = await Directory.make(10, 42);
		const base = directory(dir);
		const both = defineDataset<Row>(NAME, {
			...base,
			changes: () => ({
				cursor: 0,
				puts: [idOf(1)],
				deletes: [{ key: idOf(1), cursor: 0 }]
			})
		});
		const spool = createSpool({ routes: [], store: memoryStore(), datasets: [both] });
		const response = await rawAsk(spool, { name: NAME, since: 0, schema: 'v1' });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			'both a put and a delete'
		);
	});

	it('refuses a read that returns a row nobody asked for', async () => {
		const dir = await Directory.make(10, 43);
		const base = directory(dir);
		const stray = defineDataset<Row>(NAME, {
			...base,
			changes: () => ({ cursor: 1, puts: [idOf(1)], deletes: [] }),
			read: () => [dir.rows.get(idOf(2)) as Row]
		});
		const spool = createSpool({ routes: [], store: memoryStore(), datasets: [stray] });
		const response = await rawAsk(spool, { name: NAME, since: 0, schema: 'v1' });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain('not asked for');
	});
});

describe('any feed from any earlier cursor equals a full reseed', () => {
	it('holds over 100 random mutation sequences', async () => {
		for (let seed = 0; seed < 100; seed++) {
			const dir = await Directory.make(20, seed + 1000);
			const spool = spoolFor(dir, { proofs: seed % 2 === 0, pageSize: 7 });
			const device = blank();
			await sync(spool, device, 10);
			const roll = lcg(seed + 77);
			const pick = <T>(list: T[]): T => list[Math.floor(roll() * list.length)] as T;
			for (let step = 0; step < 6; step++) {
				const op = Math.floor(roll() * 7);
				const published = dir.ids('published');
				const drafts = dir.ids('draft');
				if (op === 0 && published.length > 0) {
					await dir.edit(pick(published), {
						title: `T${seed}.${step}`,
						version: step + 2
					});
				} else if (op === 1 && drafts.length > 0)
					await dir.edit(pick(drafts), { status: 'published' });
				else if (op === 2 && published.length > 0)
					await dir.edit(pick(published), { status: 'draft' });
				else if (op === 3 && published.length > 0) await dir.remove(pick(published));
				else if (op === 4) await dir.add({ status: roll() < 0.8 ? 'published' : 'draft' });
				else if (op === 5) await sync(spool, device, 10);
				else if (op === 6 && roll() < 0.3) dir.prune();
			}
			await sync(spool, device, 10);
			const fresh = blank();
			await sync(spool, fresh, 10);
			expect(canonicalJson(sorted(device.rows.values())), `seed ${seed}`).toBe(
				canonicalJson(sorted(fresh.rows.values()))
			);
			expect(device.digest, `seed ${seed}`).toBe(fresh.digest);
			expect(device.digest, `seed ${seed}`).toBe(dir.digest);
		}
	});
});

describe('a query route over record refs (B1)', () => {
	const QUERY: QuerySchema = { list: 'rows' };
	type Item = { id: number; title: string };
	const items: Item[] = [
		{ id: 1, title: 'Intro' },
		{ id: 2, title: 'Algebra' },
		{ id: 3, title: 'Poetry' }
	];

	const build = (proofOver: 'rows' | 'refs') =>
		createSpool({
			routes: [
				defineRoute('/list', {
					strategy: 'template',
					template: { source: '<main>{{title}}</main>' },
					query: QUERY,
					provision: { reuse: 1, futureViews: 1000 },
					load: async (ctx) => {
						const refs = items.map((i) => ctx.record(`row:${i.id}`, i));
						return {
							rows: refs,
							proof: await datasetProof(proofOver === 'rows' ? items : refs)
						};
					}
				})
			],
			store: memoryStore()
		});

	const artifactOf = (spool: Spool) =>
		spool.respond(
			new Request('https://site.test/.spool/artifact?path=%2Flist')
		) as Promise<Response>;

	it('builds the artifact when the proof is over the resolved rows, and the worker verifies it', async () => {
		const response = await artifactOf(build('rows'));
		expect(response.status).toBe(200);
		const artifact = parseArtifact(await response.json());
		const body = artifact.body as { data: unknown };
		expect(await verifyProof(QUERY, body.data)).toBe(false);

		const graph = new Graph({
			storage: memoryStorage(),
			tagVersion: () => 0,
			artifacts: async () => []
		});
		await graph.put(artifact, true);
		const materialized = await graph.materialize(artifact);
		if (!materialized.ok) throw new Error(materialized.reason);
		const data = (materialized.artifact.body as { data: unknown }).data;
		expect(await verifyProof(QUERY, data)).toBe(true);
	});

	it('refuses a proof over the refs, which the worker could never verify', async () => {
		const response = await artifactOf(build('refs'));
		expect(response.status).toBe(400);
		const { error } = (await response.json()) as { error: string };
		expect(error).toContain("/list: a query route's load needs");
	});
});
