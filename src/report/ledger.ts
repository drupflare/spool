import {
	CONTAMINATION_MS_PER_S,
	isContaminated,
	median,
	quantile,
	spread,
	type Spread
} from './derive.js';
import type { Row } from './measurement.js';
import { attributionalJoules } from './model.js';

/** one lever of the ledger: the bytes it saves on each page of a corpus, in page order */
export type Lever = {
	id: string;
	/** where the lever stands: `default` is on once its parent option is set, `option` needs its own option, `max` is not built or needs a condition the corpus does not show */
	status: 'default' | 'option' | 'max';
	corpus: 'crawl' | 'trim';
	/** the site of each page, in the same order as `bytes` */
	sites: string[];
	bytes: number[];
};

/** what a lever saves across a corpus, in bytes */
export type LeverStats = {
	pages: number;
	withSaving: number;
	medianPage: number;
	/** the median over the pages that save anything, or null when none do */
	medianEligible: number | null;
	/** the median over sites of each site's mean per page */
	medianSite: number;
	mean: number;
};

export type CrawlImageRow = {
	kind: 'image';
	site: string;
	profile: string;
	page: string;
	bytes: number;
	format: string;
	arms: {
		native?: { bytes: number };
		ceiling?: { bytes: number } | null;
		resized?: { bytes: number } | null;
		lossless?: { bytes: number } | null;
	} | null;
};

export type CrawlPageRow = {
	kind: 'page';
	site: string;
	profile: string;
	variant: 'original' | 'lazy';
	page: string;
	ok: true | string;
	imageBytesLoad: number;
	imageBytesScroll: number;
	videoBytes: number;
	videoTags: Array<{ autoplay: boolean }>;
	iframes: Array<{ host: string; bytes: number }>;
	lcp: { tag: string | null; loading: string | null } | null;
};

export type CrawlEmbedRow = {
	kind: 'embed';
	provider: 'youtube' | 'vimeo';
	arm: 'iframe' | 'facade';
	bytes: number;
	docBytes: number;
};

type TrimPage = {
	kind: 'home' | 'internal';
	saved: { br5Saved: number };
};
type TrimSite = { site: string; pages: Array<TrimPage & { newAgg?: AggRow; ok?: true | string }> };
type AggRow = { transfer: number; zstdAlone: number; zstdDict: number };

const EMBED_HOSTS: Record<string, 'youtube' | 'vimeo'> = {
	'www.youtube.com': 'youtube',
	'youtube.com': 'youtube',
	'www.youtube-nocookie.com': 'youtube',
	'youtube-nocookie.com': 'youtube',
	'player.vimeo.com': 'vimeo'
};

/** the bytes a WebP of each image saves: `native` is the file at its own size, `ceiling` the width ceiling, `resized` the rendered width */
export function imageSavings(rows: readonly CrawlImageRow[]) {
	let format = 0;
	let resize = 0;
	let lossless = 0;
	for (const row of rows) {
		const arms = row.arms;
		if (!arms?.native) continue;
		const ceiling = arms.ceiling?.bytes ?? arms.native.bytes;
		const base = Math.min(row.bytes, ceiling);
		format += row.bytes - base;
		resize += base - Math.min(base, arms.resized?.bytes ?? base);
		if (arms.lossless) lossless += Math.max(0, base - arms.lossless.bytes);
	}
	return { format, resize, lossless };
}

