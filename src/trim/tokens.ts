const WORD = /[A-Za-z0-9_-]+/g;
const NAME = /[a-zA-Z][^\s/>]*/y;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `text` with the five named entities and numeric character references decoded */
export function decodeEntities(text: string): string {
	return text.replace(
		/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi,
		(whole, dec?: string, hex?: string, name?: string) => {
			if (name) return NAMED[name.toLowerCase()] as string;
			const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex as string, 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
	);
}

function addWords(into: Set<string>, text: string, fold: boolean): void {
	for (const [word] of text.matchAll(WORD)) {
		into.add(word);
		if (fold) into.add(word.toLowerCase());
	}
}

/** one attribute of a start tag: its lowercase name, its raw value and where it sits in the HTML */
export type Attribute = { name: string; value: string; start: number; end: number };

/** a start tag, with the text between a `<script>` or `<style>` and its end tag as `body` */
export type Tag = {
	/** lowercase */
	name: string;
	attributes: Attribute[];
	body?: string;
	/** where the `<` sits in the HTML */
	start: number;
	/** where the closing `>` sits, or the length of the HTML when the tag never closes */
	end: number;
};

/** the value of the first attribute called `name` on `tag` */
export const attr = (tag: Tag, name: string): string | undefined =>
	tag.attributes.find((a) => a.name === name)?.value;

/**
 * The start tags of `html`, read the way a browser reads them: an attribute name is anything up to
 * whitespace, `/`, `>` or `=`, so a stray quote in a name (`<a href="x" 13715"="">`) is part of
 * that name and does not open a value. A quote opens a value only after `=`. The text of a
 * `<script>` or `<style>` is not scanned for tags. Comments are not skipped: a tag inside one adds
 * tokens, which only keeps more rules.
 */
export function tagsOf(html: string): Tag[] {
	const tags: Tag[] = [];
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf('<', at);
		if (open < 0) break;
		NAME.lastIndex = open + 1;
		const found = NAME.exec(html);
		if (!found) {
			at = open + 1;
			continue;
		}
		const attributes: Attribute[] = [];
		let i = open + 1 + found[0].length;
		while (i < html.length && html[i] !== '>') {
			if (/[\s/]/.test(html[i] as string)) {
				i++;
				continue;
			}
			const start = i;
			i++;
			while (i < html.length && !/[\s/>=]/.test(html[i] as string)) i++;
			const name = html.slice(start, i).toLowerCase();
			let after = i;
			while (after < html.length && /\s/.test(html[after] as string)) after++;
			let value = '';
			if (html[after] === '=') {
				after++;
				while (after < html.length && /\s/.test(html[after] as string)) after++;
				const quote = html[after];
				if (quote === '"' || quote === "'") {
					const close = html.indexOf(quote, after + 1);
					const stop = close < 0 ? html.length : close;
					value = html.slice(after + 1, stop);
					i = close < 0 ? html.length : close + 1;
				} else {
					let stop = after;
					while (stop < html.length && !/[\s>]/.test(html[stop] as string)) stop++;
					value = html.slice(after, stop);
					i = stop;
				}
			}
			attributes.push({ name, value, start, end: i });
		}
		const tag: Tag = { name: found[0].toLowerCase(), attributes, start: open, end: i };
		at = Math.min(html.length, i + 1);
		if (tag.name === 'script' || tag.name === 'style') {
			const end = new RegExp(`</${tag.name}\\s*>`, 'gi');
			end.lastIndex = at;
			const close = end.exec(html);
			tag.body = html.slice(at, close ? close.index : html.length);
			at = close ? close.index + close[0].length : html.length;
		}
		tags.push(tag);
	}
	return tags;
}

/**
 * The words a page can match a selector with: tag names (lowercase), attribute names, class
 * values and ids from the markup, and every word of an inline script, which covers
 * `drupal-settings-json` and other JSON blocks as well as code that adds classes. The set is
 * deliberately wide. A token that is present only keeps a rule, so extra words cost bytes and
 * never correctness.
 */
export function pageTokens(html: string): Set<string> {
	const tokens = new Set<string>();
	for (const tag of tagsOf(html)) {
		tokens.add(tag.name);
		if (tag.name === 'script' && tag.body) addWords(tokens, tag.body, true);
		for (const { name, value } of tag.attributes) {
			tokens.add(name);
			if (name === 'class' || name === 'id') {
				if (name === 'id' && value !== '') tokens.add(value);
				for (const piece of decodeEntities(value).split(/\s+/))
					if (piece) tokens.add(piece);
				addWords(tokens, value, false);
			}
		}
	}
	return tokens;
}

/** every word in a script's source, with a lowercase copy of each, which covers classes JS adds */
export function scriptTokens(js: string): Set<string> {
	const tokens = new Set<string>();
	addWords(tokens, js, true);
	return tokens;
}

/** whether `tag` is a `<link rel=stylesheet>` with an `href` */
export function isStylesheetLink(tag: Tag): boolean {
	const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
	return tag.name === 'link' && rel.includes('stylesheet') && (attr(tag, 'href') ?? '') !== '';
}

/** the decoded `href` of every `<link rel=stylesheet>` and `src` of every external script */
export function pageAssets(html: string): { styles: string[]; scripts: string[] } {
	const styles: string[] = [];
	const scripts: string[] = [];
	for (const tag of tagsOf(html)) {
		if (isStylesheetLink(tag)) styles.push(decodeEntities(attr(tag, 'href') as string));
		const src = attr(tag, 'src');
		if (tag.name === 'script' && src) scripts.push(decodeEntities(src));
	}
	return { styles, scripts };
}
