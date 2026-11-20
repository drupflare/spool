import { type Artifact, PROTOCOL_VERSION } from '../protocol/artifact.js';
import type { SwConfig } from '../protocol/config.js';
import type { DatasetRow } from '../protocol/dataset.js';
import { ProtocolError } from '../protocol/errors.js';
import { equivalent } from '../protocol/normalise.js';
import { matchRoute, type SerializedRoute } from '../protocol/route.js';
import type { CompiledTemplate } from '../protocol/template/compile.js';
import type { PackStore } from '../sw/pack/store.js';
import { type Renderers, renderLocal } from '../sw/render.js';
import { checkLease } from './contact.js';

/** what a page renders its held routes with */
export type NavigateOptions = {
	/** the compiled templates the page renders with, keyed by route pattern */
	templates?: Record<string, CompiledTemplate>;
	/** the page runtime's script tag, so a local page carries the tag the server injects */
	clientTag?: string;
	/** custom renderers keyed by route pattern, as the worker's `serve` takes them */
	renderers?: Renderers;
	/** the pack store the page reads, the `spool-bundle` database the entry opens */
	store: PackStore;
};

// WebKit leaves the page at the 101st history call in 10 seconds, and replaceState counts too
const HISTORY_BUDGET = 90;
const HISTORY_WINDOW_MS = 10_000;

/** the route kinds whose local answer is an HTML page */
const PAGE_STRATEGIES = ['template', 'projection'];

/**
 * Whether this page may answer `url` from the held rows. It checks the route and the renderer only;
 * the row and the parameters are read later, so a `false` here is final and a `true` is a guess.
 */
function answerable(route: SerializedRoute, url: URL, options: NavigateOptions): boolean {
	if (route.navigation === 'document') return false;
	if (!PAGE_STRATEGIES.includes(route.strategy)) return false;
	const custom = Object.hasOwn(options.renderers ?? {}, route.pattern);
	const template =
		route.strategy === 'template' && Object.hasOwn(options.templates ?? {}, route.pattern);
	if (!custom && !template) return false;
	if (route.family) return url.search === '';
	// a bare list URL is the origin's own page, which the held rows cannot reproduce
	return (
		route.query?.dataset !== undefined && route.query.plan === undefined && url.search !== ''
	);
}

/** a scan that a swap interrupts is retried once; the swap has committed by the retry */
async function scan(store: PackStore, table: string): Promise<Array<[string, DatasetRow]>> {
	try {
		return await store.scanTable(table);
	} catch (error) {
		if (error instanceof ProtocolError && error.code === 'bad-sync')
			return store.scanTable(table);
		throw error;
	}
}

/**
 * The page's view of its held routes. `offers` answers at once from the routes it loaded; `render`
 * reads the row or rows and returns the HTML, or null when the network must answer.
 *
 * @internal
 */
export function createNavigator(options: NavigateOptions) {
	const { store } = options;
	const renderers = options.renderers ?? {};
	const config = { templates: options.templates ?? {}, clientTag: options.clientTag ?? '' };
	let routes: SerializedRoute[] = [];
	let loaded = false;
	let partial = false;
	const ready = Promise.all([store.getRoutes(), store.head()])
		.then(([held, head]) => {
			routes = held;
			partial = head?.partial === true;
			loaded = true;
		})
		.catch(() => undefined);

	return {
		ready,
		offers(url: URL): boolean {
			if (!loaded) return false;
			const hit = matchRoute(routes, url.pathname);
			return (
				hit !== null &&
				!(partial && !hit.route.family) &&
				answerable(hit.route, url, options)
			);
		},
		async render(url: URL): Promise<string | null> {
			await ready;
			const hit = matchRoute(routes, url.pathname);
			if (!hit || !answerable(hit.route, url, options)) return null;
			const { route, params } = hit;
			const dataset = route.family?.dataset ?? route.query?.dataset;
			if (dataset === undefined) return null;
			const head = await store.head();
			if (!head?.tables.includes(dataset)) return null;
			// a partial head holds the ring's rows, so a list read would show a part as the whole
			if (head.partial && !route.family) return null;
			let data: unknown = {};
			let rows: DatasetRow[] | undefined;
			if (route.family) {
				const key = params[route.family.key];
				const row = key === undefined ? undefined : await store.getRow(dataset, key);
				if (row === undefined) return null;
				data = { params, row };
			} else {
				rows = (await scan(store, dataset)).map(([, row]) => row);
			}
			const artifact = {
				protocol: PROTOCOL_VERSION,
				id: url.pathname,
				scope: route.scope,
				strategy: route.strategy,
				deps: [],
				vector: 0,
				body: { data }
			} as Artifact;
			const rendered = await renderLocal(
				config as SwConfig,
				route,
				artifact,
				renderers,
				url.search.slice(1),
				rows
			);
			return rendered.ok ? rendered.html : null;
		}
	};
}

/**
 * Budgets the history entries of in-page moves. `take` reserves one entry before the page renders,
 * so a click past {@link HISTORY_BUDGET} in a 10 second window is left to the browser as a document
 * navigation. `push` writes the entry once the new content is in place.
 *
 * @internal
 */
export function createHistoryWriter(
	history: Pick<History, 'pushState'>,
	now: () => number = Date.now
) {
	const takes: number[] = [];
	return {
		take(): boolean {
			const at = now();
			while (takes.length > 0 && at - (takes[0] as number) >= HISTORY_WINDOW_MS)
				takes.shift();
			if (takes.length >= HISTORY_BUDGET) return false;
			takes.push(at);
			return true;
		},
		push(url: string): void {
			history.pushState(null, '', url);
		}
	};
}

