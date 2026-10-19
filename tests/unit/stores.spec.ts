import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ProtocolError } from '../../src/protocol/index';
import { durableObjectStore, type SpoolVersions } from '../../src/stores/durable-object';
import { memoryStore, type VersionStore } from '../../src/stores/index';

function behavesLikeAVector(make: () => VersionStore) {
	it('starts empty', async () => {
		const store = make();
		expect(await store.cursor()).toBe(0);
		expect(await store.diff(0)).toEqual({ cursor: 0, changed: {}, reset: false });
	});

	it('bumps monotonically and diffs by cursor', async () => {
		const store = make();
		expect(await store.bump(['a', 'b'])).toBe(1);
		expect(await store.bump([])).toBe(1);
		expect(await store.bump(['a', 'a'])).toBe(2);
		expect(await store.cursor()).toBe(2);
		expect((await store.diff(0)).changed).toEqual({ a: 2, b: 1 });
		expect((await store.diff(1)).changed).toEqual({ a: 2 });
		expect(await store.diff(2)).toEqual({ cursor: 2, changed: {}, reset: false });
	});

	it('tells a holder ahead of it to reset', async () => {
		const store = make();
		await store.bump(['a']);
		expect(await store.diff(7)).toEqual({ cursor: 1, changed: { a: 1 }, reset: true });
	});
}

describe('memoryStore', () => {
	behavesLikeAVector(() => memoryStore());

	it('resumes from a snapshot and refuses a bad one', async () => {
		const store = memoryStore({ cursor: 4, versions: { a: 3 } });
		expect(await store.cursor()).toBe(4);
		expect(await store.bump(['b'])).toBe(5);
		expect(() => memoryStore({ cursor: 1, versions: { a: 9 } })).toThrow(ProtocolError);
	});
});

describe('SpoolVersions', () => {
	let n = 0;
	const fresh = () => durableObjectStore(env.SPOOL_VERSIONS, `vector-${n++}`);
	behavesLikeAVector(fresh);

	it('keeps separate vectors under separate names', async () => {
		const a = durableObjectStore(env.SPOOL_VERSIONS, 'site-a');
		const b = durableObjectStore(env.SPOOL_VERSIONS, 'site-b');
		await a.bump(['t']);
		expect(await a.cursor()).toBe(1);
		expect(await b.cursor()).toBe(0);
	});

	it('defaults to one shared instance name', async () => {
		const first = durableObjectStore(env.SPOOL_VERSIONS);
		const second = durableObjectStore(env.SPOOL_VERSIONS);
		await first.bump(['shared']);
		expect((await second.diff(0)).changed).toEqual({ shared: 1 });
	});

	it('persists across a restart and keeps the cursor monotonic', async () => {
		const stub = env.SPOOL_VERSIONS.getByName('restart');
		const store = durableObjectStore(env.SPOOL_VERSIONS, 'restart');
		await store.bump(['node:1']);
		await store.bump(['node:2', 'node:1']);
		const before = await store.diff(0);

		await evictDurableObject(stub);

		expect(await store.cursor()).toBe(2);
		expect(await store.diff(0)).toEqual(before);
		expect(await store.bump(['node:3'])).toBe(3);
	});

	it('writes a bump atomically: a failing statement leaves the cursor and tags alone', async () => {
		const stub = env.SPOOL_VERSIONS.getByName('atomic');
		await stub.bump(['a']);
		const failed = await runInDurableObject(stub, (instance: SpoolVersions, state) => {
			state.storage.sql.exec('DROP TABLE spool_meta');
			try {
				instance.bump(['b']);
				return 'bumped';
			} catch {
				return 'failed';
			}
		});
		expect(failed).toBe('failed');
		const names = await runInDurableObject(stub, (_i: SpoolVersions, state) =>
			state.storage.sql
				.exec('SELECT tag FROM spool_tags ORDER BY tag')
				.toArray()
				.map((r) => r['tag'])
		);
		expect(names).toEqual(['a']);
	});
});
