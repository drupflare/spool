import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
	ARMS,
	DOCUMENT_EVERY,
	ENGINE_NAMES,
	SITES,
	SITE_NAMES,
	WORKER_VIEWS,
	parseOptions,
	planFor,
	startArm,
	visit
} from '../../scripts/measure/examples';
import { isDocumentView, pickIndex } from '../../scripts/measure/reader';
import { RIGS, measurementProblems, type Measurement } from '../../src/report/measurement';

/** the arm's own markup, which the origin page does not have; both arms are compared without it */
const withoutArmMarkup = (html: string) =>
	html
		.replace(/<script type="application\/json" id="spool-(ring|writes)">.*?<\/script>/gs, '')
		.replace(/<script[^>]*data-spool-client[^>]*>(<\/script>)?/g, '')
		.replace(/<script[^>]*data-spool-gate[^>]*>.*?<\/script>/gs, '');

/**
 * A browser that fetches each page itself and reads the links from the HTML it gets back. It holds
 * no service worker, so every view reaches the server.
 */
function stubEngine(base: string) {
	const listeners: Array<(request: unknown) => void> = [];
	let current = '/';
	let html = '';
	/** one navigation: the request listeners see it, and the page's HTML is kept for its links */
	const show = async (path: string) => {
		current = path;
		const request = {
			method: () => 'GET',
			url: () => base + path,
			resourceType: () => 'document',
			serviceWorker: () => null
		};
		listeners.forEach((listener) => listener(request));
		html = await (await fetch(base + path)).text();
	};
	const context = {
		on: (_event: string, listener: (request: unknown) => void) => listeners.push(listener),
		pages: () => [],
		newPage: async () => ({
			goto: async (url: string) => {
				const target = new URL(url);
				await show(target.pathname + target.search);
			},
			waitForLoadState: async () => undefined,
			waitForTimeout: async () => undefined,
			waitForFunction: async (_fn: unknown, arg: [string]) => {
				if (current !== arg[0]) throw new Error(`at ${current}, not ${arg[0]}`);
				return true;
			},
			evaluate: async (fn: unknown, arg?: unknown) => {
				if (typeof arg === 'string') {
					await show(arg);
					return true;
				}
				if (String(fn).includes('serviceWorker')) return false;
				return [...html.matchAll(/href="(\/[^"]*)"/g)]
					.map((match) => match[1] as string)
					.filter((href) => href !== '/login' && href !== '/logout' && href !== current);
			}
		}),
		request: {
			post: (url: string) => fetch(url, { method: 'POST' }),
			patch: (url: string, options: { data: unknown }) =>
				fetch(url, { method: 'PATCH', body: JSON.stringify(options.data) })
		},
		close: async () => undefined
	};
	return {
		name: () => 'chromium',
		launchPersistentContext: async () => context
	} as never;
}

describe('the examples rig options', () => {
	it('runs every site, both arms and every engine, with the default views', () => {
		const options = parseOptions([]);
		expect(options.views).toEqual([1, 2, 3, 10, 100]);
		expect(options.sites).toEqual(SITE_NAMES);
		expect(options.engines).toEqual(ENGINE_NAMES);
		expect(options.port).toBe(4500);
	});

	it('refuses views that are not ascending, unknown engines and sites, and a bad date', () => {
		expect(() => parseOptions(['--views', '3,2'])).toThrow('ascending');
		expect(() => parseOptions(['--engines', 'opera'])).toThrow('unknown engine');
		expect(() => parseOptions(['--sites', 'wiki'])).toThrow('unknown site');
		expect(() => parseOptions(['--date', '2026-11'])).toThrow('YYYY-MM-DD');
	});

	it('takes no padding by default and refuses a padding that is not a whole number', () => {
		expect(parseOptions([]).docBytes).toBe(0);
		expect(parseOptions(['--doc-bytes', '4096']).docBytes).toBe(4096);
		expect(() => parseOptions(['--doc-bytes', '1.5'])).toThrow('--doc-bytes');
		expect(() => parseOptions(['--doc-bytes', '17'])).toThrow('at least 18');
		expect(parseOptions(['--doc-bytes', '18']).docBytes).toBe(18);
		expect(() => parseOptions(['--doc-bytes=-1'])).toThrow('--doc-bytes');
	});

	it('plans one run per site, arm and engine, and no worker run when padded', () => {
		const plan = planFor(parseOptions(['--dry-run', '--date', '2026-11-18']));
		expect(plan.runs).toHaveLength(SITES.length * ARMS.length * ENGINE_NAMES.length);
		expect(plan.workerRuns).toHaveLength(SITES.length);
		expect(plan.workerRuns.every((run) => run.views === WORKER_VIEWS)).toBe(true);
		expect(plan.reading).toMatch(/measurements\/examples\/2026-11-18\.json$/);
		const padded = planFor(parseOptions(['--dry-run', '--doc-bytes', '4096']));
		expect(padded.workerRuns).toEqual([]);
	});

	it('adds an experiment to the reading name and refuses one that is not a lowercase word', () => {
		const plan = planFor(
			parseOptions(['--dry-run', '--date', '2026-11-18', '--experiment', 'padded'])
		);
		expect(plan.reading).toMatch(/measurements\/examples\/2026-11-18-padded\.json$/);
		expect(() => parseOptions(['--experiment', 'Padded run'])).toThrow('--experiment');
	});

	it('takes the machine name for the reading', () => {
		expect(parseOptions(['--machine', 'paisley-park']).machine).toBe('paisley-park');
		expect(parseOptions([]).machine).toBeUndefined();
	});
});

