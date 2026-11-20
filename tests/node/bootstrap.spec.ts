import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, parseRing } from '../../src/client/bootstrap';
import { declaredFetch, parseWrites } from '../../src/client/declared';
import { HEADERS } from '../../src/protocol/envelope';
import {
	bootPath,
	BUNDLE_DELTA_PREFIX,
	COOKIES,
	defineDataset,
	type DatasetRow
} from '../../src/protocol/index';
import {
	DELTA_ELEMENT_ID,
	RING_ELEMENT_ID,
	WRITES_ELEMENT_ID,
	type Ring
} from '../../src/protocol/ring';
import { WRITE_HEADERS } from '../../src/protocol/write';
import { CLIENT_CORE, GATE_CORE, NAVIGATE_CORE } from '../../src/server/embedded';
import {
	buildBundle,
	createSpool,
	defineResource,
	defineRoute,
	memoryBundleStore,
	memorySink,
	type Spool
} from '../../src/server/index';
import { buildRing } from '../../src/server/ring';
import { memoryStore } from '../../src/stores/index';
import { createPackStore } from '../../src/sw/index';
import { VERSION } from '../../src/version';
import { freshIndexedDB } from './helpers';

type BootstrapShape = NonNullable<Parameters<typeof bootstrap>[0]['shape']>;

const SOURCE =
	'<!doctype html><html><head><title>{{row.title}}</title></head><body><main data-spool-swap>{{row.title}}</main></body></html>';
const PAGE =
	'<!doctype html><html><head><title>page</title></head><body><main>page</main></body></html>';

const row = (id: string, title: string, pad: number): DatasetRow => ({
	id,
	title,
	body: 'x'.repeat(pad)
});

function courses(rows: { list: DatasetRow[] }) {
	return defineDataset('courses', {
		scope: 'public',
		key: (r) => String(r['id']),
		seed: () => rows.list,
		read: async () => [],
		changes: async () => 'reset' as const,
		horizon: async () => 0,
		head: async () => ({ cursor: 0 }),
		schema: '1',
		maxRows: 100_000,
		maxBytes: 100_000_000
	});
}

/** a site with one family route; `bump` moves the version and the rows change with it */
async function site(
	mode: 'auto' | 'never' | 'always',
	extra: Partial<Parameters<typeof createSpool>[0]> = {}
) {
	const versions = memoryStore();
	const bundles = memoryBundleStore();
	const rows = { list: [row('c1', 'One', 50), row('c2', 'Two', 50)] };
	const datasets = [courses(rows)];
	const routes = [
		defineRoute('/courses/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			family: { dataset: 'courses', key: 'id' },
			load: (ctx) => rows.list.find((r) => r['id'] === ctx.params['id'])
		})
	];
	const spool = createSpool({
		routes,
		store: versions,
		datasets,
		bundles,
		bootstrap: 'second-view',
		workerMode: mode,
		sink: memorySink(),
		...extra
	});
	const build = async () =>
		buildBundle({
			store: bundles,
			datasets,
			routes,
			version: await versions.cursor(),
			url: new URL('http://127.0.0.1/')
		});
	await build();
	const from = await versions.cursor();
	const next = async (replace: DatasetRow[]) => {
		rows.list = replace;
		await versions.bump(['courses']);
		await build();
	};
	const get = (path: string, cookie?: string) =>
		spool.handle(
			new Request(`http://127.0.0.1${path}`, cookie ? { headers: { cookie } } : {}),
			async () =>
				new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
		);
	return { spool, from, next, get, versions, bundles };
}

