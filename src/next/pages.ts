import { registerMode, type Registration, type RenderMode } from '../plugins/mode.js';
import { toSpoolPattern } from '../plugins/path.js';

/** what the Next build reports: the app page pathnames, and the concrete paths Next prerendered */
export type NextBuildInput = {
	/** app page pathnames as the adapter gives them, such as `/articles/[id]` */
	pages: readonly string[];
	/** concrete pathnames Next prerendered, such as `/articles/1` */
	prerendered: readonly string[];
	/** the top-level `cacheComponents` config flag */
	cacheComponents?: boolean;
};

/** how one page is registered; `pattern` is set only when the path converts */
export type NextPageRegistration = Registration & {
	path: string;
	pattern?: string;
	/** the prerendered paths that match the pattern */
	prerendered: string[];
};

// next lists a dynamic page's fallback shell, such as `/blog/[slug]`, as a prerender; it is no param set
function matches(pattern: string, path: string): boolean {
	if (path.includes('[')) return false;
	const want = pattern.split('/');
	const got = path.split('/');
	return (
		want.length === got.length &&
		want.every((part, at) => (part.startsWith(':') ? got[at] !== '' : part === got[at]))
	);
}

function registerPage(page: string, input: NextBuildInput): NextPageRegistration {
	const converted = toSpoolPattern('next', page);
	if (converted.kind === 'network') {
		return { path: page, register: 'network', reason: converted.reason, prerendered: [] };
	}
	const { pattern } = converted;
	const prerendered = input.prerendered.filter((path) => matches(pattern, path));
	const mode: RenderMode = {
		rendering: input.cacheComponents
			? 'streaming'
			: prerendered.length > 0
				? 'prerender'
				: 'server',
		enumerable: !pattern.includes(':') || prerendered.length > 0
	};
	const registration = registerMode(mode);
	if (registration.register === 'network' && !mode.enumerable && mode.rendering !== 'streaming') {
		registration.reason = `params not enumerable: declare a dataset family for ${pattern}`;
	}
	return { path: page, pattern, ...registration, prerendered };
}

/**
 * Registers every app page of a Next build. A page with params becomes a family only when Next
 * prerendered some of its params (`generateStaticParams`); the rest stay on the network.
 */
export function nextPages(input: NextBuildInput): NextPageRegistration[] {
	return input.pages.map((page) => registerPage(page, input));
}
