import { describe, expect, it } from 'vitest';
import {
	datasetProof,
	decodeEnvelope,
	defineRoute,
	equivalent,
	evaluateQuery,
	type Artifact,
	type QuerySchema,
	type TimedView
} from '../../src/protocol/index';
import { SW_CORE } from '../../src/server/embedded';
import { createSpool, viewsOf } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import type { ReplicaStorage } from '../../src/sw/storage';
import { artifact, nav, sub } from './helpers';
import { HTML, rig, type RigOptions } from './rig';

const JSON_TYPE = { 'content-type': 'application/json' };
const course = (id: string) => ({ id, title: `Course ${id}` });
const depends = (ctx: { params: Record<string, string> }) => [`course:${ctx.params['id']}`];
const asJson = (request: Request) => {
	const { pathname } = new URL(request.url);
	const id = pathname.split('/').pop() as string;
	return new Response(JSON.stringify(course(id)), { headers: JSON_TYPE });
};

const app: RigOptions['app'] = (request) => {
	const { pathname } = new URL(request.url);
	if (pathname.startsWith('/api/')) return asJson(request);
	if (pathname.startsWith('/p/')) {
		const id = pathname.split('/').pop();
		return new Response(`<html><head></head><body>projection ${id}</body></html>`, {
			headers: HTML
		});
	}
	if (pathname.startsWith('/big/') || pathname.startsWith('/small/')) {
		return new Response(`<html><head></head><body>big</body></html>`, { headers: HTML });
	}
	return new Response('missing', { status: 404, headers: HTML });
};

const wide = { reuse: 1, futureViews: 5 };

const routes = [
	defineRoute('/api/course/:id', {
		strategy: 'data',
		depends,
		load: (ctx) => course(ctx.params['id'] as string),
		provision: wide
	}),
	defineRoute('/api/cold/:id', {
		strategy: 'data',
		depends,
		load: (ctx) => course(ctx.params['id'] as string)
	}),
	defineRoute('/p/:id', {
		strategy: 'projection',
		depends,
		load: (ctx) => ({ id: ctx.params['id'] }),
		provision: wide
	}),
	defineRoute('/big/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{big.text}}</body></html>' },
		load: (ctx) => ({ big: ctx.record('big', { text: 'x'.repeat(200_000) }) })
	}),
	defineRoute('/small/:id', {
		strategy: 'template',
		template: { source: '<html><head></head><body>{{small.text}}</body></html>' },
		load: (ctx) => ({ small: ctx.record('small', { text: 'small' }) })
	})
];

const make = (over: Partial<RigOptions> = {}) => rig({ routes, app, ...over });
const get = (r: ReturnType<typeof make>, path: string) => r.drive(sub(path));