describe('the inline gate', () => {
	const PLAIN = '<!doctype html><html><head></head><body><main>page</main></body></html>';

	async function page(options: Partial<Parameters<typeof createSpool>[0]> = {}) {
		const spool = createSpool({
			routes: [],
			store: memoryStore(),
			sink: memorySink(),
			...options
		} as Parameters<typeof createSpool>[0]);
		const response = await spool.handle(
			new Request('http://127.0.0.1/page'),
			async () =>
				new Response(PLAIN, { headers: { 'content-type': 'text/html; charset=utf-8' } })
		);
		return response.text();
	}

	type Memory = {
		values: Map<string, string>;
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
	};

	function memory(seed: Record<string, string> = {}): Memory {
		const values = new Map(Object.entries(seed));
		return {
			values,
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => void values.set(key, value)
		};
	}

	type Appended = {
		src?: string;
		integrity?: string;
		crossOrigin?: string;
		onerror?: () => void;
		dataset: Record<string, string>;
	};

	const ORIGIN = 'http://site.test';
	const RING = JSON.stringify({ boot: '/.spool/x/boot/7.js' });

	/** runs the gate as a page at `/courses/c1` would, with a fake document the test drives */
	function runGate(options: {
		storage?: Pick<Memory, 'getItem' | 'setItem'>;
		dataset?: Record<string, string>;
		ring?: string | null;
		/** a worker already controls the page */
		controlled?: boolean;
		/** the browser's user agent, which names its engine; default none */
		userAgent?: string;
	}) {
		const appended: Appended[] = [];
		const assigned: string[] = [];
		const listeners = new Map<string, Array<(event: unknown) => void>>();
		const ready: Array<() => void> = [];
		const ring = options.ring === undefined ? RING : options.ring;
		const doc = {
			currentScript: { dataset: options.dataset ?? { src: '/.spool/x/client.js' } },
			createElement: () => ({ dataset: {} }),
			head: { append: (element: Appended) => void appended.push(element) },
			getElementById: (id: string) =>
				id === RING_ELEMENT_ID && ring !== null ? { textContent: ring } : null,
			addEventListener: (type: string, fn: (event: unknown) => void) =>
				void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
			removeEventListener: (type: string, fn: (event: unknown) => void) =>
				void listeners.set(
					type,
					(listeners.get(type) ?? []).filter((held) => held !== fn)
				)
		};
		const location = {
			origin: ORIGIN,
			pathname: '/courses/c1',
			search: '',
			href: `${ORIGIN}/courses/c1`,
			assign: (url: string) => void assigned.push(url)
		};
		// the fake form hands its fields to URLSearchParams in place of FormData
		const FormData = function (form: { fields: string[][] }) {
			return form.fields;
		};
		new Function(
			'document',
			'localStorage',
			'location',
			'addEventListener',
			'FormData',
			'navigator',
			GATE_CORE
		)(
			doc,
			options.storage ?? memory(),
			location,
			(type: string, fn: () => void) => void (type === 'DOMContentLoaded' && ready.push(fn)),
			FormData,
			{
				serviceWorker: options.controlled ? { controller: {} } : undefined,
				userAgent: options.userAgent ?? ''
			}
		);
		const event = (target: unknown, over: Record<string, unknown> = {}) => {
			const made = {
				target,
				defaultPrevented: false,
				button: 0,
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
				preventDefault: () => void (made.defaultPrevented = true),
				...over
			};
			return made;
		};
		const fire = (type: string, made: { defaultPrevented: boolean }) => {
			for (const fn of listeners.get(type) ?? []) fn(made);
			return made.defaultPrevented;
		};
		return {
			appended,
			assigned,
			listening: (type: string) => (listeners.get(type) ?? []).length,
			domReady: () => ready.forEach((fn) => fn()),
			click(href: string, over: Record<string, unknown> = {}, link: object = {}) {
				const anchor = {
					href: new URL(href, ORIGIN).href,
					target: '',
					hasAttribute: () => false,
					...link
				};
				return fire('click', event({ closest: () => anchor }, over));
			},
			submit(
				action: string,
				fields: string[][],
				method = 'get',
				over: Record<string, unknown> = {}
			) {
				const form = {
					target: '',
					fields,
					getAttribute: (name: string) =>
						name === 'method' ? method : name === 'action' ? action : null
				};
				return fire('submit', event(form, over));
			}
		};
	}

	const HELD = { src: '/.spool/x/client.js', held: '/courses/ ?/search' };

	it('replaces the client tag with the gate on a second-view page', async () => {
		const html = await page();
		expect(html).toContain('data-spool-gate');
		expect(html).not.toMatch(/<script[^>]*data-spool-client/);
	});

	it('keeps the client tag for clientTag script and for first-view', async () => {
		for (const options of [
			{ clientTag: 'script' as const },
			{ bootstrap: 'first-view' as const }
		]) {
			const html = await page(options);
			expect(html).toMatch(/<script src="[^"]*" defer data-spool-client><\/script>/);
			expect(html).not.toContain('data-spool-gate');
		}
	});

	it('names the client, its integrity and the worker mode on the gate element', async () => {
		const html = await page({
			cdn: { url: 'https://cdn.test/client.js', integrity: 'sha384-x' },
			workerMode: 'never'
		});
		expect(html).toContain('data-src="https://cdn.test/client.js"');
		expect(html).toContain('data-integrity="sha384-x"');
		expect(html).toContain('data-spool-worker="never"');
		expect(html).toContain('data-lease="86400"');
	});

	it('refuses an unknown clientTag', () => {
		expect(() =>
			createSpool({
				routes: [],
				store: memoryStore(),
				sink: memorySink(),
				clientTag: 'bogus'
			} as unknown as Parameters<typeof createSpool>[0])
		).toThrow('unknown clientTag "bogus"');
	});

	it('is a script that parses and holds no template literal', () => {
		expect(GATE_CORE).not.toContain('`');
		expect(GATE_CORE).not.toMatch(/<\/script/i);
		expect(() => new Function(GATE_CORE)).not.toThrow();
	});

	it('counts view one, loads nothing and waits for a click or a form', () => {
		const storage = memory();
		const gate = runGate({ storage, dataset: HELD });
		expect(gate.appended).toEqual([]);
		expect(storage.values.get('spool:views')).toBe('1');
		expect(gate.listening('click')).toBe(1);
		expect(gate.listening('submit')).toBe(1);
	});

	it('loads the boot script a held click needs in place of the document, and gives back its count', () => {
		const storage = memory();
		const gate = runGate({ storage, dataset: HELD });
		expect(gate.click('/courses/c2')).toBe(true);
		expect(gate.appended).toHaveLength(1);
		expect(gate.appended[0]?.src).toBe('/.spool/x/boot/7.js');
		expect(gate.appended[0]?.dataset['spoolClient']).toBe('');
		expect((globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__).toEqual({
			to: `${ORIGIN}/courses/c2`
		});
		expect(storage.values.get('spool:boot')).toBe('/.spool/x/boot/7.js');
		expect(storage.values.get('spool:views')).toBe('0');
		expect(gate.listening('click')).toBe(0);
		expect(gate.listening('submit')).toBe(0);
		gate.appended[0]?.onerror?.();
		expect(gate.assigned).toEqual([`${ORIGIN}/courses/c2`]);
		delete (globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__;
	});

	it('leaves a click the held pages cannot answer to the browser', () => {
		const gate = runGate({ dataset: HELD });
		// not under a held prefix, a query string on a family page, a list without one
		expect(gate.click('/about')).toBe(false);
		expect(gate.click('/courses/c2?x=1')).toBe(false);
		expect(gate.click('/search')).toBe(false);
		// the browser's own meanings of a click
		expect(gate.click('/courses/c2', { metaKey: true })).toBe(false);
		expect(gate.click('/courses/c2', { button: 1 })).toBe(false);
		expect(gate.click('/courses/c2', {}, { target: '_blank' })).toBe(false);
		expect(gate.click('/courses/c1#top')).toBe(false);
		expect(gate.click('http://elsewhere.test/courses/c2')).toBe(false);
		expect(gate.appended).toEqual([]);
	});

	it('loads the boot script beside a click a router already took, and leaves the click and the destination to the router', () => {
		const storage = memory();
		const gate = runGate({ storage, dataset: HELD });
		// the router handled the anchor before the document listener ran, so the event is cancelled
		expect(gate.click('/courses/c2', { defaultPrevented: true })).toBe(true);
		expect(gate.appended).toHaveLength(1);
		expect(gate.appended[0]?.src).toBe('/.spool/x/boot/7.js');
		expect(gate.appended[0]?.onerror).toBeUndefined();
		// no destination, since the router keeps the navigation; the flag asks for a worker at once
		expect((globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__).toEqual({
			router: true
		});
		delete (globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__;
		expect(storage.values.get('spool:boot')).toBe('/.spool/x/boot/7.js');
		expect(storage.values.get('spool:views')).toBe('0');
		expect(gate.listening('click')).toBe(0);
		// a cancelled click on a URL the held pages cannot answer loads nothing
		const other = runGate({ dataset: HELD });
		expect(other.click('/about', { defaultPrevented: true })).toBe(true);
		expect(other.click('/courses/c2', { defaultPrevented: true, button: 1 })).toBe(true);
		expect(other.appended).toEqual([]);
	});

	it('loads the boot script beside a GET form a router already took', () => {
		const gate = runGate({ dataset: HELD });
		expect(gate.submit('/search', [['q', 'art']], 'get', { defaultPrevented: true })).toBe(
			true
		);
		expect(gate.appended).toHaveLength(1);
		expect(gate.appended[0]?.onerror).toBeUndefined();
		expect((globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__).toEqual({
			router: true
		});
		delete (globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__;
	});

	it('loads the boot script for a GET form to a list that answers a query, and for nothing else', () => {
		const query = runGate({ dataset: HELD });
		expect(query.submit('/search', [['q', 'art']])).toBe(true);
		expect(query.appended[0]?.src).toBe('/.spool/x/boot/7.js');
		expect((globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__).toEqual({
			to: `${ORIGIN}/search?q=art`
		});
		delete (globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__;
		const post = runGate({ dataset: HELD });
		expect(post.submit('/search', [['q', 'art']], 'post')).toBe(false);
		expect(post.submit('/courses/c2', [['q', 'art']])).toBe(false);
		expect(post.submit('/elsewhere', [['q', 'art']])).toBe(false);
		expect(post.appended).toEqual([]);
	});

	it('loads nothing for a click when the page has no ring or its ring names no boot script', () => {
		for (const ring of [null, '{}', 'not json']) {
			const gate = runGate({ dataset: HELD, ring });
			expect(gate.click('/courses/c2')).toBe(false);
			expect(gate.appended).toEqual([]);
		}
	});

	it('loads the client on a later view of a page whose ring names no boot script, and gives back the count', () => {
		const storage = memory({ 'spool:views': '1' });
		const gate = runGate({ storage, ring: '{}' });
		gate.domReady();
		expect(gate.appended).toHaveLength(1);
		expect(gate.appended[0]?.src).toBe('/.spool/x/client.js');
		expect(storage.values.get('spool:views')).toBe('1');
		const none = runGate({ storage: memory({ 'spool:views': '1' }), ring: null });
		none.domReady();
		expect(none.appended).toHaveLength(1);
	});

	it('waits for a click on a later view when the ring names a boot script', () => {
		const storage = memory({ 'spool:views': '1' });
		const gate = runGate({ storage, dataset: HELD });
		gate.domReady();
		expect(gate.appended).toEqual([]);
		expect(storage.values.get('spool:views')).toBe('2');
	});

	it('loads the boot script on the third counted view with no click, so the worker can register', () => {
		const storage = memory({ 'spool:views': '2' });
		const gate = runGate({ storage, dataset: HELD });
		gate.domReady();
		expect(gate.appended.map((script) => script.src)).toEqual(['/.spool/x/boot/7.js']);
		expect(storage.values.get('spool:views')).toBe('2');
		expect(storage.values.get('spool:boot')).toBe('/.spool/x/boot/7.js');
		expect(gate.listening('click')).toBe(0);
		expect(gate.click('/courses/c2')).toBe(false);
		expect(gate.appended).toHaveLength(1);
	});

	it('loads no boot script on the third view when the page asks for no worker or a worker already controls it', () => {
		const never = runGate({
			storage: memory({ 'spool:views': '2' }),
			dataset: { ...HELD, spoolWorker: 'never' }
		});
		never.domReady();
		expect(never.appended).toEqual([]);
		const controlled = runGate({
			storage: memory({ 'spool:views': '2' }),
			dataset: HELD,
			controlled: true
		});
		controlled.domReady();
		expect(controlled.appended).toEqual([]);
	});

	it('loads no boot script on the third view in WebKit, unless the page says always', () => {
		const third = (userAgent: string, spoolWorker?: string) => {
			const gate = runGate({
				storage: memory({ 'spool:views': '2' }),
				dataset: { ...HELD, ...(spoolWorker ? { spoolWorker } : {}) },
				userAgent
			});
			gate.domReady();
			return gate.appended.map((script) => script.src);
		};
		expect(third(SAFARI_IOS)).toEqual([]);
		expect(third(SAFARI_IOS, 'always')).toEqual(['/.spool/x/boot/7.js']);
		expect(third(CHROME_DESKTOP)).toEqual(['/.spool/x/boot/7.js']);
	});

	it('loads the boot script once when a click came before the document finished', () => {
		const gate = runGate({ storage: memory({ 'spool:views': '2' }), dataset: HELD });
		expect(gate.click('/courses/c2')).toBe(true);
		gate.domReady();
		expect(gate.appended).toHaveLength(1);
	});

	it('loads the stored boot script at once on a later document, from the same runtime version only', () => {
		const same = runGate({
			storage: memory({ 'spool:views': '1', 'spool:boot': '/.spool/x/boot/7.js' }),
			dataset: HELD
		});
		expect(same.appended.map((script) => script.src)).toEqual(['/.spool/x/boot/7.js']);
		expect(same.listening('click')).toBe(0);
		const other = runGate({
			storage: memory({ 'spool:views': '1', 'spool:boot': '/.spool/old/boot/7.js' }),
			dataset: HELD
		});
		expect(other.appended).toEqual([]);
		expect(other.listening('click')).toBe(1);
	});

	it('passes the integrity and the worker mode to the client it loads', () => {
		const gate = runGate({
			storage: memory({ 'spool:views': '1' }),
			ring: '{}',
			dataset: {
				src: 'https://cdn.test/client.js',
				integrity: 'sha384-x',
				spoolWorker: 'never'
			}
		});
		gate.domReady();
		const [client] = gate.appended;
		expect(client).toMatchObject({
			integrity: 'sha384-x',
			crossOrigin: 'anonymous',
			dataset: { spoolClient: '', spoolWorker: 'never' }
		});
	});

	it('waits for a click when storage throws, and still loads the boot script for it', () => {
		const denied = () => {
			throw new Error('denied');
		};
		const gate = runGate({ storage: { getItem: denied, setItem: denied }, dataset: HELD });
		expect(gate.appended).toEqual([]);
		expect(gate.click('/courses/c2')).toBe(true);
		expect(gate.appended).toHaveLength(1);
		delete (globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__;
	});

	describe('the lease window', () => {
		const LEASED = { ...HELD, lease: '86400' };
		const DAY = 86_400_000;
		const T0 = Date.UTC(2026, 10, 19, 9);

		afterEach(() => vi.useRealTimers());

		function visit(storage: Memory, at: number, dataset: Record<string, string> = LEASED) {
			vi.setSystemTime(at);
			const gate = runGate({ storage, dataset });
			gate.domReady();
			return gate.appended.map((script) => script.src);
		}

		it('loads no boot script for five views one lease apart', () => {
			vi.useFakeTimers();
			const storage = memory();
			for (let day = 0; day < 5; day++) expect(visit(storage, T0 + day * DAY)).toEqual([]);
			expect(storage.values.get('spool:stamps')).toBe(String(T0 + 4 * DAY));
		});

		it('loads the boot script on the third view inside one lease', () => {
			vi.useFakeTimers();
			const storage = memory();
			expect(visit(storage, T0)).toEqual([]);
			expect(visit(storage, T0 + 3_600_000)).toEqual([]);
			expect(visit(storage, T0 + 7_200_000)).toEqual(['/.spool/x/boot/7.js']);
			expect(storage.values.get('spool:stamps')).toBe(`${T0},${T0 + 3_600_000}`);
		});

		it('counts a stamp in the future as outside the window', () => {
			vi.useFakeTimers();
			const storage = memory({ 'spool:stamps': [T0 + DAY, T0 + 1_000].join() });
			expect(visit(storage, T0 + 2_000)).toEqual([]);
		});

		it('counts a corrupt stamp value as zero, and a lease of 0 as the lifetime count', () => {
			vi.useFakeTimers();
			expect(visit(memory({ 'spool:stamps': 'oops' }), T0, LEASED)).toEqual([]);
			const storage = memory({ 'spool:views': '2' });
			expect(visit(storage, T0, { ...HELD, lease: '0' })).toEqual(['/.spool/x/boot/7.js']);
		});
	});
});

describe('the boot script', () => {
	const ringOf = (html: string): Ring => JSON.parse(elementText(html, RING_ELEMENT_ID) ?? 'null');

	it('is named by the ring of a family page, and the gate lists the paths a click may boot for', async () => {
		const held = await site('auto');
		const html = await (await held.get('/courses/c1')).text();
		expect(ringOf(html).boot?.split('?')[0]).toBe(bootPath(VERSION, held.from));
		expect(html).toContain('data-held="/courses/"');
	});

	it('is named by no ring and no gate when the runtime has its own tag', async () => {
		for (const extra of [
			{ clientTag: 'script' as const },
			{ bootstrap: 'first-view' as const },
			{ cdn: { url: 'https://cdn.test/client.js', integrity: 'sha384-x' } }
		]) {
			const own = await site('auto', extra);
			const html = await (await own.get('/courses/c1')).text();
			expect(ringOf(html).boot).toBeUndefined();
			expect(html).not.toContain('data-held');
			expect((await own.get(bootPath(VERSION, own.from))).status).toBe(404);
		}
	});

	it('carries the runtime, the navigation script and the pack of its version in one response', async () => {
		const held = await site('auto');
		const response = await held.get(bootPath(VERSION, held.from));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/javascript');
		expect(response.headers.get('cache-control')).toContain('immutable');
		const text = await response.text();
		const pack = await held.bundles.get(held.from);
		const given =
			/^(?:\(globalThis\.__SPOOL_BOOT__=globalThis\.__SPOOL_BOOT__\|\|\{\}\)\.shape=[^\n]*?\};)?\(globalThis\.__SPOOL_BOOT__=globalThis\.__SPOOL_BOOT__\|\|\{\}\)\.pack=\{version:(\d+),data:"([^"]*)"\};\n/.exec(
				text
			);
		expect(Number(given?.[1])).toBe(held.from);
		expect(Buffer.from(given?.[2] ?? '', 'base64')).toEqual(Buffer.from(pack ?? []));
		expect(text.endsWith(`${NAVIGATE_CORE}\n${CLIENT_CORE}`)).toBe(true);
	});

	it('answers 404 for a version the store does not hold or a name that is not a version', async () => {
		const held = await site('auto');
		for (const name of ['99', 'x', '1.5']) {
			expect(
				(await held.get(bootPath(VERSION, held.from).replace(/\d+\.js$/, `${name}.js`)))
					.status
			).toBe(404);
		}
	});

	it('installs the pack it carries with no request, on view one, when the ring is at its version', async () => {
		const store = fakeStore(undefined);
		const data = Buffer.from([1, 2, 3]).toString('base64');
		let fetched = 0;
		await bootstrap({
			store: store as never,
			doc: doc({ ring: JSON.stringify(ring()) }),
			storage: memory(),
			userAgent: CHROME,
			fetch: (async () => void fetched++) as never,
			cookie: () => undefined,
			pack: { version: 2, data }
		}).installed;
		expect(store.calls).toEqual(['ring', 'pack', 'routes']);
		expect(fetched).toBe(0);
	});

	it('ignores a carried pack of another version, and fetches nothing on view one', async () => {
		const store = fakeStore(undefined);
		let fetched = 0;
		await bootstrap({
			store: store as never,
			doc: doc({ ring: JSON.stringify(ring()) }),
			storage: memory(),
			userAgent: CHROME,
			fetch: (async () => void fetched++) as never,
			cookie: () => undefined,
			pack: { version: 1, data: Buffer.from([1]).toString('base64') }
		}).installed;
		expect(store.calls).toEqual(['ring']);
		expect(fetched).toBe(0);
	});

	describe('the routes and templates it carries', () => {
		const BOOT = '/.spool/x/boot/2.js?r=abc123';
		const SHAPE = {
			id: 'abc123',
			routes: [{ pattern: '/a/:id' }] as never,
			templates: { '/a/:id': { carried: true } } as never
		};
		const slim = (over: Partial<Ring> = {}): Ring => {
			const { routes, templates, ...rest } = ring({ boot: BOOT, ...over });
			void routes;
			void templates;
			return rest;
		};
		const run = (held: Ring, shape: typeof SHAPE | undefined, storage = memory()) => {
			const store = fakeStore(undefined);
			const result = bootstrap({
				store: store as never,
				doc: doc({ ring: JSON.stringify(held) }),
				storage,
				userAgent: CHROME,
				cookie: () => undefined,
				pack: { version: 2, data: Buffer.from([1, 2, 3]).toString('base64') },
				...(shape ? { shape } : {})
			});
			return { store, storage, result };
		};

		it('are the ones the store gets when the ring names none, and the page may navigate', async () => {
			const { store, result } = run(slim(), SHAPE);
			await result.installed;
			expect(result.current).toBe(true);
			expect(store.rings[0]).toMatchObject({
				routes: SHAPE.routes,
				templates: SHAPE.templates
			});
			expect(store.routed).toEqual([{ routes: SHAPE.routes, templates: SHAPE.templates }]);
		});

		it('refresh the routes of a held head at the same version', async () => {
			const store = fakeStore({ version: 2 });
			const result = bootstrap({
				store: store as never,
				doc: doc({ ring: JSON.stringify(slim()) }),
				storage: memory(),
				userAgent: CHROME,
				cookie: () => undefined,
				shape: SHAPE
			});
			await result.installed;
			expect(store.calls).toEqual(['routes']);
			expect(store.routed).toEqual([{ routes: SHAPE.routes, templates: SHAPE.templates }]);
		});

		it('are not used when they were built for another boot script: nothing installs, the page does not navigate and the stored boot script is dropped', async () => {
			const storage = memory();
			storage.setItem('spool:boot', '/.spool/x/boot/1.js?r=old');
			const { store, result } = run(slim(), { ...SHAPE, id: 'old' }, storage);
			await result.installed;
			expect(result.current).toBe(false);
			expect(store.calls).toEqual([]);
			expect(storage.values.get('spool:boot')).toBe('');
		});

		it('are missing from an old boot script, which is treated as another boot script', async () => {
			const { store, result } = run(slim(), undefined);
			await result.installed;
			expect(result.current).toBe(false);
			expect(store.calls).toEqual([]);
		});

		it('lose to the routes a ring carries itself, as when an older page meets a newer boot script', async () => {
			const own = ring({ boot: BOOT, routes: [{ pattern: '/own' }] as never, templates: {} });
			const { store, result } = run(own, { ...SHAPE, id: 'other' });
			await result.installed;
			expect(result.current).toBe(true);
			expect(store.rings[0]).toMatchObject({ routes: own.routes });
		});

		it('are optional in a ring, and a ring that carries them wrongly is still refused', () => {
			expect(parseRing(JSON.stringify(slim()))).not.toBeNull();
			expect(parseRing(JSON.stringify({ ...slim(), routes: {} }))).toBeNull();
			expect(parseRing(JSON.stringify({ ...slim(), templates: [] }))).toBeNull();
		});
	});
});

describe('the no-worker server', () => {
	it('answers the worker script with 404 and names no worker on a page', async () => {
		const never = await site('never');
		const script = await never.get('/spool-sw.js');
		expect(script.status).toBe(404);
		const html = await (await never.get('/courses/c1')).text();
		expect(html).not.toContain('spool-sw.js');
		expect(html).toContain('data-spool-worker="never"');
	});

	it('serves the worker script and no worker tag in auto mode', async () => {
		const auto = await site('auto');
		expect((await auto.get('/spool-sw.js')).status).toBe(200);
		expect(await (await auto.get('/courses/c1')).text()).not.toContain('data-spool-worker');
	});

	it('puts no delta on a page whose cookie names the current version, or no cookie', async () => {
		const held = await site('never');
		const plain = await held.get('/courses/c1');
		expect(await plain.text()).not.toContain(DELTA_ELEMENT_ID);
		const current = await held.get('/courses/c1', `${COOKIES.held}=${held.from}`);
		expect(await current.text()).not.toContain(DELTA_ELEMENT_ID);
	});

	it('inlines the delta from the held version when it fits', async () => {
		const held = await site('never');
		const from = held.from;
		await held.next([row('c1', 'One again', 50), row('c2', 'Two', 50)]);
		const to = await held.versions.cursor();
		const html = await (await held.get('/courses/c1', `${COOKIES.held}=${from}`)).text();
		expect(html).toContain(`id="${DELTA_ELEMENT_ID}"`);
		const body =
			/<script type="application\/json" id="spool-delta"[^>]*>([^<]*)<\/script>/.exec(
				html
			)?.[1];
		expect(JSON.parse(body ?? 'null')).toMatchObject({ from, to });
		expect(html).toContain(`data-from="${from}" data-to="${to}"`);
	});

	it('leaves a pointer with no body when the delta is past the header threshold', async () => {
		const held = await site('never');
		const from = held.from;
		await held.next([row('c1', 'One', 40_000), row('c2', 'Two', 50)]);
		const to = await held.versions.cursor();
		const html = await (await held.get('/courses/c1', `${COOKIES.held}=${from}`)).text();
		const element = /<script type="application\/json" id="spool-delta"([^>]*)><\/script>/.exec(
			html
		);
		expect(element?.[1]).toContain(`data-from="${from}" data-to="${to}"`);
	});

	it('adds the inline delta in auto mode only to a request whose cookie names an older version', async () => {
		const auto = await site('auto');
		const from = auto.from;
		await auto.next([row('c1', 'One again', 50), row('c2', 'Two', 50)]);
		const held = await auto.get('/courses/c1', `${COOKIES.held}=${from}`);
		expect(await held.text()).toContain(`id="${DELTA_ELEMENT_ID}"`);
		expect(held.headers.get('vary')).toContain('cookie');
		const other = await auto.get('/courses/c1', 'a=1');
		expect(await other.text()).not.toContain(DELTA_ELEMENT_ID);
		expect(other.headers.get('vary') ?? '').not.toContain('cookie');
		expect(await (await auto.get('/courses/c1')).text()).not.toContain(DELTA_ELEMENT_ID);
	});

	it('adds no inline delta in always mode, whatever the cookie says', async () => {
		const always = await site('always');
		const from = always.from;
		await always.next([row('c1', 'One again', 50), row('c2', 'Two', 50)]);
		const html = await (await always.get('/courses/c1', `${COOKIES.held}=${from}`)).text();
		expect(html).not.toContain(DELTA_ELEMENT_ID);
	});

	it('serves the worker script in always mode, and names it on the ring and the gate as a flag over auto', async () => {
		const always = await site('always');
		expect((await always.get('/spool-sw.js')).status).toBe(200);
		const html = await (await always.get('/courses/c1')).text();
		expect(html).toContain('data-spool-worker="always"');
		const held = parseRing(elementText(html, RING_ELEMENT_ID));
		expect(held).toMatchObject({ worker: 'auto', webkitWorker: true });
		const auto = await (await (await site('auto')).get('/courses/c1')).text();
		expect(parseRing(elementText(auto, RING_ELEMENT_ID))).not.toHaveProperty('webkitWorker');
	});

	it('serves the delta route with the same pack it inlines', async () => {
		const held = await site('never');
		const from = held.from;
		await held.next([row('c1', 'One again', 50), row('c2', 'Two', 50)]);
		const to = await held.versions.cursor();
		const route = await held.spool.handle(
			new Request(`http://127.0.0.1${BUNDLE_DELTA_PREFIX}${from}/${to}`),
			async () => new Response('no', { status: 404 })
		);
		expect(route.status).toBe(200);
		expect(await route.json()).toMatchObject({ from, to });
	});
});

const ORIGIN = 'http://127.0.0.1';

/** a site whose rows are a declared resource, so a PATCH to a row is a declared write */
async function writeSite(extra: Partial<Parameters<typeof createSpool>[0]> = {}) {
	const versions = memoryStore();
	const bundles = memoryBundleStore();
	const rows = { list: [row('c1', 'One', 50), row('c2', 'Two', 50)] };
	const datasets = [courses(rows)];
	const resource = defineResource('/courses', { dataset: 'courses', key: 'id' });
	const news = defineRoute('/news', {
		strategy: 'template',
		template: { source: SOURCE },
		load: () => ({ title: 'News', body: 'x' })
	});
	const spool = createSpool({
		routes: [news],
		resources: [resource],
		store: versions,
		datasets,
		bundles,
		bootstrap: 'second-view',
		workerMode: 'never',
		sink: memorySink(),
		...extra
	});
	await buildBundle({
		store: bundles,
		datasets,
		routes: resource.routes,
		version: await versions.cursor(),
		url: new URL(`${ORIGIN}/`)
	});
	const app = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		const target = rows.list.find((r) => `/courses/${String(r['id'])}` === pathname);
		if (request.method !== 'PATCH' || !target)
			return new Response('not found', { status: 404 });
		Object.assign(target, await request.json());
		return Response.json(target);
	};
	const page = await spool.handle(
		new Request(`${ORIGIN}/courses/c1`),
		async () =>
			new Response('<!doctype html><html><head></head><body></body></html>', {
				headers: { 'content-type': 'text/html; charset=utf-8' }
			})
	);
	const ringText = /<script type="application\/json" id="spool-ring">([^<]*)<\/script>/.exec(
		await page.text()
	)?.[1];
	return { spool, app, rows, ringText, ring: parseRing(ringText), versions };
}

/** a page store that holds the site as the page's own second view leaves it: the ring, then the pack */
async function heldStore(site: Awaited<ReturnType<typeof writeSite>>) {
	const store = createPackStore(freshIndexedDB());
	const doc = {
		getElementById: (id: string) =>
			id === RING_ELEMENT_ID ? { textContent: site.ringText } : null
	} as unknown as Document;
	const fetchOwn = (async (input: RequestInfo | URL) =>
		site.spool.handle(new Request(new URL(String(input), ORIGIN)), site.app)) as typeof fetch;
	const boot = await (await fetchOwn(site.ring?.boot ?? '')).text();
	const handed: { __SPOOL_BOOT__?: { shape?: BootstrapShape } } = {};
	new Function('globalThis', boot.slice(0, boot.indexOf('\n') + 1))(handed);
	await bootstrap({
		store,
		doc,
		// two earlier views inside the lease period, so this page is the third and holds the pack
		storage: {
			getItem: (key: string) =>
				key === 'spool:stamps' ? [Date.now() - 2_000, Date.now() - 1_000].join() : '1',
			setItem: () => undefined
		},
		fetch: fetchOwn,
		userAgent: 'Firefox',
		...(handed.__SPOOL_BOOT__?.shape ? { shape: handed.__SPOOL_BOOT__.shape } : {})
	}).installed;
	return store;
}

/** the response a spool serves for `path` when the origin answers with the plain page */
function servedPage(spool: Spool, path: string): Promise<Response> {
	return spool.handle(
		new Request(`${ORIGIN}${path}`),
		async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
	);
}

/** the text of the JSON script element `id` in `html`, or undefined */
function elementText(html: string, id: string): string | undefined {
	return new RegExp(`<script type="application/json" id="${id}">([^<]*)</script>`).exec(
		html
	)?.[1];
}

describe('a template change under the same version', () => {
	it('reaches a device that holds the pack, with the same version and rows', async () => {
		const versions = memoryStore();
		const bundles = memoryBundleStore();
		const rows = { list: [row('c1', 'One', 50), row('c2', 'Two', 50)] };
		const datasets = [courses(rows)];
		const serve = (source: string) => {
			const routes = [
				defineRoute('/courses/:id', {
					strategy: 'template',
					template: { source },
					family: { dataset: 'courses', key: 'id' },
					load: (ctx) => rows.list.find((r) => r['id'] === ctx.params['id'])
				})
			];
			const spool = createSpool({
				routes,
				store: versions,
				datasets,
				bundles,
				bootstrap: 'second-view',
				workerMode: 'never',
				sink: memorySink()
			});
			const publish = async () =>
				buildBundle({
					store: bundles,
					datasets,
					routes,
					version: await versions.cursor(),
					url: new URL(`${ORIGIN}/`)
				});
			return { spool, publish };
		};
		const pageRing = async (spool: ReturnType<typeof serve>['spool']) => {
			const page = await spool.handle(
				new Request(`${ORIGIN}/courses/c1`),
				async () =>
					new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
			);
			return parseRing(
				/<script type="application\/json" id="spool-ring">([^<]*)<\/script>/.exec(
					await page.text()
				)?.[1]
			);
		};
		const fetchFrom =
			(spool: ReturnType<typeof serve>['spool']) => async (input: RequestInfo | URL) =>
				spool.handle(
					new Request(new URL(String(input), ORIGIN)),
					async () => new Response('not found', { status: 404 })
				);
		/** the routes and templates the ring's boot script carries, read as the page would */
		const shapeOf = async (ring: Ring, spool: ReturnType<typeof serve>['spool']) => {
			const text = await (await fetchFrom(spool)(ring.boot ?? '')).text();
			const handed: { __SPOOL_BOOT__?: { shape?: BootstrapShape } } = {};
			new Function('globalThis', text.slice(0, text.indexOf('\n') + 1))(handed);
			return handed.__SPOOL_BOOT__?.shape as BootstrapShape;
		};
		const hold = (
			store: ReturnType<typeof createPackStore>,
			ring: Ring,
			spool: ReturnType<typeof serve>['spool'],
			shape: BootstrapShape
		) => {
			const doc = {
				getElementById: (id: string) =>
					id === RING_ELEMENT_ID ? { textContent: JSON.stringify(ring) } : null
			} as unknown as Document;
			return bootstrap({
				store,
				doc,
				storage: { getItem: () => '1', setItem: () => undefined },
				fetch: fetchFrom(spool) as typeof fetch,
				userAgent: 'Firefox',
				shape
			}).installed;
		};
		const first = serve(SOURCE);
		await first.publish();
		const store = createPackStore(freshIndexedDB());
		const firstRing = await pageRing(first.spool);
		if (!firstRing) throw new Error('no ring on the first page');
		const firstShape = await shapeOf(firstRing, first.spool);
		await hold(store, firstRing, first.spool, firstShape);
		expect(await store.getTemplates()).toEqual(firstShape.templates);

		const second = serve(
			SOURCE.replace('<main data-spool-swap>', '<main data-spool-swap class="new">')
		);
		await second.publish();
		const secondRing = await pageRing(second.spool);
		if (!secondRing) throw new Error('no ring on the second page');
		expect(secondRing.version).toBe(firstRing.version);
		const secondShape = await shapeOf(secondRing, second.spool);
		expect(secondShape.templates).not.toEqual(firstShape.templates);
		await hold(store, secondRing, second.spool, secondShape);
		expect(await store.getTemplates()).toEqual(secondShape.templates);
	});
});

describe('the ring and the site policy', () => {
	const CSP = "default-src 'self'";
	const cspApp = async () =>
		new Response(PAGE, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy': CSP,
				'x-secret': 'no'
			}
		});

	it('keeps the page security headers out of the ring, so page markup cannot set a policy', async () => {
		const { spool } = await site('auto');
		const html = await (await spool.handle(new Request(`${ORIGIN}/courses/c1`), cspApp)).text();
		const ring = parseRing(elementText(html, RING_ELEMENT_ID));
		expect(ring).not.toBeNull();
		expect(ring && 'policy' in ring).toBe(false);
	});

	it('never builds a ring for a principal family route, so it carries no policy', () => {
		const route = defineRoute('/me/:id', {
			strategy: 'template',
			template: { source: SOURCE },
			scope: 'principal',
			family: { dataset: 'courses', key: 'id' },
			load: () => ({})
		});
		const built = buildRing({
			path: '/me/c1',
			version: 1,
			digest: '0'.repeat(64),
			routes: [route],
			tables: { courses: [['c1', row('c1', 'One', 50)]] },
			packBytes: 1,
			ringBytes: 100_000,
			bootstrap: 'second-view',
			worker: 'auto'
		});
		expect(built).toBeUndefined();
	});
});

describe('declared writes on the no-worker page', () => {
	it('carries the declared resource writes in the ring, and none without a resource', async () => {
		const declared = await writeSite();
		expect(declared.ring?.writes?.map((write) => `${write.method} ${write.pattern}`)).toContain(
			'PATCH /courses/:id'
		);
		const plain = await site('never');
		const html = await (await plain.get('/courses/c1')).text();
		const text = /<script type="application\/json" id="spool-ring">([^<]*)<\/script>/.exec(
			html
		)?.[1];
		expect(parseRing(text)).not.toBeNull();
		expect(parseRing(text)?.writes).toBeUndefined();
	});

	it('puts the writes element on a non-family public page of a site with its own client tag, and no ring', async () => {
		const declared = await writeSite({ clientTag: 'script' });
		const html = await (await servedPage(declared.spool, '/news')).text();
		expect(elementText(html, RING_ELEMENT_ID)).toBeUndefined();
		expect(parseWrites(elementText(html, WRITES_ELEMENT_ID))).toEqual(declared.ring?.writes);
	});

	it('carries the writes in the ring of a non-family public page of a gate site, with no writes element', async () => {
		const declared = await writeSite();
		const html = await (await servedPage(declared.spool, '/news')).text();
		expect(parseRing(elementText(html, RING_ELEMENT_ID))?.writes).toEqual(
			declared.ring?.writes
		);
		expect(html).not.toContain(WRITES_ELEMENT_ID);
	});

	it('keeps the writes in the ring of a family page, with no writes element', async () => {
		const declared = await writeSite();
		const html = await (await servedPage(declared.spool, '/courses/c1')).text();
		expect(elementText(html, RING_ELEMENT_ID)).toBeDefined();
		expect(html).not.toContain(WRITES_ELEMENT_ID);
	});

	it('puts neither element on a site with no declared writes and its own client tag', async () => {
		const plain = await site('never', { clientTag: 'script' });
		const html = await (await plain.get('/elsewhere')).text();
		expect(html).not.toContain(WRITES_ELEMENT_ID);
		expect(elementText(html, RING_ELEMENT_ID)).toBeUndefined();
	});

	it('settles a PATCH from a page with no ring, through the writes element', async () => {
		const declared = await writeSite({ clientTag: 'script' });
		const store = await heldStore(declared);
		const html = await (await servedPage(declared.spool, '/news')).text();
		const writes = parseWrites(elementText(html, WRITES_ELEMENT_ID));
		const from = (await store.head())?.version ?? -1;
		const sent: string[] = [];
		const haves: Array<string | null> = [];
		const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(new URL(String(input), ORIGIN), init);
			sent.push(`${request.method} ${new URL(request.url).pathname}`);
			haves.push(request.headers.get(HEADERS.have));
			const response = await declared.spool.handle(request, declared.app);
			Object.defineProperty(response, 'url', { value: request.url });
			return response;
		}) as typeof fetch;
		const send = declaredFetch({ store, writes, origin: ORIGIN, fetch: fake });
		const response = await send(`${ORIGIN}/courses/c1`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'One again' })
		});
		expect(response.status).toBe(200);
		expect(sent).toEqual(['PATCH /courses/c1']);
		expect(haves).toEqual([String(from)]);
		expect((await store.getRow('courses', 'c1'))?.['title']).toBe('One again');
	});

	it('refuses a ring whose writes are not a list', () => {
		expect(parseRing(JSON.stringify({ protocol: 1, writes: 'PATCH' }))).toBeNull();
	});

	it('sends a PATCH with the held version and settles its delta: one request, the held row changes', async () => {
		const site = await writeSite();
		const { spool, app, ring } = site;
		const store = await heldStore(site);
		const from = (await store.head())?.version ?? -1;
		const sent: string[] = [];
		const haves: Array<string | null> = [];
		const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(new URL(String(input), ORIGIN), init);
			sent.push(`${request.method} ${new URL(request.url).pathname}`);
			haves.push(request.headers.get(HEADERS.have));
			const response = await spool.handle(request, app);
			Object.defineProperty(response, 'url', { value: request.url });
			return response;
		}) as typeof fetch;
		const send = declaredFetch({
			store,
			writes: ring?.writes ?? [],
			origin: ORIGIN,
			fetch: fake
		});
		const response = await send(`${ORIGIN}/courses/c1`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'One again' })
		});
		expect(response.status).toBe(200);
		expect(sent).toEqual(['PATCH /courses/c1']);
		expect(haves).toEqual([String(from)]);
		expect((await store.getRow('courses', 'c1'))?.['title']).toBe('One again');
	});

	it('a digest mismatch costs exactly one delta fetch, and the held row takes the server version', async () => {
		const site = await writeSite();
		const { spool, app, ring } = site;
		const store = await heldStore(site);
		const sent: string[] = [];
		const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(new URL(String(input), ORIGIN), init);
			sent.push(`${request.method} ${new URL(request.url).pathname}`);
			const response = await spool.handle(request, app);
			if (request.method !== 'PATCH') {
				Object.defineProperty(response, 'url', { value: request.url });
				return response;
			}
			const headers = new Headers(response.headers);
			headers.delete(HEADERS.delta);
			headers.set(WRITE_HEADERS.digest, '0'.repeat(64));
			const altered = new Response(await response.text(), {
				status: response.status,
				headers
			});
			Object.defineProperty(altered, 'url', { value: request.url });
			return altered;
		}) as typeof fetch;
		const send = declaredFetch({
			store,
			writes: ring?.writes ?? [],
			origin: ORIGIN,
			fetch: fake
		});
		await send(`${ORIGIN}/courses/c1`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'One again' })
		});
		expect(sent).toHaveLength(2);
		expect(sent[0]).toBe('PATCH /courses/c1');
		expect(sent[1]?.startsWith(`GET ${BUNDLE_DELTA_PREFIX}`)).toBe(true);
		expect((await store.getRow('courses', 'c1'))?.['title']).toBe('One again');
	});

	it('passes a request that matches no declared write to fetch unchanged', async () => {
		const site = await writeSite();
		const { spool, app, ring } = site;
		const store = await heldStore(site);
		const before = await store.head();
		const sent: string[] = [];
		const haves: Array<string | null> = [];
		const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(new URL(String(input), ORIGIN), init);
			sent.push(`${request.method} ${new URL(request.url).pathname}`);
			haves.push(request.headers.get(HEADERS.have));
			return spool.handle(request, app);
		}) as typeof fetch;
		const send = declaredFetch({
			store,
			writes: ring?.writes ?? [],
			origin: ORIGIN,
			fetch: fake
		});
		await send(`${ORIGIN}/elsewhere`, { method: 'PATCH', body: '{}' });
		expect(sent).toEqual(['PATCH /elsewhere']);
		expect(haves).toEqual([null]);
		expect(await store.head()).toEqual(before);
	});
});

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const PACK = '/.spool/bundle/2';

