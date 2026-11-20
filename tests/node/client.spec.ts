import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { type ActivityHost, createActivity } from '../../src/client/activity';
import { bootstrap, parseRing } from '../../src/client/bootstrap';
import { checkLease, CONTACT_KEY, holdLease, leaseClock } from '../../src/client/contact';
import { parseWrites } from '../../src/client/declared';
import { closeOnPageHide } from '../../src/client/lifecycle';
import { crossOriginLoads } from '../../src/client/loads';
import {
	compareToDocument,
	createHistoryWriter,
	createNavigator,
	enableNavigation
} from '../../src/client/navigate';
import { register } from '../../src/client/register';
import { clientPath, navigatePath } from '../../src/protocol/config';
import {
	buildPack,
	type BundleRows,
	defineRoute,
	type SerializedRoute,
	serializeRoute
} from '../../src/protocol/index';
import { type Ring, RING_ELEMENT_ID } from '../../src/protocol/ring';
import type { ResourceWrite } from '../../src/protocol/write';
import { CLIENT_CORE, NAVIGATE_CORE } from '../../src/server/embedded';
import { createSpool } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { createPackStore, type PackStore } from '../../src/sw/index';
import { VERSION } from '../../src/version';
import { freshIndexedDB, ORIGIN } from './helpers';

type Reply = (message: { type: string }) => unknown;

function container(reply?: Reply, active = true) {
	const seen: unknown[] = [];
	const worker = {
		postMessage(message: { type: string }, transfer?: MessagePort[]) {
			seen.push(message);
			if (reply) transfer?.[0]?.postMessage(reply(message));
		}
	};
	const registration = { active: active ? worker : null };
	const registered: Array<{ url: string; options: RegistrationOptions }> = [];
	return {
		seen,
		registered,
		value: {
			register: async (url: string, options: RegistrationOptions) => {
				registered.push({ url, options });
				return registration;
			},
			ready: Promise.resolve(registration)
		} as unknown as ServiceWorkerContainer
	};
}

describe('the lease clock', () => {
	const store = () => {
		const items = new Map<string, string>();
		return {
			items,
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => void items.set(key, value)
		};
	};
	const broken = {
		getItem: () => {
			throw new Error('denied');
		},
		setItem: () => {
			throw new Error('denied');
		}
	};

	it('is due with no record, then not due until the lease passes', () => {
		let at = 1_000_000;
		const clock = leaseClock(60, store(), () => at);
		expect(clock.due()).toBe(true);
		clock.mark(at);
		at += 59_999;
		expect(clock.due()).toBe(false);
		at += 1;
		expect(clock.due()).toBe(true);
	});

	it('reads the record another clock on the same store wrote', () => {
		const shared = store();
		leaseClock(60, shared, () => 5_000).mark(5_000);
		expect(leaseClock(60, shared, () => 6_000).due()).toBe(false);
		expect(shared.items.get(CONTACT_KEY)).toBe('5000');
	});

	it('counts a clock that moved back as past the lease', () => {
		const clock = leaseClock(60, store(), () => 1_000);
		clock.mark(50_000);
		expect(clock.due()).toBe(true);
	});

	it('never throws, and with a failing store it is due once per page load', () => {
		let at = 1_000_000;
		const clock = leaseClock(60, broken, () => at);
		expect(clock.due()).toBe(true);
		clock.mark(at);
		at += 1_000;
		expect(clock.due()).toBe(false);
	});

	it('asks the browser for the worker script once per lease', () => {
		const update = vi.fn(() => Promise.resolve());
		holdLease({ update } as unknown as ServiceWorkerRegistration, 60);
		checkLease();
		checkLease();
		expect(update).toHaveBeenCalledTimes(1);
	});
});

