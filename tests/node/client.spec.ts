import { describe, expect, it } from 'vitest';
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