const SAFARI_IOS =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME_DESKTOP =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** [name, user agent, whether the engine is WebKit] */
const AGENTS: Array<[string, string, boolean]> = [
	[
		'Safari on macOS',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
		true
	],
	['Safari on iOS', SAFARI_IOS, true],
	[
		'Chrome on iOS',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
		true
	],
	[
		'Firefox on iOS',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15',
		true
	],
	[
		'Edge on iOS',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.2592.87 Version/18.0 Mobile/15E148 Safari/605.1.15',
		true
	],
	['Chrome on desktop', CHROME_DESKTOP, false],
	[
		'headless Chrome',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
		false
	],
	[
		'Firefox on desktop',
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
		false
	],
	[
		'Edge on desktop',
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
		false
	],
	[
		'Chrome on Android',
		'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
		false
	],
	[
		'Firefox on Android',
		'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
		false
	]
];

const ring = (over: Partial<Ring> = {}): Ring => ({
	protocol: 1,
	version: 2,
	digest: '0'.repeat(64),
	routes: [],
	templates: {},
	tables: {},
	complete: false,
	bootstrap: 'second-view',
	worker: 'never',
	pack: { url: PACK, bytes: 1000 },
	...over
});

const memory = () => {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value)
	};
};

/** a document with an optional ring element, an optional delta element and a never tag */
function doc(options: { ring?: string | null; delta?: string | null; never?: boolean } = {}) {
	const element = (text: string | null | undefined, id: string) =>
		text === null || text === undefined
			? null
			: { textContent: text, getAttribute: () => null };
	return {
		getElementById: (id: string) => {
			if (id === RING_ELEMENT_ID) return element(options.ring, id);
			if (id === DELTA_ELEMENT_ID) return deltaElement(options.delta);
			return null;
		},
		querySelector: (selector: string) =>
			options.never && selector === 'script[data-spool-worker="never"]' ? {} : null
	} as never;
}