describe('register', () => {
	it("turns the worker's spool:cleared message into an event on the target", async () => {
		const c = container(() => ({
			type: 'spool:hello',
			protocol: 1,
			version: 'v',
			compatible: true
		}));
		let listener: (event: { data: unknown }) => void = () => undefined;
		const value = {
			...c.value,
			register: (c.value as unknown as { register: unknown }).register,
			ready: (c.value as unknown as { ready: unknown }).ready,
			addEventListener: (_: string, fn: typeof listener) => void (listener = fn)
		} as unknown as ServiceWorkerContainer;
		const events: Array<{ type: string; detail: unknown }> = [];
		await register({
			container: value,
			target: { dispatchEvent: (e) => (events.push(e as never), true) }
		});
		listener({ data: { type: 'spool:cleared', reason: 'logout' } });
		listener({ data: { type: 'other' } });
		listener({ data: null });
		expect(events.map((e) => [e.type, e.detail])).toEqual([
			['spool:cleared', { reason: 'logout' }]
		]);
	});

	it('registers /spool-sw.js with updateViaCache all and runs the handshake', async () => {
		const c = container((m) =>
			m.type === 'spool:hello'
				? { type: 'spool:hello', protocol: 1, version: '9.9.9', compatible: true }
				: { type: 'spool:status', cursor: 3, syncedAt: 0, artifacts: ['/a'] }
		);
		const client = await register({ container: c.value });
		expect(c.registered).toEqual([
			{ url: '/spool-sw.js', options: { scope: undefined, updateViaCache: 'all' } }
		]);
		expect(c.seen[0]).toEqual({ type: 'spool:hello', protocol: 1 });
		expect(client?.hello.compatible).toBe(true);
		expect(await client?.status()).toMatchObject({ cursor: 3, artifacts: ['/a'] });
	});

	it('counts the registration as a contact, so the first lease check asks for no update', async () => {
		const update = vi.fn(() => Promise.resolve());
		const worker = {
			postMessage(message: { type: string }, transfer?: MessagePort[]) {
				if (message.type !== 'spool:hello') return;
				transfer?.[0]?.postMessage({
					type: 'spool:hello',
					protocol: 1,
					version: 'v',
					compatible: true,
					lease: 60
				});
			}
		};
		const registration = { active: worker, update };
		const value = {
			register: async () => registration,
			ready: Promise.resolve(registration)
		} as unknown as ServiceWorkerContainer;
		await register({ container: value });
		expect(update).not.toHaveBeenCalled();
	});

	describe('persistent storage', () => {
		const hello = () => ({ type: 'spool:hello', protocol: 1, version: 'v', compatible: true });
		const setup = async (storage: {
			persisted(): Promise<boolean>;
			persist(): Promise<boolean>;
		}) => {
			const c = container(hello);
			let listener: (event: { data: unknown }) => void = () => undefined;
			const value = {
				...c.value,
				register: (c.value as unknown as { register: unknown }).register,
				ready: (c.value as unknown as { ready: unknown }).ready,
				addEventListener: (_: string, fn: typeof listener) => void (listener = fn)
			} as unknown as ServiceWorkerContainer;
			const events: Array<{ type: string; detail: unknown }> = [];
			const client = await register({
				container: value,
				storage,
				target: { dispatchEvent: (e) => (events.push(e as never), true) }
			});
			const tell = async () => {
				listener({ data: { type: 'spool:persist' } });
				await new Promise((resolve) => setTimeout(resolve, 0));
			};
			return { c, client, events, tell };
		};

		it('asks once when the worker says it holds a dataset, records the grant and tells the worker', async () => {
			let asked = 0;
			const { c, client, events, tell } = await setup({
				persisted: async () => false,
				persist: async () => (asked++, true)
			});
			expect(client?.persisted()).toBeNull();
			await tell();
			await tell();
			expect(asked).toBe(1);
			expect(client?.persisted()).toBe(true);
			expect(events.map((e) => [e.type, e.detail])).toEqual([
				['spool:persisted', { granted: true }]
			]);
			expect(c.seen).toContainEqual({ type: 'spool:persisted', granted: true });
		});

		it('records a refusal, and does not ask when storage is already persistent', async () => {
			const denied = await setup({
				persisted: async () => false,
				persist: async () => false
			});
			await denied.tell();
			expect(denied.client?.persisted()).toBe(false);

			let asked = 0;
			const held = await setup({
				persisted: async () => true,
				persist: async () => (asked++, true)
			});
			await held.tell();
			expect(asked).toBe(0);
			expect(held.client?.persisted()).toBe(true);
		});

		it('treats a storage manager that throws as a refusal', async () => {
			const broken = await setup({
				persisted: async () => {
					throw new Error('no');
				},
				persist: async () => true
			});
			await broken.tell();
			expect(broken.client?.persisted()).toBe(false);
		});
	});

	it('passes a custom worker url and scope', async () => {
		const c = container(() => ({
			type: 'spool:hello',
			protocol: 1,
			version: 'v',
			compatible: true
		}));
		await register({ container: c.value, workerUrl: '/sw/spool.js', scope: '/app/' });
		expect(c.registered[0]).toEqual({
			url: '/sw/spool.js',
			options: { scope: '/app/', updateViaCache: 'all' }
		});
	});

	it('reports a worker that speaks another protocol as incompatible', async () => {
		const c = container(() => ({
			type: 'spool:hello',
			protocol: 2,
			version: 'v',
			compatible: false
		}));
		expect((await register({ container: c.value }))?.hello.compatible).toBe(false);
	});

	it('resolves null where service workers do not exist', async () => {
		expect(await register()).toBeNull();
	});

	it('rejects when no worker is active, or the worker stays silent', async () => {
		await expect(register({ container: container(undefined, false).value })).rejects.toThrow(
			'not active'
		);
		await expect(
			register({ container: container().value, helloTimeoutMs: 10 })
		).rejects.toThrow('did not answer');
	});

	it('track closes a database on pagehide through the window', async () => {
		const c = container(() => ({
			type: 'spool:hello',
			protocol: 1,
			version: 'v',
			compatible: true
		}));
		const client = await register({ container: c.value });
		const listeners = new Map<string, () => void>();
		const holder = globalThis as { window?: unknown };
		holder.window = {
			addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
			removeEventListener: (type: string) => void listeners.delete(type)
		};
		try {
			let closed = 0;
			const dispose = client?.track({ close: () => void closed++ });
			listeners.get('pagehide')?.();
			expect(closed).toBe(1);
			dispose?.();
			expect(listeners.size).toBe(0);
		} finally {
			delete holder.window;
		}
	});
});

describe('closeOnPageHide', () => {
	function target() {
		const listeners = new Map<string, () => void>();
		return {
			listeners,
			addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
			removeEventListener: (type: string) => void listeners.delete(type)
		};
	}

	it('closes the database on pagehide, once per event', () => {
		const t = target();
		let closed = 0;
		closeOnPageHide({ close: () => void closed++ }, t as unknown as EventTarget);
		t.listeners.get('pagehide')?.();
		expect(closed).toBe(1);
	});

	it('stops listening after the disposer runs', () => {
		const t = target();
		const dispose = closeOnPageHide({ close() {} }, t as unknown as EventTarget);
		expect(t.listeners.has('pagehide')).toBe(true);
		dispose();
		expect(t.listeners.has('pagehide')).toBe(false);
	});
});

