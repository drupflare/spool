import { describe, expect, it } from 'vitest';
import { defineRoute } from '../../src/protocol/index';
import { SW_CORE } from '../../src/server/embedded';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
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