describe('the no-spool switch', () => {
	it.each(SITES.map((site) => [site.name, site] as const))(
		'%s answers each view with the spool arm status and type, and no spool markup from the origin',
		async (_name, site) => {
			const spooled = await site.open(true);
			const plain = await site.open(false);
			expect(spooled.spool).toBeDefined();
			expect(plain.spool).toBeUndefined();
			for (const path of site.views) {
				const url = new URL(path, 'https://site.test/').href;
				const origin = await plain.page(new Request(url));
				const handled = await spooled.spool?.handle(new Request(url), spooled.page);
				expect(handled?.status).toBe(origin.status);
				expect(handled?.headers.get('content-type')).toBe(
					origin.headers.get('content-type')
				);
				expect(await origin.text()).not.toContain('/.spool/');
			}
		}
	);

	it('adds the registration and the pack reference only in the spool arm of a page', async () => {
		const site = SITES.find((entry) => entry.name === 'courses');
		if (!site) throw new Error('no courses site');
		const spooled = await site.open(true);
		const plain = await site.open(false);
		const url = 'https://site.test/courses/101';
		const origin = await (await plain.page(new Request(url))).text();
		const handled = await (await spooled.spool?.handle(new Request(url), spooled.page))?.text();
		expect(origin).toContain('<h1>Intro to Drupal</h1>');
		expect(origin).not.toContain('/.spool/');
		expect(handled).toContain('/.spool/');
	});
});

describe('the document padding', () => {
	const PAD = 64;
	/** dashboard pages the views do not reach without a sign-in: the board and its task and project pages */
	const extra: Record<string, string[]> = {
		dashboard: ['/', '/board/tasks/t1', '/board/projects/site']
	};

	it.each(SITES.map((site) => [site.name, site] as const))(
		'%s pads each HTML page by the requested bytes, and both arms render the same padded page',
		async (name, site) => {
			const plain = await site.open(false, 0);
			const padded = await site.open(false, PAD);
			const spooled = await site.open(true, PAD);
			const pages = [...new Set([...site.views, ...(extra[name] ?? [])])];
			let checked = 0;
			for (const path of pages) {
				const url = new URL(path, 'https://site.test/').href;
				const base = await plain.page(new Request(url));
				if (!base.headers.get('content-type')?.startsWith('text/html')) continue;
				const baseText = await base.text();
				const grown = await padded.page(new Request(url));
				expect(grown.status, path).toBe(base.status);
				const grownText = await grown.text();
				expect(new TextEncoder().encode(grownText).length, path).toBe(
					new TextEncoder().encode(baseText).length + PAD
				);
				const served = await spooled.spool?.handle(new Request(url), spooled.page);
				expect(withoutArmMarkup((await served?.text()) ?? ''), path).toBe(
					withoutArmMarkup(grownText)
				);
				checked += 1;
			}
			expect(checked).toBeGreaterThan(0);
		}
	);
});

