import { describe, expect, it } from 'vitest';
import {
	type DatasetRow,
	defineDataset,
	defineRoute,
	readBundle,
	type Ring
} from '../../src/protocol/index';
import { viewStamps } from '../../src/protocol/views';
import { buildBundle, createSpool, memoryBundleStore } from '../../src/server/index';
import { buildRing, gatePaths, ringElement } from '../../src/server/ring';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';

const ORIGIN = new URL('https://example.test/');

function courses(rows: DatasetRow[]) {
	return defineDataset('courses', {
		scope: 'public',
		key: (row) => String(row['id']),
		seed: () => rows,
		read: async () => [],
		changes: async () => 'reset' as const,
		horizon: async () => 0,
		head: async () => ({ cursor: 0 }),
		schema: '1',
		maxRows: 100_000,
		maxBytes: 100_000_000
	});
}

const family = defineRoute('/courses/:id', {
	strategy: 'projection',
	family: { dataset: 'courses', key: 'id' }
});

/** c1 links to c2 and c3, c2 to c4, c3 to c5; `pad` bytes of body make each row large */
const LINKS: Record<string, string[]> = {
	c1: ['/courses/c2', '/courses/c3'],
	c2: ['/courses/c4'],
	c3: ['/courses/c5'],
	c4: [],
	c5: []
};

function fixture(pad: number): DatasetRow[] {
	return Object.entries(LINKS).map(([id, links]) => ({ id, links, body: 'x'.repeat(pad) }));
}

async function packOf(rows: DatasetRow[]) {
	const built = await buildBundle({
		store: memoryBundleStore(),
		datasets: [courses(rows)],
		routes: [family],
		version: 1,
		url: ORIGIN
	});
	const { state } = await readBundle(built.bytes);
	return { tables: state.tables, digest: built.index.digest, bytes: built.bytes.length };
}

/** a family route with a template of `source`; the template is what the ring must carry */
const sized = (source: string) =>
	defineRoute('/courses/:id', {
		strategy: 'template',
		template: { source },
		family: { dataset: 'courses', key: 'id' }
	});

function ringAt(
	path: string,
	pack: Awaited<ReturnType<typeof packOf>>,
	ringBytes: number,
	route: typeof family = family
) {
	return buildRing({
		path,
		version: 1,
		digest: pack.digest,
		routes: [route],
		tables: pack.tables,
		packBytes: pack.bytes,
		ringBytes,
		bootstrap: 'second-view',
		worker: 'auto'
	});
}

const ids = (ring: Ring | undefined) => ring?.tables['courses']?.map(([key]) => key);

/** the boot path a gate page's ring names: the pack version, then the id of the routes and templates */
const shapedBoot = (version: number) =>
	new RegExp(
		`^/\\.spool/${VERSION.replace(/\./g, '\\.')}/boot/${version}\\.js\\?r=[0-9a-f]{12}$`
	);

/** the JSON text inside a ring element, between its opening tag and `</script>` */
function innerOf(element: string): string {
	return element.slice(element.indexOf('>') + 1, element.lastIndexOf('</script>'));
}

