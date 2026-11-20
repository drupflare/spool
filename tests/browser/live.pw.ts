import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createSpool, defineRoute, memoryHub, memorySink } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { controlled, listen, type Hit } from './fixture';

/** seconds a private page may go unvalidated; the library default is 300 */
const R = 3;
const READS = 150;
const REVOKE_AT = 100;
const GAP_MS = 300;

const layout = (title: string, body: string) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

type Session = { user: string; revoked: boolean };

/** private pages behind a cookie session that the server can revoke, with the stream on or off */
async function startSite(live: false | 'adaptive' | 'always') {
	const hits: Hit[] = [];
	const sessions = new Map<string, Session>();
	const hub = memoryHub();
	const sid = (request: Request) =>
		/(?:^|;\s*)sid=([a-z0-9]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
	const sessionOf = (request: Request) => {
		const found = sessions.get(sid(request) ?? '');
		return found && !found.revoked ? found : undefined;
	};
	const spool = createSpool({
		bootstrap: 'first-view',
		routes: [
			defineRoute('/grades', {
				strategy: 'template',
				scope: 'principal',
				freshness: { maxStale: R, mode: 'hard' },
				template: { source: layout('grades', 'grades of {{owner}}') },
				depends: (ctx) => [`grades:${(ctx.identity as { principal: string }).principal}`],
				load: (ctx) => ({ owner: (ctx.identity as { principal: string }).principal })
			}),
			defineRoute('/reader', {
				strategy: 'template',
				template: { source: layout('reader', 'reading') },
				load: () => ({})
			})
		],
		store: memoryStore(),
		sink: memorySink(),
		clientTag: 'script',
		identity: {
			secret: 'live-secret',
			resolve: (request) => {
				const session = sessionOf(request);
				return session ? { principal: session.user } : null;
			}
		},
		live: live ? { hub, lease: 4, keepalive: 1, mode: live } : false
	});
	const html = (text: string, headers: Record<string, string> = {}, status = 200) =>
		new Response(text, {
			status,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0',
				...headers
			}
		});
	const app = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (url.pathname === '/login') {
			const user = url.searchParams.get('as') as string;
			const token = `${user.toLowerCase()}${sessions.size}`;
			sessions.set(token, { user, revoked: false });
			return html(layout('welcome', `signed in as ${user}`), {
				'set-cookie': `sid=${token}; Path=/`,
				'spool-partition': await spool.partition(user)
			});
		}
		if (url.pathname === '/grades') {
			const session = sessionOf(request);
			return session
				? html(layout('grades', `grades of ${session.user}`))
				: html(layout('sign in', 'please sign in'), {}, 401);
		}
		if (url.pathname === '/reader') return html(layout('reader', 'reading'));
		return new Response('not found', { status: 404 });
	};
	const base = await listen(hits, spool, app);
	return {
		...base,
		hits,
		hub,
		spool,
		/** ends the session on the server and, where the site has a stream, tells it */
		async revoke(user: string) {
			for (const session of sessions.values())
				if (session.user === user) session.revoked = true;
			await spool.revoke(user);
		}
	};
}

type Site = Awaited<ReturnType<typeof startSite>>;

/** requests the site saw, leaving out the worker script checks, beacons and the browser's own icon */
const own = (site: Site) =>
	site.hits.filter((h) => h.path !== '/spool-sw.js' && h.path !== '/.spool/beacon');
const count = (site: Site, path: string) => own(site).filter((h) => h.path === path).length;

type Held = { partition: string | null };
const held = (page: Page): Promise<Held> =>
	page.evaluate(
		() =>
			new Promise<Held>((resolve) => {
				const channel = new MessageChannel();
				channel.port1.onmessage = (event) => resolve(event.data as Held);
				(navigator.serviceWorker.controller as ServiceWorker).postMessage(
					{ type: 'spool:partition' },
					[channel.port2]
				);
			})
	);

async function ready(page: Page): Promise<void> {
	await controlled(page);
	await page.evaluate(
		() => (globalThis as unknown as { spool: { ready: Promise<unknown> } }).spool.ready
	);
}

