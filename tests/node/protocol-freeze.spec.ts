import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as angularModule from '../../src/angular/index';
import * as clientModule from '../../src/client/index';
import * as indexModule from '../../src/index';
import * as mediaModule from '../../src/media/index';
import type { BuildContext } from '../../src/next/index';
import * as nextModule from '../../src/next/index';
import * as nodeModule from '../../src/node/listener';
import * as nuxtModule from '../../src/nuxt/index';
import * as protocol from '../../src/protocol/index';
import {
	defineDataset,
	defineWrite,
	ifMatch,
	type FamilyRoute,
	type SetProof
} from '../../src/protocol/index';
import * as proxyModule from '../../src/proxy/index';
import type { PrerenderPaths } from '../../src/react-router/index';
import * as reactRouterModule from '../../src/react-router/index';
import * as reportModule from '../../src/report/index';
import { MAX_BEACON_BODY } from '../../src/server/beacon';
import * as serverModule from '../../src/server/index';
import {
	createSpool,
	defineRoute,
	type BuildBundleOptions,
	type BuiltBundle,
	type Registration,
	type Spool
} from '../../src/server/index';
import { MAX_CATALOGUE_BUILD, MAX_PIGGYBACK } from '../../src/server/spool';
import * as storesModule from '../../src/stores/index';
import { memoryStore } from '../../src/stores/index';
import {
	CATALOGUE_REASK_MS,
	FLUSH_CHUNK,
	MAX_CATALOGUE_ASKED,
	MAX_HOLD_MS,
	VIEW_BATCH,
	VIEW_HOLD_MS
} from '../../src/sw/analytics';
import * as swModule from '../../src/sw/index';
import { MAX_STATIC_BYTES } from '../../src/sw/static';
import * as trimModule from '../../src/trim/index';
import * as viteModule from '../../src/vite/index';
import * as vueModule from '../../src/vue/index';

// #region helpers: a fixture site and the shape of each body

const root = join(import.meta.dirname, '../..');
const ORIGIN = 'https://site.test';
const ID = (n: number) => `write-id-${String(n).padStart(16, '0')}`;

/** each key of a body with its JSON type; arrays and null are named, not `object` */
function typed(value: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => {
				const v = value[key];
				return [key, v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v];
			})
	);
}

async function json(response: Response | undefined): Promise<Record<string, unknown>> {
	return (await response?.json()) as Record<string, unknown>;
}

type Row = { key: string; title: string };
type State = {
	rows: Map<string, Row>;
	log: Array<{ cursor: number; key: string }>;
	cursor: number;
	floor: number;
};

/** rows `k1`..`kN` at cursors 1..N; the change log is what `changes` answers from */
function state(count: number): State {
	const rows = new Map<string, Row>();
	const log: State['log'] = [];
	for (let i = 1; i <= count; i++) {
		const key = `k${String(i).padStart(3, '0')}`;
		rows.set(key, { key, title: `row ${i}` });
		log.push({ cursor: i, key });
	}
	return { rows, log, cursor: count, floor: 0 };
}

function touch(s: State, key: string, title: string): void {
	s.cursor += 1;
	s.rows.set(key, { key, title });
	s.log.push({ cursor: s.cursor, key });
}

function drop(s: State, key: string): void {
	s.cursor += 1;
	s.rows.delete(key);
	s.log.push({ cursor: s.cursor, key });
}

function dataset(
	name: string,
	s: State,
	options: { provision?: 'auto'; headProof?: unknown } = {}
) {
	return defineDataset<Row>(name, {
		scope: 'public',
		schema: 'v1',
		maxRows: 1000,
		maxBytes: 1_000_000,
		provision: options.provision,
		key: (row) => row.key,
		seed: () => [...s.rows.values()],
		read: (ids) => ids.flatMap((id) => (s.rows.has(id) ? [s.rows.get(id) as Row] : [])),
		changes: (since) => {
			const later = s.log.filter((entry) => entry.cursor > since);
			const keys = [...new Set(later.map((entry) => entry.key))];
			return {
				cursor: s.cursor,
				puts: keys.filter((key) => s.rows.has(key)),
				deletes: later
					.filter((entry) => !s.rows.has(entry.key))
					.map((entry) => ({ key: entry.key, cursor: entry.cursor }))
			};
		},
		horizon: () => s.floor,
		head: () => ({
			cursor: s.cursor,
			...(options.headProof ? { proof: options.headProof as SetProof } : {})
		})
	});
}

type Put = {
	as?: string | null;
	name?: string;
	key?: string;
	version?: string | null;
	id?: string | null;
	body?: string;
	method?: string;
};

function put(spool: Spool, over: Put = {}): Promise<Response | undefined> {
	const as = over.as === undefined ? 'ada' : over.as;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (as) headers['x-user'] = as;
	if (over.version !== null) headers['if-match'] = ifMatch(over.version ?? '0');
	if (over.id !== null) headers['spool-write-id'] = over.id ?? ID(1);
	const key = over.key ?? `profile:${as}`;
	const query = `name=${over.name ?? 'profile'}&key=${encodeURIComponent(key)}`;
	return spool.respond(
		new Request(`${ORIGIN}/.spool/write?${query}`, {
			method: over.method ?? 'PUT',
			headers,
			body: over.body ?? JSON.stringify({ value: 'hello' })
		})
	);
}

/** one site with every endpoint: public and principal routes, three datasets and one write class */
function makeSpool(over: { writes?: boolean } = {}) {
	const db = new Map<string, { version: number; value: unknown }>();
	const profile = defineWrite({
		name: 'profile',
		scope: 'principal',
		path: '/profile',
		key: (ctx) => `profile:${ctx.identity.principal}`,
		read: (_ctx, key) => {
			const row = db.get(key);
			return { version: String(row?.version ?? 0), value: row?.value };
		},
		apply: (_ctx, key, value, expected) => {
			const row = db.get(key) ?? { version: 0, value: undefined };
			if (String(row.version) !== expected) {
				return { conflict: { version: String(row.version), value: row.value } };
			}
			db.set(key, { version: row.version + 1, value });
			return { version: String(row.version + 1) };
		},
		maxBytes: 120,
		maxPending: 2
	});
	const lists = {
		list: state(5),
		big: state(100),
		ordered: state(5)
	};
	const spool = createSpool({
		routes: [
			defineRoute('/n/:id', {
				strategy: 'template',
				template: { source: '<html><head></head><body>node {{id}}</body></html>' },
				depends: (ctx) => [`node:${ctx.params['id']}`],
				load: (ctx) => ({ id: ctx.params['id'] }),
				catalogue: () => [{ path: '/n/2', p: 1 }]
			}),
			defineRoute('/t/:id', {
				strategy: 'template',
				template: { source: '<html><head></head><body>course {{title}}</body></html>' },
				depends: (ctx) => [`page:${ctx.params['id']}`],
				load: (ctx) => ({
					title: ctx.record(`course:${ctx.params['id']}`, { title: 'Intro' })
				})
			}),
			defineRoute('/profile', {
				strategy: 'template',
				scope: 'principal',
				retention: 'persistent',
				template: { source: '<html><head></head><body>profile</body></html>' },
				depends: (ctx) => [`profile:${ctx.identity?.principal}`],
				load: (ctx) => ({ owner: ctx.identity?.principal })
			}),
			defineRoute('/tiny', {
				strategy: 'template',
				template: { source: '<html><head></head><body>tiny</body></html>' },
				provision: { maxBytes: 1 },
				load: () => ({ v: 'x'.repeat(50) })
			})
		],
		store: memoryStore(),
		identity: {
			secret: 's',
			resolve: (request) => {
				const as = request.headers.get('x-user');
				return as ? { principal: as } : null;
			}
		},
		datasets: [
			dataset('list', lists.list),
			dataset('big', lists.big, { provision: 'auto' }),
			dataset('ordered', lists.ordered, {
				headProof: { kind: 'ordered', count: 5, digest: '0'.repeat(64) }
			})
		],
		writes: { enabled: over.writes ?? true, classes: [profile] }
	});
	return { spool, lists };
}

