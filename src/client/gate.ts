// the inline gate; it stands in for the client's script tag until a click needs the runtime
import { engineOf } from '../protocol/view.js';
import { viewStamps } from '../protocol/views.js';

const { dataset } = document.currentScript as HTMLScriptElement;
const VIEWS = 'spool:views';
const STAMPS = 'spool:stamps';
const BOOT = 'spool:boot';
const paths = (dataset['held'] ?? '').split(' ').filter(Boolean);
const leaseMs = Number(dataset['lease']) * 1000;
let life = 1;
let view = 1;
let prev = '';
let loaded = false;
let src = dataset['src'] ?? '';
try {
	const seen = Number(localStorage.getItem(VIEWS));
	life = (seen >= 0 && seen < 1e9 ? seen : 0) + 1;
	localStorage.setItem(VIEWS, String(life));
	view = life;
	if (leaseMs > 0) {
		prev = localStorage.getItem(STAMPS) ?? '';
		const stamps = viewStamps(prev, Date.now(), leaseMs);
		localStorage.setItem(STAMPS, stamps.join());
		view = stamps.length;
	}
	// a boot script used before is in the browser cache; one from another runtime version is not used
	const stored = localStorage.getItem(BOOT);
	if (stored?.startsWith(src.slice(0, src.lastIndexOf('/') + 1))) {
		src = stored;
		loaded = true;
	}
} catch {
	// a failing storage leaves the gate to the click
}

// the client counts its own view, so the gate gives back the one it wrote
function load(url: string, to?: string) {
	const script = document.createElement('script');
	script.src = url;
	if (dataset['integrity']) {
		script.integrity = dataset['integrity'];
		script.crossOrigin = 'anonymous';
	}
	script.dataset['spoolClient'] = '';
	if (dataset['spoolWorker']) script.dataset['spoolWorker'] = dataset['spoolWorker'];
	if (to) script.onerror = () => location.assign(to);
	try {
		localStorage.setItem(VIEWS, String(life - 1));
		localStorage.setItem(STAMPS, prev);
	} catch {
		// the client counts from what the storage holds
	}
	document.head.append(script);
}

// the boot script the page's ring names; a page with no ring, or a ring that names none, has no pack to carry
function bootOf(): string | undefined {
	try {
		return JSON.parse(document.getElementById('spool-ring')?.textContent ?? '').boot;
	} catch {
		return undefined;
	}
}

// the boot script is going to load, so no click or later view loads it again
function claim(boot: string) {
	loaded = true;
	document.removeEventListener('click', onClick);
	document.removeEventListener('submit', onSubmit);
	try {
		localStorage.setItem(BOOT, boot);
	} catch {
		// the boot script is fetched again on a later document
	}
}

function take(event: Event, url: URL) {
	const { pathname, search } = url;
	if (url.origin !== location.origin) return;
	if (url.hash && pathname === location.pathname && search === location.search) return;
	const answered = (path: string) =>
		path[0] === '?'
			? search && pathname === path.slice(1)
			: !search && pathname.startsWith(path);
	const boot = paths.some(answered) ? bootOf() : undefined;
	if (!boot) return;
	claim(boot);
	// a client router cancels the event on the anchor, before this listener; it keeps the navigation
	// and never makes the document views that register a worker, so the runtime registers it now
	if (event.defaultPrevented) {
		(globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__ = { router: true };
		return load(boot);
	}
	event.preventDefault();
	(globalThis as { __SPOOL_BOOT__?: unknown }).__SPOOL_BOOT__ = { to: url.href };
	load(boot, url.href);
}

function onClick(event: MouseEvent) {
	const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
	if (!link || event.button || link.target) return;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (link.hasAttribute('download')) return;
	take(event, new URL(link.href));
}

function onSubmit(event: SubmitEvent) {
	const form = event.target as HTMLFormElement;
	if (form.target) return;
	if ((form.getAttribute('method') ?? 'get').toLowerCase() !== 'get') return;
	const url = new URL(form.getAttribute('action') ?? '', location.href);
	url.search = new URLSearchParams(
		new FormData(form) as unknown as Record<string, string>
	).toString();
	take(event, url);
}

if (loaded) {
	load(src);
} else {
	document.addEventListener('click', onClick);
	document.addEventListener('submit', onSubmit);
	// a ring with no boot script has no pack to wait for, so its runtime loads from the second view;
	// one that names a boot script waits for a click, or for the third view, which registers the worker
	// unless the page has none to register or one already controls it
	if (view > 1) {
		addEventListener('DOMContentLoaded', () => {
			if (loaded) return;
			const boot = bootOf();
			if (!boot) return load(dataset['src'] ?? '');
			if (view < 3 || dataset['spoolWorker'] === 'never') return;
			if (dataset['spoolWorker'] !== 'always' && engineOf(navigator.userAgent) === 'webkit')
				return;
			if (navigator.serviceWorker?.controller) return;
			claim(boot);
			load(boot);
		});
	}
}
