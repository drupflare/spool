import { ProtocolError } from '../protocol/errors.js';
import type { Tag } from '../trim/tokens.js';
import type { MediaSignals } from './headers.js';
import { appendAttributes, applyEdits, find, setValue, tagsNamed, type Edit } from './html.js';

/**
 * What `spoolProxy({ video })` does to `<video>` start tags. `preload` is the value to set, or
 * `false` to leave the attribute alone. `autoplay: 'defer'` removes the `autoplay` attribute, marks
 * the tag `data-spool-autoplay`, adds `controls` so a visitor can start the video, and sets
 * `preload` to `none` unless the option is `metadata`. With `'keep'` the `autoplay` attribute stays,
 * and a video that autoplays loads its file whatever `preload` says. `when` limits the rewrite to a
 * visitor who sent `Save-Data: on` (`save-data`) or who also has an `ECT` of `slow-2g`, `2g` or
 * `3g` (`slow`). Defaults: `preload: 'none'`, `autoplay: 'keep'`, `when: 'always'`.
 */
export type VideoOptions = {
	preload?: 'none' | 'metadata' | false;
	autoplay?: 'keep' | 'defer';
	when?: 'always' | 'save-data' | 'slow';
};

/** `VideoOptions` with every default applied */
export type ResolvedVideoOptions = Required<VideoOptions>;

/** applies the defaults to `options` and refuses an unknown value with `ProtocolError('bad-route')` */
export function resolveVideoOptions(options: VideoOptions = {}): ResolvedVideoOptions {
	const resolved = {
		preload: options.preload ?? 'none',
		autoplay: options.autoplay ?? 'keep',
		when: options.when ?? 'always'
	};
	if (![false, 'none', 'metadata'].includes(resolved.preload)) {
		throw new ProtocolError('bad-route', `video preload must be 'none', 'metadata' or false`);
	}
	if (!['keep', 'defer'].includes(resolved.autoplay)) {
		throw new ProtocolError('bad-route', `video autoplay must be 'keep' or 'defer'`);
	}
	if (!['always', 'save-data', 'slow'].includes(resolved.when)) {
		throw new ProtocolError('bad-route', `video when must be 'always', 'save-data' or 'slow'`);
	}
	return resolved;
}

function editsFor(html: string, tag: Tag, options: ResolvedVideoOptions): Edit[] {
	const edits: Edit[] = [];
	const autoplay = find(tag, 'autoplay');
	const defer = options.autoplay === 'defer' && autoplay !== undefined;
	const target = defer ? (options.preload === 'metadata' ? 'metadata' : 'none') : options.preload;
	const added: string[] = [];

	if (defer) {
		if (find(tag, 'data-spool-autoplay')) {
			let from = autoplay.start;
			while (from > tag.start && /\s/.test(html[from - 1] as string)) from--;
			edits.push({ at: from, to: autoplay.end, text: '' });
		} else {
			edits.push({ at: autoplay.start, to: autoplay.end, text: 'data-spool-autoplay' });
		}
		if (!find(tag, 'controls')) added.push('controls');
	}
	if (target !== false) {
		const preload = find(tag, 'preload');
		if (!preload) added.push(`preload="${target}"`);
		else if (preload.value.trim().toLowerCase() !== target) {
			edits.push(setValue(html, preload, target));
		}
	}
	if (added.length > 0) edits.push(appendAttributes(html, tag, added));
	return edits;
}

/**
 * Rewrites the `<video>` start tags of `html` as `options` ask and says how many tags changed.
 * It reads tags with `tagsOf` and skips a tag inside an HTML comment, a tag that never closes, and
 * every element that is not `<video>`. A tag that already says what the options ask for is not
 * counted. Everything outside the edited start tags stays byte for byte, and the edits are ASCII,
 * so a page in another charset read one byte per character comes back the same way.
 */
export function rewriteVideo(
	html: string,
	options: VideoOptions,
	signals: MediaSignals
): { html: string; rewritten: number } {
	const resolved = resolveVideoOptions(options);
	const applies =
		resolved.when === 'always' ||
		(resolved.when === 'save-data' ? signals.saveData : signals.slow || signals.saveData);
	if (!applies) return { html, rewritten: 0 };
	const edits: Edit[] = [];
	let rewritten = 0;
	for (const tag of tagsNamed(html, 'video')) {
		const tagEdits = editsFor(html, tag, resolved);
		if (tagEdits.length === 0) continue;
		rewritten++;
		edits.push(...tagEdits);
	}
	return { html: applyEdits(html, edits), rewritten };
}
