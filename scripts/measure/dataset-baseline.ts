import { parseArgs } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { parseArtifact } from '../../src/protocol/artifact.ts';
import {
	datasetProof,
	shapeQuery,
	verifyProof,
	type QuerySchema
} from '../../src/protocol/query.ts';
import { encodeHeld, MAX_HAVE } from '../../src/protocol/sync.ts';
import { createSpool, defineRoute, type Spool } from '../../src/server/index.ts';
import { memoryStore } from '../../src/stores/index.ts';
import { Graph } from '../../src/sw/graph/index.ts';
import { memoryStorage } from '../../src/sw/storage.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib.ts';

type Row = Record<string, unknown>;
type Item = { id: number; title: string; category: string; updated: number };
type World = { items: Item[]; nextId: number; loads: number };
type Reply = {
	status: number;
	bytes: number;
	gzip: number;
	brotli: number;
	loads: number;
	text: string;
};
type Arm = { name: string; gateOpen: boolean };

const SIZES = [50, 500, 5000];
const SHAPES = ['list', 'records'] as const;
type Shape = (typeof SHAPES)[number];
const CHANGES = ['change-1', 'change-10', 'change-1pct', 'delete-1', 'add-1'] as const;
type Change = (typeof CHANGES)[number];
// the default priors decline a template artifact above about 17 KB; gate open declares a reuse that always pays
const ARMS: Arm[] = [
	{ name: 'as shipped', gateOpen: false },
	{ name: 'gate open', gateOpen: true }
];
const PATHS: Record<Shape, string> = { list: '/list', records: '/records' };
const QUERY: QuerySchema = { list: 'rows' };
const TEMPLATE = { source: '<main>{{title}}</main>' };
const CATEGORIES = ['news', 'event', 'course', 'notice'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz ';

function lcg(seed: number) {
	let state = seed;
	return () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;
}

// a row at a revision; the title is 40 to 80 ASCII characters, fixed by the id and the revision
function item(id: number, revision: number): Item {
	const next = lcg((((id + 1) * 7_919 + revision * 104_729) % 2_147_483_646) + 1);
	const length = 40 + Math.floor(next() * 41);
	let title = '';
	while (title.length < length) title += ALPHABET.charAt(Math.floor(next() * ALPHABET.length));
	return { id, title, category: CATEGORIES[id % CATEGORIES.length] as string, updated: revision };
}

function fresh(n: number): World {
	return {
		items: Array.from({ length: n }, (_, id) => item(id, 0)),
		nextId: n,
		loads: 0
	};
}

const dataOf = (body: unknown) => (body as { data: unknown }).data;

function build(shape: Shape, arm: Arm, world: World): Spool {
	const provision = arm.gateOpen ? { reuse: 1, futureViews: 1000 } : undefined;
	const route = defineRoute(PATHS[shape], {
		strategy: 'template',
		template: TEMPLATE,
		query: QUERY,
		depends: () => ['dataset'],
		load: async (ctx) => {
			world.loads++;
			const rows =
				shape === 'list'
					? world.items.map((i) => ({ ...i }))
					: world.items.map((i) => ctx.record(`row:${i.id}`, i));
			return { rows, proof: await datasetProof(rows) };
		},
		...(provision ? { provision } : {})
	});
	return createSpool({ routes: [route], store: memoryStore() });
}

// the tags to bump, and how many rows the change touched
function change(world: World, shape: Shape, kind: Change): { tags: string[]; rows: number } {
	if (kind === 'delete-1') {
		world.items.shift();
		return { tags: ['dataset'], rows: 1 };
	}
	if (kind === 'add-1') {
		world.items.push(item(world.nextId++, 0));
		return { tags: ['dataset'], rows: 1 };
	}
	const count =
		kind === 'change-1'
			? 1
			: kind === 'change-10'
				? 10
				: Math.max(2, Math.ceil(world.items.length / 100));
	const tags = ['dataset'];
	for (let i = 0; i < count; i++) {
		const old = world.items[i] as Item;
		world.items[i] = item(old.id, old.updated + 1);
		if (shape === 'records') tags.push(`row:${old.id}`);
	}
	return { tags, rows: count };
}

async function fetchArtifact(
	spool: Spool,
	path: string,
	world: World,
	have?: string
): Promise<Reply> {
	const url = new URL('http://spool.test/.spool/artifact');
	url.searchParams.set('path', path);
	if (have !== undefined) url.searchParams.set('have', have);
	const before = world.loads;
	const response = await spool.respond(new Request(url));
	if (!response) throw new Error(`no handler for ${url.href}`);
	const body = Buffer.from(await response.arrayBuffer());
	return {
		status: response.status,
		bytes: body.length,
		gzip: body.length > 0 ? gzipSync(body).length : 0,
		brotli: body.length > 0 ? brotliCompressSync(body).length : 0,
		loads: world.loads - before,
		text: body.toString('utf8')
	};
}

const cell = (r: Reply) => ({
	status: r.status,
	bytes: r.bytes,
	gzip: r.gzip,
	brotli: r.brotli,
	loads: r.loads
});

async function scenario(shape: Shape, n: number, arm: Arm, kind: Change): Promise<Row> {
	const world = fresh(n);
	const spool = build(shape, arm, world);
	const path = PATHS[shape];
	const seed = await fetchArtifact(spool, path, world);
	const artifact = seed.status === 200 ? parseArtifact(JSON.parse(seed.text)) : undefined;
	const held = artifact?.records ?? [];
	const named = held.slice(0, MAX_HAVE);
	const have =
		named.length > 0
			? encodeHeld(Object.fromEntries(named.map((r) => [r.id, r.version])))
			: undefined;

	const edit = change(world, shape, kind);
	await spool.invalidate(edit.tags);

	let sync: Row | null = null;
	const vector = artifact?.vector;
	if (vector !== undefined) {
		const reply = await spool.respond(
			new Request(`http://spool.test/.spool/sync?from=${vector}`)
		);
		if (!reply) throw new Error('sync not answered');
		sync = { status: reply.status, bytes: (await reply.arrayBuffer()).byteLength };
	}

	const withHave = have === undefined ? null : await fetchArtifact(spool, path, world, have);
	const without = await fetchArtifact(spool, path, world);

	let fullHave: Row | null = null;
	if (shape === 'records' && held.length > MAX_HAVE) {
		const all = encodeHeld(Object.fromEntries(held.map((r) => [r.id, r.version])));
		const reply = await fetchArtifact(spool, path, world, all);
		fullHave = {
			status: reply.status,
			error:
				reply.text === ''
					? null
					: ((JSON.parse(reply.text) as { error?: string }).error ?? null)
		};
	}

	return {
		kind: 'scenario',
		shape,
		n,
		arm: arm.name,
		change: kind,
		changedRows: edit.rows,
		seed: cell(seed),
		refetchWithHave: withHave ? { ...cell(withHave), haveIds: named.length } : null,
		haveNote:
			have !== undefined
				? null
				: shape === 'list'
					? 'list shape holds no record ids, so no have is sent'
					: 'no record ids held, so no have is sent',
		refetchWithout: cell(without),
		sync,
		fullHave
	};
}

// the default priors and a `data` route: the server declines to ship a one-row artifact
async function dataProbe(): Promise<Row> {
	const world = fresh(1);
	const route = defineRoute('/data', {
		strategy: 'data',
		depends: () => ['dataset'],
		load: () => {
			world.loads++;
			return { rows: world.items };
		}
	});
	const spool = createSpool({ routes: [route], store: memoryStore() });
	const reply = await fetchArtifact(spool, '/data', world);
	return { kind: 'probe', strategy: 'data', arm: 'as shipped', n: 1, seed: cell(reply) };
}

// the open question: does the proof verify on the server, and on the client after materialize
async function proof(shape: Shape, n: number): Promise<Row> {
	const world = fresh(n);
	const spool = build(shape, ARMS[1] as Arm, world);
	const seed = await fetchArtifact(spool, PATHS[shape], world);
	if (seed.status !== 200) throw new Error(`${shape} ${n}: seed status ${seed.status}`);
	const artifact = parseArtifact(JSON.parse(seed.text));
	const serverData = dataOf(artifact.body);
	const serverVerify = await verifyProof(QUERY, serverData);
	const graph = new Graph({
		storage: memoryStorage(),
		tagVersion: () => 0,
		artifacts: async () => []
	});
	await graph.put(artifact, true);
	const materialized = await graph.materialize(artifact);
	if (!materialized.ok) {
		return {
			kind: 'proof',
			shape,
			n,
			serverVerify,
			materialized: false,
			reason: materialized.reason
		};
	}
	const clientData = dataOf(materialized.artifact.body);
	const shaped = await shapeQuery(QUERY, clientData, '');
	return {
		kind: 'proof',
		shape,
		n,
		serverVerify,
		materialized: true,
		clientVerify: await verifyProof(QUERY, clientData),
		shapeQuery: shaped.ok ? 'ok' : shaped.reason
	};
}

const probeText = (r: Reply | null | undefined) =>
	r ? `${r.status}/${r.bytes}/${r.gzip}/${r.brotli}/L${r.loads}` : '-';

function summary(row: Row): string {
	if (row['kind'] === 'probe') return `probe data seed=${probeText(row['seed'] as Reply)}`;
	if (row['kind'] === 'proof') return JSON.stringify(row);
	const has = row['refetchWithHave'] as (Reply & { haveIds: number }) | null;
	return [
		`${row['shape']} n=${row['n']} ${row['arm']} ${row['change']}`,
		`seed=${probeText(row['seed'] as Reply)}`,
		`have=${has ? `${probeText(has)} ids=${has.haveIds}` : '-'}`,
		`without=${probeText(row['refetchWithout'] as Reply)}`,
		`sync=${(row['sync'] as { bytes: number } | null)?.bytes ?? '-'}`
	].join(' ');
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false }
		}
	});
	return {
		machine: values.machine,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.dryRun) {
		console.log(
			JSON.stringify(
				{
					rig: 'dataset-baseline',
					date: utcDate(),
					sizes: SIZES,
					shapes: SHAPES,
					changes: CHANGES,
					arms: ARMS.map((a) => a.name),
					scenarios: SHAPES.length * SIZES.length * ARMS.length * CHANGES.length,
					out: args.out
				},
				null,
				2
			)
		);
	} else {
		const rows: Row[] = [await dataProbe()];
		for (const shape of SHAPES) {
			for (const n of SIZES) {
				for (const arm of ARMS) {
					for (const kind of CHANGES) rows.push(await scenario(shape, n, arm, kind));
				}
			}
		}
		for (const shape of SHAPES) {
			for (const n of SIZES) rows.push(await proof(shape, n));
		}
		for (const row of rows) console.log(summary(row));
		const draft: Draft = {
			rig: 'dataset-baseline',
			date: utcDate(),
			layer: 'L1',
			question:
				'exact response bytes, route load runs and sync bytes of the v0.3 artifact for a held collection of 50, 500 and 5000 rows, after one row, ten rows, one percent of rows, one delete or one add, as a list of rows or as records; and whether the query proof verifies on the server and on the client after materialize',
			instrument:
				'spool.respond on an in-process createSpool with a memory store, no browser; node:zlib gzip and brotli of each response body; load runs counted inside the route',
			machine: localMachine(args.machine),
			software: {
				runtime: process.versions.bun
					? `bun ${process.versions.bun}`
					: `node ${process.version}`,
				zlib: 'node:zlib, default levels'
			},
			method: {
				route: 'template strategy, query { list: "rows" }, depends ["dataset"], loads counted',
				shapes: {
					list: 'the rows inline in the data; the proof is over the rows',
					records:
						'each row registered with ctx.record; the list holds refs; the proof is over the refs'
				},
				changes: {
					'change-1, change-10, change-1pct':
						'bump dataset, and the row tag of each changed row in the records shape; change-1pct is max(2, ceil(N / 100)) rows',
					'delete-1, add-1': 'bump dataset only'
				},
				refetch:
					'each scenario runs on a fresh spool: seed, change, then one refetch with have and one without, both in the same state; then /.spool/sync from the seed vector',
				have: `the seed record ids and versions, the first ${MAX_HAVE} when there are more; a full have above ${MAX_HAVE} is sent once as fullHave`,
				gates: {
					'as shipped': 'default provision priors',
					'gate open':
						'route provision { reuse: 1, futureViews: 1000 }, so benefit() is positive at every size here'
				},
				proof: 'gate open arm: verifyProof on the built data, Graph.put and materialize from src/sw/graph, then verifyProof and shapeQuery on the materialized data',
				dataProbe:
					'a data route with default priors, one row, to check the gate on that strategy',
				titles: '40 to 80 ASCII characters from a seeded generator',
				bytes: 'raw response body; a 204 is a declined artifact and counts 0 bytes',
				origin: 'in process'
			},
			exclusions: [
				'none; a row with status 204 is a declined artifact with 0 bytes, kept as measured'
			],
			rows
		};
		console.log(writeMeasurement(args.out, draft, { overwrite: args.force }));
	}
}
