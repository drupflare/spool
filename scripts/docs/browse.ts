import { chromium } from '@playwright/test';
import { join } from 'node:path';

const out = process.argv[2] ?? 'typedoc';
const shots = process.argv[3];
if (!shots) throw new Error('usage: bun scripts/docs/browse.ts <typedoc dir> <screenshot dir>');

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		let path = decodeURIComponent(new URL(req.url).pathname);
		if (path.endsWith('/')) path += 'index.html';
		const file = Bun.file(join(out, path));
		return (await file.exists())
			? new Response(file)
			: new Response('missing', { status: 404 });
	}
});
const base = `http://localhost:${server.port}`;

const pages = {
	landing: 'index.html',
	adapter: 'documents/docs_adapters_express.html',
	advanced: 'documents/ADVANCED_USAGE.html',
	api: 'classes/index.NavModel.html'
};
const widths = [360, 768, 1280];
const browser = await chromium.launch();
const say = (line: string) => console.log(line);

for (const [name, path] of Object.entries(pages)) {
	for (const width of widths) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
		await page.goto(`${base}/${path}`, { waitUntil: 'load' });
		await page.waitForTimeout(700);
		const m = await page.evaluate(() => ({
			scroll: document.documentElement.scrollWidth,
			inner: window.innerWidth,
			sidebar: (() => {
				const r = document.getElementById('docs-sidebar')?.getBoundingClientRect();
				return r ? `${Math.round(r.x)},${Math.round(r.width)}` : 'none';
			})(),
			toc:
				!!document.querySelector('.docs-toc') &&
				getComputedStyle(document.querySelector('.docs-toc')!).display
		}));
		await page.screenshot({ path: join(shots, `${name}-${width}.png`) });
		say(
			`shot ${name} ${width}: scrollWidth ${m.scroll} innerWidth ${m.inner} overflow ${m.scroll > m.inner} sidebar x,w ${m.sidebar} toc ${m.toc} errors ${errors.length}${errors.length ? ` ${errors[0]}` : ''}`
		);
		await page.close();
	}
}

// search returns a hit for "spool", from the button and from the / key
for (const mode of ['click', 'slash'] as const) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(`${base}/index.html`, { waitUntil: 'load' });
	await page.waitForTimeout(500);
	if (mode === 'click') await page.click('#tsd-search-trigger');
	else await page.keyboard.press('/');
	await page.fill('#tsd-search-input', 'spool');
	await page.waitForSelector('#tsd-search-results li', { timeout: 10000 });
	const n = await page.locator('#tsd-search-results li').count();
	const first = await page.locator('#tsd-search-results li').first().innerText();
	if (mode === 'click') await page.screenshot({ path: join(shots, 'search-1280.png') });
	say(`search via ${mode}: ${n} results, first "${first.replace(/\s+/g, ' ').slice(0, 60)}"`);
	await page.close();
}

// drawer by keyboard at 360
{
	const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
	await page.goto(`${base}/documents/docs_adapters_express.html`, { waitUntil: 'load' });
	await page.waitForTimeout(500);
	const active = () =>
		page.evaluate(() => {
			const a = document.activeElement as HTMLElement | null;
			return `${a?.tagName}.${a?.className}|${a?.textContent?.trim().slice(0, 20)}`;
		});
	const order: string[] = [];
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press('Tab');
		order.push(await active());
	}
	say(`tab order: ${order.join(' > ')}`);
	await page.focus('.docs-menu');
	const sizeMenu = await page.locator('.docs-menu').boundingBox();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(300);
	const open = await page.evaluate(() =>
		document.getElementById('docs-sidebar')!.matches(':popover-open')
	);
	const inside = await page.evaluate(() => !!document.activeElement?.closest('#docs-sidebar'));
	const rows = await page.evaluate(() => {
		const h = [...document.querySelectorAll('#docs-sidebar summary, #docs-sidebar a')].map(
			(e) => e.getBoundingClientRect().height
		);
		return Math.min(...h.filter((v) => v > 0));
	});
	await page.screenshot({ path: join(shots, 'drawer-360.png') });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	const closed = await page.evaluate(
		() => !document.getElementById('docs-sidebar')!.matches(':popover-open')
	);
	const back = await active();
	say(
		`drawer: opens by Enter ${open}, focus moved inside ${inside}, Escape closes ${closed}, focus returns to ${back}, menu button ${Math.round(sizeMenu?.width ?? 0)}x${Math.round(sizeMenu?.height ?? 0)}, smallest row ${rows}px`
	);
	await page.close();
}

// theme toggle and persisted state
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(`${base}/documents/docs_adapters_express.html`, { waitUntil: 'load' });
	await page.waitForTimeout(500);
	await page.click('#docs-theme');
	const theme = await page.evaluate(() => [
		document.documentElement.dataset.theme,
		localStorage.getItem('tsd-theme')
	]);
	await page.screenshot({ path: join(shots, 'adapter-1280-toggled.png') });
	await page.reload({ waitUntil: 'load' });
	const kept = await page.evaluate(() => document.documentElement.dataset.theme);
	say(`theme toggle: ${theme.join(' / ')}, after reload ${kept}`);
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.evaluate(() => localStorage.removeItem('tsd-theme'));
	await page.reload({ waitUntil: 'load' });
	await page.screenshot({ path: join(shots, 'adapter-1280-os-dark.png') });
	await page.close();
}

// focus is not hidden under the fixed top bar
{
	const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
	await page.goto(`${base}/documents/ADVANCED_USAGE.html`, { waitUntil: 'load' });
	await page.waitForTimeout(500);
	let worst = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 90; i++) {
		await page.keyboard.press('Tab');
		const top = await page.evaluate(() => {
			const a = document.activeElement as HTMLElement | null;
			if (!a || a.closest('header') || a.closest('.docs-sidebar') || a.matches('.docs-skip'))
				return null;
			return (
				a.getBoundingClientRect().top -
				document.querySelector('header')!.getBoundingClientRect().bottom
			);
		});
		if (top !== null) worst = Math.min(worst, top);
	}
	say(`focus clearance below the top bar over 90 tab stops: smallest gap ${Math.round(worst)}px`);
	await page.close();
}

// no JavaScript: the sidebar is in the page and the current link is marked
{
	const context = await browser.newContext({
		javaScriptEnabled: false,
		viewport: { width: 1280, height: 900 }
	});
	const page = await context.newPage();
	await page.goto(`${base}/documents/docs_adapters_express.html`, { waitUntil: 'load' });
	const info = await page.evaluate(() => ({
		sidebar: getComputedStyle(document.getElementById('docs-sidebar')!).display,
		current: document.querySelector('#docs-sidebar a[aria-current="page"]')?.textContent,
		body: getComputedStyle(document.body).display,
		themeHidden: (document.getElementById('docs-theme') as HTMLElement).hidden
	}));
	await page.screenshot({ path: join(shots, 'adapter-1280-nojs.png') });
	say(
		`no JS: sidebar ${info.sidebar}, current "${info.current}", body ${info.body}, theme button hidden ${info.themeHidden}`
	);
	await context.close();
}

await browser.close();
await server.stop(true);
