import { ProtocolError } from './errors.js';

/** the tags that changed after a cursor, each with the cursor value of its last change */
export type VectorDiff = {
	cursor: number;
	changed: Record<string, number>;
	/** the asked-for cursor is ahead of this vector, so the holder lost state and must start over */
	reset: boolean;
};

/** a vector as JSON: the cursor and every tag's version */
export type VectorSnapshot = { cursor: number; versions: Record<string, number> };

/**
 * Tag to counter, with one cursor that only moves forward. A bump moves the cursor once and stamps
 * every tag in it with the new value, so a tag's version is the cursor at its last change and
 * `diff(from)` is every tag stamped after `from`.
 */
export class VersionVector {
	#cursor = 0;
	readonly #versions = new Map<string, number>();

	/** rebuilds a vector from {@link VersionVector.snapshot} */
	static from(snapshot: VectorSnapshot): VersionVector {
		const vector = new VersionVector();
		if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) {
			throw new ProtocolError('bad-sync', 'snapshot cursor must be a non-negative integer');
		}
		vector.#cursor = snapshot.cursor;
		for (const [tag, version] of Object.entries(snapshot.versions)) {
			if (!Number.isSafeInteger(version) || version < 1 || version > snapshot.cursor) {
				throw new ProtocolError(
					'bad-sync',
					`snapshot version for "${tag}" is out of range`
				);
			}
			vector.#versions.set(tag, version);
		}
		return vector;
	}

	/** the version of the most recent bump */
	get cursor(): number {
		return this.#cursor;
	}

	/** the cursor at which `tag` last changed, or 0 when it never has */
	version(tag: string): number {
		return this.#versions.get(tag) ?? 0;
	}

	/** records a change to `tags` and returns the new cursor; no tags is no change */
	bump(tags: readonly string[]): number {
		if (tags.length === 0) return this.#cursor;
		this.#cursor += 1;
		for (const tag of tags) this.#versions.set(tag, this.#cursor);
		return this.#cursor;
	}

	/** every tag changed after `from` */
	diff(from: number): VectorDiff {
		if (from > this.#cursor) return { cursor: this.#cursor, changed: this.#all(), reset: true };
		const changed = Object.fromEntries(
			[...this.#versions].filter(([, version]) => version > from)
		);
		return { cursor: this.#cursor, changed, reset: false };
	}

	/** the vector as JSON */
	snapshot(): VectorSnapshot {
		return { cursor: this.#cursor, versions: this.#all() };
	}

	#all(): Record<string, number> {
		return Object.fromEntries(this.#versions);
	}
}
