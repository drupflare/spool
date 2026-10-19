import { describe, expect, it } from 'vitest';
import {
	CLEAR_ALL,
	decodeEnvelope,
	decodeEnvelopeOrClear,
	encodeEnvelope,
	HEADERS,
	ProtocolError,
	writeEnvelope,
	type Envelope
} from '../../src/protocol/index';

const roundTrip = (envelope: Envelope): Envelope =>
	decodeEnvelope(new Headers(encodeEnvelope(envelope)));

describe('the envelope codec', () => {
	it('always writes Spool-Protocol', () => {
		expect(encodeEnvelope({})).toEqual({ 'spool-protocol': '1' });
		expect(roundTrip({})).toEqual({ protocol: 1 });
	});

	it('round-trips Spool-Artifact, including ids and tags that need escaping', () => {
		const artifact = {
			id: '/tag/a b;c=d',
			scope: 'principal' as const,
			deps: ['node:1', 'menu,main', 'a;b'],
			version: 12
		};
		expect(roundTrip({ artifact }).artifact).toEqual(artifact);
	});

	it('round-trips an artifact with no deps', () => {
		const artifact = { id: '/', scope: 'public' as const, deps: [], version: 0 };
		expect(roundTrip({ artifact }).artifact).toEqual(artifact);
	});

	it('round-trips Spool-Invalidate with its versions', () => {
		const invalidate = { 'node:1': 4, 'a=b,c': 9, __proto__x: 1 };
		expect(roundTrip({ invalidate }).invalidate).toEqual(invalidate);
	});

	it('keeps an invalidated tag named __proto__ as an own property', () => {
		const decoded = decodeEnvelope(new Headers({ 'spool-invalidate': '__proto__=3' }));
		expect(Object.keys(decoded.invalidate ?? {})).toEqual(['__proto__']);
	});

	it('omits an empty Spool-Invalidate and an empty Spool-Clear', () => {
		const headers = encodeEnvelope({ invalidate: {}, clear: [] });
		expect(headers).toEqual({ 'spool-protocol': '1' });
	});

	it('round-trips Spool-Clear, Spool-Vector, the echoed cursor and Spool-Partition', () => {
		const envelope: Envelope = {
			protocol: 1,
			clear: [CLEAR_ALL, 'part/1'],
			vector: 77,
			seen: 70,
			partition: 'Ab_-09xyz'
		};
		expect(roundTrip(envelope)).toEqual(envelope);
	});

	it('writes onto existing Headers and replaces a spool header already there', () => {
		const headers = new Headers({ 'spool-vector': '1', 'x-other': 'keep' });
		writeEnvelope(headers, { vector: 5, clear: ['*'] });
		expect(headers.get(HEADERS.vector)).toBe('5');
		expect(headers.get(HEADERS.clear)).toBe(CLEAR_ALL);
		expect(headers.get('x-other')).toBe('keep');
	});

	it('decodes a response with no spool headers as an empty envelope', () => {
		expect(decodeEnvelope(new Headers())).toEqual({});
	});

	it.each([
		['spool-protocol', 'x'],
		['spool-protocol', '-1'],
		['spool-vector', '1.5'],
		['spool-vector', ''],
		['spool-vector-seen', 'abc'],
		['spool-artifact', 'noequals'],
		['spool-artifact', 'id=%2Fa; scope=public'],
		['spool-artifact', 'id=%2Fa; scope=other; v=1'],
		['spool-artifact', 'id=%E0%A4%A; scope=public; v=1'],
		['spool-artifact', 'id=%2Fa; scope=public; deps=%E0%A4%A; v=1'],
		['spool-artifact', 'id=%2Fa; scope=public; v=x'],
		['spool-invalidate', 'noversion'],
		['spool-invalidate', 'a=x'],
		['spool-invalidate', '%E0%A4%A=1'],
		['spool-clear', '%E0%A4%A'],
		['spool-partition', 'has space']
	])('throws ProtocolError for %s: %s', (name, value) => {
		try {
			decodeEnvelope(new Headers({ [name]: value }));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ProtocolError);
			expect((error as ProtocolError).code).toBe('bad-header');
		}
	});

	it('keeps a valid Spool-Clear when another spool header is malformed', () => {
		const headers = new Headers({
			'spool-protocol': '1',
			'spool-artifact': 'noequals',
			'spool-clear': 'abc, d%20e'
		});
		expect(() => decodeEnvelope(headers)).toThrow(ProtocolError);
		expect(decodeEnvelopeOrClear(headers)).toEqual({ protocol: 1, clear: ['abc', 'd e'] });
	});

	it('reads a malformed Spool-Clear as a full wipe', () => {
		const headers = new Headers({ 'spool-protocol': '1', 'spool-clear': '%E0%A4%A' });
		expect(decodeEnvelopeOrClear(headers)).toEqual({ protocol: 1, clear: [CLEAR_ALL] });
		expect(
			decodeEnvelopeOrClear(new Headers({ 'spool-vector': 'x', 'spool-clear': '%E0%A4%A' }))
		).toEqual({ protocol: 1, clear: [CLEAR_ALL] });
	});

	it('decodes a sound envelope in full and leaves other cases alone', () => {
		const sound = new Headers(encodeEnvelope({ vector: 3, clear: ['*'] }));
		expect(decodeEnvelopeOrClear(sound)).toEqual({ protocol: 1, vector: 3, clear: ['*'] });
		expect(decodeEnvelopeOrClear(new Headers())).toEqual({});
		expect(decodeEnvelopeOrClear(new Headers({ 'spool-vector': 'x' }))).toBeUndefined();
		const other = new Headers({
			'spool-protocol': '2',
			'spool-vector': 'x',
			'spool-clear': '*'
		});
		expect(decodeEnvelopeOrClear(other)).toBeUndefined();
	});

	it('refuses to encode a partition that is not a base64url token', () => {
		expect(() => encodeEnvelope({ partition: 'a b' })).toThrow(ProtocolError);
	});
});