describe('data strategy', () => {
	it('answers an API GET locally with no request once the first answer has provisioned it', async () => {
		const r = make();
		const first = await get(r, '/api/course/1');
		expect(await first.json()).toEqual(course('1'));
		expect(r.log).toEqual(['GET /api/course/1', 'GET /.spool/artifact']);

		r.reset();
		const second = await get(r, '/api/course/1');
		expect(r.log).toEqual([]);
		expect(second.headers.get('content-type')).toBe('application/json');
		expect(await second.json()).toEqual(course('1'));
	});

	it('equals the network answer after parsing, and uses the route content type when it names one', async () => {
		const custom = defineRoute('/api/typed/:id', {
			strategy: 'data',
			load: (ctx) => course(ctx.params['id'] as string),
			contentType: 'application/vnd.api+json',
			provision: wide
		});
		const r = make({ routes: [custom] });
		const network = await (await get(r, '/api/typed/9')).text();
		const local = await get(r, '/api/typed/9');
		expect(local.headers.get('content-type')).toBe('application/vnd.api+json');
		expect(JSON.parse(await local.text())).toEqual(JSON.parse(network));
	});

	it('goes back to the network after a change to a tag it depends on', async () => {
		const r = make();
		await get(r, '/api/course/1');
		await get(r, '/api/course/1');
		await r.spool.invalidate(['course:1']);
		r.advance(901);
		await get(r, '/api/course/1');
		r.reset();
		await get(r, '/api/course/1');
		expect(r.log[0]).toBe('GET /api/course/1');
	});

	it('leaves a navigation to the API URL and a ranged request to the network', async () => {
		const r = make();
		await get(r, '/api/course/1');
		r.reset();
		await r.drive(nav('/api/course/1'));
		await r.drive(sub('/api/course/1', { headers: { range: 'bytes=0-4' } }));
		expect(r.log).toEqual(['GET /api/course/1', 'GET /api/course/1']);
	});

	it('does not provision a route whose expected reuse does not repay its transfer, and asks once', async () => {
		const r = make();
		await get(r, '/api/cold/1');
		await get(r, '/api/cold/1');
		await get(r, '/api/cold/1');
		expect(r.log.filter((l) => l === 'GET /.spool/artifact')).toHaveLength(1);
		expect(r.log.filter((l) => l === 'GET /api/cold/1')).toHaveLength(3);
		expect(await r.runtime.replica.ids()).toEqual([]);
	});

	it('answers a declined artifact request with a 204 and the declination header', async () => {
		const r = make();
		const response = await r.spool.respond(
			new Request('https://site.test/.spool/artifact?path=/api/cold/1')
		);
		expect(response?.status).toBe(204);
		expect(response?.headers.get('spool-provision')).toBe('declined');
		const taken = await r.spool.respond(
			new Request('https://site.test/.spool/artifact?path=/api/course/1')
		);
		expect(taken?.status).toBe(200);
	});

	it('keeps a principal data route out of the store without a partition host', async () => {
		const mine = defineRoute('/api/me', {
			strategy: 'data',
			scope: 'principal',
			load: () => ({}),
			provision: wide
		});
		const r = make({ routes: [mine] });
		await get(r, '/api/me');
		await get(r, '/api/me');
		expect(r.log.filter((l) => l === 'GET /api/me')).toHaveLength(2);
	});
});

describe('projection strategy and the bundled worker', () => {
	const render = (artifact: { body: { data?: unknown } }) =>
		`<html><head></head><body>projection ${(artifact.body.data as { id: string }).id}</body></html>`;

	it('renders stored data through a renderer the site bundled, with no request', async () => {
		const r = make();
		const worker = r.make({ renderers: { '/p/:id': render as never } });
		await r.visit('/p/7', worker);
		r.reset();
		const body = await r.visit('/p/7', worker);
		expect(r.log).toEqual([]);
		expect(body).toContain('projection 7');
		expect(body).toContain('data-spool-client');
	});

	it('refuses a projection route that has no renderer and lets the network answer', async () => {
		const r = make();
		await r.visit('/p/7');
		r.reset();
		const body = await r.visit('/p/7');
		expect(r.log).toEqual(['GET /p/7']);
		expect(body).toContain('projection 7');
	});

	it("serves the site's own bundle in place of the embedded core, after the config", async () => {
		const spool = createSpool({
			routes,
			store: memoryStore(),
			worker: 'self.__bundled = true;'
		});
		const script = await spool.stub().text();
		expect(script.startsWith('self.__SPOOL_CONFIG__=')).toBe(true);
		expect(script.endsWith('\nself.__bundled = true;')).toBe(true);
		expect(script).not.toContain(SW_CORE.slice(0, 200));
		const plain = await createSpool({ routes, store: memoryStore() }).stub().text();
		expect(plain.endsWith(SW_CORE)).toBe(true);
	});
});

