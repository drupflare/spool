import { describe, expect, it, vi } from 'vitest';
import { createActivity, type ActivityHost } from '../../src/client/activity';
import { closeOnPageHide } from '../../src/client/lifecycle';
import { crossOriginLoads } from '../../src/client/loads';
import { register } from '../../src/client/register';

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
