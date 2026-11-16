import { median, quantile } from './derive.js';
import type { Row } from './measurement.js';
import { attributionalJoules } from './model.js';

/** the quartiles, median and mean of a list of per-page figures */
export type Quartiles = { n: number; p25: number; median: number; p75: number; mean: number };

/** {@link Quartiles} of a list, or null when it is empty */
export function quartiles(values: readonly number[]): Quartiles | null {
	if (values.length === 0) return null;
	return {
		n: values.length,
		p25: quantile(values, 0.25),
		median: quantile(values, 0.5),
		p75: quantile(values, 0.75),
		mean: values.reduce((sum, v) => sum + v, 0) / values.length
	};
}

/** bytes a trim saves on one kind of view, and the attributional joules those bytes carry */
export type TrimSaving = { bytes: Quartiles; joules: Quartiles };

type SavedRow = { br5Saved: number };
type PixelRow = { differing: number; compared: number } | { error: string };
type TrimmedPageRow = {
	kind: 'home' | 'internal';
	saved: SavedRow;
	oracleA: {
		used: number;
		falseRemovals: number;
		lost: Array<{ file: string; selector: string }>;
	};
	oracleB: { control: PixelRow; trimmed: PixelRow; fulfilled: number } | { error: string } | null;
	guard: { fired: boolean };
	leaveOneOut: {
		trimmedFiles: number;
		guardFired: boolean;
		oracleA: { used: number; falseRemovals: number } | null;
	} | null;
};
type TrimmedSiteRow = {
	site: string;
	pages: TrimmedPageRow[];
	files: Array<{
		trimmed: boolean;
		raw: number;
		br5: number;
		trimmedRaw: number;
		trimmedBr5: number;
	}>;
};

function saving(bytes: readonly number[]): TrimSaving | null {
	const b = quartiles(bytes);
	const j = quartiles(bytes.map((n) => attributionalJoules(n)));
	return b && j ? { bytes: b, joules: j } : null;
}

const sitesOf = (rows: readonly Row[]) => rows as unknown as TrimmedSiteRow[];

const pixels = (cell: PixelRow | undefined): number | null =>
	cell && 'differing' in cell ? cell.differing : null;

/** what the trimmed experiment measured, per site and pooled */
export type TrimFigures = {
	sites: Array<{
		site: string;
		cold: TrimSaving | null;
		first: TrimSaving | null;
		/** the share of the site's stylesheet bytes (brotli 5) the trim removes */
		fileShare: number;
	}>;
	/** the home page of each site, a cold view */
	cold: TrimSaving;
	/** each internal page, the first view of it in a visit */
	first: TrimSaving;
	files: { count: number; trimmed: number; br5: number; trimmedBr5: number };
	/** Oracle A: used rules the trimmed text lost */
	rules: { pages: number; used: number; falseRemovals: number; offenders: string[] };
	/** Oracle B: pixels that differ from the original CSS, and the same page against itself */
	render: {
		pages: number;
		errors: number;
		/** pages whose trimmed screenshot equals the original to the pixel */
		identical: number;
		/** pages whose second screenshot of the original equals the first to the pixel */
		controlIdentical: number;
		/** pages where the trimmed arm differed by more pixels than the control did */
		beyondControl: number;
		/** pages where the trimmed arm differed and the control did not */
		trimmedOnly: number;
		maxTrimmed: number;
		maxControl: number;
	};
	/** leave-one-out over the internal pages */
	leaveOneOut: {
		pages: number;
		guardFired: number;
		/** pages the guard let through that link a trimmed file, Oracle A on them */
		unguarded: number;
		unguardedRules: number;
		falseRemovals: number;
		pagesWithFalseRemovals: number;
	};
};

