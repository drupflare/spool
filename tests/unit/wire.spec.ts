import { describe, expect, it } from 'vitest';
import {
	ARTIFACT_TAG_PREFIX,
	artifactTag,
	encodeHeld,
	MAX_BEACON_EVENTS,
	MAX_WANT,
	parseArtifact,
	parseBeaconBatch,
	parseHeld,
	parseSyncResponse,
	ProtocolError,
	toSyncResponse,
	VersionVector,
	type Artifact
} from '../../src/protocol/index';

const base = { protocol: 1, id: '/a', scope: 'public', deps: ['t'], vector: 3 };

const expectCode = (fn: () => unknown, code: string) => {
	try {
		fn();
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe(code);
	}
};

describe('parseArtifact', () => {
	it('round-trips a template artifact through JSON', () => {
		const artifact: Artifact = {
			...base,
			scope: 'public',
			protocol: 1,
			strategy: 'template',
			body: { data: { x: [1] } }
		} as Artifact;
		expect(parseArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact);
	});

	it('round-trips an assembly artifact with and without fragments and slots', () => {
		const full = {
			...base,
			strategy: 'assembly',
			body: { shell: 's', fragments: { a: 'x' }, slots: { n: '1' } }
		};
		expect(parseArtifact(JSON.parse(JSON.stringify(full)))).toEqual(full);
		const bare = { ...base, strategy: 'assembly', body: { shell: 's' } };
		expect(parseArtifact(bare)).toEqual(bare);
	});

	it('keeps a principal scope', () => {
		expect(
			parseArtifact({ ...base, scope: 'principal', strategy: 'template', body: { data: 1 } })
				.scope
		).toBe('principal');
	});

	it.each([
		['not an object', 'x'],
		['an array', []],
		['null', null],
		['another protocol', { ...base, protocol: 2, strategy: 'template', body: { data: 1 } }],
		['a relative id', { ...base, id: 'a', strategy: 'template', body: { data: 1 } }],
		['no id', { ...base, id: 5, strategy: 'template', body: { data: 1 } }],
		['an unknown scope', { ...base, scope: 'x', strategy: 'template', body: { data: 1 } }],
		['deps not a list', { ...base, deps: 'a', strategy: 'template', body: { data: 1 } }],
		['a non-string dep', { ...base, deps: [1], strategy: 'template', body: { data: 1 } }],
		['a fractional vector', { ...base, vector: 1.5, strategy: 'template', body: { data: 1 } }],
		['a negative vector', { ...base, vector: -1, strategy: 'template', body: { data: 1 } }],
		['a string vector', { ...base, vector: '1', strategy: 'template', body: { data: 1 } }],
		['no body', { ...base, strategy: 'template' }],
		['a template body without data', { ...base, strategy: 'template', body: {} }],
		['an assembly body without a shell', { ...base, strategy: 'assembly', body: {} }],
		[
			'fragments not an object',
			{ ...base, strategy: 'assembly', body: { shell: 's', fragments: [] } }
		],
		[
			'a non-string fragment',
			{ ...base, strategy: 'assembly', body: { shell: 's', fragments: { a: 1 } } }
		],
		['an unknown strategy', { ...base, strategy: 'projection', body: {} }]
	])('refuses %s', (_name, value) => {
		expectCode(() => parseArtifact(value), 'bad-artifact');
	});
});