/** the levers of the image-crawl corpus: the first views of the desktop profile, one entry per page */
export function crawlLevers(rows: readonly Row[]): Lever[] {
	const all = rows as unknown as Array<CrawlImageRow | CrawlPageRow | CrawlEmbedRow>;
	const pages = all.filter(
		(r): r is CrawlPageRow =>
			r.kind === 'page' &&
			r.profile === 'desktop' &&
			r.variant === 'original' &&
			r.ok === true
	);
	const images = all.filter(
		(r): r is CrawlImageRow => r.kind === 'image' && r.profile === 'desktop'
	);
	const embeds = all.filter((r): r is CrawlEmbedRow => r.kind === 'embed');
	const facade = (provider: 'youtube' | 'vimeo') => {
		const row = embeds.find((e) => e.provider === provider && e.arm === 'facade');
		return row ? row.bytes + row.docBytes : 0;
	};
	const key = (r: { site: string; page: string }) => `${r.site}|${r.page}`;
	const byPage = new Map<string, CrawlImageRow[]>();
	for (const image of images) byPage.set(key(image), [...(byPage.get(key(image)) ?? []), image]);
	const sites = pages.map((p) => p.site);
	const per = (f: (page: CrawlPageRow) => number) => pages.map(f);
	const embedSaved = (page: CrawlPageRow) =>
		page.iframes.reduce((sum, frame) => {
			const provider = EMBED_HOSTS[frame.host];
			return provider ? sum + Math.max(0, frame.bytes - facade(provider)) : sum;
		}, 0);
	const idle = (page: CrawlPageRow) =>
		page.videoTags.length > 0 && page.videoTags.every((t) => !t.autoplay);
	return [
		{
			id: 'images-format',
			status: 'default',
			corpus: 'crawl',
			sites,
			bytes: per((p) => imageSavings(byPage.get(key(p)) ?? []).format)
		},
		{
			id: 'images-resize',
			status: 'default',
			corpus: 'crawl',
			sites,
			bytes: per((p) => imageSavings(byPage.get(key(p)) ?? []).resize)
		},
		{
			id: 'video-preload',
			status: 'default',
			corpus: 'crawl',
			sites,
			bytes: per((p) => (idle(p) ? p.videoBytes : 0))
		},
		{
			id: 'video-defer',
			status: 'option',
			corpus: 'crawl',
			sites,
			bytes: per((p) => (idle(p) ? 0 : p.videoBytes))
		},
		{ id: 'embeds', status: 'option', corpus: 'crawl', sites, bytes: per(embedSaved) }
	];
}

/** bytes of image data a visit that never scrolls does not load when `loading="lazy"` is on, by page */
export function lazyUnscrolled(rows: readonly Row[], profile = 'desktop') {
	const pages = (rows as unknown as CrawlPageRow[]).filter(
		(r) => r.kind === 'page' && r.profile === profile && r.ok === true
	);
	const original = new Map(
		pages.filter((p) => p.variant === 'original').map((p) => [`${p.site}|${p.page}`, p])
	);
	const pairs = pages
		.filter((p) => p.variant === 'lazy')
		.flatMap((lazy) => {
			const base = original.get(`${lazy.site}|${lazy.page}`);
			return base ? [{ base, lazy }] : [];
		});
	const lcpImages = pairs.filter((p) => p.lazy.lcp?.tag === 'IMG');
	return {
		pairs: pairs.length,
		sites: pairs.map((p) => p.base.site),
		bytes: pairs.map((p) => Math.max(0, p.base.imageBytesLoad - p.lazy.imageBytesLoad)),
		baseLoad: pairs.map((p) => p.base.imageBytesLoad),
		lazyLoad: pairs.map((p) => p.lazy.imageBytesLoad),
		lcpImagePages: lcpImages.length,
		lcpLazyPages: lcpImages.filter(
			(p) => p.lazy.lcp?.loading === 'lazy' && p.base.lcp?.loading !== 'lazy'
		).length
	};
}

/** the levers of the trim corpus: the first views of internal pages of the Drupal sites */
export function trimLevers(trimmed: readonly Row[], crawl: readonly Row[]): Lever[] {
	const trimSites = trimmed as unknown as TrimSite[];
	const aggSites = crawl as unknown as TrimSite[];
	const internal = <T extends TrimPage>(sites: Array<{ site: string; pages: T[] }>) =>
		sites.flatMap((s) =>
			s.pages.filter((p) => p.kind === 'internal').map((p) => ({ site: s.site, page: p }))
		);
	const css = internal(trimSites);
	const agg = internal(aggSites).filter((x) => x.page.ok === true && x.page.newAgg);
	return [
		{
			id: 'css-trim',
			status: 'option',
			corpus: 'trim',
			sites: css.map((x) => x.site),
			bytes: css.map((x) => x.page.saved.br5Saved)
		},
		{
			id: 'aggregate-dictionary',
			status: 'max',
			corpus: 'trim',
			sites: agg.map((x) => x.site),
			bytes: agg.map((x) => {
				const a = x.page.newAgg as AggRow;
				return a.zstdAlone > 0 ? a.transfer * Math.max(0, 1 - a.zstdDict / a.zstdAlone) : 0;
			})
		}
	];
}

