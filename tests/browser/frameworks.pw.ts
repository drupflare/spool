import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A8 for each framework: the routes the plugin registers are the app's convertible routes, and once a
 * held page has had its first view, reading it makes no request. Each fixture is built first, with
 * `bun install --ignore-scripts` and `bun run build` in its directory.
 */

/** 1.5 s between document navigations: WebKit coalesces its worker script check inside one second */
const dwell = () => new Promise((resolve) => setTimeout(resolve, 1500));

async function up(origin: string): Promise<boolean> {
	return fetch(`${origin}/api/pages`)
		.then((response) => response.ok)
		.catch(() => false);
}

/** starts a fixture server from `entry` once `marker` (a built file) exists; returns its origin */
async function serve(dir: string, marker: string, entry: string, port: number) {
	const root = fileURLToPath(new URL(`../fixtures/frameworks/${dir}/`, import.meta.url));
	if (!existsSync(`${root}${marker}`)) {
		throw new Error(`build the fixture first: ${root}${marker} is missing`);
	}
	const origin = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, [`${root}${entry}`], {
		cwd: root,
		env: { ...process.env, PORT: String(port) },
		stdio: 'ignore'
	});
	for (let i = 0; i < 100 && !(await up(origin)); i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	expect(await up(origin)).toBe(true);
	return { origin, child };
}

/** the server paths answered since the last read, `/api/*` excluded */
async function takeHits(origin: string, reset: boolean): Promise<string[]> {
	return (await fetch(`${origin}/api/hits${reset ? '?reset' : ''}`)).json() as Promise<string[]>;
}

async function visit(page: Page, origin: string, path: string): Promise<void> {
	await page.goto(`${origin}${path}`);
	await dwell();
}

/** three document views of one page: the gate loads the boot script on the third and the worker registers */
async function viewThrice(page: Page, origin: string, path: string): Promise<void> {
	await visit(page, origin, path);
	await visit(page, origin, path);
	await page.goto(`${origin}${path}`);
}

/** WebKit re-checks the worker script on every navigation; Chromium and Firefox do not */
const checks = (browserName: string, navigations: number) =>
	browserName === 'webkit' ? Array<string>(navigations).fill('/spool-sw.js') : [];

type Registration = { path: string; pattern?: string; register: string };

