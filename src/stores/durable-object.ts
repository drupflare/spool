import { DurableObject } from 'cloudflare:workers';
import type { VectorDiff } from '../protocol/vector.js';
import type { VersionStore } from './version-store.js';

/**
 * The version vector in a SQLite-backed Durable Object: one row per tag and one cursor row, so it
 * survives eviction and restarts. Bind it as a Durable Object class and pass the namespace to
 * {@link durableObjectStore}.
 */
export class SpoolVersions extends DurableObject {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec(
			'CREATE TABLE IF NOT EXISTS spool_tags (tag TEXT PRIMARY KEY, version INTEGER NOT NULL) WITHOUT ROWID'
		);
		sql.exec(
			'CREATE TABLE IF NOT EXISTS spool_meta (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL)'
		);
		sql.exec('INSERT OR IGNORE INTO spool_meta (id, cursor) VALUES (0, 0)');
	}

	/** records a change to `tags` and returns the new cursor */
	bump(tags: string[]): number {
		const sql = this.ctx.storage.sql;
		return this.ctx.storage.transactionSync(() => {
			const cursor = this.cursor();
			if (tags.length === 0) return cursor;
			const next = cursor + 1;
			for (const tag of new Set(tags)) {
				sql.exec(
					'INSERT INTO spool_tags (tag, version) VALUES (?, ?) ON CONFLICT (tag) DO UPDATE SET version = excluded.version',
					tag,
					next
				);
			}
			sql.exec('UPDATE spool_meta SET cursor = ? WHERE id = 0', next);
			return next;
		});
	}

	/** the cursor of the most recent bump */
	cursor(): number {
		return Number(
			this.ctx.storage.sql.exec('SELECT cursor FROM spool_meta WHERE id = 0').one()['cursor']
		);
	}

	/** every tag changed after `from`; see `VersionVector.diff` */
	diff(from: number): VectorDiff {
		const cursor = this.cursor();
		const reset = from > cursor;
		const rows = this.ctx.storage.sql
			.exec('SELECT tag, version FROM spool_tags WHERE version > ?', reset ? 0 : from)
			.toArray();
		const changed = Object.fromEntries(
			rows.map((r) => [String(r['tag']), Number(r['version'])])
		);
		return { cursor, changed, reset };
	}
}

/** a {@link VersionStore} over one named instance of the {@link SpoolVersions} namespace */
export function durableObjectStore(
	namespace: DurableObjectNamespace<SpoolVersions>,
	name = 'spool'
): VersionStore {
	const stub = () => namespace.getByName(name);
	return {
		bump: (tags) => stub().bump([...tags]),
		cursor: () => stub().cursor(),
		diff: (from) => stub().diff(from)
	};
}
