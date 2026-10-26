/** one file of a crawl: its URL, its kind and its plain compressed size */
export type BaseCandidate = {
	/** the URL the file was crawled from */
	url: string;
	/** whether the file is a stylesheet or a script */
	kind: 'style' | 'script';
	/** compressed size of the file alone, with no dictionary, in bytes */
	plain: number;
};

/** compressed size of `file` against `dictionary`, both indexes into the candidate list */
export type DeltaSize = (file: number, dictionary: number) => number | Promise<number>;

export type BaseChoice = {
	/** whether the base is a stylesheet or a script */
	kind: 'style' | 'script';
	/** the path up to the last slash that every member shares */
	directory: string;
	/** the URL of the chosen base file */
	url: string;
	/** how many files of the crawl share the directory and kind, the base included */
	files: number;
	/** mean bytes each other file costs against this base, capped at its plain size */
	meanDelta: number;
};

/** the path of a URL up to and including its last slash */
export function dirOf(url: string): string {
	const path = new URL(url).pathname;
	return path.slice(0, path.lastIndexOf('/') + 1);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The member of `members` that minimizes the sum, over the other members, of the smaller of their
 * delta against it and their plain size. Ties keep the member listed first.
 */
export function pickBase(
	members: readonly number[],
	delta: (file: number, dictionary: number) => number,
	plain: (file: number) => number
): { best: number; score: number } {
	let best = -1;
	let bestScore = Infinity;
	for (const c of members) {
		let score = 0;
		for (const f of members) {
			if (f !== c) score += Math.min(delta(f, c), plain(f));
		}
		if (score < bestScore) {
			best = c;
			bestScore = score;
		}
	}
	return { best, score: bestScore };
}

/**
 * One base per directory and kind. Members are ordered by URL before scoring, so a tie goes to the
 * URL that sorts first whatever the input order. A group of one file has no base.
 */
export async function chooseBases(
	files: readonly BaseCandidate[],
	delta: DeltaSize
): Promise<BaseChoice[]> {
	const at = (i: number) => files[i] as BaseCandidate;
	const groups = new Map<string, number[]>();
	for (const [i, f] of files.entries()) {
		const key = JSON.stringify([f.kind, dirOf(f.url)]);
		const members = groups.get(key);
		if (members) members.push(i);
		else groups.set(key, [i]);
	}
	const choices: BaseChoice[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const sorted = [...members].sort((a, b) => compare(at(a).url, at(b).url));
		const sizes = new Map<string, number>();
		for (const f of sorted) {
			for (const c of sorted) {
				if (f !== c) sizes.set(`${f}|${c}`, await delta(f, c));
			}
		}
		const { best, score } = pickBase(
			sorted,
			(f, c) => sizes.get(`${f}|${c}`) as number,
			(f) => at(f).plain
		);
		const { kind, url } = at(best);
		choices.push({
			kind,
			directory: dirOf(url),
			url,
			files: sorted.length,
			meanDelta: score / (sorted.length - 1)
		});
	}
	return choices.sort((a, b) => compare(a.directory, b.directory) || compare(a.kind, b.kind));
}

/** true for the exact pathnames of the chosen base URLs; a query string does not count */
export function baseMatcher(choices: readonly BaseChoice[]): (pathname: string) => boolean {
	const paths = new Set(choices.map((choice) => new URL(choice.url).pathname));
	return (pathname) => paths.has(pathname);
}
