import type { Page } from '@playwright/test';

/** a 32-bit FNV-1a hash of `text` as eight hex digits */
export function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** the index a seed picks from `count` links; the same seed picks the same link in both arms */
export const pickIndex = (seed: string, count: number): number =>
	Number.parseInt(fnv1a(seed), 16) % count;

/** view 1 and every `every`-th view after it are document navigations; the rest are in-page clicks */
export const isDocumentView = (view: number, every: number): boolean =>
	view === 1 || view % every === 0;

/** the same-origin link targets (path and query) the page offers, in document order; login, logout and the current page are left out */
export function linksOn(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
			.filter(
				(a) =>
					a.origin === location.origin &&
					!a.hasAttribute('target') &&
					!a.hasAttribute('download') &&
					a.pathname !== '/login' &&
					a.pathname !== '/logout' &&
					a.pathname + a.search !== location.pathname + location.search
			)
			.map((a) => a.pathname + a.search)
	);
}

/** clicks the first same-origin link in the page that goes to `target`; false when there is none */
export function clickLink(page: Page, target: string): Promise<boolean> {
	return page.evaluate((href) => {
		const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
			(a) =>
				a.origin === location.origin &&
				!a.hasAttribute('target') &&
				!a.hasAttribute('download') &&
				a.pathname + a.search === href
		);
		if (!link) return false;
		link.click();
		return true;
	}, target);
}

/**
 * Clicks one link the page offers, chosen by `seed` from the offered links. Returns null when the
 * page offers no link to click.
 */
export async function clickOffered(
	page: Page,
	seed: string
): Promise<{ href: string; index: number; count: number } | null> {
	const hrefs = await linksOn(page);
	if (hrefs.length === 0) return null;
	const index = pickIndex(seed, hrefs.length);
	const href = hrefs[index] as string;
	return (await clickLink(page, href)) ? { href, index, count: hrefs.length } : null;
}

/** clicks a synthetic anchor to `href` in the page; a click the page cannot answer may navigate the document */
export function clickHref(page: Page, href: string): Promise<void> {
	return page
		.evaluate((target) => {
			const a = document.createElement('a');
			a.href = target;
			document.body.append(a);
			a.click();
			a.remove();
		}, href)
		.catch(() => undefined);
}

/** waits until the location is `path` (with its query) and, when given, the first heading reads `title` */
export function settleOn(page: Page, path: string, title?: string): Promise<boolean> {
	return page
		.waitForFunction(
			([p, t]) =>
				location.pathname + location.search === p &&
				(t === undefined || document.querySelector('h1')?.textContent?.trim() === t),
			[path, title],
			{ timeout: 15000 }
		)
		.then(
			() => true,
			() => false
		);
}