/** the figures of a trimmed reading's rows */
export function trimFigures(rows: readonly Row[]): TrimFigures {
	const sites = sitesOf(rows);
	const home = (s: TrimmedSiteRow) => s.pages.filter((p) => p.kind === 'home');
	const internal = (s: TrimmedSiteRow) => s.pages.filter((p) => p.kind === 'internal');
	const bytesOf = (pages: readonly TrimmedPageRow[]) => pages.map((p) => p.saved.br5Saved);
	const pages = sites.flatMap((s) => s.pages);
	const files = sites.flatMap((s) => s.files);
	const cold = saving(sites.flatMap((s) => bytesOf(home(s))));
	const first = saving(sites.flatMap((s) => bytesOf(internal(s))));
	if (!cold || !first) throw new RangeError('the reading has no home page or no internal page');

	const lost = pages.flatMap((p) => p.oracleA.lost);
	const shots = pages.flatMap((p) => (p.oracleB && 'control' in p.oracleB ? [p.oracleB] : []));
	const pairs = shots.flatMap((s) => {
		const control = pixels(s.control);
		const trimmed = pixels(s.trimmed);
		return control === null || trimmed === null ? [] : [{ control, trimmed }];
	});
	const loo = pages.flatMap((p) => (p.leaveOneOut ? [p.leaveOneOut] : []));
	const checked = loo.flatMap((l) => (l.oracleA ? [l.oracleA] : []));
	return {
		sites: sites.map((s) => ({
			site: s.site,
			cold: saving(bytesOf(home(s))),
			first: saving(bytesOf(internal(s))),
			fileShare:
				1 -
				s.files.reduce((t, f) => t + f.trimmedBr5, 0) /
					Math.max(
						1,
						s.files.reduce((t, f) => t + f.br5, 0)
					)
		})),
		cold,
		first,
		files: {
			count: files.length,
			trimmed: files.filter((f) => f.trimmed).length,
			br5: files.reduce((t, f) => t + f.br5, 0),
			trimmedBr5: files.reduce((t, f) => t + f.trimmedBr5, 0)
		},
		rules: {
			pages: pages.length,
			used: pages.reduce((t, p) => t + p.oracleA.used, 0),
			falseRemovals: lost.length,
			offenders: lost.map((l) => `${l.file} ${l.selector}`)
		},
		render: {
			pages: pairs.length,
			errors: pages.filter((p) => p.oracleB !== null).length - pairs.length,
			identical: pairs.filter((p) => p.trimmed === 0).length,
			controlIdentical: pairs.filter((p) => p.control === 0).length,
			beyondControl: pairs.filter((p) => p.trimmed > p.control).length,
			trimmedOnly: pairs.filter((p) => p.trimmed > 0 && p.control === 0).length,
			maxTrimmed: Math.max(0, ...pairs.map((p) => p.trimmed)),
			maxControl: Math.max(0, ...pairs.map((p) => p.control))
		},
		leaveOneOut: {
			pages: loo.length,
			guardFired: loo.filter((l) => l.guardFired).length,
			unguarded: checked.length,
			unguardedRules: checked.reduce((t, c) => t + c.used, 0),
			falseRemovals: checked.reduce((t, c) => t + c.falseRemovals, 0),
			pagesWithFalseRemovals: checked.filter((c) => c.falseRemovals > 0).length
		}
	};
}

type CoveragePage = {
	ok: true | string;
	files: Array<{
		kind: 'css' | 'js';
		origin: 'same' | 'third';
		raw: number;
		usedLoad: number;
		usedScroll: number;
	}>;
};

/** used share of one kind of same-origin file, at load and after one scroll, per page */
export type CoverageFigures = {
	cssLoad: Quartiles | null;
	cssScroll: Quartiles | null;
	jsLoad: Quartiles | null;
	jsScroll: Quartiles | null;
};

function shares(
	pages: readonly CoveragePage[],
	kind: 'css' | 'js',
	field: 'usedLoad' | 'usedScroll'
) {
	return pages.flatMap((page) => {
		const same = page.files.filter((f) => f.origin === 'same' && f.kind === kind);
		const total = same.reduce((t, f) => t + f.raw, 0);
		return total > 0 ? [same.reduce((t, f) => t + f[field], 0) / total] : [];
	});
}

/** a changed aggregate's comparison with an earlier file of its kind; the zstd sizes are null when the base did not load */
export type Base = {
	url: string | null;
	status: number | null;
	zstdAlone: number | null;
	zstdDict: number | null;
};

/** one same-origin CSS or JS aggregate of a site, keyed by its path with the query dropped */
export type Aggregate = {
	path: string;
	kind: 'css' | 'js';
	raw: number;
	/** the largest transfer a page recorded for it, or null when no page did */
	transfer: number | null;
	/** only on a reading taken with an earlier reading to compare against, for a name that changed */
	base: Base | null;
};

/** whether a URL is a Drupal aggregate: a CSS or JS file directly under a `files/css/` or `files/js/` folder */
export function isAggregate(url: string): boolean {
	return /\/files\/(css|js)\/[^/]+$/.test(new URL(url).pathname);
}

type AggregateFile = {
	url: string;
	kind: 'css' | 'js';
	origin: 'same' | 'third';
	raw: number;
	transfer: number | null;
	base?: Base | null;
};

