import { expect, test, type Page } from '@playwright/test';
import { createSpool, defineRoute, memorySink } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { listen, type Fixture, type Hit } from './fixture';

const CSP = "default-src 'self'; script-src 'self'";
const SOURCE =
	'<!doctype html><html><head><meta charset="utf-8"><title>{{title}}</title></head><body><h1>{{title}}</h1><script>window.inlineRan = true</script></body></html>';
const page = (title: string) => SOURCE.replace(/\{\{title\}\}/g, title);

type Client = { status(): Promise<{ artifacts: string[] }> };
type SpoolWindow = { spool: { ready: Promise<Client | null> } };

let fx: Pick<Fixture, 'origin' | 'stop'>;
const hits: Hit[] = [];

test.beforeAll(async () => {
	const spool = createSpool({
		routes: [
			defineRoute('/sec/:id', {
				strategy: 'template',
				template: { source: SOURCE },
				depends: (ctx) => [`sec:${ctx.params['id']}`],
				load: (ctx) => ({ title: `sec ${ctx.params['id']}` })
			})
		],
		store: memoryStore(),
		sink: memorySink()
	});
	fx = await listen(hits, spool, (request) => {
		const { pathname } = new URL(request.url);
		if (!pathname.startsWith('/sec/')) return new Response('not found', { status: 404 });
		return new Response(page(`sec ${pathname.split('/').pop()}`), {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'max-age=0',
				'x-frame-options': 'DENY',
				'content-security-policy': CSP
			}
		});
	});
});

test.afterAll(() => fx.stop());

const stored = (target: Page) =>
	target.evaluate(async () => {
		const client = await (window as unknown as SpoolWindow).spool.ready;
		return (await (client as Client).status()).artifacts;
	});

test('a local view carries the site headers and the policy still blocks inline script', async ({
	page: tab
}) => {
	await tab.goto(`${fx.origin}/sec/1`);
	await tab.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await tab.evaluate(() => (window as unknown as SpoolWindow).spool.ready);
	await tab.goto(`${fx.origin}/sec/1`);
	await expect.poll(async () => await stored(tab), { timeout: 15_000 }).toContain('/sec/1');
	hits.length = 0;

	const response = await tab.goto(`${fx.origin}/sec/1`);
	expect(hits.map((hit) => hit.path).filter((path) => path !== '/spool-sw.js')).toEqual([]);
	expect(response?.headers()['x-frame-options']).toBe('DENY');
	expect(response?.headers()['content-security-policy']).toBe(CSP);
	await expect(tab.locator('h1')).toHaveText('sec 1');
	expect(await tab.evaluate(() => (window as unknown as { inlineRan?: true }).inlineRan)).toBe(
		undefined
	);
});
