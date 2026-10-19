import { HEADERS } from '../protocol/envelope.js';
import { ProtocolError } from '../protocol/errors.js';
import { MAX_NEED, parseHeld, toSyncResponse } from '../protocol/sync.js';
import type { VersionStore } from '../stores/version-store.js';

/** a JSON response that no cache may keep */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
	});
}

async function respondNeed(held: Record<string, number>, store: VersionStore): Promise<Response> {
	const versions = Object.values(held);
	const headers = { [HEADERS.protocol]: '1' };
	if (versions.length === 0) {
		const cursor = await store.cursor();
		return json(
			{ ...toSyncResponse({ cursor, changed: {}, reset: false }), partial: true },
			200,
			{
				...headers,
				[HEADERS.vector]: String(cursor)
			}
		);
	}
	const diff = await store.diff(Math.min(...versions));
	const behind = Math.max(...versions) > diff.cursor;
	const changed = behind
		? {}
		: Object.fromEntries(
				Object.entries(diff.changed).filter(
					([tag, version]) => Object.hasOwn(held, tag) && version > (held[tag] as number)
				)
			);
	return json(
		{ ...toSyncResponse({ cursor: diff.cursor, changed, reset: behind }), partial: true },
		200,
		{ ...headers, [HEADERS.vector]: String(diff.cursor) }
	);
}

/**
 * Answers `/.spool/sync`. With `from=<n>` it is every tag changed after `n` and the artifacts
 * dropped. With `need=<id>@<version>,...` it is only those ids whose version moved past the one
 * the worker holds, which is the invalid part of what the next page reads and nothing else.
 */
export async function respondSync(url: URL, store: VersionStore): Promise<Response> {
	const need = url.searchParams.get('need');
	if (need !== null) return respondNeed(parseHeld(need, MAX_NEED), store);
	const raw = url.searchParams.get('from') ?? '';
	if (!/^\d{1,15}$/.test(raw)) {
		throw new ProtocolError('bad-sync', 'from must be a non-negative integer');
	}
	const diff = await store.diff(Number(raw));
	return json(toSyncResponse(diff), 200, {
		[HEADERS.protocol]: '1',
		[HEADERS.vector]: String(diff.cursor)
	});
}