function deltaElement(text: string | null | undefined) {
	if (text === null || text === undefined) return null;
	return {
		textContent: text,
		getAttribute: (name: string) =>
			name === 'data-from' ? '1' : name === 'data-to' ? '2' : null
	};
}

type Deltas = { from: number; to: number; tables: Record<string, never>; digest: string };
const DELTA: Deltas = { from: 1, to: 2, tables: {}, digest: '0'.repeat(64) };

/** a store that holds a head at `head` (complete unless `partial`) and records each call */
function fakeStore(head: { version: number; partial?: boolean } | undefined) {
	const calls: string[] = [];
	const rings: Ring[] = [];
	const routed: Array<{ routes: unknown; templates: unknown }> = [];
	let current = head;
	const store = {
		calls,
		rings,
		routed,
		head: async () =>
			current && {
				version: current.version,
				partial: current.partial,
				digest: '0'.repeat(64),
				generation: 1,
				blockRows: 128,
				codec: 'gzip',
				tables: []
			},
		installRing: async (held: Ring) => {
			calls.push('ring');
			rings.push(held);
			current = { version: 2, partial: true };
			return { installed: true, version: 2, rows: 0, complete: false };
		},
		estimateBeforeInstall: async () => ({ checked: true, fits: true }),
		installPack: async (source: AsyncIterable<Uint8Array>) => {
			calls.push('pack');
			for await (const chunk of source) void chunk;
			current = { version: 2 };
			return { installed: true };
		},
		putRoutes: async (routes: unknown, templates: unknown) => {
			calls.push('routes');
			routed.push({ routes, templates });
		},
		applyDelta: async (delta: Deltas) => {
			calls.push(`delta ${delta.from}>${delta.to}`);
			current = { version: delta.to };
		}
	};
	return store;
}