/** the same-origin URL a plain click loads in place, or null when the browser should handle the click */
function linkUrl(event: MouseEvent): URL | null {
	if (event.defaultPrevented || event.button !== 0) return null;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
	const link = (event.target as Element | null)?.closest?.('a[href]');
	if (!link || link.hasAttribute('target') || link.hasAttribute('download')) return null;
	const url = new URL(link.getAttribute('href') ?? '', location.href);
	if (url.origin !== location.origin) return null;
	if (url.hash !== '' && url.pathname === location.pathname && url.search === location.search) {
		return null;
	}
	return url;
}

/** the same-origin GET URL a form submits to, or null when the browser should handle it */
function formUrl(event: SubmitEvent): URL | null {
	const form = event.target as HTMLFormElement | null;
	if (!form || event.defaultPrevented || form.hasAttribute('target')) return null;
	if ((form.getAttribute('method') ?? 'get').toLowerCase() !== 'get') return null;
	const url = new URL(form.getAttribute('action') ?? location.href, location.href);
	if (url.origin !== location.origin) return null;
	const params = new URLSearchParams();
	for (const [name, value] of new FormData(form)) {
		if (typeof value === 'string') params.append(name, value);
	}
	url.search = params.toString();
	return url;
}

/** replaces the swap element, the sidebar when both pages have one, and the title */
function swapPage(html: string): void {
	const next = new DOMParser().parseFromString(html, 'text/html');
	const swapOf = (scope: Document) =>
		scope.querySelector('[data-spool-swap]') ?? scope.querySelector('main');
	const target = swapOf(document);
	const incoming = swapOf(next);
	if (!target || !incoming) throw new Error('the page has no swap element');
	target.replaceWith(document.importNode(incoming, true));
	const sidebar = document.querySelector('[data-spool-swap-sidebar]');
	const nextSidebar = next.querySelector('[data-spool-swap-sidebar]');
	if (sidebar && nextSidebar) sidebar.replaceWith(document.importNode(nextSidebar, true));
	document.title = next.title;
}

/**
 * Answers same-origin link clicks, GET form submits and history moves to held routes from the
 * page, with no request. Anything the held rows cannot answer goes to the browser as it would
 * have. Dispatches `spool:navigated` on `window` after each local swap. Resolves `ready` once the
 * routes are loaded; until then nothing is intercepted. `go` moves to `url` as a click would, and
 * loads it as a document when the held rows cannot answer.
 */
export function enableNavigation(options: NavigateOptions): {
	ready: Promise<void>;
	go(url: URL): void;
	stop(): void;
} {
	const held = createNavigator(options);
	const entries = createHistoryWriter(history);
	let shown = new URL(location.href);

	async function visit(url: URL, push: boolean): Promise<boolean> {
		checkLease();
		const html = await held.render(url);
		if (html === null) return false;
		swapPage(html);
		if (push) {
			entries.push(url.href);
			const fragment = url.hash.slice(1);
			const at = fragment ? document.getElementById(decodeURIComponent(fragment)) : null;
			if (at) at.scrollIntoView();
			else window.scrollTo(0, 0);
		}
		shown = url;
		window.dispatchEvent(
			new CustomEvent('spool:navigated', { detail: { url: url.href, local: true } })
		);
		return true;
	}

	// a failed local render hands the move to the browser, which loads the page as it always did
	function go(url: URL, push: boolean): void {
		const fallback = () => (push ? location.assign(url.href) : location.reload());
		visit(url, push).then((done) => {
			if (!done) fallback();
		}, fallback);
	}

	// a click the budget refuses is not prevented, so the browser loads it as a document
	const onClick = (event: MouseEvent) => {
		const url = linkUrl(event);
		if (!url || !held.offers(url) || !entries.take()) return;
		event.preventDefault();
		go(url, true);
	};
	const onSubmit = (event: SubmitEvent) => {
		const url = formUrl(event);
		if (!url || !held.offers(url) || !entries.take()) return;
		event.preventDefault();
		go(url, true);
	};
	const onPop = () => {
		const url = new URL(location.href);
		// a fragment move fires popstate too; the page already shows this path
		if (url.pathname === shown.pathname && url.search === shown.search) return;
		go(url, false);
	};

	document.addEventListener('click', onClick);
	document.addEventListener('submit', onSubmit);
	window.addEventListener('popstate', onPop);
	return {
		ready: held.ready,
		go: (url) => go(url, true),
		stop() {
			document.removeEventListener('click', onClick);
			document.removeEventListener('submit', onSubmit);
			window.removeEventListener('popstate', onPop);
		}
	};
}

/**
 * The first difference between the page this device renders for `href` and the network's
 * document for it, or null when they match after normalisation. A URL the device cannot answer
 * is a difference too.
 */
export async function compareToDocument(
	href: string,
	options: NavigateOptions
): Promise<string | null> {
	const url = new URL(href, location.href);
	const local = await createNavigator(options).render(url);
	if (local === null) return `no held page for ${url.pathname}`;
	const network = await (await fetch(url.href, { cache: 'no-store' })).text();
	const verdict = equivalent(local, network);
	return verdict.equal ? null : verdict.reason;
}