describe('cross-origin loads', () => {
	const entry = (name: string) => ({ name });

	it('counts the resources on another origin and skips the page runtime script', () => {
		const origin = 'https://site.test';
		const entries = [
			entry('https://site.test/site.css'),
			entry('https://cdn.test/spool/client.js'),
			entry('https://fonts.test/a.woff2'),
			entry('https://fonts.test/b.woff2'),
			entry('http://site.test/insecure.js'),
			entry('not a url')
		];
		expect(crossOriginLoads(entries, origin)).toBe(4);
		expect(crossOriginLoads(entries, origin, ['https://cdn.test/spool/client.js'])).toBe(3);
		expect(crossOriginLoads([], origin)).toBe(0);
	});

	it('asks the worker for the view id of a path and posts the count for it', async () => {
		const c = container((m) =>
			m.type === 'spool:view'
				? { type: 'spool:view', id: 'abc' }
				: { type: 'spool:hello', protocol: 1, version: 'v', compatible: true }
		);
		const client = await register({ container: c.value });
		expect(await client?.view('/p')).toBe('abc');
		client?.reportLoads('abc', 3);
		expect(c.seen.slice(-2)).toEqual([
			{ type: 'spool:view', path: '/p' },
			{ type: 'spool:loads', view: 'abc', count: 3 }
		]);
	});
});

describe('activity', () => {
	const el = () => ({}) as Element;

	function loop(pauseThrows = false) {
		const calls: string[] = [];
		return {
			calls,
			controls: {
				pause: () => {
					calls.push('pause');
					if (pauseThrows) throw new Error('boom');
				},
				resume: () => void calls.push('resume')
			}
		};
	}

	function fakeHost(startHidden = false, offScreenAtStart: Element[] = []) {
		let hidden = startHidden;
		let clock = 0;
		let nextId = 1;
		const visibility = new Set<() => void>();
		const observers = new Map<Element, (onScreen: boolean) => void>();
		const timers = new Map<number, { at: number; callback: () => void }>();
		const host: ActivityHost = {
			hidden: () => hidden,
			onVisibilityChange(listener) {
				visibility.add(listener);
				return () => void visibility.delete(listener);
			},
			observe(target, listener) {
				observers.set(target, listener);
				listener(!offScreenAtStart.includes(target));
				return () => void observers.delete(target);
			},
			setTimeout(callback, ms) {
				const id = nextId++;
				timers.set(id, { at: clock + ms, callback });
				return id;
			},
			clearTimeout(handle) {
				timers.delete(handle as number);
			}
		};
		return {
			host,
			timers,
			setHidden(next: boolean) {
				hidden = next;
				for (const listener of [...visibility]) listener();
			},
			setOnScreen(target: Element, onScreen: boolean) {
				observers.get(target)?.(onScreen);
			},
			advance(ms: number) {
				clock += ms;
				for (const [id, timer] of [...timers]) {
					if (timer.at > clock) continue;
					timers.delete(id);
					timer.callback();
				}
			}
		};
	}

	function lcg(seed: number) {
		let state = seed;
		return () => {
			state = (state * 16807) % 2147483647;
			return state / 2147483647;
		};
	}

	function expectAlternating(calls: string[], paused: boolean) {
		calls.forEach((call, i) => expect(call).toBe(i % 2 === 0 ? 'pause' : 'resume'));
		expect(calls.length % 2 === 1).toBe(paused);
	}

	it('alternates pause and resume and matches the rule after every event, over 20 seeded runs', () => {
		let pauses = 0;
		for (let run = 1; run <= 20; run++) {
			const random = lcg(run);
			const target = el();
			const f = fakeHost();
			const l = loop();
			const hiddenAfterMs = [0, 250, 10_000].at(run % 3) ?? 0;
			createActivity(f.host).register(l.controls, { target, hiddenAfterMs });
			let clock = 0;
			let hiddenSince: number | null = null;
			let hidden = false;
			let onScreen = true;
			for (let step = 0; step < 60; step++) {
				const roll = random();
				if (roll < 0.3) {
					hidden = !hidden;
					hiddenSince = hidden ? clock : null;
					f.setHidden(hidden);
				} else if (roll < 0.55) {
					onScreen = !onScreen;
					f.setOnScreen(target, onScreen);
				} else {
					const ms = Math.floor(random() * 6000);
					clock += ms;
					f.advance(ms);
				}
				const hiddenPaused = hiddenSince !== null && clock - hiddenSince >= hiddenAfterMs;
				expectAlternating(l.calls, !onScreen || hiddenPaused);
			}
			pauses += l.calls.filter((call) => call === 'pause').length;
		}
		expect(pauses).toBeGreaterThan(0);
	});

	it('pauses at once when hiddenAfterMs is 0 and leaves no timer behind', () => {
		const f = fakeHost();
		const l = loop();
		createActivity(f.host).register(l.controls, { hiddenAfterMs: 0 });
		f.setHidden(true);
		expect(l.calls).toEqual(['pause']);
		expect(f.timers.size).toBe(0);
		f.setHidden(false);
		expect(l.calls).toEqual(['pause', 'resume']);
	});

	it('waits 10000 ms by default before pausing a hidden page', () => {
		const f = fakeHost();
		const l = loop();
		createActivity(f.host).register(l.controls);
		f.setHidden(true);
		f.advance(9999);
		expect(l.calls).toEqual([]);
		f.advance(1);
		expect(l.calls).toEqual(['pause']);
		f.setHidden(false);
		expect(l.calls).toEqual(['pause', 'resume']);
	});

	it('pauses at once when the first report puts the target off screen', () => {
		const target = el();
		const f = fakeHost(false, [target]);
		const l = loop();
		createActivity(f.host).register(l.controls, { target });
		expect(l.calls).toEqual(['pause']);
		f.setOnScreen(target, true);
		expect(l.calls).toEqual(['pause', 'resume']);
	});

	it('resumes only when neither the target nor the hidden page holds the loop paused', () => {
		const target = el();
		const f = fakeHost();
		const l = loop();
		createActivity(f.host).register(l.controls, { target, hiddenAfterMs: 0 });
		f.setOnScreen(target, false);
		f.setHidden(true);
		expect(l.calls).toEqual(['pause']);
		f.setOnScreen(target, true);
		expect(l.calls).toEqual(['pause']);
		f.setHidden(false);
		expect(l.calls).toEqual(['pause', 'resume']);
		f.setHidden(true);
		f.setOnScreen(target, false);
		f.setHidden(false);
		expect(l.calls).toEqual(['pause', 'resume', 'pause']);
		f.setOnScreen(target, true);
		expect(l.calls).toEqual(['pause', 'resume', 'pause', 'resume']);
	});

	it('resumes a paused loop once on unregister, and a second unregister does nothing', () => {
		const target = el();
		const f = fakeHost(false, [target]);
		const l = loop();
		const unregister = createActivity(f.host).register(l.controls, {
			target,
			hiddenAfterMs: 0
		});
		expect(l.calls).toEqual(['pause']);
		unregister();
		unregister();
		f.setOnScreen(target, true);
		f.setHidden(true);
		f.setHidden(false);
		expect(l.calls).toEqual(['pause', 'resume']);
		expect(f.timers.size).toBe(0);
	});

	it('unregister clears a pending hidden timer', () => {
		const f = fakeHost();
		const l = loop();
		const unregister = createActivity(f.host).register(l.controls);
		f.setHidden(true);
		expect(f.timers.size).toBe(1);
		unregister();
		expect(f.timers.size).toBe(0);
		f.advance(10_000);
		expect(l.calls).toEqual([]);
	});

	it('catches a throwing pause, warns once, and keeps the loop going', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const target = el();
			const f = fakeHost();
			const l = loop(true);
			createActivity(f.host).register(l.controls, { target });
			f.setOnScreen(target, false);
			f.setOnScreen(target, true);
			f.setOnScreen(target, false);
			expect(l.calls).toEqual(['pause', 'resume', 'pause']);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith('spool.activity', expect.any(Error));
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps two loops independent', () => {
		const target = el();
		const f = fakeHost();
		const first = loop();
		const second = loop();
		const activity = createActivity(f.host);
		activity.register(first.controls, { target });
		activity.register(second.controls, { hiddenAfterMs: 0 });
		f.setOnScreen(target, false);
		expect(first.calls).toEqual(['pause']);
		expect(second.calls).toEqual([]);
		f.setHidden(true);
		expect(first.calls).toEqual(['pause']);
		expect(second.calls).toEqual(['pause']);
		f.setOnScreen(target, true);
		expect(first.calls).toEqual(['pause', 'resume']);
		expect(second.calls).toEqual(['pause']);
	});
});