describe('the no-worker page', () => {
	it('registers no worker on any view of a never ring', async () => {
		const store = fakeStore(undefined);
		const storage = memory();
		const views = [] as boolean[];
		for (let view = 1; view <= 3; view++) {
			views.push(
				bootstrap({
					store: store as never,
					doc: doc({ ring: JSON.stringify(ring()) }),
					storage,
					userAgent: CHROME,
					cookie: () => undefined
				}).worker
			);
		}
		expect(views).toEqual([false, false, false]);
	});

	it('registers the worker on view 1 when a router took the click that loaded the boot script, and not otherwise', () => {
		const options = {
			store: fakeStore(undefined) as never,
			doc: doc({ ring: JSON.stringify(ring({ worker: 'auto' })) }),
			userAgent: CHROME,
			cookie: () => undefined
		};
		expect(bootstrap({ ...options, storage: memory() }).worker).toBe(false);
		expect(bootstrap({ ...options, storage: memory(), router: true }).worker).toBe(true);
		// a page that must not ask for a worker still does not
		const never = doc({ ring: JSON.stringify(ring({ worker: 'never' })) });
		expect(bootstrap({ ...options, doc: never, storage: memory(), router: true }).worker).toBe(
			false
		);
	});

	it('registers no worker on a page with no ring when the page names never', async () => {
		const result = bootstrap({
			store: fakeStore(undefined) as never,
			doc: doc({ never: true }),
			storage: memory(),
			userAgent: CHROME,
			cookie: () => undefined
		});
		expect(result.worker).toBe(false);
	});

	describe('the WebKit default', () => {
		const auto = (over: Partial<Ring> = {}) =>
			JSON.stringify(ring({ worker: 'auto', bootstrap: 'first-view', ...over }));
		const run = (held: string | null, userAgent: string) =>
			bootstrap({
				store: fakeStore(undefined) as never,
				doc: doc({ ring: held }),
				storage: memory(),
				userAgent,
				fetch: (async () => new Response(new Uint8Array([1]))) as never,
				cookie: () => undefined
			});

		it.each(AGENTS)(
			'on %s an auto ring page registers the worker unless the engine is WebKit',
			(_name, agent, webkit) => {
				expect(run(auto(), agent).worker).toBe(!webkit);
			}
		);

		it('registers the worker in WebKit when the ring says the site chose always', () => {
			for (const [, agent] of AGENTS) {
				expect(run(auto({ webkitWorker: true }), agent).worker).toBe(true);
			}
		});

		it('keeps the registration of a never ring off in every engine, always or not', () => {
			for (const [, agent] of AGENTS) {
				expect(run(auto({ worker: 'never', webkitWorker: true }), agent).worker).toBe(
					false
				);
			}
		});

		it('registers the worker in WebKit on a page with no ring, where no pack can answer', () => {
			expect(run(null, SAFARI_IOS).worker).toBe(true);
		});

		it('still installs the pack and holds its version in the cookie', async () => {
			const cookies: string[] = [];
			const store = fakeStore(undefined);
			await bootstrap({
				store: store as never,
				doc: doc({ ring: auto() }),
				storage: memory(),
				userAgent: SAFARI_IOS,
				fetch: (async () => new Response(new Uint8Array([1]))) as never,
				cookie: (value: string) => void cookies.push(value)
			}).installed;
			expect(store.calls).toEqual(['ring', 'pack', 'routes']);
			expect(cookies).toEqual([`${COOKIES.held}=2; path=/; max-age=604800; samesite=lax`]);
		});

		it('still reads a ring that carries the always flag, as a client that predates it does', () => {
			// the earlier check listed these fields only, so the extra one is ignored and worker is auto
			const held = parseRing(auto({ webkitWorker: true }));
			expect(held).toMatchObject({ worker: 'auto', webkitWorker: true });
			expect(
				parseRing(JSON.stringify({ ...ring({ worker: 'auto' }), extra: 1 }))
			).not.toBeNull();
		});
	});

	it('writes the held cookie after a pack installs, and not after the ring alone', async () => {
		const cookies: string[] = [];
		const storage = memory();
		const store = fakeStore(undefined);
		const options = {
			store: store as never,
			doc: doc({ ring: JSON.stringify(ring()) }),
			storage,
			userAgent: CHROME,
			fetch: (async () => new Response(new Uint8Array([1]))) as never,
			cookie: (value: string) => void cookies.push(value)
		};
		await bootstrap(options).installed;
		expect(cookies).toEqual([]);
		await bootstrap(options).installed;
		expect(cookies).toEqual([`${COOKIES.held}=2; path=/; max-age=604800; samesite=lax`]);
	});

	it('applies an inline delta to a complete head before the ring, then holds its version', async () => {
		const cookies: string[] = [];
		const store = fakeStore({ version: 1 });
		await bootstrap({
			store: store as never,
			doc: doc({
				ring: JSON.stringify(ring({ version: 2, complete: true, pack: undefined })),
				delta: JSON.stringify(DELTA)
			}),
			storage: memory(),
			userAgent: CHROME,
			cookie: (value: string) => void cookies.push(value)
		}).installed;
		expect(store.calls).toEqual(['delta 1>2', 'routes']);
		expect(cookies).toEqual([`${COOKIES.held}=2; path=/; max-age=604800; samesite=lax`]);
	});

	it('fetches the delta route when the document holds a pointer', async () => {
		const store = fakeStore({ version: 1 });
		const asked: string[] = [];
		await bootstrap({
			store: store as never,
			doc: doc({ delta: '' }),
			storage: memory(),
			userAgent: CHROME,
			fetch: (async (url: string) => {
				asked.push(url);
				return Response.json(DELTA);
			}) as never,
			cookie: () => undefined
		}).installed;
		expect(asked).toEqual([`${BUNDLE_DELTA_PREFIX}1/2`]);
		expect(store.calls).toEqual(['delta 1>2']);
	});

	it('holds the cookie from a complete head on a page with no ring', async () => {
		const cookies: string[] = [];
		await bootstrap({
			store: fakeStore({ version: 3 }) as never,
			doc: doc({ never: true }),
			storage: memory(),
			userAgent: CHROME,
			cookie: (value: string) => void cookies.push(value)
		}).installed;
		expect(cookies).toEqual([`${COOKIES.held}=3; path=/; max-age=604800; samesite=lax`]);
	});
});

