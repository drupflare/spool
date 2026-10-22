import { decodeEntities, tagsOf, type Tag } from '../trim/tokens.js';
import { applyEdits, commentRanges, find, noscriptRanges, within, type Edit } from './html.js';

/** the embed hosts `embeds` knows */
export type EmbedProvider = 'youtube' | 'vimeo';

/**
 * What `spoolProxy({ embeds })` does to a server-rendered `<iframe>` of a YouTube or Vimeo embed:
 * it becomes an iframe whose `srcdoc` is one link to the real embed, so the player loads when the
 * visitor clicks. `providers` defaults to both. `thumbnail` shows YouTube's `hqdefault.jpg` in the
 * link; default true, and Vimeo always gets a plain placeholder. A page that sends a
 * `Content-Security-Policy` header is left alone, because the facade needs an inline style and the
 * thumbnail host, unless `ignoreCsp` is true.
 */
export type EmbedOptions = {
	providers?: readonly EmbedProvider[];
	thumbnail?: boolean;
	ignoreCsp?: boolean;
};

/** `EmbedOptions` with every default applied */
export type ResolvedEmbedOptions = {
	providers: ReadonlySet<EmbedProvider>;
	thumbnail: boolean;
	ignoreCsp: boolean;
};

/** what the proxy counted for `embeds`: pages with a rewritten embed, the embeds, and the ones left alone by reason (`csp`, `jsapi`) */
export type EmbedStats = { pages: number; rewritten: number; skipped: Record<string, number> };

/** applies the defaults to `options` */
export function resolveEmbedOptions(options: EmbedOptions = {}): ResolvedEmbedOptions {
	return {
		providers: new Set(options.providers ?? ['youtube', 'vimeo']),
		thumbnail: options.thumbnail !== false,
		ignoreCsp: options.ignoreCsp === true
	};
}

const HOSTS: Record<string, { provider: EmbedProvider; path: RegExp }> = {
	'youtube.com': { provider: 'youtube', path: /^\/embed\/([A-Za-z0-9_-]{6,64})\/?$/ },
	'www.youtube.com': { provider: 'youtube', path: /^\/embed\/([A-Za-z0-9_-]{6,64})\/?$/ },
	'youtube-nocookie.com': { provider: 'youtube', path: /^\/embed\/([A-Za-z0-9_-]{6,64})\/?$/ },
	'www.youtube-nocookie.com': {
		provider: 'youtube',
		path: /^\/embed\/([A-Za-z0-9_-]{6,64})\/?$/
	},
	'player.vimeo.com': { provider: 'vimeo', path: /^\/video\/([A-Za-z0-9_-]{6,64})\/?$/ }
};