/** {@link LeverStats} of a lever's per-page bytes, or null for an empty corpus */
export function leverStats(sites: readonly string[], bytes: readonly number[]): LeverStats | null {
	if (bytes.length === 0) return null;
	const saving = bytes.filter((b) => b > 0);
	const perSite = new Map<string, number[]>();
	bytes.forEach((b, i) =>
		perSite.set(sites[i] as string, [...(perSite.get(sites[i] as string) ?? []), b])
	);
	const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
	return {
		pages: bytes.length,
		withSaving: saving.length,
		medianPage: quantile(bytes, 0.5),
		medianEligible: saving.length > 0 ? quantile(saving, 0.5) : null,
		medianSite: median([...perSite.values()].map(mean)),
		mean: mean(bytes)
	};
}

/** the bytes of several levers added page by page; the levers must come from one corpus and one page order */
export function addLevers(levers: readonly Lever[]): { sites: string[]; bytes: number[] } | null {
	const first = levers[0];
	if (!first) return null;
	return {
		sites: first.sites,
		bytes: first.bytes.map((_, i) => levers.reduce((sum, l) => sum + (l.bytes[i] ?? 0), 0))
	};
}

/** the dictionary choices the `dictionary-size` rig measures; see that rig for what each one is */
export const DICTIONARY_ARMS = [
	'oracle',
	'browser',
	'serverVisit',
	'serverHeld',
	'serverOut'
] as const;

/** one of {@link DICTIONARY_ARMS} */
export type DictionaryArm = (typeof DICTIONARY_ARMS)[number];

/** what one dictionary choice saves against brotli 11 alone, with a file that gains nothing served plain */
export type DictionaryStat = {
	/** the median over sites of the share of that site's brotli 11 bytes saved */
	medianSite: number;
	/** the same share over every file of every site */
	pooled: number;
	/** internal pages */
	pages: number;
	/** the median bytes saved on an internal page's first view */
	medianPageBytes: number;
	/** internal pages whose new files save more than 5% of their brotli 11 bytes */
	pagesOver5: number;
};

type DictionaryFile = {
	kind: 'file';
	site: string;
	page: number;
	pageKind: string;
	br11: number;
} & Record<DictionaryArm, { zstd: number | null; br: number | null } | undefined>;

/**
 * The savings of each dictionary choice in a `dictionary-size` reading, for `dcz` (zstd) and `dcb`
 * (brotli). A file the choice gives no dictionary, or whose delta is not smaller than brotli 11,
 * saves nothing.
 */
export function dictionaryArms(rows: readonly Record<string, unknown>[]) {
	const files = rows.filter((r) => r.kind === 'file') as unknown as DictionaryFile[];
	const stat = (arm: DictionaryArm, codec: 'zstd' | 'br'): DictionaryStat => {
		const saved = (f: DictionaryFile) => {
			const size = f[arm]?.[codec];
			return size == null ? 0 : Math.max(0, f.br11 - size);
		};
		const share = (group: readonly DictionaryFile[]) => {
			const plain = group.reduce((s, f) => s + f.br11, 0);
			return plain > 0 ? group.reduce((s, f) => s + saved(f), 0) / plain : 0;
		};
		const bySite = new Map<string, DictionaryFile[]>();
		const byPage = new Map<string, DictionaryFile[]>();
		for (const f of files) {
			bySite.set(f.site, [...(bySite.get(f.site) ?? []), f]);
			if (f.pageKind === 'internal') {
				const key = `${f.site}|${f.page}`;
				byPage.set(key, [...(byPage.get(key) ?? []), f]);
			}
		}
		const pages = [...byPage.values()];
		return {
			medianSite: median([...bySite.values()].map(share)),
			pooled: share(files),
			pages: pages.length,
			medianPageBytes: median(pages.map((p) => p.reduce((s, f) => s + saved(f), 0))),
			pagesOver5: pages.filter((p) => share(p) > 0.05).length
		};
	};
	const arms = {} as Record<DictionaryArm, { zstd: DictionaryStat; br: DictionaryStat }>;
	for (const arm of DICTIONARY_ARMS) arms[arm] = { zstd: stat(arm, 'zstd'), br: stat(arm, 'br') };
	return {
		sites: new Set(files.map((f) => f.site)).size,
		files: files.length,
		br11Bytes: files.reduce((s, f) => s + f.br11, 0),
		arms
	};
}

