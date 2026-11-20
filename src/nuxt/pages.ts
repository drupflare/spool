import { registerMode, type Registration, type RenderMode } from '../plugins/mode.js';
import { toSpoolPattern } from '../plugins/path.js';

/** the fields of a Nuxt page the registration reads */
export type NuxtPageInput = {
	/** the vue-router path Nuxt emits, such as `/articles/:id()` */
	path: string;
	/** `client` renders in the browser; `server` and `all` render on the server */
	mode?: 'client' | 'server' | 'all';
	/** the page's route rules, from `defineRouteRules()` */
	rules?: object;
};

/** a page with its nested children, as `pages:resolved` gives them */
export type NuxtPageTree = NuxtPageInput & { children?: NuxtPageTree[] };

/** how one page is registered; `pattern` is set only when the path converts */
export type PageRegistration = Registration & { path: string; pattern?: string };

function join(base: string, child: string): string {
	if (child.startsWith('/')) return child;
	if (child === '') return base || '/';
	return `${base.replace(/\/$/, '')}/${child}`;
}

/** every page of the tree, parents before children, with full paths */
export function flattenPages(pages: readonly NuxtPageTree[], parent = ''): NuxtPageInput[] {
	return pages.flatMap((page) => {
		const path = join(parent, page.path);
		return [{ ...page, path }, ...flattenPages(page.children ?? [], path)];
	});
}

function renderingOf(page: NuxtPageInput, rules: Record<string, unknown>): RenderMode['rendering'] {
	if (page.mode === 'client' || rules.ssr === false) return 'client';
	if (rules.streaming === true) return 'streaming';
	if (rules.prerender === true) return 'prerender';
	return 'server';
}

/**
 * Registers one Nuxt page. A path that does not convert stays on the network; a page with params
 * is not enumerable here, because the module cannot know the params its data has.
 */
export function registerPage(page: NuxtPageInput): PageRegistration {
	const converted = toSpoolPattern('nuxt', page.path);
	if (converted.kind === 'network') {
		return { path: page.path, register: 'network', reason: converted.reason };
	}
	const rules = (page.rules ?? {}) as Record<string, unknown>;
	const mode: RenderMode = {
		rendering: renderingOf(page, rules),
		enumerable: !converted.pattern.includes(':')
	};
	const seconds = typeof rules.swr === 'number' ? rules.swr : rules.isr;
	if (typeof seconds === 'number') mode.revalidate = seconds;
	const registration = registerMode(mode);
	if (registration.register === 'network' && !mode.enumerable && mode.rendering !== 'streaming') {
		registration.reason = `params not enumerable: declare a dataset family for ${converted.pattern}`;
	}
	return { path: page.path, pattern: converted.pattern, ...registration };
}
