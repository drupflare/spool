import { ProtocolError } from '../errors.js';
import type { CompiledTemplate, TemplateNode } from './compile.js';

type Frame = { value: unknown; index: number };

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

/** escapes the five characters that matter in HTML text and quoted attributes */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

function own(value: unknown, key: string): unknown {
	if (value === null || typeof value !== 'object') return undefined;
	return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function lookup(path: string[], frames: Frame[]): unknown {
	const innermost = frames[frames.length - 1] as Frame;
	if (path.length === 0) return innermost.value;
	if (path[0] === '@index') return innermost.index;
	for (let i = frames.length - 1; i >= 0; i--) {
		const frame = frames[i] as Frame;
		if (own(frame.value, path[0] as string) === undefined) continue;
		return path.reduce<unknown>((value, key) => own(value, key), frame.value);
	}
	return undefined;
}

function truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	return !(
		value === undefined ||
		value === null ||
		value === false ||
		value === '' ||
		value === 0
	);
}

function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function run(nodes: TemplateNode[], frames: Frame[], trusted: ReadonlySet<string>): string {
	let out = '';
	for (const node of nodes) {
		if (node.t === 'text') out += node.v;
		else if (node.t === 'var') {
			const value = text(lookup(node.p, frames));
			if (!node.raw) out += escapeHtml(value);
			else if (trusted.has(node.p.join('.'))) out += value;
			else
				throw new ProtocolError('bad-template', `{{{${node.p.join('.')}}}} is not trusted`);
		} else if (node.t === 'if') {
			out += run(truthy(lookup(node.p, frames)) ? node.then : node.else, frames, trusted);
		} else {
			const list = lookup(node.p, frames);
			if (!Array.isArray(list)) continue;
			list.forEach((value, index) => {
				out += run(node.body, [...frames, { value, index }], trusted);
			});
		}
	}
	return out;
}

/**
 * Renders a compiled template against JSON data. A name resolves only to an own property of the
 * data, so `constructor` and `__proto__` print nothing, and a raw field must be in the template's
 * trusted list even if the tree was edited after compilation.
 */
export function interpretTemplate(template: CompiledTemplate, data: unknown): string {
	if (template.v !== 1) {
		throw new ProtocolError('bad-template', `unknown template version ${String(template.v)}`);
	}
	return run(template.nodes, [{ value: data, index: 0 }], new Set(template.trusted));
}