describe('provisioning benefit rule', () => {
	const bytes = (r: ReturnType<typeof make>) =>
		r.artifacts.reduce((total, a) => total + a.text.length, 0);

	it('leaves out an artifact whose records cost more than their expected reuse repays', async () => {
		const r = make();
		await r.visit('/big/1');
		await r.visit('/big/1');
		expect(await r.runtime.replica.ids()).toEqual([]);
		expect(r.artifacts.filter((a) => a.text !== '')).toEqual([]);
		expect(r.log.filter((l) => l === 'GET /big/1')).toHaveLength(2);
		const records = (await r.runtime.message({ type: 'spool:graph' })) as { records: string[] };
		expect(records.records).toEqual([]);
	});

	it("ships the same records when the operator's priors say they will be reused enough", async () => {
		const r = make({ spool: { provision: { reuse: 0.9, futureViews: 20 } } });
		await r.visit('/big/1');
		expect(await r.runtime.replica.ids()).toEqual(['/big/1']);
		expect(bytes(r)).toBeGreaterThan(200_000);
		r.reset();
		await r.visit('/big/1');
		expect(r.log).toEqual([]);
	});

	it('provisions a small page under the default priors, and asks again only after a restart', async () => {
		const r = make();
		await r.visit('/small/1');
		expect(await r.runtime.replica.ids()).toEqual(['/small/1']);
		await r.visit('/big/1');
		const restarted = r.make();
		r.reset();
		await r.visit('/big/1', restarted);
		expect(r.log.filter((l) => l.startsWith('GET /.spool/artifact'))).toHaveLength(1);
	});

	it('weighs a data route by its own size, so a typical priors pair breaks even and declines', async () => {
		const r = make();
		await get(r, '/api/cold/2');
		expect(r.artifacts.filter((a) => a.text !== '')).toHaveLength(0);
		expect(r.log.filter((l) => l === 'GET /.spool/artifact')).toHaveLength(1);
	});
});

