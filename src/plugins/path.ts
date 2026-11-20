/** the framework path syntaxes the converter reads */
export type PathSyntax = 'vue-router' | 'nuxt' | 'react-router' | 'next' | 'angular';

/** a spool pattern, or the reason the path stays a network route */
export type Conversion = { kind: 'pattern'; pattern: string } | { kind: 'network'; reason: string };

type Part = { kind: 'static' | 'param'; text: string } | { kind: 'network'; reason: string };

const CATCH_ALL = 'catch-all segment: ** captures no value';
const REPEAT = 'repeatable segment: spool has no repeatable segment';
const OPTIONAL = 'optional segment: spool has no optional segment';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const PLAIN = /^[A-Za-z0-9._~-]+$/;
const VUE_PARAM = /^:([^:()?+*]+)(\(\))?$/;
const VUE_CATCH_ALL = /\(\.\*\)\*$|\(\[\^\/\]\*\)\*$/;
const NEXT_PARAM = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

function network(reason: string): Part {
	return { kind: 'network', reason };
}

function plain(segment: string): Part {
	if (PLAIN.test(segment) && segment !== '.' && segment !== '..') {
		return { kind: 'static', text: segment };
	}
	return network('static segment has a reserved or non-ASCII character');
}

// nuxt emits `:name()` for a file `[name].vue`; the empty pattern is the default one-segment match
function vuePart(segment: string): Part {
	const param = VUE_PARAM.exec(segment);
	if (param) {
		const name = param[1] ?? '';
		return NAME.test(name)
			? { kind: 'param', text: `:${name}` }
			: network('parameter name is not an identifier');
	}
	if (VUE_CATCH_ALL.test(segment)) return network(CATCH_ALL);
	if (segment.endsWith('?')) return network(OPTIONAL);
	if (segment.startsWith(':') && /[+*]$/.test(segment)) return network(REPEAT);
	if (segment.includes('(')) return network('custom regular expression in a segment');
	return plain(segment);
}

function reactPart(segment: string): Part {
	if (segment.includes('*')) return network('splat segment: * captures no value');
	if (segment.endsWith('?')) return network(OPTIONAL);
	if (segment.startsWith(':')) {
		return PARAM.test(segment)
			? { kind: 'param', text: segment }
			: network('parameter is not a whole identifier segment');
	}
	if (/[(){}]/.test(segment)) return network('grouped segment');
	return plain(segment);
}

function nextPart(segment: string): Part {
	if (segment.startsWith('[...') || segment.startsWith('[[...')) return network(CATCH_ALL);
	const param = NEXT_PARAM.exec(segment);
	if (param) return { kind: 'param', text: `:${param[1] ?? ''}` };
	if (segment.includes('['))
		return network('dynamic segment mixed with text or not an identifier');
	if (segment.startsWith('(')) {
		return network('interception segment: (.) and (..) match another route');
	}
	return plain(segment);
}

function angularPart(segment: string): Part {
	if (segment === '**') return network('wildcard route: ** captures no value');
	if (segment.startsWith(':')) {
		return PARAM.test(segment)
			? { kind: 'param', text: segment }
			: network('parameter name is not an identifier');
	}
	if (/[*()]/.test(segment)) return network('unsupported segment');
	return plain(segment);
}

// next drops route groups, parallel slots and the leaf `page` or `route`, as its own router does
function nextSegments(segments: readonly string[]): string[] {
	return segments.filter(
		(segment, at) =>
			!(segment.startsWith('(') && segment.endsWith(')')) &&
			!segment.startsWith('@') &&
			!(at === segments.length - 1 && (segment === 'page' || segment === 'route'))
	);
}

// a `/` inside parentheses is part of a pattern, such as the `([^/]*)*` of a nuxt catch-all
function segmentsOf(path: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of path) {
		if (char === '(') depth++;
		else if (char === ')') depth = Math.max(0, depth - 1);
		if (char === '/' && depth === 0) {
			out.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	out.push(current);
	return out.filter((segment) => segment !== '');
}

function drive(segments: readonly string[], part: (segment: string) => Part): Conversion {
	const out: string[] = [];
	for (const segment of segments) {
		const next = part(segment);
		if (next.kind === 'network') return { kind: 'network', reason: next.reason };
		out.push(next.text);
	}
	const names = out.filter((text) => text.startsWith(':'));
	if (new Set(names).size !== names.length) {
		return { kind: 'network', reason: 'duplicate parameter name' };
	}
	return { kind: 'pattern', pattern: `/${out.join('/')}` };
}

/**
 * Converts a framework route path to a spool pattern. A static segment and a single-segment
 * parameter convert; anything else returns `network` with the reason, never a pattern that would
 * match a different set of URLs. Angular paths may omit the leading slash.
 */
export function toSpoolPattern(syntax: PathSyntax, path: string): Conversion {
	if (syntax !== 'angular' && !path.startsWith('/')) {
		return { kind: 'network', reason: 'path must start with /' };
	}
	const segments = segmentsOf(path);
	switch (syntax) {
		case 'vue-router':
		case 'nuxt':
			return drive(segments, vuePart);
		case 'react-router':
			return drive(segments, reactPart);
		case 'next':
			return drive(nextSegments(segments), nextPart);
		case 'angular':
			return drive(segments, angularPart);
	}
}