describe('the dashboard principal page', () => {
	it('answers /me as HTML with the spool registration once a member is signed in', async () => {
		const site = SITES.find((entry) => entry.name === 'dashboard');
		if (!site) throw new Error('no dashboard site');
		expect(site.views).toContain('/me');
		const spooled = await site.open(true);
		const handled = await spooled.spool?.handle(
			new Request('https://site.test/me', { headers: { cookie: 'user=ada' } }),
			spooled.page
		);
		expect(handled?.headers.get('content-type')).toContain('text/html');
		expect(await handled?.text()).toContain('/.spool/');
	});
});

describe('the click reader', () => {
	it('makes view 1 and every sixth view a document, and the rest clicks', () => {
		const views = Array.from({ length: 12 }, (_, i) => i + 1);
		expect(views.filter((view) => isDocumentView(view, DOCUMENT_EVERY))).toEqual([1, 6, 12]);
	});

	it('picks one of the offered links from the seed, the same way every time', () => {
		for (const count of [1, 2, 7]) {
			const index = pickIndex('courses:4', count);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(count);
			expect(pickIndex('courses:4', count)).toBe(index);
		}
	});

	it('takes the same path in both arms, with a document every sixth view', async () => {
		const site = SITES.find((entry) => entry.name === 'courses');
		if (!site) throw new Error('no courses site');
		const walk = async (arm: 'spool' | 'no-spool') => {
			const { server, counts } = await startArm(site, arm, 0);
			const port = (server.address() as AddressInfo).port;
			const entries: Array<{ action: string; kind?: string; path?: string }> = [];
			try {
				await visit({
					site,
					engine: stubEngine(`http://127.0.0.1:${port}`),
					base: `http://127.0.0.1:${port}`,
					profile: 'unused',
					views: 8,
					checkpoints: [8],
					counters: () => ({ server_requests: counts.requests }),
					runtime: 'node',
					arm,
					trace: (entry) => entries.push(entry as (typeof entries)[number])
				});
			} finally {
				server.closeAllConnections();
				await new Promise((done) => server.close(done));
			}
			return entries.filter((entry) => entry.action === 'view');
		};
		const spool = await walk('spool');
		const plain = await walk('no-spool');
		expect(spool.map((entry) => entry.path)).toHaveLength(8);
		expect(spool.map((entry) => entry.path)).toEqual(plain.map((entry) => entry.path));
		expect(spool.map((entry) => entry.kind)).toEqual([
			'document',
			'click',
			'click',
			'click',
			'click',
			'document',
			'click',
			'click'
		]);
	});
});

describe('a visit through a stub browser', () => {
	it('counts one server request and one origin call per view when no worker holds the pack', async () => {
		const site = SITES.find((entry) => entry.name === 'courses');
		if (!site) throw new Error('no courses site');
		const { server, counts } = await startArm(site, 'spool', 0);
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		try {
			const base = `http://127.0.0.1:${port}`;
			const rows = await visit({
				site,
				engine: stubEngine(base),
				base,
				profile: 'unused',
				views: 3,
				checkpoints: [1, 2, 3],
				counters: () => ({
					server_requests: counts.requests,
					origin_calls: counts.origin,
					server_bytes: counts.bytes
				}),
				runtime: 'node',
				arm: 'spool'
			});
			expect(rows.map((row) => row.views)).toEqual([1, 2, 3]);
			expect(rows.map((row) => row.server_requests)).toEqual([1, 2, 3]);
			expect(rows.map((row) => row.origin_calls)).toEqual([1, 2, 3]);
			expect(rows.map((row) => row.browser_requests)).toEqual([1, 2, 3]);
			expect(rows.map((row) => row.off_path)).toEqual([0, 0, 0]);
		} finally {
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		}
	});

	it('passes the schema-1 reader as the rig writes it', () => {
		const draft: Omit<Measurement, 'schema'> = {
			rig: 'examples' as Measurement['rig'],
			date: '2026-11-18',
			layer: 'L1',
			question: 'a visit',
			instrument: 'a stub',
			machine: { name: 'test' },
			software: { node: 'v0' },
			method: {},
			exclusions: ['a reason'],
			rows: [{ views: 1 }]
		};
		expect(RIGS).toContain('examples');
		expect(measurementProblems({ schema: 1, ...draft })).toEqual([]);
	});
});