describe('buildRing', () => {
	it('carries a public list route and its template, so a complete ring answers the list', async () => {
		const pack = await packOf(fixture(10));
		const list = defineRoute('/courses', {
			strategy: 'template',
			template: { source: '<main>{{#each items}}{{id}}{{/each}}</main>' },
			query: { list: 'items', dataset: 'courses', filter: { dept: 'string' }, pageSize: 20 },
			load: () => ({})
		});
		const ring = buildRing({
			path: '/courses/c1',
			version: 1,
			digest: pack.digest,
			routes: [sized('<main>{{row.id}}</main>'), list],
			tables: pack.tables,
			packBytes: pack.bytes,
			ringBytes: 1 << 20,
			bootstrap: 'second-view',
			worker: 'auto'
		});
		expect(ring?.routes?.map((route) => route.pattern)).toEqual(['/courses/:id', '/courses']);
		expect(Object.keys(ring?.templates ?? {})).toEqual(['/courses/:id', '/courses']);
		expect(ring?.complete).toBe(true);
	});

	it.each(['auto', 'never', 'always'] as const)(
		'writes the %s worker mode as a field a client that predates always reads',
		async (mode) => {
			const pack = await packOf(fixture(3));
			for (const slim of [false, true]) {
				const ring = buildRing({
					path: '/courses/c1',
					version: 1,
					digest: pack.digest,
					routes: [family],
					tables: pack.tables,
					packBytes: pack.bytes,
					ringBytes: 1 << 20,
					bootstrap: 'second-view',
					worker: mode,
					slim
				});
				expect(ring?.worker).toBe(mode === 'never' ? 'never' : 'auto');
				expect(ring?.webkitWorker).toBe(mode === 'always' ? true : undefined);
				expect('webkitWorker' in (ring ?? {})).toBe(mode === 'always');
			}
		}
	);

	it('holds the entry row alone when the next linked row would exceed the budget', async () => {
		const pack = await packOf(fixture(2000));
		const ring = ringAt('/courses/c1', pack, 1024);
		expect(ids(ring)).toEqual(['c1']);
		expect(ring?.complete).toBe(false);
		expect(ring?.pack).toEqual({ url: '/.spool/bundle/1', bytes: pack.bytes });
	});

	it('walks links breadth first: c3 is held before c4, which is two links from c1', async () => {
		const pack = await packOf(fixture(2000));
		const ring = ringAt('/courses/c1', pack, 8192);
		expect(ids(ring)).toEqual(['c1', 'c2', 'c3']);
		expect(ring?.tables['path:courses']?.map(([path]) => path)).toEqual([
			'/courses/c1',
			'/courses/c2',
			'/courses/c3'
		]);
		expect(ring?.complete).toBe(false);
	});

	it('holds every row, and no pack, when the budget covers the site', async () => {
		const pack = await packOf(fixture(2000));
		const ring = ringAt('/courses/c1', pack, 16 * 1024 * 1024);
		expect(ids(ring)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
		expect(ring?.complete).toBe(true);
		expect(ring?.pack).toBeUndefined();
	});

	it('holds the entry row alone when the budget is smaller than the entry row', async () => {
		const pack = await packOf(fixture(2000));
		const ring = ringAt('/courses/c1', pack, 10);
		expect(ids(ring)).toEqual(['c1']);
		expect(ring?.complete).toBe(false);
	});

	it('carries the template of each family route, and none for a route without one', async () => {
		const pack = await packOf(fixture(0));
		const route = sized('<p>{{row.id}}</p>');
		expect(ringAt('/courses/c1', pack, 8192, route)?.templates).toEqual({
			'/courses/:id': route.template
		});
		expect(ringAt('/courses/c1', pack, 8192)?.templates).toEqual({});
	});

	it('counts a template against the budget: a budget that fits the row but not the template holds the row alone', async () => {
		const pack = await packOf(fixture(0));
		const route = sized('x'.repeat(2000));
		const ring = ringAt('/courses/c1', pack, 1024, route);
		expect(ids(ring)).toEqual(['c1']);
		expect(ring?.routes).toHaveLength(1);
		expect(ring?.templates).toEqual({ '/courses/:id': route.template });
		expect(ids(ringAt('/courses/c1', pack, 16 * 1024 * 1024, route))).toEqual([
			'c1',
			'c2',
			'c3',
			'c4',
			'c5'
		]);
		const plain = ids(ringAt('/courses/c1', pack, 1024));
		expect(plain?.length).toBeGreaterThan(1);
	});

	it('gives the same ring for the same input', async () => {
		const pack = await packOf(fixture(2000));
		expect(ringAt('/courses/c1', pack, 8192)).toEqual(ringAt('/courses/c1', pack, 8192));
	});

	it('names the boot script when it is given one, and none otherwise', async () => {
		const pack = await packOf(fixture(0));
		const options = {
			path: '/courses/c1',
			version: 1,
			digest: pack.digest,
			routes: [family],
			tables: pack.tables,
			packBytes: pack.bytes,
			ringBytes: 16 * 1024 * 1024,
			bootstrap: 'second-view' as const,
			worker: 'auto' as const
		};
		expect(buildRing({ ...options, boot: '/.spool/1/boot/1.js' })?.boot).toBe(
			'/.spool/1/boot/1.js'
		);
		expect(buildRing(options)).not.toHaveProperty('boot');
	});

	it('leaves the routes and templates out of a slim ring, and keeps them in a full one', async () => {
		const pack = await packOf(fixture(0));
		const route = sized('<main>{{row.id}}</main>');
		const options = {
			path: '/courses/c1',
			version: 1,
			digest: pack.digest,
			routes: [route],
			tables: pack.tables,
			packBytes: pack.bytes,
			ringBytes: 16 * 1024 * 1024,
			bootstrap: 'second-view' as const,
			worker: 'auto' as const
		};
		const slim = buildRing({ ...options, slim: true });
		expect(slim).not.toHaveProperty('routes');
		expect(slim).not.toHaveProperty('templates');
		expect(slim?.tables).toEqual({});
		expect(buildRing(options)).toHaveProperty('routes');
		expect(buildRing(options)).toHaveProperty('templates');
	});

	it('gives no ring to a path that no family route matches', async () => {
		const pack = await packOf(fixture(0));
		expect(ringAt('/about', pack, 8192)).toBeUndefined();
	});

	it('parses back to the same ring from its element', async () => {
		const pack = await packOf(fixture(0));
		const ring = ringAt('/courses/c1', pack, 16 * 1024 * 1024);
		expect(ring).toBeDefined();
		expect(JSON.parse(innerOf(ringElement(ring as Ring)))).toEqual(ring);
	});

	it('escapes </script> and <!-- in a row so the element cannot close early', async () => {
		const pack = await packOf([{ id: 'c1', links: [], title: '</script><!-- x' }]);
		const ring = ringAt('/courses/c1', pack, 16 * 1024 * 1024);
		const element = ringElement(ring as Ring);
		const text = innerOf(element);
		expect(text).not.toContain('<');
		expect(element.match(/<\/script>/g)).toHaveLength(1);
		expect(JSON.parse(text).tables.courses[0][1].title).toBe('</script><!-- x');
	});
});

describe('viewStamps', () => {
	const DAY = 86_400_000;
	const HOUR = 3_600_000;

	it('counts the third view inside one lease period as the third stamp', () => {
		let stored = '';
		const counts: number[] = [];
		for (const now of [0, HOUR, 2 * HOUR]) {
			const next = viewStamps(stored, now, DAY);
			counts.push(next.length);
			stored = next.join();
		}
		expect(counts).toEqual([1, 2, 3]);
	});

	it('keeps two views inside the period below three', () => {
		expect(viewStamps('0', HOUR, DAY)).toEqual([0, HOUR]);
	});

	it('lets the oldest stamp fall out once a lease period has passed it', () => {
		expect(viewStamps('0,5000', DAY, DAY)).toEqual([5_000, DAY]);
	});

	it('counts one view a day as one, since a stamp a full lease old is outside', () => {
		let stored = '';
		const counts: number[] = [];
		for (let day = 0; day < 5; day++) {
			const next = viewStamps(stored, day * DAY, DAY);
			counts.push(next.length);
			stored = next.join();
		}
		expect(counts).toEqual([1, 1, 1, 1, 1]);
	});

	it('treats a stamp in the future as outside the window', () => {
		expect(viewStamps('5000,500', 1_000, DAY)).toEqual([500, 1_000]);
	});

	it('counts an empty, corrupt or negative stored value as zero', () => {
		for (const stored of ['', 'x', '-1', '{"a":1}', ',,']) {
			expect(viewStamps(stored, 1_000, DAY)).toEqual([1_000]);
		}
	});

	it('keeps the last three stamps when more are inside the period', () => {
		expect(viewStamps('0,1,2,3', 4, DAY)).toEqual([2, 3, 4]);
	});
});

describe('gatePaths', () => {
	const template = { source: '<main>{{row.id}}</main>' };
	const dataset = { dataset: 'courses', key: 'id' };

	it('lists the prefix of a template family route and a query list route with its path', () => {
		const routes = [
			defineRoute('/courses/:id', { strategy: 'template', template, family: dataset }),
			defineRoute('/courses', {
				strategy: 'template',
				template,
				query: {
					list: 'items',
					dataset: 'courses',
					filter: { dept: 'string' },
					pageSize: 20
				},
				load: () => ({})
			})
		];
		expect(gatePaths(routes)).toEqual(['/courses/', '?/courses']);
	});

	it('takes the part of a pattern before its first parameter, once', () => {
		const routes = [
			defineRoute('/people/:id/bio', { strategy: 'template', template, family: dataset }),
			defineRoute('/people/:id/jobs', { strategy: 'template', template, family: dataset })
		];
		expect(gatePaths(routes)).toEqual(['/people/']);
	});

	it('leaves out what the page runtime cannot render with no custom renderer', () => {
		const routes = [
			defineRoute('/a/:id', { strategy: 'projection', family: dataset }),
			defineRoute('/b/:id', { strategy: 'data', family: dataset }),
			defineRoute('/c/:id', {
				strategy: 'template',
				template,
				family: dataset,
				navigation: 'document'
			}),
			defineRoute('/d/:id', {
				strategy: 'template',
				template,
				family: dataset,
				scope: 'principal'
			})
		];
		expect(gatePaths(routes)).toEqual([]);
	});
});

describe('createSpool and the ring in a family page', () => {
	const PAGE =
		'<!doctype html><html><head><title>c</title></head><body><p>course</p></body></html>';

	async function serve(rows: DatasetRow[], clientTag?: 'inline' | 'script') {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const spool = createSpool({
			routes: [family],
			store: versions,
			datasets: [courses(rows)],
			bundles,
			...(clientTag ? { clientTag } : {})
		});
		const version = await versions.cursor();
		await buildBundle({
			store: bundles,
			datasets: [courses(rows)],
			routes: [family],
			version,
			url: ORIGIN
		});
		return { spool, bundles, version };
	}

	async function page(
		spool: Awaited<ReturnType<typeof serve>>['spool'],
		path: string,
		method = 'GET'
	) {
		const response = await spool.decorate(
			new Request(new URL(path, ORIGIN), { method }),
			new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
		);
		return response.text();
	}

	it('puts a ring before </head> of a family page and nothing on other pages', async () => {
		const { spool } = await serve(fixture(0), 'script');
		const html = await page(spool, '/courses/c1');
		expect(html).toContain('<script type="application/json" id="spool-ring">');
		expect(html.indexOf('id="spool-ring"')).toBeLessThan(html.indexOf('</head>'));
		expect(await page(spool, '/about')).not.toContain('id="spool-ring"');
		expect(await page(spool, '/courses/c1', 'HEAD')).not.toContain('id="spool-ring"');
	});

	it('on a gate page every HTML page of the site names the boot script, not only a family page', async () => {
		const { spool, version } = await serve(fixture(0));
		const ringOf = (html: string) => {
			const start = html.indexOf('<script type="application/json" id="spool-ring">');
			const end = html.indexOf('</script>', start);
			return JSON.parse(html.slice(html.indexOf('>', start) + 1, end)) as Ring;
		};
		const family = ringOf(await page(spool, '/courses/c1'));
		const home = ringOf(await page(spool, '/'));
		const about = ringOf(await page(spool, '/about'));
		expect(home.boot).toMatch(shapedBoot(version));
		expect(home).toEqual(family);
		expect(about).toEqual(family);
		expect(await page(spool, '/', 'HEAD')).not.toContain('id="spool-ring"');
	});

	it('names the worker mode in the ring, and refuses an unknown one', async () => {
		const rows = fixture(0);
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const spool = createSpool({
			routes: [family],
			store: versions,
			datasets: [courses(rows)],
			bundles,
			workerMode: 'never'
		});
		await buildBundle({
			store: bundles,
			datasets: [courses(rows)],
			routes: [family],
			version: await versions.cursor(),
			url: ORIGIN
		});
		expect(await page(spool, '/courses/c1')).toContain('"worker":"never"');
		expect(() =>
			createSpool({ routes: [family], store: memoryStore(), workerMode: 'always' })
		).not.toThrow();
		expect(() =>
			createSpool({ routes: [family], store: memoryStore(), workerMode: 'maybe' as never })
		).toThrow('unknown workerMode "maybe"');
	});

	it('on a gate page the ring holds no rows and names the pack and the boot script', async () => {
		const rows = Object.entries(LINKS).map(([id, links]) => ({ id, links, body: 'x' }));
		const { spool, bundles, version } = await serve(rows);
		const html = await page(spool, '/courses/c1');
		const start = html.indexOf('<script type="application/json" id="spool-ring">');
		const end = html.indexOf('</script>', start);
		const ring = JSON.parse(html.slice(html.indexOf('>', start) + 1, end)) as Ring;
		expect(ring.tables).toEqual({});
		expect(ring.complete).toBe(false);
		expect(ring.boot).toMatch(shapedBoot(version));
		expect(ring.pack).toEqual({
			url: `/.spool/bundle/${version}`,
			bytes: (await bundles.get(version))?.length
		});
	});

	it('on a gate page the ring holds no routes and no templates, and the boot script carries them', async () => {
		const { spool, version } = await serve(fixture(0));
		const html = await page(spool, '/courses/c1');
		const start = html.indexOf('<script type="application/json" id="spool-ring">');
		const end = html.indexOf('</script>', start);
		const ring = JSON.parse(html.slice(html.indexOf('>', start) + 1, end)) as Ring;
		expect(Object.keys(ring).sort()).toEqual(
			[
				'bootstrap',
				'boot',
				'complete',
				'digest',
				'lease',
				'pack',
				'protocol',
				'tables',
				'version',
				'worker'
			].sort()
		);
		const response = await spool.respond(new Request(new URL(ring.boot ?? '', ORIGIN)));
		expect(response?.status).toBe(200);
		const text = await response?.text();
		const handed: { __SPOOL_BOOT__?: { shape?: Record<string, unknown>; pack?: unknown } } = {};
		new Function('globalThis', (text ?? '').slice(0, (text ?? '').indexOf('\n') + 1))(handed);
		const shape = handed.__SPOOL_BOOT__?.shape as {
			id: string;
			routes: Array<{ pattern: string }>;
			templates: Record<string, unknown>;
		};
		expect(ring.boot).toBe(`/.spool/${VERSION}/boot/${version}.js?r=${shape.id}`);
		expect(shape.routes.map((route) => route.pattern)).toEqual(['/courses/:id']);
		expect(shape.templates).toEqual({});
		expect(handed.__SPOOL_BOOT__?.pack).toMatchObject({ version });
	});

	it('names another boot script when only a template changes, under the same pack version', async () => {
		const bootOf = async (source: string) => {
			const route = defineRoute('/courses/:id', {
				strategy: 'template',
				template: { source },
				family: { dataset: 'courses', key: 'id' },
				load: () => ({})
			});
			const versions = memoryStore();
			const bundles = memoryBundleStore();
			const spool = createSpool({
				routes: [route],
				store: versions,
				datasets: [courses(fixture(0))],
				bundles
			});
			await buildBundle({
				store: bundles,
				datasets: [courses(fixture(0))],
				routes: [route],
				version: await versions.cursor(),
				url: ORIGIN
			});
			const html = await page(spool, '/courses/c1');
			return /"boot":"([^"]+)"/.exec(html)?.[1];
		};
		const one = await bootOf('<main data-spool-swap>{{row.id}}</main>');
		const two = await bootOf('<main data-spool-swap class="new">{{row.id}}</main>');
		expect(one).toMatch(shapedBoot(0));
		expect(two).toMatch(shapedBoot(0));
		expect(two).not.toBe(one);
	});

	it('at 10,000 rows, the first document names the stored pack and holds the budget', async () => {
		const rows: DatasetRow[] = Array.from({ length: 10_000 }, (_, i) => {
			const id = `c${String(i).padStart(5, '0')}`;
			const next = `/courses/c${String(i + 1).padStart(5, '0')}`;
			return { id, title: `Course ${i}`, links: [next] };
		});
		const { spool, bundles, version } = await serve(rows, 'script');
		const stored = await bundles.get(version);
		const html = await page(spool, '/courses/c00000');
		const start = html.indexOf('<script type="application/json" id="spool-ring">');
		const end = html.indexOf('</script>', start);
		const ring = JSON.parse(html.slice(html.indexOf('>', start) + 1, end)) as Ring;
		expect(ring.complete).toBe(false);
		expect(ring.pack).toEqual({ url: `/.spool/bundle/${version}`, bytes: stored?.length });
		expect(ring.tables['courses']?.length).toBe(ROWS_AT_10K);
		const held = Object.values(ring.tables).flat();
		const bytes = held.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0);
		expect(bytes + JSON.stringify(ring.routes).length).toBeLessThanOrEqual(24_576);
		expect(html.length - PAGE.length - spool.config.clientTag.length).toBe(
			ringElement(ring).length
		);
	});
});

/** rows the default ring holds from the 10,000-row chain (observed on the first green run; L1) */
const ROWS_AT_10K = 220;
