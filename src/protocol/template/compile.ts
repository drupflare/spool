import { ProtocolError } from '../errors.js';

/** one node of a compiled template; `p` is a dotted path split into segments, `[]` is `this` */
export type TemplateNode =
	| { t: 'text'; v: string }
	| { t: 'var'; p: string[]; raw: boolean }
	| { t: 'each'; p: string[]; body: TemplateNode[] }
	| { t: 'if'; p: string[]; then: TemplateNode[]; else: TemplateNode[] };

/** the JSON a service worker interprets; `trusted` lists the paths allowed to print unescaped */
export type CompiledTemplate = {
	v: 1;
	trusted: string[];
	nodes: TemplateNode[];
};

/** what a route declares: the source and the fields the server vouches for as markup */
export type TemplateSource = {
	source: string;
	trusted?: readonly string[];
};

const TAG = /\{\{\{([^}]*)\}\}\}|\{\{([^}]*)\}\}/g;
const PATH = /^(?:this|@index|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/;

function parsePath(text: string, tag: string): string[] {
	const path = text.trim();
	if (!PATH.test(path)) throw new ProtocolError('bad-template', `bad field "${path}" in ${tag}`);
	return path === 'this' ? [] : path.split('.');
}

type Frame = {
	kind: 'root' | 'each' | 'if';
	path: string[];
	target: TemplateNode[];
	owner?: Extract<TemplateNode, { t: 'if' }>;
};

/**
 * Compiles Mustache-shaped source to a JSON tree: `{{field}}` escaped, `{{{field}}}` raw (only for
 * paths in `trusted`), `{{#each list}}`, `{{#if field}}` with an optional `{{else}}`, `{{this}}`
 * and `{{@index}}`. There is no expression syntax, so the interpreter needs no `eval`.
 */
export function compileTemplate(input: TemplateSource): CompiledTemplate {
	const trusted = [...(input.trusted ?? [])];
	const root: TemplateNode[] = [];
	const stack: Frame[] = [{ kind: 'root', path: [], target: root }];
	const top = () => stack[stack.length - 1] as Frame;
	let last = 0;

	for (const match of input.source.matchAll(TAG)) {
		const at = match.index as number;
		if (at > last) top().target.push({ t: 'text', v: input.source.slice(last, at) });
		last = at + match[0].length;

		if (match[1] !== undefined) {
			const p = parsePath(match[1], match[0]);
			const name = match[1].trim();
			if (!trusted.includes(name)) {
				throw new ProtocolError('bad-template', `{{{${name}}}} is not a trusted field`);
			}
			top().target.push({ t: 'var', p, raw: true });
			continue;
		}

		const body = (match[2] as string).trim();
		if (body.startsWith('!')) continue;
		if (body === 'else') {
			const frame = top();
			if (frame.kind !== 'if' || !frame.owner) {
				throw new ProtocolError('bad-template', '{{else}} outside {{#if}}');
			}
			frame.target = frame.owner.else;
			continue;
		}
		if (body.startsWith('#')) {
			const [kind = '', ...rest] = body.slice(1).trim().split(/\s+/);
			if (rest.length !== 1) throw new ProtocolError('bad-template', `bad block ${match[0]}`);
			const p = parsePath(rest[0] as string, match[0]);
			if (kind === 'each') {
				const node: TemplateNode = { t: 'each', p, body: [] };
				top().target.push(node);
				stack.push({ kind: 'each', path: p, target: node.body });
			} else if (kind === 'if') {
				const node = { t: 'if' as const, p, then: [] as TemplateNode[], else: [] };
				top().target.push(node);
				stack.push({ kind: 'if', path: p, target: node.then, owner: node });
			} else throw new ProtocolError('bad-template', `unknown block "${kind}"`);
			continue;
		}
		if (body.startsWith('/')) {
			const kind = body.slice(1).trim();
			const frame = top();
			if (frame.kind === 'root' || frame.kind !== kind) {
				throw new ProtocolError('bad-template', `unexpected {{/${kind}}}`);
			}
			stack.pop();
			continue;
		}
		top().target.push({ t: 'var', p: parsePath(body, match[0]), raw: false });
	}

	if (last < input.source.length) top().target.push({ t: 'text', v: input.source.slice(last) });
	if (stack.length > 1) {
		throw new ProtocolError('bad-template', `unclosed {{#${top().kind}}} block`);
	}
	return { v: 1, trusted, nodes: root };
}
