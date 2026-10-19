import { ProtocolError } from './errors.js';

/** the values a pattern captured, keyed by parameter name */
export type Params = Record<string, string>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function segments(path: string): string[] {
	const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
	return trimmed === '/' ? [] : trimmed.slice(1).split('/');
}

/**
 * Validates a spool path pattern: `/a/:b/c`, where `:name` captures one whole segment, and a final
 * `**` matches any number of segments after the prefix, none included. A trailing slash is ignored
 * on both sides of a match.
 */
export function checkPattern(pattern: string): void {
	if (!pattern.startsWith('/')) {
		throw new ProtocolError('bad-pattern', `pattern must start with "/": ${pattern}`);
	}
	const seen = new Set<string>();
	const parts = segments(pattern);
	for (const [at, part] of parts.entries()) {
		if (part === '') throw new ProtocolError('bad-pattern', `empty segment in ${pattern}`);
		if (part === '**') {
			if (at !== parts.length - 1) {
				throw new ProtocolError(
					'bad-pattern',
					`"**" must be the last segment in ${pattern}`
				);
			}
			continue;
		}
		if (!part.startsWith(':')) continue;
		const name = part.slice(1);
		if (!NAME.test(name)) {
			throw new ProtocolError('bad-pattern', `bad parameter name "${name}" in ${pattern}`);
		}
		if (seen.has(name)) {
			throw new ProtocolError('bad-pattern', `duplicate parameter "${name}" in ${pattern}`);
		}
		seen.add(name);
	}
}

/** the captured params when `path` fits `pattern`, otherwise null */
export function matchPattern(pattern: string, path: string): Params | null {
	const want = segments(pattern);
	const got = segments(path);
	const rest = want[want.length - 1] === '**';
	if (rest) want.pop();
	if (rest ? got.length < want.length : want.length !== got.length) return null;
	const params: Params = {};
	for (let i = 0; i < want.length; i++) {
		const expected = want[i] as string;
		const actual = got[i] as string;
		if (expected.startsWith(':')) {
			if (actual === '') return null;
			try {
				params[expected.slice(1)] = decodeURIComponent(actual);
			} catch {
				return null;
			}
		} else if (expected !== actual) return null;
	}
	return params;
}

/** the path a pattern produces for `params`; the inverse of {@link matchPattern} */
export function fillPattern(pattern: string, params: Params): string {
	const parts = segments(pattern).map((part) => {
		if (part === '**') {
			throw new ProtocolError('bad-pattern', `${pattern} has no single path to fill`);
		}
		if (!part.startsWith(':')) return part;
		const value = params[part.slice(1)];
		if (value === undefined) {
			throw new ProtocolError(
				'bad-pattern',
				`missing parameter "${part.slice(1)}" for ${pattern}`
			);
		}
		return encodeURIComponent(value);
	});
	return `/${parts.join('/')}`;
}