describe('the lease window in bootstrap()', () => {
	const DAY = 86_400_000;
	const T0 = Date.UTC(2026, 10, 19, 9);
	const leased = (lease?: number) =>
		JSON.stringify(ring({ worker: 'auto', ...(lease === undefined ? {} : { lease }) }));

	afterEach(() => vi.useRealTimers());

	function visit(storage: ReturnType<typeof memory>, text: string, at: number) {
		vi.setSystemTime(at);
		return bootstrap({
			store: fakeStore(undefined) as never,
			doc: doc({ ring: text }),
			storage,
			userAgent: CHROME,
			cookie: () => undefined
		}).worker;
	}

	it('registers no worker on five views one lease apart', () => {
		vi.useFakeTimers();
		const storage = memory();
		const workers = [0, 1, 2, 3, 4].map((day) =>
			visit(storage, leased(86_400), T0 + day * DAY)
		);
		expect(workers).toEqual([false, false, false, false, false]);
	});

	it('registers the worker on the third view inside one lease', () => {
		vi.useFakeTimers();
		const storage = memory();
		const workers = [0, 3_600_000, 7_200_000].map((ms) =>
			visit(storage, leased(86_400), T0 + ms)
		);
		expect(workers).toEqual([false, false, true]);
	});

	it('counts the lifetime views when the ring names no lease or a lease of 0', () => {
		vi.useFakeTimers();
		for (const lease of [undefined, 0]) {
			const storage = memory();
			const workers = [0, DAY, 2 * DAY].map((ms) => visit(storage, leased(lease), T0 + ms));
			expect(workers).toEqual([false, false, true]);
		}
	});

	it('reads a lease in seconds and refuses one that is not a whole number', () => {
		expect(parseRing(leased(86_400))?.lease).toBe(86_400);
		expect(parseRing(JSON.stringify({ ...ring(), lease: 'day' }))).toBeNull();
	});
});
