import { tagsOf, type Attribute, type Tag } from '../trim/tokens.js';

/** one replacement in an HTML string: the text from `at` to `to` becomes `text` */
export type Edit = { at: number; to: number; text: string };

/** the `[start, end)` ranges of the HTML comments in `html`; a comment that never closes runs to the end */
export function commentRanges(html: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let at = html.indexOf('<!--');
	while (at >= 0) {
		const close = html.indexOf('-->', at + 4);
		const end = close < 0 ? html.length : close + 3;
		ranges.push([at, end]);
		at = html.indexOf('<!--', end);
	}
	return ranges;
}

/** the ranges of every `<noscript>` element, from its start tag to its end tag or the end of the HTML */
export function noscriptRanges(html: string, tags: readonly Tag[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const tag of tags) {
		if (tag.name !== 'noscript') continue;
		const after = html.slice(tag.end).search(/<\/noscript\s*>/i);
		ranges.push([tag.start, after < 0 ? html.length : tag.end + after]);
	}
	return ranges;
}

/** the ranges of the outermost elements called `name`, from the start tag to the matching end tag or the end of the HTML */
export function elementRanges(
	html: string,
	tags: readonly Tag[],
	name: string
): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let open = -1;
	for (const tag of tags) {
		if (tag.name !== name || tag.start < open) continue;
		const pattern = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
		pattern.lastIndex = tag.end;
		let depth = 1;
		let end = html.length;
		for (let hit = pattern.exec(html); hit; hit = pattern.exec(html)) {
			depth += hit[1] ? -1 : 1;
			if (depth === 0) {
				end = hit.index + hit[0].length;
				break;
			}
		}
		ranges.push([tag.start, end]);
		open = end;
	}
	return ranges;
}

/** the range of `<head>`, from its start tag to the first `<body>` or `</head>`, or null without one */
export function headRange(html: string, tags: readonly Tag[]): [number, number] | null {
	const head = tags.find((tag) => tag.name === 'head');
	if (!head) return null;
	const rest = html.slice(head.end);
	const stop = rest.search(/<\/head\s*>|<body[\s>]/i);
	return [head.start, stop < 0 ? html.length : head.end + stop];
}

/** whether `at` falls inside any of `ranges` */
export const within = (ranges: ReadonlyArray<[number, number]>, at: number): boolean =>
	ranges.some(([start, end]) => at >= start && at < end);

/** the first attribute of `tag` called `name`, whose name is already lowercase */
export const find = (tag: Tag, name: string): Attribute | undefined =>
	tag.attributes.find((a) => a.name === name);

/** the edit that gives the attribute `a` the value `value`, keeping its quote style */
export function setValue(html: string, a: Attribute, value: string): Edit {
	const raw = html.slice(a.start, a.end);
	const prefix = /^[^=\s]+\s*=\s*/.exec(raw);
	if (!prefix) return { at: a.end, to: a.end, text: `="${value}"` };
	const quote = raw[prefix[0].length];
	const q = quote === '"' || quote === "'" ? quote : '';
	return { at: a.start + prefix[0].length, to: a.end, text: `${q}${value}${q}` };
}

/** the edit that adds `attributes` (such as `preload="none"`) to the end of `tag`, before a closing slash */
export function appendAttributes(html: string, tag: Tag, attributes: readonly string[]): Edit {
	const floor = tag.attributes.at(-1)?.end ?? tag.start + 1 + tag.name.length;
	const slash = html[tag.end - 1] === '/' && floor < tag.end;
	const at = slash ? tag.end - 1 : tag.end;
	const gap = /\s/.test(html[at - 1] as string) ? '' : ' ';
	return { at, to: at, text: `${gap}${attributes.join(' ')}` };
}

/** `html` with `edits` applied; they may arrive in any order and must not overlap */
export function applyEdits(html: string, edits: readonly Edit[]): string {
	let out = '';
	let from = 0;
	for (const edit of [...edits].sort((a, b) => a.at - b.at)) {
		out += html.slice(from, edit.at) + edit.text;
		from = edit.to;
	}
	return out + html.slice(from);
}

/** the start tags of `html` that are named `name`, close with `>` and sit outside comments */
export function tagsNamed(html: string, name: string, tags: readonly Tag[] = tagsOf(html)): Tag[] {
	const comments = commentRanges(html);
	return tags.filter(
		(tag) => tag.name === name && html[tag.end] === '>' && !within(comments, tag.start)
	);
}
