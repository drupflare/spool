import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceHash } from '../../scripts/source-hash';
import { CLIENT_CORE, SOURCE_HASH, SW_CORE } from '../../src/server/embedded';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('the embedded bundles', () => {
	it('were built from the current sources; run `bun run build:sw` when this fails', () => {
		expect(SOURCE_HASH).toBe(sourceHash(root));
	});

	it('register the four service worker handlers when the worker script runs', () => {
		const listeners: string[] = [];
		const scope = {
			__SPOOL_CONFIG__: {
				protocol: 1,
				version: 'test',
				routes: [],
				templates: {},
				beacons: [],
				clientTag: ''
			},
			location: { origin: 'https://site.test' },
			addEventListener: (type: string) => void listeners.push(type)
		};
		new Function('self', 'indexedDB', 'caches', 'fetch', SW_CORE)(scope, {}, {}, () => {});
		expect(listeners.sort()).toEqual(['activate', 'fetch', 'install', 'message']);
	});

	it('exposes spool.ready, resolving null without service workers, when the page script runs', async () => {
		const holder = globalThis as { spool?: { ready: Promise<unknown> } };
		delete holder.spool;
		new Function(CLIENT_CORE)();
		const ready = (globalThis as { spool?: { ready: Promise<unknown> } }).spool?.ready;
		expect(await ready).toBeNull();
		delete holder.spool;
	});
});