/** the provider and id of an embed URL, with the URL made absolute, or null for any other address */
export function embedOf(src: string): { provider: EmbedProvider; id: string; url: URL } | null {
	const text = decodeEntities(src).trim();
	if (!/^(?:https?:)?\/\//i.test(text)) return null;
	let url: URL;
	try {
		url = new URL(text.startsWith('//') ? `https:${text}` : text);
	} catch {
		return null;
	}
	const host = HOSTS[url.hostname.toLowerCase()];
	const id = host?.path.exec(url.pathname)?.[1];
	// the playlist embed is `/embed/videoseries?list=...` and has no single video id
	if (!host || !id || id === 'videoseries') return null;
	return { provider: host.provider, id, url };
}

const escape = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const KEPT = new Set([
	'width',
	'height',
	'title',
	'class',
	'style',
	'allow',
	'allowfullscreen',
	'loading',
	'id',
	'sandbox',
	'referrerpolicy'
]);

const STYLE =
	'html,body{margin:0;height:100%;background:#000}a{position:relative;display:block;height:100%;color:#fff;font:14px/1.2 sans-serif;text-decoration:none}' +
	'img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover}' +
	'.g{position:absolute;top:0;right:0;bottom:0;left:0;margin:auto;width:64px;height:44px;border-radius:12px;background:rgba(0,0,0,.7);text-align:center;font-size:26px;line-height:44px}' +
	'.t{position:absolute;left:0;right:0;bottom:0;padding:8px 12px;background:rgba(0,0,0,.6);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}';

/** the document a facade iframe carries in `srcdoc`, before it is escaped for the attribute */
export function facadeDocument(
	embed: { provider: EmbedProvider; id: string; url: URL },
	title: string,
	thumbnail: boolean
): string {
	const link = new URL(embed.url);
	link.searchParams.set('autoplay', '1');
	const label = escape(title);
	const picture =
		thumbnail && embed.provider === 'youtube'
			? `<img src="https://i.ytimg.com/vi/${embed.id}/hqdefault.jpg" alt="">`
			: '';
	return (
		`<!doctype html><meta charset=utf-8><style>${STYLE}</style>` +
		`<a href="${escape(link.href)}" aria-label="${label}">${picture}` +
		`<span class=g>&#9654;</span><span class=t>${label}</span></a>`
	);
}

function facadeTag(
	html: string,
	tag: Tag,
	embed: NonNullable<ReturnType<typeof embedOf>>,
	o: ResolvedEmbedOptions
) {
	const kept = tag.attributes
		.filter((a) => KEPT.has(a.name))
		.map((a) => html.slice(a.start, a.end));
	const title = decodeEntities(find(tag, 'title')?.value ?? '').trim() || 'Play video';
	const doc = escape(facadeDocument(embed, title, o.thumbnail));
	return `<iframe ${[...kept, `srcdoc="${doc}"`].join(' ')}>`;
}

/**
 * Replaces each server-rendered YouTube or Vimeo `<iframe src>` in `html` with a facade, as
 * `options` allow, and says how many it replaced and how many it left alone. Only an `https`,
 * `http` or protocol-relative `src` on a known embed host and path, with an id of 6 to 64 letters,
 * digits, `-` and `_`, is touched. An iframe inside an HTML comment or `<noscript>`, one that has
 * `srcdoc`, and one whose URL sets `enablejsapi=1` (the page's script expects the real player) stay
 * as they are; the last is counted as `jsapi`. With `page.csp` set, and no `ignoreCsp`, every
 * matching iframe is left alone and counted as `csp`. The facade keeps `width`, `height`, `title`,
 * `class`, `style`, `allow`, `allowfullscreen`, `loading`, `id`, `sandbox` and `referrerpolicy`.
 * Everything outside the replaced start tags stays byte for byte.
 */
export function rewriteEmbeds(
	html: string,
	options: EmbedOptions | ResolvedEmbedOptions = {},
	page: { csp: boolean } = { csp: false }
): { html: string; rewritten: number; skipped: Record<string, number> } {
	const resolved: ResolvedEmbedOptions =
		options.providers instanceof Set
			? (options as ResolvedEmbedOptions)
			: resolveEmbedOptions(options as EmbedOptions);
	const tags = tagsOf(html);
	const comments = commentRanges(html);
	const noscripts = noscriptRanges(html, tags);
	const edits: Edit[] = [];
	const skipped: Record<string, number> = {};
	for (const tag of tags) {
		if (tag.name !== 'iframe' || html[tag.end] !== '>') continue;
		if (within(comments, tag.start) || within(noscripts, tag.start)) continue;
		const src = find(tag, 'src')?.value;
		if (src === undefined || find(tag, 'srcdoc')) continue;
		const embed = embedOf(src);
		if (!embed || !resolved.providers.has(embed.provider)) continue;
		if (embed.url.searchParams.get('enablejsapi') === '1') {
			skipped.jsapi = (skipped.jsapi ?? 0) + 1;
			continue;
		}
		if (page.csp && !resolved.ignoreCsp) {
			skipped.csp = (skipped.csp ?? 0) + 1;
			continue;
		}
		edits.push({ at: tag.start, to: tag.end + 1, text: facadeTag(html, tag, embed, resolved) });
	}
	return { html: applyEdits(html, edits), rewritten: edits.length, skipped };
}