/** registers the worker, signs in, holds /grades and parks the page on /reader with its stream up or not */
async function signedIn(page: Page, site: Site, live: boolean): Promise<void> {
	await page.goto(`${site.origin}/reader`);
	await ready(page);
	await page.goto(`${site.origin}/login?as=A`);
	const id = await site.spool.partition('A');
	await expect.poll(async () => (await held(page)).partition).toBe(id);
	await page.goto(`${site.origin}/grades`);
	await expect(page.locator('main p')).toHaveText('grades of A');
	await page.waitForTimeout(1_500);
	await page.goto(`${site.origin}/reader`);
	await ready(page);
	if (live) await expect.poll(() => site.hub.stats().open).toBe(1);
}

/** one read: a document navigation in a frame of the parked page, which the worker handles like any other */
const read = (page: Page): Promise<string> =>
	page.evaluate(
		() =>
			new Promise<string>((resolve) => {
				const frame = document.createElement('iframe');
				frame.onload = () => {
					const text = frame.contentDocument?.body.innerText ?? '';
					frame.remove();
					resolve(text);
				};
				frame.src = '/grades';
				document.body.append(frame);
			})
	);

type Arm = {
	liveOpens: number;
	renewals: number;
	grades: number;
	unauthorised: number;
	privateAfter: number;
	wipeMs: number;
};

/** READS reads GAP_MS apart; the server ends the session after read REVOKE_AT */
async function reading(page: Page, site: Site, live: boolean): Promise<Arm> {
	let privateAfter = 0;
	let wipeMs = -1;
	let revokedAt = 0;
	const snap = () => ({
		sync: count(site, '/.spool/sync'),
		live: site.hub.stats().opened,
		grades: count(site, '/grades')
	});
	const base = snap();
	let before = { sync: 0, live: 0, grades: 0 };
	for (let i = 1; i <= READS; i++) {
		const text = await read(page);
		if (i > REVOKE_AT && text.includes('grades of A')) privateAfter += 1;
		if (i === REVOKE_AT) {
			const now = snap();
			before = {
				sync: now.sync - base.sync,
				live: now.live - base.live,
				grades: now.grades - base.grades
			};
			revokedAt = Date.now();
			await site.revoke('A');
			// a stream wipes within milliseconds; a renewal-only page wipes at the read that renews
			if (live) {
				while (Date.now() - revokedAt < 5_000 && wipeMs < 0) {
					if ((await held(page)).partition === null) wipeMs = Date.now() - revokedAt;
					else await page.waitForTimeout(5);
				}
			}
		}
		await page.waitForTimeout(GAP_MS);
		if (i > REVOKE_AT && wipeMs < 0 && (await held(page)).partition === null) {
			wipeMs = Date.now() - revokedAt;
		}
	}
	return {
		liveOpens: before.live,
		renewals: before.sync,
		grades: before.grades,
		unauthorised: count(site, '/grades') - base.grades - before.grades,
		privateAfter,
		wipeMs
	};
}

test.describe.configure({ mode: 'serial' });

test('the stream holds the principal lease: no renewal while reading, and a revocation reaches the page at once', async ({
	browser,
	browserName
}) => {
	test.setTimeout(240_000);
	const results: Record<string, Arm> = {};
	const setup: Record<string, number> = {};
	for (const live of ['adaptive', false] as const) {
		const site = await startSite(live);
		const context = await browser.newContext();
		const page = await context.newPage();
		try {
			await signedIn(page, site, false);
			setup[live ? 'stream' : 'renewal'] = site.hub.stats().opened;
			results[live ? 'stream' : 'renewal'] = await reading(page, site, live !== false);
			// the revoked event closed the stream, and the wiped page holds no partition to open another for
			if (live) expect(site.hub.stats().open).toBe(0);
		} finally {
			await context.close();
			await site.stop();
		}
	}
	const { stream, renewal } = results as Record<'stream' | 'renewal', Arm>;
	console.log(
		`${browserName} setup stream opens ${JSON.stringify(setup)} ${JSON.stringify(results)}`
	);
	// adaptive arm: loading documents opened no stream; the parked page paid one renewal, then the
	// second became the stream
	expect(setup['stream']).toBe(0);
	expect(stream.renewals).toBe(1);
	expect(stream.liveOpens).toBe(1);
	// every read after the revocation went to the network and was refused; none showed private data
	expect(stream.privateAfter).toBe(0);
	expect(stream.unauthorised).toBe(READS - REVOKE_AT);
	// renewal arm: renewals while reading, and no stream
	expect(renewal.liveOpens).toBe(0);
	expect(renewal.renewals).toBeGreaterThan(0);
});