// #endregion

describe('the wire names and the version', () => {
	it('pins the protocol version and every header name', () => {
		expect(protocol.PROTOCOL_VERSION).toBe(1);
		expect(protocol.HEADERS).toEqual({
			protocol: 'spool-protocol',
			artifact: 'spool-artifact',
			invalidate: 'spool-invalidate',
			clear: 'spool-clear',
			vector: 'spool-vector',
			partition: 'spool-partition',
			vectorSeen: 'spool-vector-seen',
			provision: 'spool-provision',
			provisionReason: 'spool-provision-reason',
			delta: 'spool-delta',
			have: 'spool-have'
		});
		expect(protocol.WRITE_HEADERS).toEqual({
			id: 'spool-write-id',
			digest: 'spool-write-digest'
		});
	});

	it('pins every path', () => {
		expect(protocol.PATHS).toEqual({
			sync: '/.spool/sync',
			artifact: '/.spool/artifact',
			dataset: '/.spool/dataset',
			beacon: '/.spool/beacon',
			write: '/.spool/write',
			worker: '/spool-sw.js'
		});
	});

	it('pins the live path beside PATHS and the names of its events', () => {
		expect(protocol.LIVE_PATH).toBe('/.spool/live');
		expect(protocol.LIVE_EVENTS).toEqual(['hello', 'lease', 'delta', 'revoked']);
		expect(Object.keys(protocol.PATHS)).toEqual([
			'sync',
			'artifact',
			'dataset',
			'beacon',
			'write',
			'worker'
		]);
	});

	it('pins the bundle prefix', () => {
		expect(protocol.BUNDLE_PREFIX).toBe('/.spool/bundle/');
		expect(protocol.BUNDLE_DELTA_PREFIX).toBe('/.spool/bundle/delta/');
	});

	it('pins the navigation script path under the version prefix', () => {
		expect(protocol.navigatePath('1.2.3')).toBe('/.spool/1.2.3/navigate.js');
	});

	it('pins the boot script path under the version prefix, by pack version', () => {
		expect(protocol.bootPath('1.2.3', 42)).toBe('/.spool/1.2.3/boot/42.js');
	});

	it('pins the ring element id', () => {
		expect(protocol.RING_ELEMENT_ID).toBe('spool-ring');
	});

	it('pins the delta element id and the held-version cookie name', () => {
		expect(protocol.DELTA_ELEMENT_ID).toBe('spool-delta');
		expect(protocol.COOKIES).toEqual({ held: 'spool-held' });
	});

	it('pins the writes element id', () => {
		expect(protocol.WRITES_ELEMENT_ID).toBe('spool-writes');
	});
});

describe('the envelope as literal header strings', () => {
	it('decodes a principal artifact with deps and a partition', () => {
		const headers = new Headers({
			'spool-protocol': '1',
			'spool-artifact': 'id=%2Fprofile; scope=principal; deps=profile%3Aada,menu; v=7',
			'spool-partition': 'x9_Q-Bv1'
		});
		expect(protocol.decodeEnvelope(headers)).toEqual({
			protocol: 1,
			artifact: {
				id: '/profile',
				scope: 'principal',
				deps: ['profile:ada', 'menu'],
				version: 7
			},
			partition: 'x9_Q-Bv1'
		});
	});

	it('decodes a public artifact with a hash and no deps', () => {
		const headers = new Headers({
			'spool-artifact':
				'id=%2Fa; scope=public; v=3; h=0123456789abcdefghijklmnopqrstuvwxyzABCDEF-'
		});
		expect(protocol.decodeEnvelope(headers).artifact).toEqual({
			id: '/a',
			scope: 'public',
			deps: [],
			version: 3,
			hash: '0123456789abcdefghijklmnopqrstuvwxyzABCDEF-'
		});
	});

	it('decodes invalidation, clear and cursor headers', () => {
		const headers = new Headers({
			'spool-invalidate': 'node%3A1=4, menu=2',
			'spool-clear': 'part%2F1, *',
			'spool-vector': '9',
			'spool-vector-seen': '8'
		});
		expect(protocol.decodeEnvelope(headers)).toEqual({
			invalidate: { 'node:1': 4, menu: 2 },
			clear: ['part/1', '*'],
			vector: 9,
			seen: 8
		});
	});

	it('ignores unknown fields and unknown headers', () => {
		const headers = new Headers({
			'spool-artifact': 'id=%2Fa; scope=public; v=1; future=yes',
			'spool-future': 'x',
			'x-spool-note': 'y'
		});
		expect(protocol.decodeEnvelope(headers)).toEqual({
			artifact: { id: '/a', scope: 'public', deps: [], version: 1 }
		});
	});

	it.each([
		['spool-vector', '-3'],
		['spool-invalidate', 'menu=1.5'],
		['spool-clear', '%ZZ'],
		['spool-artifact', 'id=%2Fa; scope=principal; v=2; deps=%ZZ']
	])('throws bad-header for %s: %s', (name, value) => {
		try {
			protocol.decodeEnvelope(new Headers({ [name]: value }));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(protocol.ProtocolError);
			expect((error as protocol.ProtocolError).code).toBe('bad-header');
		}
	});

	it('encodes a principal artifact with its partition and clear as these literal headers', () => {
		expect(
			protocol.encodeEnvelope({
				artifact: { id: '/profile', scope: 'principal', deps: ['profile:ada'], version: 7 },
				partition: 'x9_Q-Bv1',
				clear: ['*']
			})
		).toEqual({
			'spool-protocol': '1',
			'spool-artifact': 'id=%2Fprofile; scope=principal; deps=profile%3Aada; v=7',
			'spool-clear': '*',
			'spool-partition': 'x9_Q-Bv1'
		});
	});
});