/** the windows of one arm that a derivation keeps and drops, and why */
export type WindowCount = {
	kept: number;
	/** other containers used more than the limit of CPU per second */
	dropped: number;
	/** the window belongs to a round whose idle windows disagree (idle-activity only) */
	idleControl: number;
};

const windowSeconds = (row: Row) => (row.elapsedMs as number) / 1000;

const timed = (rows: readonly Row[]) =>
	rows.filter((r) => typeof r.elapsedMs === 'number' && r.elapsedMs > 0);

const tally = (counts: Record<string, WindowCount>, arm: unknown): WindowCount =>
	(counts[String(arm)] ??= { kept: 0, dropped: 0, idleControl: 0 });

/** kept and dropped windows per arm under the contamination limit; a row with no length (a probe) is not a window */
export function windowCounts(
	rows: readonly Row[],
	limit = CONTAMINATION_MS_PER_S
): Record<string, WindowCount> {
	const counts: Record<string, WindowCount> = {};
	for (const row of timed(rows)) {
		tally(counts, row.arm)[isContaminated(row, limit) ? 'dropped' : 'kept']++;
	}
	return counts;
}

/** the idle windows of a round may differ by this factor, largest over smallest, before the round is dropped */
export const IDLE_AGREEMENT = 1.25;

/** one arm of an idle-activity reading, after the drops */
export type ActivityArm = {
	windows: number;
	/** package watts over the kept windows */
	watts: Spread;
	/** watts above the idle windows of the same round */
	extraWatts: Spread;
};

/**
 * Package watts per arm of an idle-activity reading. A window is dropped when other containers used
 * more than `limit` ms of CPU per second. The rig cannot see a host process or a container that
 * stopped inside a window, so the three idle windows of each round also act as a control: when the
 * largest of them is over {@link IDLE_AGREEMENT} times the smallest, the whole round is dropped. An
 * arm with no kept window is null.
 */
export function activityFigures(rows: readonly Row[], limit = CONTAMINATION_MS_PER_S) {
	const counts: Record<string, WindowCount> = {};
	const watts = (row: Row) => (row.pkgJ as number) / windowSeconds(row);
	const calm = timed(rows).filter((row) => {
		const contaminated = isContaminated(row, limit);
		if (contaminated) tally(counts, row.arm).dropped++;
		return !contaminated;
	});
	const idleByRound = new Map<number, number[]>();
	for (const row of calm) {
		if (row.arm === 'idle') {
			idleByRound.set(row.round as number, [
				...(idleByRound.get(row.round as number) ?? []),
				watts(row)
			]);
		}
	}
	const noisy = [...idleByRound]
		.filter(([, w]) => w.length > 1 && Math.max(...w) > IDLE_AGREEMENT * Math.min(...w))
		.map(([round]) => round);
	const kept = calm.filter((row) => {
		const drop = noisy.includes(row.round as number);
		tally(counts, row.arm)[drop ? 'idleControl' : 'kept']++;
		return !drop;
	});
	const idleRound = new Map(
		[...idleByRound].filter(([round]) => !noisy.includes(round)).map(([r, w]) => [r, median(w)])
	);
	const idleWatts = idleRound.size > 0 ? spread([...idleRound.values()]) : null;
	const arms: Record<string, ActivityArm | null> = {};
	for (const name of new Set(timed(rows).map((row) => String(row.arm)))) {
		if (name === 'idle') continue;
		const mine = kept.filter((row) => row.arm === name && idleRound.has(row.round as number));
		arms[name] =
			mine.length === 0
				? null
				: {
						windows: mine.length,
						watts: spread(mine.map(watts)),
						extraWatts: spread(
							mine.map(
								(row) => watts(row) - (idleRound.get(row.round as number) as number)
							)
						)
					};
	}
	return { idleWatts, noisyRounds: noisy.sort((a, b) => a - b), counts, arms };
}

/** attributional joules for `bytes` (the same SWD v4 rate as the headline, no origin term: these are the same requests with fewer bytes) */
export const ledgerJoules = (bytes: number): number => attributionalJoules(bytes);

/** megawatt-hours a year when `perView` joules are saved on a share of `views` views */
export const ledgerMWh = (perView: number, views: number, share: number): number =>
	(perView * views * share) / 3.6e9;