/** the aggregates of each site of a trim reading, one entry per path across its pages */
export function aggregatesOf(rows: readonly Row[]): Map<string, Aggregate[]> {
	const out = new Map<string, Aggregate[]>();
	for (const row of rows as unknown as Array<{
		site: string;
		pages?: Array<{ files?: AggregateFile[] }>;
	}>) {
		const byPath = new Map<string, Aggregate>();
		for (const page of row.pages ?? []) {
			for (const file of page.files ?? []) {
				if (file.origin !== 'same' || !isAggregate(file.url)) continue;
				const path = new URL(file.url).pathname;
				const entry = byPath.get(path) ?? {
					path,
					kind: file.kind,
					raw: file.raw,
					transfer: null,
					base: null
				};
				if (
					file.transfer !== null &&
					(entry.transfer === null || file.transfer > entry.transfer)
				)
					entry.transfer = file.transfer;
				entry.base ??= file.base ?? null;
				byPath.set(path, entry);
			}
		}
		out.set(row.site, [...byPath.values()]);
	}
	return out;
}

/** one site's aggregates on the second reading against the first */
export type ChurnSite = {
	site: string;
	/** aggregates on the second reading */
	aggregates: number;
	/** of which the name is new since the first reading */
	changed: number;
	/** the changed names' share of the second reading's aggregate transfer bytes; null without any transfer */
	changedShare: number | null;
	/** changed aggregates whose base loaded, and the zstd dictionary size over standalone size across them */
	compared: number;
	dictRatio: number | null;
	/** the same non-empty set of names on both readings */
	unchanged: boolean;
};

/** the median and mean over the sites that have a value, and how many did */
export type Summary = { median: number | null; mean: number | null; sites: number };

/** the churn between two readings of the same sites, over the sites both hold */
export type ChurnFigures = {
	sites: ChurnSite[];
	changedShare: Summary;
	dictRatio: Summary;
	/** sites whose aggregate names are identical on both readings */
	unchangedSites: number;
};

const summary = (xs: readonly number[]): Summary => ({
	median: xs.length === 0 ? null : median(xs),
	mean: xs.length === 0 ? null : xs.reduce((n, x) => n + x, 0) / xs.length,
	sites: xs.length
});

/**
 * Churn between an earlier and a later trim reading. Names are compared by path, so a changed
 * name is an aggregate the later reading holds and the earlier one did not. The dictionary ratio
 * uses the base sizes the later reading recorded; the earlier reading carries none.
 */
export function churnFigures(prior: readonly Row[], current: readonly Row[]): ChurnFigures {
	const before = aggregatesOf(prior);
	const now = aggregatesOf(current);
	const sites: ChurnSite[] = [];
	for (const [site, files] of now) {
		const earlier = before.get(site);
		if (!earlier) continue;
		const old = new Set(earlier.map((a) => a.path));
		const sized = files.filter((a) => a.transfer !== null);
		const changed = files.filter((a) => !old.has(a.path));
		const changedSized = changed.filter((a) => a.transfer !== null);
		const total = sized.reduce((n, a) => n + (a.transfer ?? 0), 0);
		const changedBytes = changedSized.reduce((n, a) => n + (a.transfer ?? 0), 0);
		const pairs = changed.flatMap((a) => {
			const b = a.base;
			return b && b.zstdAlone !== null && b.zstdDict !== null
				? [{ alone: b.zstdAlone, dict: b.zstdDict }]
				: [];
		});
		const alone = pairs.reduce((n, p) => n + p.alone, 0);
		sites.push({
			site,
			aggregates: files.length,
			changed: changed.length,
			changedShare: total > 0 ? changedBytes / total : null,
			compared: pairs.length,
			dictRatio: pairs.length > 0 ? pairs.reduce((n, p) => n + p.dict, 0) / alone : null,
			unchanged:
				files.length > 0 &&
				files.length === earlier.length &&
				files.every((a) => old.has(a.path))
		});
	}
	return {
		sites,
		changedShare: summary(
			sites.flatMap((s) => (s.changedShare === null ? [] : [s.changedShare]))
		),
		dictRatio: summary(sites.flatMap((s) => (s.dictRatio === null ? [] : [s.dictRatio]))),
		unchangedSites: sites.filter((s) => s.unchanged).length
	};
}

/** coverage shares of the coverage reading (`measurements/trim/<date>.json`), pooled over its pages */
export function coverageFigures(rows: readonly Row[]): CoverageFigures & { pages: number } {
	const pages = (rows as unknown as Array<{ pages: CoveragePage[] }>)
		.flatMap((r) => r.pages)
		.filter((p) => p.ok === true);
	return {
		pages: pages.length,
		cssLoad: quartiles(shares(pages, 'css', 'usedLoad')),
		cssScroll: quartiles(shares(pages, 'css', 'usedScroll')),
		jsLoad: quartiles(shares(pages, 'js', 'usedLoad')),
		jsScroll: quartiles(shares(pages, 'js', 'usedScroll'))
	};
}