// Headless engines keep every tab `visible` (bringToFront and, in Chromium, a minimised window left
// visibilityState unchanged). This test therefore SIMULATES hiding: it overrides
// document.visibilityState in the tab and dispatches visibilitychange. The lock, the EventSource,
// the hub and the hand-over are real; only the visibility signal is simulated.
test('a hidden tab hands the stream to a visible one, and none is open when all are hidden (visibility simulated)', async ({
	browser
}) => {
	const site = await startSite('always');
	const context: BrowserContext = await browser.newContext();
	const setVisible = (page: Page, visible: boolean) =>
		page.evaluate((state) => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => (state ? 'visible' : 'hidden')
			});
			document.dispatchEvent(new Event('visibilitychange'));
		}, visible);
	try {
		const a = await context.newPage();
		await signedIn(a, site, true);
		const b = await context.newPage();
		await b.goto(`${site.origin}/reader`);
		await ready(b);
		const parked = site.hub.stats().opened;
		await setVisible(a, false);
		await expect.poll(() => site.hub.stats().opened - parked).toBe(1);
		expect(site.hub.stats().open).toBe(1);
		await setVisible(b, false);
		await expect.poll(() => site.hub.stats().open).toBe(0);
		await setVisible(a, true);
		await expect.poll(() => site.hub.stats().open).toBe(1);
		expect(site.hub.stats().opened - parked).toBe(2);
	} finally {
		await context.close();
		await site.stop();
	}
});

test('one stream is held by one tab of the origin, and a tab that leaves hands it on', async ({
	browser,
	browserName
}) => {
	const site = await startSite('always');
	const context: BrowserContext = await browser.newContext();
	try {
		const a = await context.newPage();
		await signedIn(a, site, true);
		const parked = site.hub.stats().opened;
		const b = await context.newPage();
		await b.goto(`${site.origin}/reader`);
		await ready(b);
		await a.bringToFront();
		await b.bringToFront();
		// Chromium only: try to minimise tab a's window, which is the one real way to hide it headless
		if (browserName === 'chromium') {
			try {
				const cdp = await context.newCDPSession(a);
				const { windowId } = await cdp.send('Browser.getWindowForTarget');
				await cdp.send('Browser.setWindowBounds', {
					windowId,
					bounds: { windowState: 'minimized' }
				});
				await a.waitForTimeout(500);
			} catch {
				// the browser has no window to minimise
			}
		}
		const visibility = await Promise.all(
			[a, b].map((p) => p.evaluate(() => document.visibilityState))
		);
		await b.waitForTimeout(1_500);
		// two tabs, one stream: the second tab queued on the lock; it opens one only if the first went hidden
		expect(site.hub.stats().open).toBe(1);
		expect(site.hub.stats().opened - parked).toBe(visibility[0] === 'hidden' ? 1 : 0);
		console.log(`${browserName} visibility after bringToFront: ${visibility.join(', ')}`);
		// the tab holding the stream leaves: the other tab takes it
		await a.close();
		await expect.poll(() => site.hub.stats().opened - parked).toBe(1);
		expect(site.hub.stats().open).toBe(1);
		await b.close();
		await expect.poll(() => site.hub.stats().open).toBe(0);
	} finally {
		await context.close();
		await site.stop();
	}
});