describe('security headers on a local render', () => {
	const ALL = {
		'content-security-policy': "default-src 'self'",
		'content-security-policy-report-only': "default-src 'none'",
		'x-frame-options': 'DENY',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'same-origin',
		'permissions-policy': 'camera=()',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-embedder-policy': 'require-corp',
		'cross-origin-resource-policy': 'same-origin'
	};
	const secured = [
		defineRoute('/t/:id', {
			strategy: 'template',
			template: { source: '<html><head></head><body>{{id}}</body></html>' },
			depends,
			load: (ctx) => ({ id: ctx.params['id'] })
		}),
		defineRoute('/api/d/:id', {
			strategy: 'data',
			depends,
			load: (ctx) => course(ctx.params['id'] as string),
			provision: wide
		})
	];
	let sent: Record<string, Record<string, string>> = {};
	const secureApp: RigOptions['app'] = (request) => {
		const { pathname } = new URL(request.url);
		const id = pathname.split('/').pop() as string;
		const extra = { 'x-other': 'not a policy', ...(sent[pathname] ?? sent['*']) };
		if (pathname.startsWith('/api/')) {
			return new Response(JSON.stringify(course(id)), {
				headers: { ...JSON_TYPE, ...extra }
			});
		}
		if (pathname === '/t/404') return new Response('gone', { status: 404, headers: extra });
		if (pathname === '/t/redirect') {
			return new Response(null, { status: 302, headers: { ...extra, location: '/t/1' } });
		}
		if (pathname === '/clear') {
			return new Response('<html><head></head><body>clear</body></html>', {
				headers: { ...HTML, ...extra, 'spool-clear': '*' }
			});
		}
		if (pathname === '/file.pdf') {
			return new Response('pdf', {
				headers: { 'content-type': 'application/pdf', ...extra }
			});
		}
		return new Response(`<html><head></head><body>${id}</body></html>`, {
			headers: { ...HTML, ...extra }
		});
	};
	const secure = () => {
		sent = { '*': ALL };
		return rig({ routes: secured, app: secureApp });
	};
	const policyOf = (response: Response) =>
		Object.fromEntries(
			Object.keys(ALL).map((name) => [name, response.headers.get(name) ?? undefined])
		);
	/** stores an artifact for `/t/<id>` the worker never saw a network view of */
	const unseen = async (r: ReturnType<typeof secure>, id: string) => {
		await r.runtime.message({ type: 'spool:status' });
		await r.runtime.replica.put(
			artifact({ id: `/t/${id}`, deps: [], vector: 0, body: { data: { id } } }),
			true
		);
	};

	it('replays the nine security headers of the network answer and no other', async () => {
		const r = secure();
		await r.drive(nav('/t/1'));
		r.reset();
		const local = await r.drive(nav('/t/1'));
		expect(r.log).toEqual([]);
		expect(policyOf(local)).toEqual(ALL);
		expect(local.headers.has('x-other')).toBe(false);
		expect(local.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(await local.text()).toContain('1');
	});

	it('keeps each path its own set, and a path with none of its own takes the latest set seen', async () => {
		const r = secure();
		sent = {
			'/t/1': { 'content-security-policy': 'p1' },
			'/t/2': { 'x-frame-options': 'DENY' }
		};
		await r.drive(nav('/t/1'));
		await r.drive(nav('/t/2'));
		await unseen(r, '3');
		r.reset();
		const [one, two, three] = [
			await r.drive(nav('/t/1')),
			await r.drive(nav('/t/2')),
			await r.drive(nav('/t/3'))
		];
		expect(r.log).toEqual([]);
		expect(one.headers.get('content-security-policy')).toBe('p1');
		expect(one.headers.has('x-frame-options')).toBe(false);
		expect(two.headers.get('x-frame-options')).toBe('DENY');
		expect(two.headers.has('content-security-policy')).toBe(false);
		expect(three.headers.get('x-frame-options')).toBe('DENY');
		expect(three.headers.has('content-security-policy')).toBe(false);
	});

	it('goes to the network for a stored page until a policy has been seen, then serves it locally', async () => {
		const r = secure();
		await unseen(r, '3');
		const first = await r.drive(nav('/t/3'));
		expect(r.log).toEqual(['GET /t/3']);
		expect(policyOf(first)).toEqual(ALL);
		r.reset();
		const second = await r.drive(nav('/t/3'));
		expect(r.log).toEqual([]);
		expect(policyOf(second)).toEqual(ALL);
	});

	it('keeps nothing from an error, a redirect or a page that is not HTML', async () => {
		const r = secure();
		await r.drive(nav('/t/404'));
		await r.drive(nav('/t/redirect'));
		await r.drive(nav('/file.pdf'));
		expect(r.runtime.replica.sitePolicy).toBeUndefined();
		expect(r.runtime.replica.policyOf('/t/404')).toBeUndefined();
		expect(r.runtime.replica.policyOf('/t/redirect')).toBeUndefined();
		await unseen(r, '3');
		r.reset();
		await r.drive(nav('/t/3'));
		expect(r.log).toEqual(['GET /t/3']);
	});

	it('answers a data route with the headers its own network answer carried', async () => {
		const r = secure();
		sent = { '/api/d/1': { 'x-content-type-options': 'nosniff' } };
		await get(r, '/api/d/1');
		r.reset();
		const local = await get(r, '/api/d/1');
		expect(r.log).toEqual([]);
		expect(local.headers.get('x-content-type-options')).toBe('nosniff');
		expect(local.headers.get('content-type')).toBe('application/json');
		expect(local.headers.has('x-other')).toBe(false);
	});

	it('keeps the sets across a worker restart', async () => {
		const r = secure();
		await r.drive(nav('/t/1'));
		const restarted = r.make();
		r.reset();
		const local = await r.drive(nav('/t/1'), restarted);
		expect(r.log).toEqual([]);
		expect(policyOf(local)).toEqual(ALL);
	});

	it('wipes the sets with the store, so a page stored again is not served until one is seen', async () => {
		const r = secure();
		await r.drive(nav('/t/1'));
		expect(r.runtime.replica.sitePolicy).toBeDefined();
		await r.drive(nav('/clear'));
		expect(await r.runtime.replica.ids()).toEqual([]);
		expect(r.runtime.replica.sitePolicy).toBeUndefined();
		expect(r.runtime.replica.policyOf('/t/1')).toBeUndefined();
		await unseen(r, '1');
		r.reset();
		await r.drive(nav('/t/1'));
		expect(r.log).toEqual(['GET /t/1']);
	});
});

describe('query routes', () => {
	const rows = [
		{ name: 'Ada', department: 'math', age: 36 },
		{ name: 'Bo', department: 'cs', age: 25 },
		{ name: 'Cy', department: 'math', age: 25 },
		{ name: 'Di', department: 'art', age: 41 },
		{ name: 'Ed', department: 'math', age: 30 }
	];
	const query: QuerySchema = {
		list: 'people',
		filter: { department: 'string', age: 'number' },
		sort: ['name', 'age'],
		pageSize: 2
	};
	const dataset = async () => ({ people: rows, proof: await datasetProof(rows) });
	const page = (mark: string) => ({
		source: `<html><head></head><body><p>{{#if query}}{{query.page}} of {{query.pages}}, {{query.total}} found{{else}}all{{/if}}</p><ul>{{#each people}}<li>{{name}}${mark}</li>{{/each}}</ul></body></html>`
	});
	const listing = (items: Array<Record<string, unknown>>, summary: string) =>
		`<html><head></head><body><p>${summary}</p><ul>${items.map((p) => `<li>${p['name']}</li>`).join('')}</ul></body></html>`;
	const hard = { maxStale: 60, mode: 'hard' } as const;
	const wide = { reuse: 1, futureViews: 5 };

	const queryRoutes = [
		defineRoute('/people', {
			strategy: 'template',
			template: page(''),
			depends: () => ['people'],
			load: dataset,
			query
		}),
		defineRoute('/staff', {
			strategy: 'template',
			template: page('!'),
			load: dataset,
			query
		}),
		defineRoute('/hard-people', {
			strategy: 'template',
			template: page(''),
			depends: () => ['people'],
			freshness: hard,
			load: dataset,
			query
		}),
		defineRoute('/api/people', {
			strategy: 'data',
			depends: () => ['people'],
			load: dataset,
			query,
			provision: wide
		}),
		defineRoute('/roster', {
			strategy: 'projection',
			load: dataset,
			query
		})
	];

	const shaped = async (
		search: string
	): Promise<{ people: unknown[]; proof: unknown; query?: Record<string, number> }> => {
		const data = await dataset();
		const result = search === '' ? null : evaluateQuery(query, data, search);
		return result
			? {
					...data,
					people: result.items,
					query: { total: result.total, page: result.page, pages: result.pages }
				}
			: data;
	};

	const queryApp: RigOptions['app'] = async (request) => {
		const { pathname, search } = new URL(request.url);
		if (pathname === '/api/people') {
			return new Response(JSON.stringify(await shaped(search)), { headers: JSON_TYPE });
		}
		const result = search === '' ? null : evaluateQuery(query, { people: rows }, search);
		if (pathname === '/roster') {
			const total = result ? result.total : rows.length;
			const count = result ? result.items.length : rows.length;
			return new Response(`<html><head></head><body>${total}:${count}</body></html>`, {
				headers: HTML
			});
		}
		if (['/people', '/staff', '/hard-people'].includes(pathname)) {
			const summary = result
				? `${result.page} of ${result.pages}, ${result.total} found`
				: 'all';
			return new Response(listing(result ? result.items : rows, summary), { headers: HTML });
		}
		return new Response('missing', { status: 404, headers: HTML });
	};

	const queryRig = (over: Partial<RigOptions> = {}) =>
		rig({ routes: queryRoutes, app: queryApp, ...over });
	type QueryRig = ReturnType<typeof queryRig>;
	const network = async (r: QueryRig, url: string) =>
		(await r.spool.handle(new Request(`https://site.test${url}`), queryApp)).text();
	const held = async (storage: ReplicaStorage): Promise<TimedView[]> =>
		viewsOf((await storage.readBeacons()).map((b) => b.event));
	const GOOD = '/people?department=math&sort=name&page=2';

	it('answers a valid query URL from the stored collection with 0 requests', async () => {
		const r = queryRig();
		await r.visit('/people');
		expect(r.log).toEqual(['GET /people', 'GET /.spool/artifact']);
		r.reset();

		expect(await r.visit(GOOD)).toContain('<p>2 of 2, 3 found</p><ul><li>Ed</li></ul>');
		expect(await r.visit('/people?sort=-age')).toContain(
			'<p>1 of 3, 5 found</p><ul><li>Di</li><li>Ada</li></ul>'
		);
		expect(await r.visit('/people?age=25&age=30&sort=-name')).toContain(
			'<p>1 of 2, 3 found</p><ul><li>Ed</li><li>Cy</li></ul>'
		);
		expect(await r.visit('/people')).toContain('<p>all</p>');
		expect(r.log).toEqual([]);
	});

	it('renders the same page as the network does for each valid query', async () => {
		const r = queryRig();
		await r.visit('/people');
		r.reset();
		const urls = [
			GOOD,
			'/people?department=cs',
			'/people?department=none',
			'/people?sort=-age&page=3',
			'/people?age=25&department=math'
		];
		for (const url of urls) {
			const verdict = equivalent(await r.visit(url), await network(r, url));
			expect(verdict.equal, `${url}: ${verdict.equal ? '' : verdict.reason}`).toBe(true);
		}
		expect(r.log).toEqual([]);
	});

	it.each([
		['an unknown parameter', '?colour=red'],
		['a number filter with text', '?age=old'],
		['a page past the last', '?page=9'],
		['a repeated sort', '?sort=name&sort=age'],
		['a sort that is not listed', '?sort=department']
	])('sends %s to the network exactly once', async (_name, search) => {
		const r = queryRig();
		await r.visit('/people');
		r.reset();
		expect(await r.visit(`/people${search}`)).toContain('<p>all</p>');
		expect(r.log).toEqual(['GET /people']);
		expect(r.urls).toEqual([`GET /people${search}`]);
		r.reset();
		await r.visit(GOOD);
		expect(r.log).toEqual([]);
	});

	it.each([
		['count', (data: { proof: object }) => ({ ...data, proof: { ...data.proof, count: 4 } })],
		[
			'digest',
			(data: { proof: object }) => ({ ...data, proof: { ...data.proof, digest: 'x' } })
		],
		[
			'an item removed',
			(data: { people: unknown[] }) => ({ ...data, people: data.people.slice(1) })
		],
		[
			'an item edited',
			(data: { people: object[] }) => ({
				...data,
				people: [{ ...data.people[0], age: 99 }, ...data.people.slice(1)]
			})
		]
	])(
		'goes to the network when the stored %s no longer matches the proof, then holds it whole again',
		async (_name, tamper) => {
			const r = queryRig();
			await r.visit('/people');
			const stored = (await r.runtime.replica.get('/people')) as { artifact: Artifact };
			const data = stored.artifact.body as { data: never };
			await r.runtime.replica.put(
				{ ...stored.artifact, body: { data: tamper(data.data) } } as Artifact,
				true
			);
			r.reset();

			expect(await r.visit('/people?department=math')).toContain('<p>1 of 2, 3 found</p>');
			expect(r.urls).toEqual([
				'GET /people?department=math',
				'GET /.spool/artifact?path=%2Fpeople'
			]);
			r.reset();
			expect(await r.visit('/people?department=math')).toContain('<p>1 of 2, 3 found</p>');
			expect(r.log).toEqual([]);
		}
	);

	it('syncs first on a hard route past its bound, as it does for the path, and shows the local answer', async () => {
		const r = queryRig();
		await r.visit('/hard-people');
		r.reset();
		await r.visit('/hard-people?department=cs');
		expect(r.log).toEqual([]);

		r.advance(61);
		expect(await r.visit('/hard-people?department=cs')).toContain('<p>1 of 1, 1 found</p>');
		expect(r.log).toEqual(['GET /.spool/sync']);

		await r.spool.invalidate(['people']);
		r.advance(61);
		r.reset();
		await r.visit('/hard-people?department=cs');
		expect(r.log).toEqual(['GET /.spool/sync', 'GET /hard-people', 'GET /.spool/artifact']);
	});

	it('stores nothing under a URL with a query string, and a cold one provisions the path', async () => {
		const r = queryRig();
		await r.visit('/people?department=math');
		expect(r.urls).toEqual([
			'GET /people?department=math',
			'GET /.spool/artifact?path=%2Fpeople'
		]);
		expect(await r.runtime.replica.ids()).toEqual(['/people']);
		expect(r.runtime.replica.policyOf('/people?department=math')).toBeUndefined();
		r.reset();
		expect(await r.visit('/people?department=cs')).toContain('<p>1 of 1, 1 found</p>');
		expect(r.log).toEqual([]);
		expect(await r.runtime.replica.ids()).toEqual(['/people']);
	});

	it('compares the local render of a query URL with the network answer in shadow mode', async () => {
		const r = queryRig({ spool: { mode: 'shadow' } });
		await r.visit('/people');
		await r.visit('/staff');
		expect((await r.runtime.replica.ids()).sort()).toEqual(['/people', '/staff']);
		for (let i = 0; i < 3; i++) {
			await r.visit(GOOD);
			await r.visit(GOOD.replace('/people', '/staff'));
		}
		const views = await held(r.storage);
		const byRoute = (route: string) => views.filter((v) => v.route === route);
		expect(byRoute('/people').map((v) => [v.tier, v.reason, v.mismatch])).toEqual(
			Array.from({ length: 3 }, () => ['shadow', 'fresh', false])
		);
		expect(byRoute('/staff').map((v) => [v.tier, v.reason, v.mismatch])).toEqual(
			Array.from({ length: 3 }, () => ['shadow', 'fresh', true])
		);
	});

	it('answers a GET with a query from a data route and sends what it cannot answer to the network', async () => {
		const r = queryRig();
		await r.drive(sub('/api/people'));
		r.reset();

		const local = await r.drive(sub('/api/people?sort=-name&page=1'));
		expect(r.log).toEqual([]);
		expect(local.headers.get('content-type')).toBe('application/json');
		const expected = await shaped('?sort=-name&page=1');
		expect(await local.json()).toEqual(expected);
		expect(expected.query).toEqual({ total: 5, page: 1, pages: 3 });
		expect(expected.people).toHaveLength(2);

		await r.drive(sub('/api/people?colour=red'));
		expect(r.urls).toEqual(['GET /api/people?colour=red']);
	});

	it('gives a projection renderer the page of items and the page numbers', async () => {
		const r = queryRig();
		const renderer = (stored: { body: { data?: unknown } }) => {
			const data = stored.body.data as { people: unknown[]; query: { total: number } };
			return `<html><head></head><body>${data.query.total}:${data.people.length}</body></html>`;
		};
		const worker = r.make({ renderers: { '/roster': renderer as never } });
		await r.visit('/roster', worker);
		r.reset();
		expect(await r.visit('/roster?department=math', worker)).toContain('3:2');
		expect(await r.visit('/roster?department=math&page=2', worker)).toContain('3:1');
		expect(r.log).toEqual([]);
		await r.visit('/roster?colour=red', worker);
		expect(r.log).toEqual(['GET /roster']);
	});
});

describe('query routes on the server', () => {
	const rows = [{ name: 'Ada' }, { name: 'Bo' }];
	let load: () => Promise<unknown> = async () => ({});
	const spool = createSpool({
		routes: [
			defineRoute('/people', {
				strategy: 'data',
				load: () => load(),
				query: { list: 'people', pageSize: 1 },
				provision: { reuse: 1, futureViews: 5 }
			})
		],
		store: memoryStore()
	});
	const ask = (path: string) =>
		spool.respond(
			new Request(`https://site.test/.spool/artifact?path=${encodeURIComponent(path)}`)
		) as Promise<Response>;
	const error = async (response: Response) =>
		((await response.json()) as { error: string }).error;

	it('ships the collection with its proof in the artifact', async () => {
		const proof = await datasetProof(rows);
		load = async () => ({ people: rows, proof });
		const response = await ask('/people');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { body: { data: object } };
		expect(body.body.data).toEqual({ people: rows, proof });
		expect(spool.config.routes[0]?.query).toEqual({ list: 'people', pageSize: 1 });
	});

	it('refuses to build an artifact whose load has no valid proof', async () => {
		const proof = await datasetProof(rows);
		const bad: unknown[] = [
			{ people: rows },
			{ people: rows, proof: { ...proof, count: 1 } },
			{ people: rows, proof: { ...proof, digest: 'x' } },
			{ people: rows.slice(1), proof },
			{ proof },
			{ people: 'none', proof },
			null
		];
		for (const value of bad) {
			load = async () => value;
			const response = await ask('/people');
			expect(response.status).toBe(400);
			expect(await error(response)).toContain("/people: a query route's load needs");
		}
	});

	it('builds the artifact of a path only: a path with a query string has no route', async () => {
		load = async () => ({ people: rows, proof: await datasetProof(rows) });
		const response = await ask('/people?name=Ada');
		expect(response.status).toBe(404);
		expect(await error(response)).toBe('no route');
	});

	it('advertises the artifact of the path on a response for a URL with a query string', async () => {
		const response = await spool.decorate(
			new Request('https://site.test/people?name=Ada'),
			new Response('{}', { headers: JSON_TYPE })
		);
		expect(decodeEnvelope(response.headers).artifact).toMatchObject({
			id: '/people',
			scope: 'public'
		});
	});

	it('refuses a principal route that declares query', () => {
		expect(() =>
			defineRoute('/me', {
				strategy: 'data',
				scope: 'principal',
				load: () => ({}),
				query: { list: 'a' }
			})
		).toThrow(/public route/);
	});
});