test.describe('nuxt', () => {
	let origin = '';
	let child: ChildProcess | undefined;

	test.beforeAll(async () => {
		({ origin, child } = await serve(
			'nuxt',
			'.output/server/index.mjs',
			'.output/server/index.mjs',
			4620
		));
	});

	test.afterAll(() => {
		child?.kill();
	});

	test('the registered routes are the static pages, and the rest stay on the network', async () => {
		const pages = (await (await fetch(`${origin}/api/pages`)).json()) as Registration[];
		const registered = pages
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect(registered).toEqual(['/about', '/shell', '/']);
		expect(
			pages.filter((page) => page.register === 'network').map((page) => page.path)
		).toEqual(['/articles/:id()', '/docs/:slug(.*)*', '/:opt?']);
	});

	test('a held page makes 0 requests after its first view; a network page makes 1', async ({
		page,
		browserName
	}) => {
		// the router takes the click, so the boot script it loads registers the worker at once
		await visit(page, origin, '/about');
		await page.click('a[href="/articles/1"]');
		await page.waitForURL(`${origin}/articles/1`);
		// WebKit drops a registration still in flight when the next document starts
		await dwell();
		await visit(page, origin, '/about');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		const held = ['/about', '/', '/shell', '/articles/1'];
		for (const path of held) await visit(page, origin, path);

		await takeHits(origin, true);
		for (const path of held) await visit(page, origin, path);
		expect(await takeHits(origin, false)).toEqual(checks(browserName, held.length));

		await takeHits(origin, true);
		await visit(page, origin, '/docs/a/b');
		expect([...(await takeHits(origin, false))].sort()).toEqual(
			['/docs/a/b', ...checks(browserName, 1)].sort()
		);
	});

	test('a click the Nuxt router takes loads the boot script beside it and installs the pack', async ({
		page
	}) => {
		const seen: string[] = [];
		page.on('request', (request) => seen.push(new URL(request.url()).pathname));
		await takeHits(origin, true);
		await page.goto(`${origin}/about`);
		await page.click('a[href="/articles/1"]');
		await page.waitForURL(`${origin}/articles/1`);
		await page.waitForFunction(() => 'spool' in window, undefined, { timeout: 15_000 });
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		// the boot script, and the worker script it registers on the view a router click never makes
		const requests = seen.filter(
			(path) => !path.startsWith('/_nuxt/') && path !== '/spool-sw.js' && path !== '/about'
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatch(/^\/\.spool\/[^/]+\/boot\/\d+\.js$/);
		// the page never sees the worker script request, the server does
		const served = (await takeHits(origin, false)).filter(
			(path) => !path.startsWith('/_nuxt/')
		);
		expect(served.filter((path) => path === '/spool-sw.js')).toHaveLength(1);
		const heads = () =>
			page.evaluate(
				() =>
					new Promise<number>((resolve) => {
						const open = indexedDB.open('spool-bundle');
						open.onerror = () => resolve(-1);
						open.onsuccess = () => {
							try {
								const count = open.result
									.transaction('head')
									.objectStore('head')
									.count();
								count.onsuccess = () => resolve(count.result);
							} catch {
								resolve(0);
							}
						};
					})
			);
		await expect.poll(heads, { timeout: 15_000 }).toBe(1);
	});
});

test.describe('next', () => {
	let origin = '';
	let child: ChildProcess | undefined;

	test.beforeAll(async () => {
		({ origin, child } = await serve('next', '.next/spool-pages.json', 'server.ts', 4920));
	});

	test.afterAll(() => {
		child?.kill();
	});

	test('the registered routes are the convertible routes, and the rest stay on the network', async () => {
		const pages = (await (await fetch(`${origin}/api/pages`)).json()) as Registration[];
		const registered = pages
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect([...registered].sort()).toEqual(['/', '/about', '/articles/:id']);
		expect(
			pages
				.filter((page) => page.register === 'network')
				.map((page) => page.path)
				.sort()
		).toEqual(['/blog/[slug]', '/docs/[...slug]']);
	});

	test('a held page makes 0 requests after its first view; a network page makes 1', async ({
		page,
		browserName
	}) => {
		await viewThrice(page, origin, '/about');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		const held = ['/', '/about', '/articles/1'];
		for (const path of held) await visit(page, origin, path);

		await takeHits(origin, true);
		for (const path of held) await visit(page, origin, path);
		expect(await takeHits(origin, false)).toEqual(checks(browserName, held.length));

		await takeHits(origin, true);
		await visit(page, origin, '/docs/a/b');
		expect([...(await takeHits(origin, false))].sort()).toEqual(
			['/docs/a/b', ...checks(browserName, 1)].sort()
		);
	});
});

test.describe('react-router', () => {
	let origin = '';
	let child: ChildProcess | undefined;

	test.beforeAll(async () => {
		const root = fileURLToPath(
			new URL('../fixtures/frameworks/react-router/', import.meta.url)
		);
		if (!existsSync(`${root}build/server/index.js`)) {
			throw new Error(`build the fixture first: ${root}build/server/index.js is missing`);
		}
		origin = 'http://127.0.0.1:4750';
		child = spawn('bun', ['server.ts'], {
			cwd: root,
			env: { ...process.env, PORT: '4750' },
			stdio: 'ignore'
		});
		for (let i = 0; i < 100 && !(await up(origin)); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await up(origin)).toBe(true);
	});

	test.afterAll(() => {
		child?.kill();
	});

	test('the registered routes are the convertible routes, and the rest stay on the network', async () => {
		const pages = (await (await fetch(`${origin}/api/pages`)).json()) as Registration[];
		const registered = pages
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect(registered).toEqual(['/', '/about', '/blog', '/news']);
		expect(
			pages.filter((page) => page.register === 'network').map((page) => page.path)
		).toEqual(['/articles/:id', '/docs/*', '/opt/:id?', '/blog/:slug']);
	});

	test('a held page makes 0 requests after its first view; a network page makes 1', async ({
		page,
		browserName
	}) => {
		await viewThrice(page, origin, '/about');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		const held = ['/', '/about', '/blog', '/news', '/articles/1'];
		for (const path of held) await visit(page, origin, path);

		await takeHits(origin, true);
		for (const path of held) await visit(page, origin, path);
		expect(await takeHits(origin, false)).toEqual(checks(browserName, held.length));

		await takeHits(origin, true);
		await visit(page, origin, '/docs/a/b');
		expect([...(await takeHits(origin, false))].sort()).toEqual(
			['/docs/a/b', ...checks(browserName, 1)].sort()
		);
	});
});

test.describe('angular', () => {
	let origin = '';
	let child: ChildProcess | undefined;

	test.beforeAll(async () => {
		const root = fileURLToPath(new URL('../fixtures/frameworks/angular/', import.meta.url));
		if (!existsSync(`${root}dist/angular-app/server/server.mjs`)) {
			throw new Error(`build the fixture first: ${root}dist/angular-app is missing`);
		}
		origin = 'http://127.0.0.1:4950';
		child = spawn('bun', ['server.ts'], {
			cwd: root,
			env: { ...process.env, PORT: '4950' },
			stdio: 'ignore'
		});
		for (let i = 0; i < 100 && !(await up(origin)); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(await up(origin)).toBe(true);
	});

	test.afterAll(() => {
		child?.kill();
	});

	test('the registered routes are the convertible routes, and the rest stay on the network', async () => {
		const pages = (await (await fetch(`${origin}/api/pages`)).json()) as Registration[];
		const registered = pages
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect(registered).toEqual(['/', '/about', '/shell', '/news', '/articles/:id', '/blog']);
		expect(
			pages.filter((page) => page.register === 'network').map((page) => page.path)
		).toEqual(['/users/:id', '/docs/**', '/blog/:slug', '/old']);
	});

	test('a held page makes 0 requests after its first view; a network page makes 1', async ({
		page,
		browserName
	}) => {
		await viewThrice(page, origin, '/about');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		const held = ['/', '/about', '/shell', '/news', '/blog', '/articles/1'];
		for (const path of held) await visit(page, origin, path);

		await takeHits(origin, true);
		for (const path of held) await visit(page, origin, path);
		expect(await takeHits(origin, false)).toEqual(checks(browserName, held.length));

		await takeHits(origin, true);
		await visit(page, origin, '/docs/a/b');
		expect([...(await takeHits(origin, false))].sort()).toEqual(
			['/docs/a/b', ...checks(browserName, 1)].sort()
		);
	});
});

test.describe('vue', () => {
	let origin = '';
	let child: ChildProcess | undefined;

	test.beforeAll(async () => {
		({ origin, child } = await serve('vue', 'dist/index.html', 'server/index.ts', 4721));
	});

	test.afterAll(() => {
		child?.kill();
	});

	test('the registered routes are the convertible routes, and the rest stay on the network', async () => {
		const pages = (await (await fetch(`${origin}/api/pages`)).json()) as Registration[];
		const registered = pages
			.filter((page) => page.register !== 'network')
			.map((page) => page.pattern);
		expect([...registered].sort()).toEqual(['/', '/about', '/articles']);
		expect(
			pages
				.filter((page) => page.register === 'network')
				.map((page) => page.path)
				.sort()
		).toEqual(['/:opt?', '/docs/:slug(.*)*']);
	});

	test('a held page makes 0 requests after its first view; a network page makes 1', async ({
		page,
		browserName
	}) => {
		await viewThrice(page, origin, '/about');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
			timeout: 15_000
		});
		const held = ['/', '/about', '/articles'];
		for (const path of held) await visit(page, origin, path);

		await takeHits(origin, true);
		for (const path of held) await visit(page, origin, path);
		expect(await takeHits(origin, false)).toEqual(checks(browserName, held.length));

		await takeHits(origin, true);
		await visit(page, origin, '/docs/a/b');
		expect([...(await takeHits(origin, false))].sort()).toEqual(
			['/docs/a/b', ...checks(browserName, 1)].sort()
		);
	});
});