describe('sync responses', () => {
	it('splits artifact drops from changed tags', () => {
		const vector = new VersionVector();
		vector.bump(['node:1', artifactTag('/page')]);
		const response = toSyncResponse(vector.diff(0));
		expect(response).toEqual({
			protocol: 1,
			cursor: 1,
			changed: { 'node:1': 1 },
			dropped: ['/page'],
			reset: false
		});
		expect(artifactTag('/page')).toBe(`${ARTIFACT_TAG_PREFIX}/page`);
	});

	it('round-trips through JSON', () => {
		const response = toSyncResponse(new VersionVector().diff(0));
		expect(parseSyncResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
	});

	it.each([
		['null', null],
		['another protocol', { protocol: 2, cursor: 0, changed: {}, dropped: [], reset: false }],
		['a bad cursor', { protocol: 1, cursor: -1, changed: {}, dropped: [], reset: false }],
		['changed as an array', { protocol: 1, cursor: 0, changed: [], dropped: [], reset: false }],
		[
			'a fractional version',
			{ protocol: 1, cursor: 0, changed: { a: 0.5 }, dropped: [], reset: false }
		],
		[
			'dropped not strings',
			{ protocol: 1, cursor: 0, changed: {}, dropped: [1], reset: false }
		],
		['reset not boolean', { protocol: 1, cursor: 0, changed: {}, dropped: [], reset: 0 }]
	])('refuses %s', (_name, value) => {
		expectCode(() => parseSyncResponse(value), 'bad-sync');
	});
});

describe('beacon batches', () => {
	const event = { path: '/cdn-cgi/rum', body: '{}', contentType: 'application/json', at: 1 };

	it('round-trips through JSON', () => {
		const batch = { protocol: 1, events: [event] };
		expect(parseBeaconBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
		expect(parseBeaconBatch({ protocol: 1, events: [] }).events).toEqual([]);
	});

	it.each([
		['null', null],
		['another protocol', { protocol: 2, events: [] }],
		['events not a list', { protocol: 1, events: {} }],
		['a relative path', { protocol: 1, events: [{ ...event, path: 'x' }] }],
		['a non-string body', { protocol: 1, events: [{ ...event, body: 1 }] }],
		['a non-string content type', { protocol: 1, events: [{ ...event, contentType: 1 }] }],
		['a non-finite time', { protocol: 1, events: [{ ...event, at: Number.NaN }] }],
		['a null event', { protocol: 1, events: [null] }],
		[
			'too many events',
			{ protocol: 1, events: Array.from({ length: MAX_BEACON_EVENTS + 1 }, () => event) }
		]
	])('refuses %s', (_name, value) => {
		expectCode(() => parseBeaconBatch(value), 'bad-beacon');
	});
});

describe('want lists on beacon batches', () => {
	it('round-trips a want list and leaves it off a batch that has none', () => {
		const batch = { protocol: 1, events: [], want: ['/a', '/b'] };
		expect(parseBeaconBatch(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
		expect('want' in parseBeaconBatch({ protocol: 1, events: [] })).toBe(false);
	});

	it.each([
		['a non-list', { want: '/a' }],
		['a relative path', { want: ['a'] }],
		['a non-string', { want: [1] }],
		['too many paths', { want: Array.from({ length: MAX_WANT + 1 }, (_, i) => `/p${i}`) }]
	])('refuses %s', (_name, extra) => {
		expectCode(() => parseBeaconBatch({ protocol: 1, events: [], ...extra }), 'bad-beacon');
	});
});

describe('held versions', () => {
	it('round-trips ids with commas, at signs and non-ASCII through the query format', () => {
		const held = { 'a,b': 1, 'c@d': 2, 'é:1': 3, plain: 0, [artifactTag('/p/1')]: 9 };
		expect(parseHeld(encodeHeld(held), 64)).toEqual(held);
		expect(parseHeld('', 64)).toEqual({});
	});

	it.each(['a', 'a@', 'a@x', 'a@-1', '@3', 'a@1.5', 'a%ZZ@1'])('refuses %j', (text) => {
		expectCode(() => parseHeld(text, 64), 'bad-sync');
	});

	it('refuses more ids than the limit', () => {
		expectCode(() => parseHeld('a@1,b@1,c@1', 2), 'bad-sync');
		expect(Object.keys(parseHeld('a@1,b@1', 2))).toEqual(['a', 'b']);
	});

	it('carries the partial flag on a sync response and drops it when false', () => {
		const base = { protocol: 1, cursor: 3, changed: {}, dropped: [], reset: false };
		expect(parseSyncResponse({ ...base, partial: true })).toEqual({ ...base, partial: true });
		expect('partial' in parseSyncResponse({ ...base, partial: false })).toBe(false);
		expectCode(() => parseSyncResponse({ ...base, partial: 1 }), 'bad-sync');
	});
});