describe('in-page navigation', () => {
	type Listener = (event: Record<string, unknown>) => void;

	const TEMPLATE = {
		source: '<!doctype html><html><head><title>{{row.title}}</title></head><body><main data-spool-swap><h1>{{row.title}}</h1></main></body></html>'
	};
	const LIST = {
		source: '<!doctype html><html><head><title>Courses</title></head><body><main><ul>{{#each items}}<li>{{id}} {{title}}</li>{{/each}}</ul></main></body></html>'
	};
	const ROWS: BundleRows = [
		['c1', { id: 'c1', title: 'Title 1', dept: 'cs' }],
		['c2', { id: 'c2', title: 'Title 2', dept: 'math' }],
		['c3', { id: 'c3', title: 'Title 3', dept: 'cs' }]
	];
	const family = defineRoute('/courses/:id', {
		strategy: 'template',
		template: TEMPLATE,
		family: { dataset: 'courses', key: 'id' }
	});
	const list = defineRoute('/courses', {
		strategy: 'template',
		template: LIST,
		query: { list: 'items', dataset: 'courses', filter: { dept: 'string' } },
		load: () => ({})
	});
	const templates = {
		[family.pattern]: family.template as NonNullable<typeof family.template>,
		[list.pattern]: list.template as NonNullable<typeof list.template>
	};

	async function held(extra: SerializedRoute[] = []) {
		const store = createPackStore(freshIndexedDB());
		const { bytes } = await buildPack({ version: 1, tables: { courses: ROWS } });
		async function* chunks() {
			yield bytes;
		}
		await store.installPack(chunks());
		await store.putRoutes([serializeRoute(family), serializeRoute(list), ...extra]);
		return store;
	}

	/** an event target that records what it is asked to dispatch */
	function eventTarget() {
		const listeners = new Map<string, Listener[]>();
		return {
			addEventListener: (type: string, fn: Listener) =>
				listeners.set(type, [...(listeners.get(type) ?? []), fn]),
			removeEventListener: (type: string, fn: Listener) =>
				listeners.set(
					type,
					(listeners.get(type) ?? []).filter((f) => f !== fn)
				),
			dispatchEvent: (event: { type: string }) => {
				for (const fn of listeners.get(event.type) ?? []) fn(event as never);
				return true;
			},
			fire: (type: string, event: Record<string, unknown>) => {
				for (const fn of listeners.get(type) ?? []) fn(event);
			}
		};
	}

	/**
	 * a page with the browser globals the navigator reads; `calls` records what it asked the
	 * browser, and `swapped` the swap elements it replaced
	 */
	function fakePage(href: string) {
		const calls: string[] = [];
		const swapped: string[] = [];
		const url = new URL(href);
		const incoming = { tag: 'incoming' };
		const main = {
			replaceWith: (next: unknown) => swapped.push(next === incoming ? 'main' : 'other')
		};
		const doc = Object.assign(eventTarget(), {
			title: '',
			querySelector: (selector: string) => (selector.includes('sidebar') ? null : main),
			getElementById: (): null => null,
			importNode: (node: unknown) => node
		});
		globalThis.DOMParser = class {
			parseFromString() {
				return {
					title: 'Page',
					querySelector: (selector: string) =>
						selector.includes('sidebar') ? null : incoming
				};
			}
		} as never;
		const win = Object.assign(eventTarget(), { scrollTo: () => undefined });
		const location = {
			href,
			origin: url.origin,
			pathname: url.pathname,
			search: url.search,
			assign: (to: string) => void calls.push(`assign ${to}`),
			reload: () => void calls.push('reload')
		};
		const history = {
			pushState: (_state: unknown, _title: string, to: string) =>
				void calls.push(`push ${to}`),
			replaceState: (_state: unknown, _title: string, to: string) =>
				void calls.push(`replace ${to}`)
		};
		Object.assign(globalThis, { document: doc, window: win, location, history });
		return { doc, win, calls, swapped };
	}

	function clickOn(href: string, attrs: Record<string, string> = {}, over = {}) {
		const link = {
			getAttribute: (name: string) => (name === 'href' ? href : null),
			hasAttribute: (name: string) => name in attrs
		};
		return {
			type: 'click',
			button: 0,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			defaultPrevented: false,
			target: { closest: () => link },
			preventDefault() {
				this.defaultPrevented = true;
			},
			...over
		};
	}

	afterEach(() => {
		for (const name of ['document', 'window', 'location', 'history', 'DOMParser']) {
			Reflect.deleteProperty(globalThis, name);
		}
	});

	it('answers a held family route for an id the page never fetched', async () => {
		const nav = createNavigator({ store: await held(), templates });
		await nav.ready;
		const html = await nav.render(new URL('/courses/c2', ORIGIN));
		expect(html).toContain('<h1>Title 2</h1>');
		expect(html).toContain('<title>Title 2</title>');
	});

	it('answers a declared query from the held rows and refuses an undeclared parameter', async () => {
		const nav = createNavigator({ store: await held(), templates });
		await nav.ready;
		const html = await nav.render(new URL('/courses?dept=cs', ORIGIN));
		expect(html).toContain('<li>c1 Title 1</li>');
		expect(html).toContain('<li>c3 Title 3</li>');
		expect(html).not.toContain('c2');
		expect(await nav.render(new URL('/courses?color=red', ORIGIN))).toBeNull();
	});

	it('leaves a missing row and a family route with navigation document to the network', async () => {
		const people = defineRoute('/people/:id', {
			strategy: 'template',
			template: TEMPLATE,
			family: { dataset: 'courses', key: 'id' },
			navigation: 'document'
		});
		const nav = createNavigator({
			store: await held([serializeRoute(people)]),
			templates: { ...templates, [people.pattern]: people.template as never }
		});
		await nav.ready;
		expect(await nav.render(new URL('/courses/zz', ORIGIN))).toBeNull();
		expect(await nav.render(new URL('/people/c1', ORIGIN))).toBeNull();
		expect(nav.offers(new URL('/people/c1', ORIGIN))).toBe(false);
	});

	it('leaves a route the page has no template or renderer for to the network', async () => {
		const nav = createNavigator({ store: await held(), templates: {} });
		await nav.ready;
		expect(nav.offers(new URL('/courses/c2', ORIGIN))).toBe(false);
		expect(await nav.render(new URL('/courses/c2', ORIGIN))).toBeNull();
	});

	it('answers a ring item from a partial head and leaves a list read to the network', async () => {
		const store = createPackStore(freshIndexedDB());
		const ring: Ring = {
			protocol: 1,
			version: 1,
			digest: '0'.repeat(64),
			routes: [serializeRoute(family), serializeRoute(list)],
			templates: {},
			tables: { courses: ROWS.slice(0, 1) },
			complete: false,
			bootstrap: 'second-view',
			worker: 'auto',
			pack: { url: '/.spool/bundle/1', bytes: 1 }
		};
		await store.installRing(ring);
		const nav = createNavigator({ store, templates });
		await nav.ready;
		expect(await nav.render(new URL('/courses/c1', ORIGIN))).toContain('<h1>Title 1</h1>');
		expect(await nav.render(new URL('/courses/c2', ORIGIN))).toBeNull();
		expect(nav.offers(new URL('/courses', ORIGIN))).toBe(false);
		expect(await nav.render(new URL('/courses?dept=cs', ORIGIN))).toBeNull();
	});

	it('intercepts a plain same-origin click on a held route and nothing else', async () => {
		const page = fakePage(`${ORIGIN}/`);
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		const prevented = (event: ReturnType<typeof clickOn>) => {
			page.doc.fire('click', event);
			return event.defaultPrevented;
		};
		expect(prevented(clickOn('/courses/c2'))).toBe(true);
		await vi.waitFor(() => expect(page.swapped).toEqual(['main']));
		expect(prevented(clickOn('/courses/c2', {}, { metaKey: true }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', {}, { ctrlKey: true }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', {}, { shiftKey: true }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', {}, { altKey: true }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', {}, { button: 1 }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', { target: '_blank' }))).toBe(false);
		expect(prevented(clickOn('/courses/c2', { download: '' }))).toBe(false);
		expect(prevented(clickOn('https://other.test/courses/c2'))).toBe(false);
		expect(prevented(clickOn('/about'))).toBe(false);
		expect(prevented(clickOn('#top'))).toBe(false);
		nav.stop();
		expect(page.swapped).toEqual(['main']);
		expect(page.calls).toEqual([`push ${ORIGIN}/courses/c2`]);
	});

	it('hands a click on a missing row to the browser', async () => {
		const page = fakePage(`${ORIGIN}/`);
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		const event = clickOn('/courses/zz');
		page.doc.fire('click', event);
		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(page.calls).toEqual([`assign ${ORIGIN}/courses/zz`]));
	});

	it('swaps the page, pushes the URL and reports spool:navigated for a held route', async () => {
		const page = fakePage(`${ORIGIN}/`);
		const swapped = page.swapped;
		const events: unknown[] = [];
		page.win.addEventListener('spool:navigated', (event) => events.push(event['detail']));
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		page.doc.fire('click', clickOn('/courses/c2'));
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(swapped).toEqual(['main']);
		expect(page.doc.title).toBe('Page');
		expect(page.calls).toEqual([`push ${ORIGIN}/courses/c2`]);
		expect(events).toEqual([{ url: `${ORIGIN}/courses/c2`, local: true }]);
		nav.stop();
	});

	it('hands a click past the history budget to the browser, with no swap', async () => {
		const page = fakePage(`${ORIGIN}/`);
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		for (let i = 0; i < 90; i++) page.doc.fire('click', clickOn('/courses/c2'));
		await vi.waitFor(() => expect(page.calls).toHaveLength(90));
		const event = clickOn('/courses/c2');
		page.doc.fire('click', event);
		expect(event.defaultPrevented).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(page.swapped).toEqual(Array(90).fill('main'));
		expect(page.calls).toHaveLength(90);
		nav.stop();
	});

	it('leaves a fragment move on the page it already shows alone', async () => {
		const page = fakePage(`${ORIGIN}/courses/c2`);
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		page.win.fire('popstate', {});
		expect(page.calls).toEqual([]);
		nav.stop();
	});

	it('answers a GET form submit on a held list route and hands an undeclared parameter over', async () => {
		const page = fakePage(`${ORIGIN}/`);
		const nav = enableNavigation({ store: await held(), templates });
		await nav.ready;
		let fields: Array<[string, string]> = [];
		const native = globalThis.FormData;
		globalThis.FormData = class {
			*[Symbol.iterator]() {
				yield* fields;
			}
		} as never;
		const submit = () => {
			const event = {
				type: 'submit',
				defaultPrevented: false,
				preventDefault() {
					this.defaultPrevented = true;
				},
				target: {
					getAttribute: (name: string) =>
						name === 'method' ? 'get' : name === 'action' ? '/courses' : null,
					hasAttribute: () => false
				}
			};
			page.doc.fire('submit', event);
			return event.defaultPrevented;
		};
		try {
			fields = [['dept', 'cs']];
			expect(submit()).toBe(true);
			await vi.waitFor(() => expect(page.calls).toEqual([`push ${ORIGIN}/courses?dept=cs`]));
			fields = [['color', 'red']];
			expect(submit()).toBe(true);
			await vi.waitFor(() =>
				expect(page.calls.at(-1)).toBe(`assign ${ORIGIN}/courses?color=red`)
			);
		} finally {
			globalThis.FormData = native;
			nav.stop();
		}
	});

	it('takes no 91st history entry in a 10 second window, and writes only the taken ones', () => {
		const calls: string[] = [];
		let at = 0;
		const writes = createHistoryWriter({ pushState: () => void calls.push('push') }, () => at);
		const takes = Array.from({ length: 91 }, () => writes.take());
		expect(takes.slice(0, 90).every(Boolean)).toBe(true);
		expect(takes[90]).toBe(false);
		writes.push('/x');
		expect(calls).toEqual(['push']);
		at = 10_000;
		expect(writes.take()).toBe(true);
	});

	it('refuses navigation on a route that is not a family route', () => {
		expect(() =>
			defineRoute('/x', {
				strategy: 'template',
				template: TEMPLATE,
				load: () => ({}),
				navigation: 'document'
			} as never)
		).toThrow('navigation applies to a family route');
		expect(() =>
			defineRoute('/courses/:id', {
				strategy: 'template',
				template: TEMPLATE,
				family: { dataset: 'courses', key: 'id' },
				navigation: 'soft'
			} as never)
		).toThrow('unknown navigation');
	});

	it('compares a local page with the network document and names the first difference', async () => {
		fakePage(`${ORIGIN}/`);
		const store = await held();
		const real = globalThis.fetch;
		const serve = (html: string) => {
			globalThis.fetch = (async () => new Response(html)) as never;
		};
		const compare = (path: string) =>
			compareToDocument(`${ORIGIN}${path}`, { store, templates });
		try {
			serve(TEMPLATE.source.replaceAll('{{row.title}}', 'Title 2'));
			expect(await compare('/courses/c2')).toBeNull();
			serve(TEMPLATE.source.replaceAll('{{row.title}}', 'Title 9'));
			expect(await compare('/courses/c2')).toMatch(/^diverges at \d+/);
			expect(await compare('/courses/zz')).toBe('no held page for /courses/zz');
		} finally {
			globalThis.fetch = real;
		}
	});
});

describe('bootstrap', () => {
	const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
	const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
	const PACK = '/.spool/pack/2';

	const ring = (over: Partial<Ring> = {}): Ring => ({
		protocol: 1,
		version: 2,
		digest: '0'.repeat(64),
		routes: [],
		templates: {},
		tables: {},
		complete: false,
		bootstrap: 'second-view',
		worker: 'auto',
		pack: { url: PACK, bytes: 1000 },
		...over
	});

	const docWith = (text: string | null) =>
		({
			getElementById: (id: string) =>
				id === RING_ELEMENT_ID && text !== null ? { textContent: text } : null
		}) as never;

	const memory = () => {
		const values = new Map<string, string>();
		return {
			values,
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value)
		};
	};

	const broken = {
		getItem: () => {
			throw new Error('no storage');
		},
		setItem: () => {
			throw new Error('no storage');
		}
	};

	/** a store that records each call; its head turns full after a pack installs */
	const fakeStore = (
		options: { fits?: boolean; refuseInstall?: boolean; throwOnRing?: boolean } = {}
	) => {
		const calls: string[] = [];
		let full = false;
		const store = {
			head: async () =>
				full
					? {
							version: 2,
							digest: '0'.repeat(64),
							generation: 1,
							blockRows: 128,
							codec: 'gzip',
							tables: []
						}
					: undefined,
			installRing: async () => {
				calls.push('ring');
				if (options.throwOnRing) throw new Error('refused');
			},
			estimateBeforeInstall: async (bytes: number) => {
				calls.push(`fit ${bytes}`);
				return { checked: true, fits: options.fits ?? true };
			},
			installPack: async (source: AsyncIterable<Uint8Array>) => {
				calls.push('pack');
				for await (const chunk of source) calls.push(`chunk ${chunk.byteLength}`);
				if (options.refuseInstall)
					return { installed: false, fit: { checked: true, fits: false } };
				full = true;
				return { installed: true };
			},
			putRoutes: async () => {
				calls.push('routes');
			}
		};
		return { calls, store: store as unknown as PackStore };
	};

	/** a fetch that records each url and answers three bytes */
	const network = () => {
		const urls: string[] = [];
		const fetch = async (url: string) => {
			urls.push(url);
			return new Response(new Uint8Array([1, 2, 3]));
		};
		return { urls, fetch: fetch as unknown as typeof globalThis.fetch };
	};

	it('parses a well-formed ring and ignores a malformed, missing or foreign one', () => {
		const good = ring();
		expect(parseRing(JSON.stringify(good))).toEqual(good);
		expect(parseRing(JSON.stringify(ring({ complete: true, pack: undefined })))).not.toBeNull();
		expect(parseRing(null)).toBeNull();
		expect(parseRing('')).toBeNull();
		expect(parseRing('{not json')).toBeNull();
		expect(parseRing(JSON.stringify({ ...good, protocol: 2 }))).toBeNull();
		expect(parseRing(JSON.stringify({ ...good, worker: 'maybe' }))).toBeNull();
		expect(parseRing(JSON.stringify({ ...good, pack: undefined }))).toBeNull();
		expect(parseRing(JSON.stringify({ ...good, tables: [] }))).toBeNull();
		expect(parseRing('[]')).toBeNull();
		expect(parseRing(JSON.stringify({ ...good, templates: [] }))).toBeNull();
		// a gate page's ring carries no routes or templates; the boot script does
		expect(parseRing(JSON.stringify({ ...good, templates: undefined }))).not.toBeNull();
	});

	it.each([
		['second-view', 'auto', false, [false, false, true], [0, 1, 0]],
		['first-view', 'auto', false, [true, true, true], [1, 0, 0]],
		['second-view', 'never', false, [false, false, false], [0, 1, 0]],
		['second-view', 'auto', true, [false, false, true], [0, 0, 0]],
		['first-view', 'auto', true, [true, true, true], [0, 0, 0]]
	] as const)(
		'gate %s, worker %s, complete %s: worker per view %j, pack requests per view %j',
		async (bootstrapGate, worker, complete, workers, fetches) => {
			const { store } = fakeStore();
			const storage = memory();
			const net = network();
			const text = JSON.stringify(
				ring({
					bootstrap: bootstrapGate,
					worker,
					complete,
					pack: complete ? undefined : { url: PACK, bytes: 1000 }
				})
			);
			const seenWorkers: boolean[] = [];
			const seenFetches: number[] = [];
			for (let view = 1; view <= 3; view++) {
				const before = net.urls.length;
				const boot = bootstrap({
					store,
					doc: docWith(text),
					storage,
					fetch: net.fetch,
					userAgent: FIREFOX
				});
				seenWorkers.push(boot.worker);
				await boot.installed;
				seenFetches.push(net.urls.length - before);
			}
			expect(seenWorkers).toEqual(workers);
			expect(seenFetches).toEqual(fetches);
		}
	);

	it('writes the ring on view 1, fetches the pack once on view 2 and never again', async () => {
		const { calls, store } = fakeStore();
		const storage = memory();
		const net = network();
		const text = JSON.stringify(ring());
		const run = () =>
			bootstrap({ store, doc: docWith(text), storage, fetch: net.fetch, userAgent: FIREFOX });

		await run().installed;
		expect(calls).toEqual(['ring']);
		expect(net.urls).toEqual([]);

		await run().installed;
		expect(calls).toEqual(['ring', 'ring', 'fit 1000', 'pack', 'chunk 3', 'routes']);
		expect(net.urls).toEqual([PACK]);

		await run().installed;
		expect(net.urls).toEqual([PACK]);
		expect(calls.slice(6)).toEqual(['routes']);
	});

	it('skips the pack and the ring when the store holds that version or newer', async () => {
		const { calls, store } = fakeStore();
		const held = { ...store, head: async () => ({ version: 3 }) } as unknown as PackStore;
		const net = network();
		await bootstrap({
			store: held,
			doc: docWith(JSON.stringify(ring())),
			storage: memory(),
			fetch: net.fetch,
			userAgent: CHROME
		}).installed;
		expect(calls).toEqual([]);
		expect(net.urls).toEqual([]);
	});

	it('refuses the pack when the quota estimate says it does not fit, and keeps the ring', async () => {
		const { calls, store } = fakeStore({ fits: false });
		const net = network();
		const storage = memory();
		const boot = () =>
			bootstrap({
				store,
				doc: docWith(JSON.stringify(ring())),
				storage,
				fetch: net.fetch,
				userAgent: CHROME
			});
		await boot().installed;
		await boot().installed;
		expect(net.urls).toEqual([]);
		expect(calls).toEqual(['ring', 'ring', 'fit 1000']);
	});

	it('counts a view per load and treats a failing storage as a first view every time', async () => {
		const { store } = fakeStore();
		const text = JSON.stringify(ring());
		const net = network();
		const storage = memory();
		const count = () =>
			bootstrap({ store, doc: docWith(text), storage, fetch: net.fetch, userAgent: CHROME });
		count();
		count();
		expect(storage.values.get('spool:views')).toBe('2');

		const worker = [1, 2, 3].map(
			() =>
				bootstrap({
					store,
					doc: docWith(text),
					storage: broken,
					fetch: net.fetch,
					userAgent: CHROME
				}).worker
		);
		expect(worker).toEqual([false, false, false]);
	});

	it('never throws into the page, on a refused ring, a failed fetch or a null storage', async () => {
		const refused = fakeStore({ throwOnRing: true });
		await expect(
			bootstrap({
				store: refused.store,
				doc: docWith(JSON.stringify(ring())),
				storage: null,
				fetch: network().fetch,
				userAgent: CHROME
			}).installed
		).resolves.toBeUndefined();

		const offline = fakeStore();
		const failing = (async () => {
			throw new TypeError('network down');
		}) as unknown as typeof globalThis.fetch;
		await expect(
			bootstrap({
				store: offline.store,
				doc: docWith(JSON.stringify(ring())),
				storage: memory(),
				fetch: failing,
				userAgent: CHROME
			}).installed
		).resolves.toBeUndefined();
	});

	it('refuses a pack the store will not install, and then puts no routes', async () => {
		const { calls, store } = fakeStore({ refuseInstall: true });
		const net = network();
		const storage = memory();
		const text = JSON.stringify(ring());
		const once = () =>
			bootstrap({ store, doc: docWith(text), storage, fetch: net.fetch, userAgent: CHROME })
				.installed;
		await once();
		await once();
		expect(calls).not.toContain('routes');
		expect(storage.values.has('spool:lifetimes')).toBe(false);
	});

	it('counts an installed pack as a lifetime, and asks for persistence in Chromium only', async () => {
		const asks = { chrome: 0, firefox: 0 };
		const run = async (userAgent: string, key: 'chrome' | 'firefox') => {
			const { store } = fakeStore();
			const storage = memory();
			const manager = {
				persisted: async () => false,
				persist: async () => (asks[key]++, true)
			};
			const net = network();
			const text = JSON.stringify(ring());
			for (let view = 1; view <= 2; view++) {
				await bootstrap({
					store,
					doc: docWith(text),
					storage,
					fetch: net.fetch,
					manager,
					userAgent
				}).installed;
			}
			return storage.values.get('spool:lifetimes');
		};
		expect(await run(CHROME, 'chrome')).toBe('1');
		expect(await run(FIREFOX, 'firefox')).toBe('1');
		expect(asks).toEqual({ chrome: 1, firefox: 0 });
	});

	it('leaves the page on the old path when the ring is missing: the worker registers at once', async () => {
		const { store } = fakeStore();
		const boot = bootstrap({
			store,
			doc: docWith(null),
			storage: memory(),
			fetch: network().fetch,
			userAgent: CHROME
		});
		expect(boot.worker).toBe(true);
		const noDocument = bootstrap({ store, storage: memory(), userAgent: CHROME });
		expect(noDocument.worker).toBe(true);
		await noDocument.installed;
	});
});

describe('the navigation script', () => {
	it('keeps the navigation code out of the entry and in its own script', () => {
		expect(CLIENT_CORE).not.toContain('spool:navigated');
		expect(NAVIGATE_CORE).toContain('spool:navigated');
	});

	it('keeps the pack store in the entry and out of the navigation script', () => {
		expect(CLIENT_CORE).toContain('spool-bundle');
		expect(NAVIGATE_CORE).not.toContain('spool-bundle');
	});

	it('leaves the package.json contents out of the entry, and the version constant matches it', () => {
		expect(CLIENT_CORE).not.toContain('Client-Side Page Rendering and Execution Framework');
		expect(VERSION).toBe(packageJson.version);
	});

	it('is served at its version path with the page script headers', async () => {
		const spool = createSpool({ routes: [], store: memoryStore() });
		const origin = 'https://site.test';
		const script = await spool.respond(new Request(`${origin}${navigatePath(VERSION)}`));
		const client = await spool.respond(new Request(`${origin}${clientPath(VERSION)}`));
		expect(script?.status).toBe(200);
		expect(script?.headers.get('content-type')).toBe(client?.headers.get('content-type'));
		expect(script?.headers.get('cache-control')).toBe(client?.headers.get('cache-control'));
		expect(await script?.text()).toBe(NAVIGATE_CORE);
	});
});

describe('the writes element', () => {
	it('reads the element as its declared writes, and as none when it is not a list', () => {
		const write = { method: 'PATCH', pattern: '/courses/:id' } as unknown as ResourceWrite;
		expect(parseWrites(JSON.stringify([write]))).toEqual([write]);
		expect(parseWrites('{"method":"PATCH"}')).toEqual([]);
		expect(parseWrites('not json')).toEqual([]);
		expect(parseWrites(null)).toEqual([]);
	});
});