describe('the response bodies, key by key', () => {
	it('answers /.spool/sync with from as these keys and types', async () => {
		const { spool } = makeSpool();
		await spool.invalidate(['node:1', 'menu']);
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/sync?from=0`));
		expect(response?.status).toBe(200);
		expect(response?.headers.get('spool-protocol')).toBe('1');
		expect(response?.headers.get('spool-vector')).toBe('1');
		const body = await json(response);
		expect(typed(body)).toEqual({
			protocol: 'number',
			cursor: 'number',
			changed: 'object',
			dropped: 'array',
			reset: 'boolean'
		});
		expect(body).toEqual({
			protocol: 1,
			cursor: 1,
			changed: { 'node:1': 1, menu: 1 },
			dropped: [],
			reset: false
		});
	});

	it('answers /.spool/sync with need as the same keys plus partial', async () => {
		const { spool } = makeSpool();
		await spool.invalidate(['node:1', 'menu']);
		const body = await json(
			await spool.respond(
				new Request(`${ORIGIN}/.spool/sync?need=${encodeURIComponent('node:1@0,menu@1')}`)
			)
		);
		expect(typed(body)).toEqual({
			protocol: 'number',
			cursor: 'number',
			changed: 'object',
			dropped: 'array',
			reset: 'boolean',
			partial: 'boolean'
		});
	});

	it('refuses a sync cursor that is not an integer with a 400 error body', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/sync?from=x`));
		expect(response?.status).toBe(400);
		expect(typed(await json(response))).toEqual({ error: 'string' });
	});

	it('names the partition on sync only for a request that resolves to someone', async () => {
		const { spool } = makeSpool();
		const signed = await spool.respond(
			new Request(`${ORIGIN}/.spool/sync?from=0`, { headers: { 'x-user': 'ada' } })
		);
		const anon = await spool.respond(new Request(`${ORIGIN}/.spool/sync?from=0`));
		expect(signed?.headers.get('spool-partition')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(anon?.headers.get('spool-partition')).toBeNull();
	});

	it('answers a public artifact with these keys and types', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/artifact?path=/n/1`));
		expect(response?.status).toBe(200);
		expect(response?.headers.get('spool-protocol')).toBe('1');
		const body = await json(response);
		expect(typed(body)).toEqual({
			protocol: 'number',
			id: 'string',
			scope: 'string',
			deps: 'array',
			vector: 'number',
			strategy: 'string',
			body: 'object'
		});
	});

	it('answers an artifact with records with a records list, and with have an empty one', async () => {
		const { spool } = makeSpool();
		const full = await json(
			await spool.respond(new Request(`${ORIGIN}/.spool/artifact?path=/t/1`))
		);
		expect(typed(full)).toEqual({
			protocol: 'number',
			id: 'string',
			scope: 'string',
			deps: 'array',
			vector: 'number',
			records: 'array',
			strategy: 'string',
			body: 'object'
		});
		const held = encodeURIComponent('course%3A1@0');
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/artifact?path=/t/1&have=${held}`)
		);
		const trimmed = await json(response);
		expect(typed(trimmed)).toEqual(typed(full));
		expect(trimmed['records']).toEqual([]);
	});

	it('answers a principal artifact private with its partition', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/artifact?path=/profile`, { headers: { 'x-user': 'ada' } })
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get('cache-control')).toBe('private, no-store');
		expect(response?.headers.get('spool-partition')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(typed(await json(response))).toEqual({
			protocol: 'number',
			id: 'string',
			scope: 'string',
			deps: 'array',
			vector: 'number',
			strategy: 'string',
			body: 'object'
		});
	});

	it('answers 204 with the declined headers when the budget refuses an artifact', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/artifact?path=/tiny`));
		expect(response?.status).toBe(204);
		expect(response?.headers.get('spool-provision')).toBe('declined');
		expect(response?.headers.get('spool-provision-reason')).toBe('budget');
		expect(await response?.text()).toBe('');
	});

	it.each([
		['/.spool/artifact?path=n/1', 400, 'path must start with "/"'],
		['/.spool/artifact?path=/nothing', 404, 'no route'],
		['/.spool/artifact?path=/profile', 401, 'sign in']
	])('answers %s with %i and an error body', async (path, status, message) => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}${path}`));
		expect(response?.status).toBe(status);
		expect(await json(response)).toEqual({ error: message });
	});

	it('answers a beacon with events only as 204 and no body', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: JSON.stringify({
					protocol: 1,
					events: [
						{ path: '/cdn-cgi/rum', body: '{}', contentType: 'application/json', at: 5 }
					]
				})
			})
		);
		expect(response?.status).toBe(204);
		expect(await response?.text()).toBe('');
	});

	it('answers a beacon that asks for artifacts with protocol and artifacts', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: JSON.stringify({ protocol: 1, events: [], want: ['/n/1'] })
			})
		);
		expect(response?.status).toBe(200);
		expect(typed(await json(response))).toEqual({ protocol: 'number', artifacts: 'array' });
	});

	it('answers a beacon that asks for a catalogue with protocol and catalogue', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: JSON.stringify({ protocol: 1, events: [], catalogue: { path: '/n/1' } })
			})
		);
		expect(response?.status).toBe(200);
		expect(typed(await json(response))).toEqual({ protocol: 'number', catalogue: 'array' });
	});

	it('answers a beacon with want and catalogue with all three keys', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: JSON.stringify({
					protocol: 1,
					events: [],
					want: ['/n/1'],
					catalogue: { path: '/n/1' }
				})
			})
		);
		expect(typed(await json(response))).toEqual({
			protocol: 'number',
			artifacts: 'array',
			catalogue: 'array'
		});
	});

	it('refuses a beacon by method, size, JSON and protocol', async () => {
		const { spool } = makeSpool();
		const get = await spool.respond(new Request(`${ORIGIN}/.spool/beacon`));
		expect(get?.status).toBe(405);
		expect(get?.headers.get('allow')).toBe('POST');
		const big = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: 'x'.repeat(MAX_BEACON_BODY + 1)
			})
		);
		expect(big?.status).toBe(413);
		const notJson = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, { method: 'POST', body: 'nope' })
		);
		expect(notJson?.status).toBe(400);
		expect(typed(await json(notJson))).toEqual({ error: 'string' });
		const wrongProtocol = await spool.respond(
			new Request(`${ORIGIN}/.spool/beacon`, {
				method: 'POST',
				body: JSON.stringify({ protocol: 2, events: [] })
			})
		);
		expect(wrongProtocol?.status).toBe(400);
		expect(typed(await json(wrongProtocol))).toEqual({ error: 'string' });
	});

	it('answers a seed as one page with a proof', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=list`));
		expect(response?.status).toBe(200);
		expect(response?.headers.get('spool-protocol')).toBe('1');
		const body = await json(response);
		expect(typed(body)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			proof: 'object'
		});
		expect(body['proof']).toMatchObject({ kind: 'set', count: 5 });
	});

	it('pages a seed with next, then after with next, then after with a proof', async () => {
		const { spool } = makeSpool();
		const first = await json(
			await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=list&limit=2`))
		);
		expect(typed(first)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			next: 'string'
		});
		expect(first['next']).toBe('k002');
		const second = await json(
			await spool.respond(
				new Request(`${ORIGIN}/.spool/dataset?name=list&limit=2&after=k002`)
			)
		);
		expect(typed(second)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			after: 'string',
			next: 'string'
		});
		const last = await json(
			await spool.respond(
				new Request(`${ORIGIN}/.spool/dataset?name=list&limit=2&after=k004`)
			)
		);
		expect(typed(last)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			after: 'string',
			proof: 'object'
		});
		expect(last['proof']).toMatchObject({ kind: 'set', count: 5 });
	});

	it('answers a patch with puts, deletes and a proof', async () => {
		const { spool, lists } = makeSpool();
		touch(lists.list, 'k002', 'changed');
		drop(lists.list, 'k005');
		const body = await json(
			await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=list&since=5&schema=v1`))
		);
		expect(typed(body)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			proof: 'object'
		});
		expect(body).toMatchObject({
			cursor: 7,
			reset: false,
			puts: [{ key: 'k002', row: { key: 'k002', title: 'changed' } }],
			deletes: [{ key: 'k005', cursor: 7 }]
		});
	});

	it('answers a patch below the horizon with a reset seed', async () => {
		const { spool, lists } = makeSpool();
		touch(lists.list, 'k002', 'changed');
		lists.list.floor = 6;
		const body = await json(
			await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=list&since=5&schema=v1`))
		);
		expect(typed(body)).toEqual({
			protocol: 'number',
			name: 'string',
			schema: 'string',
			cursor: 'number',
			reset: 'boolean',
			puts: 'array',
			deletes: 'array',
			proof: 'object'
		});
		expect(body['reset']).toBe(true);
	});

	it('refuses a seed with 409 and the control that bound', async () => {
		const { spool, lists } = makeSpool();
		touch(lists.big, 'k001', 'changed once');
		touch(lists.big, 'k002', 'changed twice');
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=big`));
		expect(response?.status).toBe(409);
		expect(response?.headers.get('spool-provision')).toBe('declined');
		expect(response?.headers.get('spool-provision-reason')).toBe('native');
		expect(await json(response)).toEqual({ error: 'declined', controls: 'native' });
	});

	it('refuses a backend proof that is not a set proof with 400', async () => {
		const { spool } = makeSpool();
		const response = await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=ordered`));
		expect(response?.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'ordered: a proof must be a set proof' });
	});

	it('refuses an unknown dataset and a request with no name', async () => {
		const { spool } = makeSpool();
		const unknown = await spool.respond(new Request(`${ORIGIN}/.spool/dataset?name=nope`));
		expect(unknown?.status).toBe(404);
		expect(await json(unknown)).toEqual({ error: 'no dataset' });
		const unnamed = await spool.respond(new Request(`${ORIGIN}/.spool/dataset`));
		expect(unnamed?.status).toBe(400);
		expect(await json(unnamed)).toEqual({ error: 'name is required' });
	});

	it('answers a write that applies with its new version', async () => {
		const { spool } = makeSpool();
		const response = await put(spool, { version: '0', id: ID(1) });
		expect(response?.status).toBe(200);
		expect(typed(await json(response))).toEqual({ version: 'string' });
	});

	it('answers a repeat of the last applied id with the current version', async () => {
		const { spool } = makeSpool();
		await put(spool, { version: '0', id: ID(1) });
		const again = await put(spool, { version: '0', id: ID(1) });
		expect(again?.status).toBe(200);
		expect(await json(again)).toEqual({ version: '1' });
	});

	it('answers a stale write with 412 and the server side of the conflict', async () => {
		const { spool } = makeSpool();
		await put(spool, { version: '0', id: ID(1) });
		const response = await put(spool, { version: '0', id: ID(2), body: '{"value":"bye"}' });
		expect(response?.status).toBe(412);
		const body = await json(response);
		expect(typed(body)).toEqual({ code: 'string', conflict: 'object' });
		expect(typed(body['conflict'] as Record<string, unknown>)).toEqual({
			version: 'string',
			value: 'string'
		});
		expect(body).toEqual({ code: 'conflict', conflict: { version: '1', value: 'hello' } });
	});

	it.each([
		['writes-off', 403, { writes: false }, {}],
		['bad-method', 405, {}, { method: 'POST' }],
		['unknown-write', 404, {}, { name: 'nope' }],
		['sign-in', 401, {}, { as: null }],
		['bad-key', 400, {}, { key: '' }],
		['bad-id', 400, {}, { id: null }],
		['missing-version', 428, {}, { version: null }],
		['bad-version', 400, {}, { version: 'x y' }],
		['forbidden', 403, {}, { key: 'profile:bob' }],
		['too-large', 413, {}, { body: JSON.stringify({ value: 'x'.repeat(200) }) }],
		['bad-body', 400, {}, { body: 'nope' }]
	] as Array<[string, number, { writes?: boolean }, Put]>)(
		'refuses with %s as %i and the code and error keys',
		async (code, status, makeOver, over) => {
			const { spool } = makeSpool(makeOver);
			const response = await put(spool, { version: '0', id: ID(1), ...over });
			expect(response?.status).toBe(status);
			const body = await json(response);
			expect(typed(body)).toEqual({ code: 'string', error: 'string' });
			expect(body['code']).toBe(code);
		}
	);

	it('refuses a reused write id with another body with 422', async () => {
		const { spool } = makeSpool();
		await put(spool, { version: '0', id: ID(1) });
		const response = await put(spool, {
			version: '1',
			id: ID(1),
			body: JSON.stringify({ value: 'other' })
		});
		expect(response?.status).toBe(422);
		expect(await json(response)).toEqual({
			code: 'id-reused',
			error: 'that id was used for another body'
		});
	});
});

describe('the static manifest, spool.json', () => {
	const full = {
		schema: 1,
		routes: [
			{
				pattern: '/assets/:name',
				strategy: 'static',
				version: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
				freshness: { maxStale: 600, mode: 'soft' },
				offline: 'refuse',
				sync: 'deferred'
			},
			{ pattern: '/about', strategy: 'static', version: '"v7"' }
		]
	};
	const minimal = {
		schema: 1,
		routes: [{ pattern: '/about', strategy: 'static', version: '"v7"' }]
	};

	/** the code and message a refused manifest carries; undefined when it is accepted */
	function refusal(value: unknown): { code: string; message: string } | undefined {
		try {
			protocol.parseManifest(value);
			return undefined;
		} catch (error) {
			return {
				code: (error as protocol.ProtocolError).code,
				message: (error as Error).message
			};
		}
	}

	it('pins the schema number', () => {
		expect(protocol.MANIFEST_SCHEMA).toBe(1);
	});

	it('keeps exactly these keys and types on a manifest and on each route', () => {
		const parsed = protocol.parseManifest(full);
		expect(parsed).toEqual(full);
		expect(typed(parsed as unknown as Record<string, unknown>)).toEqual({
			routes: 'array',
			schema: 'number'
		});
		const [first, second] = parsed.routes as unknown as Array<Record<string, unknown>>;
		expect(typed(first as Record<string, unknown>)).toEqual({
			freshness: 'object',
			offline: 'string',
			pattern: 'string',
			strategy: 'string',
			sync: 'string',
			version: 'string'
		});
		expect(typed(first?.['freshness'] as Record<string, unknown>)).toEqual({
			maxStale: 'number',
			mode: 'string'
		});
		expect(typed(second as Record<string, unknown>)).toEqual({
			pattern: 'string',
			strategy: 'string',
			version: 'string'
		});
	});

	it('keeps only the freshness fields a route gives', () => {
		const partial = {
			schema: 1,
			routes: [
				{ pattern: '/a', strategy: 'static', version: '"v1"', freshness: { mode: 'hard' } }
			]
		};
		expect(protocol.parseManifest(partial).routes[0]?.freshness).toEqual({ mode: 'hard' });
	});

	it('takes pattern, strategy and version as the required route fields', () => {
		expect(protocol.parseManifest(minimal)).toEqual(minimal);
		expect(refusal({ schema: 1, routes: [{ strategy: 'static', version: '"v7"' }] })).toEqual({
			code: 'bad-manifest',
			message: 'routes[0].pattern must be a string'
		});
	});

	it.each([
		[
			'no strategy',
			{ schema: 1, routes: [{ pattern: '/about', version: '"v7"' }] },
			'/about: strategy must be "static"'
		],
		[
			'a template strategy',
			{ schema: 1, routes: [{ pattern: '/about', strategy: 'template', version: '"v7"' }] },
			'/about: strategy must be "static"'
		],
		[
			'no version',
			{ schema: 1, routes: [{ pattern: '/about', strategy: 'static' }] },
			'/about: version must be a string of 1 to 256 characters'
		],
		[
			'an empty version',
			{ schema: 1, routes: [{ pattern: '/about', strategy: 'static', version: '' }] },
			'/about: version must be a string of 1 to 256 characters'
		]
	])('refuses a route with %s as bad-manifest', (_name, value, message) => {
		expect(refusal(value)).toEqual({ code: 'bad-manifest', message });
	});

	it('ignores an unknown field on the manifest or on a route', () => {
		const extra = {
			schema: 1,
			generated: '2026-11-15',
			routes: [
				{
					pattern: '/about',
					strategy: 'static',
					version: '"v7"',
					scope: 'principal',
					comment: 'x'
				}
			]
		};
		expect(protocol.parseManifest(extra)).toEqual(minimal);
	});

	it.each([
		['the number 2', { schema: 2, routes: [] }],
		['the string "1"', { schema: '1', routes: [] }]
	])('refuses a wrong schema, %s, as bad-manifest', (_name, value) => {
		expect(refusal(value)).toEqual({
			code: 'bad-manifest',
			message: 'unsupported manifest schema'
		});
	});

	it('refuses a version over 256 characters and accepts one of exactly 256', () => {
		const withVersion = (version: string) => ({
			schema: 1,
			routes: [{ pattern: '/a', strategy: 'static', version }]
		});
		expect(refusal(withVersion('v'.repeat(257)))).toEqual({
			code: 'bad-manifest',
			message: '/a: version must be a string of 1 to 256 characters'
		});
		expect(refusal(withVersion('v'.repeat(256)))).toBeUndefined();
	});

	it('refuses a pattern declared twice and a routes value that is not a list', () => {
		expect(refusal({ schema: 1, routes: [minimal.routes[0], minimal.routes[0]] })).toEqual({
			code: 'bad-manifest',
			message: '/about: declared twice'
		});
		expect(refusal({ schema: 1, routes: {} })).toEqual({
			code: 'bad-manifest',
			message: 'routes must be a list'
		});
	});
});

describe('the limits, by name, value and file', () => {
	const exported: Record<string, unknown> = {
		...protocol,
		MAX_BEACON_BODY,
		MAX_PIGGYBACK,
		MAX_CATALOGUE_BUILD,
		MAX_STATIC_BYTES,
		MAX_HOLD_MS,
		VIEW_BATCH,
		VIEW_HOLD_MS,
		FLUSH_CHUNK,
		CATALOGUE_REASK_MS,
		MAX_CATALOGUE_ASKED
	};

	const LIMITS: Array<[string, number | string, string]> = [
		['MAX_NEED', 64, 'src/protocol/sync.ts'],
		['MAX_HAVE', 256, 'src/protocol/sync.ts'],
		['MAX_BEACON_BYTES', 65_536, 'src/protocol/beacon.ts'],
		['MAX_BEACON_EVENTS', 500, 'src/protocol/beacon.ts'],
		['MAX_WANT', 8, 'src/protocol/beacon.ts'],
		['MAX_CATALOGUE_PATH', 2048, 'src/protocol/beacon.ts'],
		['MAX_VERSION_CHARS', 256, 'src/protocol/manifest.ts'],
		['MAX_ROUTE_CHARS', 256, 'src/protocol/view.ts'],
		['MAX_LOAD_ORIGINS', 32, 'src/protocol/view.ts'],
		['MAX_WRITE_KEY', 256, 'src/protocol/write.ts'],
		['MAX_WRITE_BYTES', 1_048_576, 'src/protocol/write.ts'],
		['MAX_WRITE_PENDING', 1000, 'src/protocol/write.ts'],
		['MAX_BUNDLE_FRAME_BYTES', 8_388_608, 'src/protocol/bundle.ts'],
		['PROTOCOL_VERSION', 1, 'src/protocol/artifact.ts'],
		['MANIFEST_SCHEMA', 1, 'src/protocol/manifest.ts'],
		['SPOOL_PREFIX', '/.spool/', 'src/protocol/config.ts'],
		['BUNDLE_PREFIX', '/.spool/bundle/', 'src/protocol/config.ts'],
		['BUNDLE_DELTA_PREFIX', '/.spool/bundle/delta/', 'src/protocol/config.ts'],
		['OWN_PREFIX', '/.spool/', 'src/protocol/beacon.ts'],
		['VIEW_PATH', '/.spool/view', 'src/protocol/view.ts'],
		['LOADS_PATH', '/.spool/loads', 'src/protocol/view.ts'],
		['LIVE_PATH', '/.spool/live', 'src/protocol/config.ts'],
		['LIVE_PING', 'ping', 'src/protocol/config.ts'],
		['DROPPED_PATH', '/.spool/dropped', 'src/protocol/beacon.ts'],
		['ARTIFACT_TAG_PREFIX', 'spool:artifact:', 'src/protocol/sync.ts'],
		['CLEAR_ALL', '*', 'src/protocol/envelope.ts'],
		['CLIENT_TAG_ATTR', 'data-spool-client', 'src/protocol/tag.ts'],
		['GATE_ATTR', 'data-spool-gate', 'src/protocol/tag.ts'],
		['GA4_RECOMMENDED_MS', 172_800_000, 'src/protocol/collector.ts'],
		['GA4_HARD_MS', 259_200_000, 'src/protocol/collector.ts'],
		['JOULES_PER_BYTE', 0.0006984, 'src/protocol/provision.ts'],
		['ORIGIN_JOULES', 0.455, 'src/protocol/provision.ts'],
		['DEFAULT_CATALOGUE_BYTES', 32_768, 'src/protocol/provision.ts'],
		['MAX_PIGGYBACK', 32, 'src/server/spool.ts'],
		['MAX_CATALOGUE_BUILD', 32, 'src/server/spool.ts'],
		['MAX_BEACON_BODY', 262_144, 'src/server/beacon.ts'],
		['MAX_STATIC_BYTES', 4_194_304, 'src/sw/static.ts'],
		['MAX_HOLD_MS', 86_400_000, 'src/sw/analytics.ts'],
		['VIEW_BATCH', 20, 'src/sw/analytics.ts'],
		['VIEW_HOLD_MS', 3_600_000, 'src/sw/analytics.ts'],
		['FLUSH_CHUNK', 100, 'src/sw/analytics.ts'],
		['CATALOGUE_REASK_MS', 86_400_000, 'src/sw/analytics.ts'],
		['MAX_CATALOGUE_ASKED', 256, 'src/sw/analytics.ts']
	];

	it.each(LIMITS)('%s is %s and defined in %s', (name, value, file) => {
		expect(exported[name]).toBe(value);
		const source = readFileSync(join(root, file), 'utf8');
		expect(source).toContain(`export const ${name} = `);
	});
});

describe('the public export names of each entry point', () => {
	const EXPORTS: Array<[string, Record<string, unknown>, string[]]> = [
		[
			'.',
			indexModule,
			[
				'ACTIVITY_PAIRS',
				'ARTIFACT_TAG_PREFIX',
				'AZURE_EGRESS',
				'BLOCK_ROWS',
				'BOOTSTRAP_EXTRA_NO_WORKER',
				'BOOTSTRAP_EXTRA_WORKER',
				'BUNDLE_DELTA_PREFIX',
				'BUNDLE_PREFIX',
				'CF_FREE_REQUESTS_PER_DAY',
				'CF_PAID_INCLUDED',
				'CF_PAID_PER_MILLION',
				'CLASS_OF_ENGINE_DEFAULT',
				'CLEAR_ALL',
				'CLIENT_TAG_ATTR',
				'COMPACT_OVERLAY_BYTES',
				'COMPACT_OVERLAY_ROWS',
				'CONTAMINATION_MS_PER_S',
				'COOKIES',
				'CRAWL',
				'DATASET_DEFAULTS',
				'DATASET_NAME',
				'DATASET_PAGE_CAP',
				'DATASET_PAGE_ROWS',
				'DAYS_PER_MONTH',
				'DEFAULT_CATALOGUE_BYTES',
				'DEFAULT_FRESHNESS',
				'DEFAULT_PRIOR',
				'DELTA_ELEMENT_ID',
				'DEMAND',
				'DEMAND_LAYERS',
				'DEMAND_PATHS',
				'DICTIONARY_ARMS',
				'DOCUMENT_BYTES',
				'DROPPED_PATH',
				'DRUPAL_NULL_KEY',
				'ECON_PRICES_READ',
				'EGRID_LB_PER_MWH',
				'ELECTRICITY_PRICE',
				'EMBER_US_G_PER_KWH',
				'EMPTY_DIGEST',
				'ENGINE_CLASSES',
				'ENGINE_CLASS_LABELS',
				'FIRST_VIEW_BYTES',
				'FIRST_VIEW_SHARE',
				'FREE_TIER_VIEWS',
				'FROM_EXTERNAL',
				'GA4_COLLECTOR',
				'GA4_HARD_MS',
				'GA4_RECOMMENDED_MS',
				'GATE_ATTR',
				'GCP_EGRESS',
				'GOAL_HIGH_SHARE',
				'GOAL_SHARES',
				'G_PER_LB',
				'HEADERS',
				'HISTORY',
				'HOSTING_KWH_PER_SITE',
				'HOSTS',
				'IDLE_AGREEMENT',
				'INDEX_MIN_ROWS',
				'INLINE_OPEN',
				'JOULES_PER_BYTE',
				'KNOWN_ORIGINS',
				'LIVE_EVENTS',
				'LIVE_PATH',
				'LIVE_PING',
				'LOADS_PATH',
				'LOOP_CLASSES',
				'LOOP_WINDOW_S',
				'MANIFEST_SCHEMA',
				'MAX_BEACON_BYTES',
				'MAX_BEACON_EVENTS',
				'MAX_BUNDLE_FRAME_BYTES',
				'MAX_CATALOGUE_PATH',
				'MAX_HAVE',
				'MAX_LOAD_ORIGINS',
				'MAX_NEED',
				'MAX_ROUTE_CHARS',
				'MAX_VERSION_CHARS',
				'MAX_WANT',
				'MAX_WRITE_BYTES',
				'MAX_WRITE_KEY',
				'MAX_WRITE_PENDING',
				'MEASUREMENT_SCHEMA',
				'MOBILE_SHARE',
				'MODELLED_VIEW',
				'MeasurementError',
				'NOT_MODIFIED_SOCKET_BYTES',
				'NavModel',
				'ORIGIN_J',
				'ORIGIN_JOULES',
				'OVERHEAD_ROUTES',
				'OWN_PREFIX',
				'PANTHEON_OVERAGE',
				'PATHS',
				'PRICES_READ',
				'PROOF_MISMATCH',
				'PROTOCOL_VERSION',
				'PUE',
				'ProtocolError',
				'RADIO_J',
				'READ_SHARE',
				'REASON_TIER',
				'REPEAT_VIEW_BYTES',
				'RESOURCE_APPLY',
				'RESOURCE_METHODS',
				'RETROFIT_DOCUMENTS',
				'RETROFIT_IN_PAGE',
				'RETROFIT_ORIGIN',
				'RETROFIT_VIEWS',
				'RETROFIT_WORKER',
				'RIGS',
				'RING_ELEMENT_ID',
				'SERVER_FLOOR',
				'SERVER_WATTS',
				'SESSION',
				'SPOOL_PREFIX',
				'STORAGE',
				'STUB_304_BYTES',
				'STUB_FULL_ST_BYTES',
				'SWD_V4',
				'TIERS',
				'TableIndex',
				'VIEW_PATH',
				'VersionVector',
				'WATER_DIRECT',
				'WATER_INDIRECT',
				'WATER_INDIRECT_LBNL',
				'WEBKIT_STUB_RATE',
				'WORKLOADS',
				'WRITES_ELEMENT_ID',
				'WRITE_HEADERS',
				'WRITE_NAME',
				'WRITE_STATUS',
				'activityFigures',
				'activityGains',
				'addLevers',
				'aggregatesOf',
				'applyChanges',
				'applyDelta',
				'applyPatch',
				'applyStamp',
				'artifactTag',
				'assemble',
				'attributionalJoules',
				'avoidedShare',
				'bandwidthUsd',
				'baselinePerReadView',
				'benefit',
				'bestAndWorst',
				'bootPath',
				'buildPack',
				'bundleDigest',
				'cacheability',
				'cacheabilityFigures',
				'canonicalJson',
				'capacityMWh',
				'capacityPlan',
				'catalogueFigures',
				'channelRows',
				'checkCollectors',
				'checkPattern',
				'checkPlan',
				'chooseEntries',
				'chunkSplitFigures',
				'churnFigures',
				'classifyOrigin',
				'clientPath',
				'clientTag',
				'collectRefs',
				'compactBundle',
				'compactionDue',
				'compareText',
				'compileTemplate',
				'couplingReport',
				'coverageFigures',
				'crawlLevers',
				'createCollector',
				'dataCentreJoules',
				'datasetBenefit',
				'datasetFigures',
				'datasetProof',
				'decodeEnvelope',
				'decodeEnvelopeOrClear',
				'defineDataset',
				'defineResource',
				'defineRoute',
				'defineWrite',
				'demandBytes',
				'demandCounts',
				'demandDocumentCounts',
				'demandSavings',
				'demandWorkerCounts',
				'deviceCpuFigures',
				'dictionaryArms',
				'digestAdd',
				'digestSub',
				'documentRequests',
				'drupalRenderFigures',
				'egressUsd',
				'egridGPerKwh',
				'electricityPrice',
				'encodeDatasetRequest',
				'encodeEnvelope',
				'encodeHeld',
				'engineOf',
				'entryBreakEven',
				'equivalent',
				'escapeHtml',
				'escapeInline',
				'evaluatePlan',
				'evaluateQuery',
				'expectedNet',
				'factors',
				'factorsByEngine',
				'fillPattern',
				'fillSlots',
				'findLeaks',
				'firstViewDocumentMedian',
				'firstViewFigures',
				'firstViewFit',
				'fleetFor',
				'footprintMwh',
				'freeReadViewsPerDay',
				'freeTierCeiling',
				'freeViewsPair',
				'funnelOf',
				'gPerKwhFromLbPerMwh',
				'gateTag',
				'halves',
				'heldShare',
				'ifMatch',
				'imageSavings',
				'inferenceFigures',
				'injectClientTag',
				'inlineElement',
				'institutionReport',
				'interpretTemplate',
				'intervalsFromWork',
				'isAggregate',
				'isContaminated',
				'isRef',
				'isSetProof',
				'isWriteId',
				'isWriteKey',
				'isWriteVersion',
				'joulesPerView',
				'joulesPerViewWithOrigin',
				'keyField',
				'kwhPerMv',
				'lazyUnscrolled',
				'leastSquares',
				'ledgerJoules',
				'ledgerMWh',
				'leverStats',
				'libraryBytes',
				'libraryStages',
				'linearFit',
				'loaded',
				'loadsFromBeacon',
				'loadsToBeacon',
				'loopClasses',
				'loopFigures',
				'lowerBound',
				'makeDelta',
				'manifestRoutes',
				'matchCollector',
				'matchPattern',
				'matchRoute',
				'measurementPath',
				'measurementProblems',
				'median',
				'mergeDeltas',
				'mismatchesByRoute',
				'monthlyGb',
				'multiplierOf',
				'navigatePath',
				'netBytesShare',
				'newWriteId',
				'nextShare',
				'noWorkerRequestsPerReadView',
				'nodesNeeded',
				'normalise',
				'onWireFigures',
				'overIncluded',
				'paidMonth',
				'paidRequestsUsd',
				'parseArtifact',
				'parseBeaconBatch',
				'parseDatasetRequest',
				'parseDatasetResponse',
				'parseHeld',
				'parseLiveDelta',
				'parseManifest',
				'parseMeasurement',
				'parseMeasurementText',
				'parseProjectionEntry',
				'parseRecordEntry',
				'parseSyncResponse',
				'pathMatches',
				'peakCut',
				'perMillionViewsUsd',
				'phoneRun',
				'placeInline',
				'placeholder',
				'placeholderIds',
				'plainValue',
				'plan',
				'powerSweep',
				'priorFrom',
				'projectionRef',
				'quantile',
				'quartiles',
				'raplRun',
				'readBlock',
				'readBundle',
				'readFrames',
				'readIfMatch',
				'readInline',
				'recordRef',
				'renderAssembly',
				'repaidAfter',
				'repeatBytesBySite',
				'repeatNavFigures',
				'repeatSplitBySite',
				'requestUsd',
				'requestsByClass',
				'requestsPerReadView',
				'requireLayers',
				'resolveRefs',
				'retrofitRatio',
				'rollUpInstitutions',
				'rowHash',
				'rowRef',
				'runtimeRun',
				'saving',
				'serialiseMeasurement',
				'serializeRoute',
				'serializeWrite',
				'serverYearMWh',
				'serversAfter',
				'setProof',
				'shapePlan',
				'shapeQuery',
				'shapeRows',
				'shellHash',
				'shouldAct',
				'siteFigures',
				'slot',
				'slotNames',
				'smoothReuse',
				'splitRequestBytes',
				'splitRowId',
				'spoolBytes',
				'spread',
				'stageMultiplier',
				'stripInline',
				'swdTotal',
				'tabsFigures',
				'thirdPartyCacheBySite',
				'thirdPartyCacheSplit',
				'thirdPartyReport',
				'toSyncResponse',
				'tonnesFromMwh',
				'transitions',
				'trimFigures',
				'trimLevers',
				'usdForMwh',
				'verifyProof',
				'viewFromBeacon',
				'viewToBeacon',
				'viewsChannelMWh',
				'viewsWithLoads',
				'warmFigures',
				'webkitStubPerReadView',
				'weigh',
				'wilson',
				'windowCounts',
				'workerRequests',
				'writeEnvelope',
				'writeFor',
				'zAnnual',
				'zDaily',
				'zPeakWork',
				'zeroNetworkFigures'
			]
		],
		[
			'./protocol',
			protocol,
			[
				'ARTIFACT_TAG_PREFIX',
				'BLOCK_ROWS',
				'BUNDLE_DELTA_PREFIX',
				'BUNDLE_PREFIX',
				'CLEAR_ALL',
				'CLIENT_TAG_ATTR',
				'COMPACT_OVERLAY_BYTES',
				'COMPACT_OVERLAY_ROWS',
				'COOKIES',
				'DATASET_DEFAULTS',
				'DATASET_NAME',
				'DATASET_PAGE_CAP',
				'DATASET_PAGE_ROWS',
				'DEFAULT_CATALOGUE_BYTES',
				'DEFAULT_FRESHNESS',
				'DEFAULT_PRIOR',
				'DELTA_ELEMENT_ID',
				'DROPPED_PATH',
				'EMPTY_DIGEST',
				'FROM_EXTERNAL',
				'GA4_COLLECTOR',
				'GA4_HARD_MS',
				'GA4_RECOMMENDED_MS',
				'GATE_ATTR',
				'HEADERS',
				'INDEX_MIN_ROWS',
				'INLINE_OPEN',
				'JOULES_PER_BYTE',
				'LIVE_EVENTS',
				'LIVE_PATH',
				'LIVE_PING',
				'LOADS_PATH',
				'MANIFEST_SCHEMA',
				'MAX_BEACON_BYTES',
				'MAX_BEACON_EVENTS',
				'MAX_BUNDLE_FRAME_BYTES',
				'MAX_CATALOGUE_PATH',
				'MAX_HAVE',
				'MAX_LOAD_ORIGINS',
				'MAX_NEED',
				'MAX_ROUTE_CHARS',
				'MAX_VERSION_CHARS',
				'MAX_WANT',
				'MAX_WRITE_BYTES',
				'MAX_WRITE_KEY',
				'MAX_WRITE_PENDING',
				'NavModel',
				'ORIGIN_JOULES',
				'OWN_PREFIX',
				'PATHS',
				'PROOF_MISMATCH',
				'PROTOCOL_VERSION',
				'ProtocolError',
				'REASON_TIER',
				'RESOURCE_APPLY',
				'RESOURCE_METHODS',
				'RING_ELEMENT_ID',
				'SPOOL_PREFIX',
				'TableIndex',
				'VIEW_PATH',
				'VersionVector',
				'WRITES_ELEMENT_ID',
				'WRITE_HEADERS',
				'WRITE_NAME',
				'WRITE_STATUS',
				'applyChanges',
				'applyDelta',
				'applyPatch',
				'applyStamp',
				'artifactTag',
				'assemble',
				'benefit',
				'bootPath',
				'buildPack',
				'bundleDigest',
				'canonicalJson',
				'checkCollectors',
				'checkPattern',
				'checkPlan',
				'chooseEntries',
				'clientPath',
				'clientTag',
				'collectRefs',
				'compactBundle',
				'compactionDue',
				'compareText',
				'compileTemplate',
				'couplingReport',
				'createCollector',
				'datasetBenefit',
				'datasetProof',
				'decodeEnvelope',
				'decodeEnvelopeOrClear',
				'defineDataset',
				'defineResource',
				'defineRoute',
				'defineWrite',
				'digestAdd',
				'digestSub',
				'encodeDatasetRequest',
				'encodeEnvelope',
				'encodeHeld',
				'engineOf',
				'entryBreakEven',
				'equivalent',
				'escapeHtml',
				'escapeInline',
				'evaluatePlan',
				'evaluateQuery',
				'expectedNet',
				'fillPattern',
				'fillSlots',
				'funnelOf',
				'gateTag',
				'ifMatch',
				'injectClientTag',
				'inlineElement',
				'interpretTemplate',
				'isRef',
				'isSetProof',
				'isWriteId',
				'isWriteKey',
				'isWriteVersion',
				'keyField',
				'loadsFromBeacon',
				'loadsToBeacon',
				'lowerBound',
				'makeDelta',
				'manifestRoutes',
				'matchCollector',
				'matchPattern',
				'matchRoute',
				'mergeDeltas',
				'navigatePath',
				'newWriteId',
				'normalise',
				'parseArtifact',
				'parseBeaconBatch',
				'parseDatasetRequest',
				'parseDatasetResponse',
				'parseHeld',
				'parseLiveDelta',
				'parseManifest',
				'parseProjectionEntry',
				'parseRecordEntry',
				'parseSyncResponse',
				'placeInline',
				'placeholder',
				'placeholderIds',
				'plainValue',
				'plan',
				'priorFrom',
				'projectionRef',
				'readBlock',
				'readBundle',
				'readFrames',
				'readIfMatch',
				'readInline',
				'recordRef',
				'renderAssembly',
				'resolveRefs',
				'rowHash',
				'rowRef',
				'serializeRoute',
				'serializeWrite',
				'setProof',
				'shapePlan',
				'shapeQuery',
				'shapeRows',
				'shellHash',
				'shouldAct',
				'slot',
				'slotNames',
				'smoothReuse',
				'splitRowId',
				'stripInline',
				'toSyncResponse',
				'verifyProof',
				'viewFromBeacon',
				'viewToBeacon',
				'viewsWithLoads',
				'weigh',
				'writeEnvelope',
				'writeFor'
			]
		],
		[
			'./server',
			serverModule,
			[
				'MAX_BEACON_BLOB',
				'MAX_CATALOGUE_BUILD',
				'MAX_PIGGYBACK',
				'MP_MAX_EVENTS',
				'analyticsEngineSink',
				'buildBundle',
				'combineSinks',
				'compressedSize',
				'createSpool',
				'datasetProof',
				'defineDataset',
				'defineResource',
				'defineRoute',
				'defineWrite',
				'eventsOf',
				'ga4Requests',
				'ga4Sink',
				'jsonLinesSink',
				'memoryBundleStore',
				'memoryHub',
				'memorySink',
				'memoryStaticSink',
				'mpViolations',
				'partitionId',
				'routesFromPages',
				'splitBytes',
				'staticHeaders',
				'viewsOf',
				'workSeries'
			]
		],
		['./node', nodeModule, ['fileStaticSink', 'toNodeListener', 'toRequest', 'writeResponse']],
		[
			'./proxy',
			proxyModule,
			[
				'DECLINE_PATH',
				'PURGE_PATH',
				'TAG_HEADERS',
				'TRIM_PATH',
				'baseMatcher',
				'chooseBases',
				'cookieNames',
				'createDictionaries',
				'decline',
				'equalSecrets',
				'frameDictionaryBody',
				'headerCharset',
				'htmlCharset',
				'isUtf8',
				'pathTag',
				'readTags',
				'recordDecline',
				'respondPurge',
				'responseDecline',
				'setsPrivateCookie',
				'spoolProxy',
				'stripTags'
			]
		],
		['./stores', storesModule, ['memoryStore']],
		['./nuxt', nuxtModule, ['default']],
		[
			'./next',
			nextModule,
			['SPOOL_PAGES_FILE', 'default', 'nextPages', 'spoolRouteHandler', 'spoolTag']
		],
		[
			'./react-router',
			reactRouterModule,
			['flattenRoutes', 'reactRouterPages', 'spoolReactRouter']
		],
		['./vite', viteModule, ['spoolVite']],
		['./vue', vueModule, ['spoolVue', 'vuePages']],
		['./angular', angularModule, ['spoolAngular']],
		[
			'./sw',
			swModule,
			['MANIFEST_FILE', 'QUOTA_MARGIN_BYTES', 'createPackStore', 'manifestConfig', 'serve']
		],
		[
			'./client',
			clientModule,
			[
				'browserActivityHost',
				'closeOnPageHide',
				'createActivity',
				'enableNavigation',
				'register'
			]
		],
		[
			'./report',
			reportModule,
			[
				'ACTIVITY_PAIRS',
				'AZURE_EGRESS',
				'BOOTSTRAP_EXTRA_NO_WORKER',
				'BOOTSTRAP_EXTRA_WORKER',
				'CF_FREE_REQUESTS_PER_DAY',
				'CF_PAID_INCLUDED',
				'CF_PAID_PER_MILLION',
				'CLASS_OF_ENGINE_DEFAULT',
				'CONTAMINATION_MS_PER_S',
				'CRAWL',
				'DAYS_PER_MONTH',
				'DEMAND',
				'DEMAND_LAYERS',
				'DEMAND_PATHS',
				'DICTIONARY_ARMS',
				'DOCUMENT_BYTES',
				'DRUPAL_NULL_KEY',
				'ECON_PRICES_READ',
				'EGRID_LB_PER_MWH',
				'ELECTRICITY_PRICE',
				'EMBER_US_G_PER_KWH',
				'ENGINE_CLASSES',
				'ENGINE_CLASS_LABELS',
				'FIRST_VIEW_BYTES',
				'FIRST_VIEW_SHARE',
				'FREE_TIER_VIEWS',
				'GCP_EGRESS',
				'GOAL_HIGH_SHARE',
				'GOAL_SHARES',
				'G_PER_LB',
				'HISTORY',
				'HOSTING_KWH_PER_SITE',
				'HOSTS',
				'IDLE_AGREEMENT',
				'KNOWN_ORIGINS',
				'LOOP_CLASSES',
				'LOOP_WINDOW_S',
				'MEASUREMENT_SCHEMA',
				'MOBILE_SHARE',
				'MODELLED_VIEW',
				'MeasurementError',
				'NOT_MODIFIED_SOCKET_BYTES',
				'ORIGIN_J',
				'OVERHEAD_ROUTES',
				'PANTHEON_OVERAGE',
				'PRICES_READ',
				'PUE',
				'RADIO_J',
				'READ_SHARE',
				'REPEAT_VIEW_BYTES',
				'RETROFIT_DOCUMENTS',
				'RETROFIT_IN_PAGE',
				'RETROFIT_ORIGIN',
				'RETROFIT_VIEWS',
				'RETROFIT_WORKER',
				'RIGS',
				'SERVER_FLOOR',
				'SERVER_WATTS',
				'SESSION',
				'STORAGE',
				'STUB_304_BYTES',
				'STUB_FULL_ST_BYTES',
				'SWD_V4',
				'TIERS',
				'WATER_DIRECT',
				'WATER_INDIRECT',
				'WATER_INDIRECT_LBNL',
				'WEBKIT_STUB_RATE',
				'WORKLOADS',
				'activityFigures',
				'activityGains',
				'addLevers',
				'aggregatesOf',
				'attributionalJoules',
				'avoidedShare',
				'bandwidthUsd',
				'baselinePerReadView',
				'bestAndWorst',
				'cacheability',
				'cacheabilityFigures',
				'capacityMWh',
				'capacityPlan',
				'catalogueFigures',
				'channelRows',
				'chunkSplitFigures',
				'churnFigures',
				'classifyOrigin',
				'coverageFigures',
				'crawlLevers',
				'dataCentreJoules',
				'datasetFigures',
				'demandBytes',
				'demandCounts',
				'demandDocumentCounts',
				'demandSavings',
				'demandWorkerCounts',
				'deviceCpuFigures',
				'dictionaryArms',
				'documentRequests',
				'drupalRenderFigures',
				'egressUsd',
				'egridGPerKwh',
				'electricityPrice',
				'factors',
				'factorsByEngine',
				'findLeaks',
				'firstViewDocumentMedian',
				'firstViewFigures',
				'firstViewFit',
				'fleetFor',
				'footprintMwh',
				'freeReadViewsPerDay',
				'freeTierCeiling',
				'freeViewsPair',
				'gPerKwhFromLbPerMwh',
				'halves',
				'heldShare',
				'imageSavings',
				'inferenceFigures',
				'institutionReport',
				'intervalsFromWork',
				'isAggregate',
				'isContaminated',
				'joulesPerView',
				'joulesPerViewWithOrigin',
				'kwhPerMv',
				'lazyUnscrolled',
				'leastSquares',
				'ledgerJoules',
				'ledgerMWh',
				'leverStats',
				'libraryBytes',
				'libraryStages',
				'linearFit',
				'loaded',
				'loopClasses',
				'loopFigures',
				'measurementPath',
				'measurementProblems',
				'median',
				'mismatchesByRoute',
				'monthlyGb',
				'multiplierOf',
				'netBytesShare',
				'nextShare',
				'noWorkerRequestsPerReadView',
				'nodesNeeded',
				'onWireFigures',
				'overIncluded',
				'paidMonth',
				'paidRequestsUsd',
				'parseMeasurement',
				'parseMeasurementText',
				'pathMatches',
				'peakCut',
				'perMillionViewsUsd',
				'phoneRun',
				'powerSweep',
				'quantile',
				'quartiles',
				'raplRun',
				'repaidAfter',
				'repeatBytesBySite',
				'repeatNavFigures',
				'repeatSplitBySite',
				'requestUsd',
				'requestsByClass',
				'requestsPerReadView',
				'requireLayers',
				'retrofitRatio',
				'rollUpInstitutions',
				'runtimeRun',
				'saving',
				'serialiseMeasurement',
				'serverYearMWh',
				'serversAfter',
				'siteFigures',
				'splitRequestBytes',
				'spoolBytes',
				'spread',
				'stageMultiplier',
				'swdTotal',
				'tabsFigures',
				'thirdPartyCacheBySite',
				'thirdPartyCacheSplit',
				'thirdPartyReport',
				'tonnesFromMwh',
				'transitions',
				'trimFigures',
				'trimLevers',
				'usdForMwh',
				'viewsChannelMWh',
				'warmFigures',
				'webkitStubPerReadView',
				'wilson',
				'windowCounts',
				'workerRequests',
				'zAnnual',
				'zDaily',
				'zPeakWork',
				'zeroNetworkFigures'
			]
		],
		[
			'./trim',
			trimModule,
			[
				'TRIM_PARAM',
				'buildTrimManifest',
				'decodeEntities',
				'guardPage',
				'pageAssets',
				'pageTokens',
				'scriptTokens',
				'sourceHash',
				'stripTrimParam',
				'tagsOf',
				'trimCss',
				'trimKey'
			]
		],
		[
			'./media',
			mediaModule,
			[
				'IMAGE_HINTS',
				'IMAGE_VARY',
				'PNG_AUTO_BYTES',
				'RESPONSIVE_PARAM',
				'TINYIMG_MIN_VERSION',
				'convertImage',
				'createImageConverter',
				'embedOf',
				'facadeDocument',
				'imageRequest',
				'imageVariant',
				'memoryImageCache',
				'originSearch',
				'resolveEmbedOptions',
				'resolveImageOptions',
				'resolveLazyOptions',
				'resolveResponsiveOptions',
				'resolveVideoOptions',
				'rewriteEmbeds',
				'rewriteLazy',
				'rewriteResponsive',
				'rewriteVideo',
				'signalsOf',
				'takeWidth',
				'tinyimgEncoder'
			]
		]
	];

	it.each(EXPORTS)('%s exports exactly these names', (_subpath, module, names) => {
		expect(Object.keys(module).sort()).toEqual(names);
	});
});

describe('the type names each entry point exports', () => {
	// types have no runtime value; the typecheck of this file is the pin
	it('pins the named types the entry points export', () => {
		expectTypeOf<BuildBundleOptions>().toHaveProperty('store');
		expectTypeOf<BuiltBundle>().toHaveProperty('bytes');
		expectTypeOf<FamilyRoute>().toBeObject();
		expectTypeOf<PrerenderPaths>().toEqualTypeOf<
			boolean | readonly string[] | ((args: never) => unknown)
		>();
		expectTypeOf<BuildContext>().toHaveProperty('distDir');
		expectTypeOf<Registration>().toHaveProperty('register');
	});
});
