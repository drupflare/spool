import { describe, expect, it } from 'vitest';
import { ProtocolError, VersionVector } from '../../src/protocol/index';

describe('VersionVector', () => {
	it('starts at zero with every tag unversioned', () => {
		const vector = new VersionVector();
		expect(vector.cursor).toBe(0);
		expect(vector.version('a')).toBe(0);
		expect(vector.diff(0)).toEqual({ cursor: 0, changed: {}, reset: false });
	});

	it('moves the cursor once per bump and stamps every tag in it', () => {
		const vector = new VersionVector();
		expect(vector.bump(['a', 'b'])).toBe(1);
		expect(vector.bump(['a'])).toBe(2);
		expect(vector.version('a')).toBe(2);
		expect(vector.version('b')).toBe(1);
	});

	it('is monotonic: the cursor never decreases and an empty bump changes nothing', () => {
		const vector = new VersionVector();
		const seen: number[] = [];
		for (const tags of [['a'], [], ['b', 'a'], [], ['c']]) seen.push(vector.bump(tags));
		expect(seen).toEqual([1, 1, 2, 2, 3]);
		expect(seen).toEqual([...seen].sort((x, y) => x - y));
	});

	it('diffs every tag stamped after the cursor and nothing at or before it', () => {
		const vector = new VersionVector();
		vector.bump(['a']);
		vector.bump(['b']);
		vector.bump(['a', 'c']);
		expect(vector.diff(0).changed).toEqual({ a: 3, b: 2, c: 3 });
		expect(vector.diff(1).changed).toEqual({ a: 3, b: 2, c: 3 });
		expect(vector.diff(2).changed).toEqual({ a: 3, c: 3 });
		expect(vector.diff(3)).toEqual({ cursor: 3, changed: {}, reset: false });
	});

	it('tells a holder ahead of the vector to reset and hands it everything', () => {
		const vector = new VersionVector();
		vector.bump(['a']);
		expect(vector.diff(9)).toEqual({ cursor: 1, changed: { a: 1 }, reset: true });
	});

	it('keeps a tag named like an Object property', () => {
		const vector = new VersionVector();
		vector.bump(['__proto__', 'constructor']);
		expect(Object.keys(vector.diff(0).changed).sort()).toEqual(['__proto__', 'constructor']);
	});

	it('round-trips through a snapshot', () => {
		const vector = new VersionVector();
		vector.bump(['a']);
		vector.bump(['b', 'a']);
		const copy = VersionVector.from(JSON.parse(JSON.stringify(vector.snapshot())));
		expect(copy.snapshot()).toEqual(vector.snapshot());
		expect(copy.bump(['c'])).toBe(3);
	});

	it.each([
		[{ cursor: -1, versions: {} }],
		[{ cursor: 1.5, versions: {} }],
		[{ cursor: 1, versions: { a: 2 } }],
		[{ cursor: 1, versions: { a: 0 } }]
	])('refuses the snapshot %j', (snapshot) => {
		expect(() => VersionVector.from(snapshot)).toThrow(ProtocolError);
	});
});
