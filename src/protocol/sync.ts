import { PROTOCOL_VERSION } from './artifact.js';
import { ProtocolError } from './errors.js';
import type { VectorDiff } from './vector.js';

/** an artifact id rides the vector as this tag, so an explicit drop shares the sync cursor */
export const ARTIFACT_TAG_PREFIX = 'spool:artifact:';

/** the body of `/.spool/sync` */
export type SyncResponse = {
	protocol: typeof PROTOCOL_VERSION;
	cursor: number;
	/** tag to the vector version of its last change */
	changed: Record<string, number>;
	/** artifact ids the server dropped outright */
	dropped: string[];
	/** the server's vector is behind the asked-for cursor: drop everything held */
	reset: boolean;
	/** answers a `need` request: `changed` covers only the ids asked about and the cursor is not the holder's to take */
	partial?: boolean;
};

/** most ids one `need` request may name; a worker needing more falls back to a full sync */
export const MAX_NEED = 64;

/** most ids one `have` list may carry on an artifact request */
export const MAX_HAVE = 256;

/** the vector tag that drops artifact `id` */
export function artifactTag(id: string): string {
	return `${ARTIFACT_TAG_PREFIX}${id}`;
}

/** splits a vector diff into changed tags and dropped artifact ids */
export function toSyncResponse(diff: VectorDiff): SyncResponse {
	const entries = Object.entries(diff.changed);
	const dropped = entries
		.filter(([tag]) => tag.startsWith(ARTIFACT_TAG_PREFIX))
		.map(([tag]) => tag.slice(ARTIFACT_TAG_PREFIX.length));
	const changed = Object.fromEntries(
		entries.filter(([tag]) => !tag.startsWith(ARTIFACT_TAG_PREFIX))
	);
	return { protocol: PROTOCOL_VERSION, cursor: diff.cursor, changed, dropped, reset: diff.reset };
}

function bad(message: string): never {
	throw new ProtocolError('bad-sync', message);
}

/** `id@version` pairs for the `need` and `have` query parameters, ids percent-encoded */
export function encodeHeld(held: Readonly<Record<string, number>>): string {
	return Object.entries(held)
		.map(([id, version]) => `${encodeURIComponent(id)}@${version}`)
		.join(',');
}

/** reads {@link encodeHeld} back; throws `ProtocolError` on a malformed pair or more than `limit` */
export function parseHeld(text: string, limit: number): Record<string, number> {
	const out: Record<string, number> = {};
	const parts = text.split(',').filter((part) => part !== '');
	if (parts.length > limit) return bad(`more than ${limit} ids`);
	for (const part of parts) {
		const at = part.lastIndexOf('@');
		const version = part.slice(at + 1);
		if (at < 1 || !/^\d{1,15}$/.test(version)) return bad('entries are id@version');
		try {
			out[decodeURIComponent(part.slice(0, at))] = Number(version);
		} catch {
			return bad('an id has a bad escape');
		}
	}
	return out;
}

/** validates JSON from `/.spool/sync` */
export function parseSyncResponse(value: unknown): SyncResponse {
	if (typeof value !== 'object' || value === null) return bad('sync response must be an object');
	const v = value as Record<string, unknown>;
	if (v['protocol'] !== PROTOCOL_VERSION) return bad('unsupported protocol version');
	const { cursor, changed, dropped, reset, partial } = v;
	if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
		return bad('cursor must be a non-negative integer');
	}
	if (typeof changed !== 'object' || changed === null || Array.isArray(changed)) {
		return bad('changed must be an object');
	}
	for (const version of Object.values(changed)) {
		if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
			return bad('changed versions must be integers');
		}
	}
	if (!Array.isArray(dropped) || dropped.some((d) => typeof d !== 'string')) {
		return bad('dropped must be a list of strings');
	}
	if (typeof reset !== 'boolean') return bad('reset must be a boolean');
	if (partial !== undefined && typeof partial !== 'boolean')
		return bad('partial must be a boolean');
	const out: SyncResponse = {
		protocol: PROTOCOL_VERSION,
		cursor,
		changed: changed as Record<string, number>,
		dropped,
		reset
	};
	if (partial) out.partial = true;
	return out;
}
