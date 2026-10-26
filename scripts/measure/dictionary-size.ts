import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	brotliCompressSync,
	constants as Z,
	zstdCompressSync,
	zstdDecompressSync
} from 'node:zlib';
import { dirOf, pickBase } from '../../src/proxy/bases.ts';
import { DICTIONARY_ARMS, dictionaryArms, type DictionaryArm } from '../../src/report/ledger.ts';
import {
	isMain,
	localMachine,
	MEASUREMENTS_DIR,
	utcDate,
	writeMeasurement,
	type Draft
} from './lib';

const HELP = `Usage: bun scripts/measure/dictionary-size.ts [--machine NAME] [--experiment NAME] [--out DIR]
       [--force] [--dry-run] [--sites SUBSTRING[,SUBSTRING]] [--pages N]

Bytes only. For each Drupal site of measurements/trim/2026-10-19.json it visits the home page and
the first N internal pages (default 4), collects the same-origin stylesheets and scripts in visit
order, and for each file new to the visit sizes it alone (brotli 11, zstd 19) and against a
dictionary chosen four ways: the oracle (the best earlier file of the same kind), the browser
(the most recent earlier file of the same kind in the same directory), the server in the visit (one
base file per directory chosen offline over the whole crawl, used once the visit has fetched it)
and the server holding its base from an earlier visit. Every delta is decoded and compared.
brotli needs the brotli command line tool on PATH.`;

const WINDOW_LOG = 23;
const DELAY_MS = 250;
const PAGES_PER_SITE = 4;
const BIG = 1 << 30;
const TRIM = join(MEASUREMENTS_DIR, 'trim', '2026-10-19.json');
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 spool-dictionary-size/1.0';

const zstdParams = { [Z.ZSTD_c_compressionLevel]: 19, [Z.ZSTD_c_windowLog]: WINDOW_LOG };
const brotliParams = { [Z.BROTLI_PARAM_QUALITY]: 11, [Z.BROTLI_PARAM_LGWIN]: 24 };

export type FileKind = 'css' | 'js';

/** what the arm planner needs to know about one file new to the visit, in visit order */
export type Candidate = { kind: FileKind; dir: string; br11: number; page: number };

/** the file (an index into the visit's files) each arm uses as its dictionary, or null for none */
export type Plan = {
	oracle: number | null;
	browser: number | null;
	serverVisit: number | null;
	serverHeld: number | null;
	serverOut: number | null;
};

/** the base file chosen for one directory and kind */
export type Base = { kind: FileKind; dir: string; base: number; files: number; meanZstd: number };

/**
 * Chooses the dictionary of every arm for every file. `delta(file, dictionary)` is the compressed
 * size of `file` against `dictionary`. The oracle takes the best earlier file of the same kind, the
 * browser the latest earlier one of the same kind and directory. The server base of a directory and
 * kind is the file with the smallest sum, over the group's other files, of the smaller of their
 * delta against it and their plain brotli size; a group of one has none. `serverVisit` uses the base
 * only after the visit has fetched it, `serverHeld` whenever the file is not the base itself, and
 * `serverOut` is `serverHeld` with the base chosen without any file first seen on the same page, so
 * the page being measured did not pick its own dictionary.
 */
export function planArms(
	files: readonly Candidate[],
	delta: (file: number, dictionary: number) => number
): { plans: Plan[]; bases: Base[] } {
	const groups = new Map<string, number[]>();
	for (const [i, f] of files.entries()) {
		const key = `${f.kind}|${f.dir}`;
		groups.set(key, [...(groups.get(key) ?? []), i]);
	}
	const pick = (members: readonly number[]) =>
		pickBase(members, delta, (f) => (files[f] as Candidate).br11);
	const baseOf = new Map<string, number>();
	const bases: Base[] = [];
	for (const [key, members] of groups) {
		if (members.length < 2) continue;
		const { best, score: bestScore } = pick(members);
		baseOf.set(key, best);
		const first = files[best] as Candidate;
		bases.push({
			kind: first.kind,
			dir: first.dir,
			base: best,
			files: members.length,
			meanZstd: bestScore / (members.length - 1)
		});
	}
	const plans = files.map((file, i): Plan => {
		const earlier = [...files.keys()].filter(
			(j) => j < i && (files[j] as Candidate).kind === file.kind
		);
		let oracle: number | null = null;
		for (const j of earlier) {
			if (oracle === null || delta(i, j) < delta(i, oracle)) oracle = j;
		}
		const near = earlier.filter((j) => (files[j] as Candidate).dir === file.dir);
		const base = baseOf.get(`${file.kind}|${file.dir}`);
		const held = base === undefined || base === i ? null : base;
		const others = (groups.get(`${file.kind}|${file.dir}`) ?? []).filter(
			(j) => (files[j] as Candidate).page !== file.page
		);
		return {
			oracle,
			browser: near.at(-1) ?? null,
			serverVisit: held !== null && held < i ? held : null,
			serverHeld: held,
			serverOut: others.length < 2 ? null : pick(others).best
		};
	});
	return { plans, bases };
}

type Fetched = { url: string; kind: FileKind; body: Buffer };

type Arms = Record<DictionaryArm, { from: string | null; zstd: number | null; br: number | null }>;

let lastRequest = 0;

async function get(url: string, accept: string) {
	const wait = lastRequest + DELAY_MS - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastRequest = Date.now();
	const res = await fetch(url, {
		headers: { 'user-agent': UA, 'accept-encoding': 'identity', accept },
		signal: AbortSignal.timeout(60_000)
	});
	return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

/** the same-origin stylesheets and scripts a page names, in document order */
declare class HTMLRewriter {
	on(
		selector: string,
		handlers: { element(el: { getAttribute(name: string): string | null }): void }
	): HTMLRewriter;
	transform(response: Response): Response;
}

async function references(html: string, pageUrl: string, host: string) {
	const out: Array<{ url: string; kind: FileKind }> = [];
	const take = (raw: string | null, kind: FileKind) => {
		if (!raw) return;
		const u = new URL(raw.replaceAll('&amp;', '&'), pageUrl);
		if (u.hostname !== host) return;
		u.hash = '';
		out.push({ url: u.href, kind });
	};
	await new HTMLRewriter()
		.on('link', {
			element(el) {
				const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
				if (rel.includes('stylesheet')) take(el.getAttribute('href'), 'css');
			}
		})
		.on('script', {
			element(el) {
				take(el.getAttribute('src'), 'js');
			}
		})
		.transform(new Response(html))
		.text();
	return out;
}

type TrimRow = {
	site: string;
	pages: Array<{ url: string; kind: 'home' | 'internal'; ok: boolean }>;
};

export function plan(args: ReturnType<typeof parse>) {
	const sites = (JSON.parse(readFileSync(TRIM, 'utf8')) as { rows: TrimRow[] }).rows.filter(
		(r) => !args.sites || args.sites.some((part) => r.site.includes(part))
	);
	return {
		rig: 'dictionary-size',
		date: utcDate(),
		sites: sites.map((r) => r.site),
		pagesPerSite: `home plus the first ${args.pages} internal pages of the trim reading that loaded`,
		arms: DICTIONARY_ARMS,
		baselines: ['brotli 11', `zstd 19, window log ${WINDOW_LOG}`],
		delayMs: DELAY_MS,
		output: `measurements/dictionary-size/${utcDate()}${args.experiment ? `-${args.experiment}` : ''}.json`
	};
}

async function visit(row: TrimRow, pages: number, work: string) {
	const host = new URL(row.site).hostname;
	const wanted = [
		...row.pages.filter((p) => p.kind === 'home' && p.ok),
		...row.pages.filter((p) => p.kind === 'internal' && p.ok).slice(0, pages)
	];
	const fetched: Fetched[] = [];
	const owner: number[] = [];
	const seen = new Set<string>();
	const failures: string[] = [];
	const pageRows: Array<Record<string, unknown>> = [];
	for (const [index, page] of wanted.entries()) {
		const res = await get(page.url, 'text/html,application/xhtml+xml');
		pageRows.push({
			kind: 'page',
			site: row.site,
			index,
			pageKind: page.kind,
			url: page.url,
			status: res.status,
			files: 0
		});
		if (res.status !== 200) {
			failures.push(`page ${page.url} status ${res.status}`);
			continue;
		}
		for (const ref of await references(res.body.toString('utf8'), page.url, host)) {
			if (seen.has(ref.url)) continue;
			seen.add(ref.url);
			const file = await get(ref.url, ref.kind === 'css' ? 'text/css,*/*;q=0.1' : '*/*');
			if (file.status !== 200) {
				failures.push(`file ${ref.url} status ${file.status}`);
				continue;
			}
			fetched.push({ url: ref.url, kind: ref.kind, body: file.body });
			owner.push(index);
			(pageRows[index] as { files: number }).files++;
		}
	}

	const plain = fetched.map((f) => ({
		br11: brotliCompressSync(f.body, { params: brotliParams }).length,
		zstd19: zstdCompressSync(f.body, { params: zstdParams }).length
	}));
	const zstdMemo = new Map<string, number>();
	const delta = (file: number, dictionary: number) => {
		const key = `${file}|${dictionary}`;
		let size = zstdMemo.get(key);
		if (size === undefined) {
			const body = (fetched[file] as Fetched).body;
			const dict = (fetched[dictionary] as Fetched).body;
			const packed = zstdCompressSync(body, { dictionary: dict, params: zstdParams });
			if (!zstdDecompressSync(packed, { dictionary: dict }).equals(body)) {
				failures.push(`zstd delta did not decode ${(fetched[file] as Fetched).url}`);
			}
			size = packed.length;
			zstdMemo.set(key, size);
		}
		return size;
	};
	const brotliMemo = new Map<string, number>();
	const brotliDelta = (file: number, dictionary: number) => {
		const key = `${file}|${dictionary}`;
		let size = brotliMemo.get(key);
		if (size === undefined) {
			const body = (fetched[file] as Fetched).body;
			const path = join(work, `${dictionary}.bin`);
			writeFileSync(path, (fetched[dictionary] as Fetched).body);
			const packed = execFileSync('brotli', ['-q', '11', '-w', '24', '-c', '-D', path], {
				input: body,
				maxBuffer: BIG
			});
			const back = execFileSync('brotli', ['-d', '-c', '-D', path], {
				input: packed,
				maxBuffer: BIG
			});
			if (!back.equals(body))
				failures.push(`brotli delta did not decode ${(fetched[file] as Fetched).url}`);
			size = packed.length;
			brotliMemo.set(key, size);
		}
		return size;
	};

	const { plans, bases } = planArms(
		fetched.map((f, i) => ({
			kind: f.kind,
			dir: dirOf(f.url),
			br11: (plain[i] as { br11: number }).br11,
			page: owner[i] as number
		})),
		delta
	);
	const fileRows = fetched.map((f, i) => {
		const chosen = plans[i] as Plan;
		const arm = (from: number | null) => ({
			from: from === null ? null : (fetched[from] as Fetched).url,
			zstd: from === null ? null : delta(i, from),
			br: from === null ? null : brotliDelta(i, from)
		});
		const arms = {
			oracle: arm(chosen.oracle),
			browser: arm(chosen.browser),
			serverVisit: arm(chosen.serverVisit),
			serverHeld: arm(chosen.serverHeld),
			serverOut: arm(chosen.serverOut)
		} satisfies Arms;
		return {
			kind: 'file',
			site: row.site,
			page: owner[i],
			pageKind: (pageRows[owner[i] as number] as { pageKind: string }).pageKind,
			url: f.url,
			fileKind: f.kind,
			dir: dirOf(f.url),
			raw: f.body.length,
			...(plain[i] as object),
			...arms
		};
	});
	const baseRows = bases.map((b) => ({
		kind: 'base',
		site: row.site,
		fileKind: b.kind,
		dir: b.dir,
		base: (fetched[b.base] as Fetched).url,
		files: b.files,
		meanZstd: Math.round(b.meanZstd)
	}));
	return { rows: [...pageRows, ...baseRows, ...fileRows], failures };
}

export function parse(argv: string[]) {
	const { values } = parseArgs({
		args: argv,
		options: {
			machine: { type: 'string' },
			experiment: { type: 'string' },
			out: { type: 'string', default: MEASUREMENTS_DIR },
			force: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', default: false },
			sites: { type: 'string' },
			pages: { type: 'string', default: String(PAGES_PER_SITE) }
		}
	});
	return {
		machine: values.machine,
		experiment: values.experiment,
		out: values.out as string,
		force: values.force as boolean,
		dryRun: values['dry-run'] as boolean,
		help: values.help as boolean,
		sites: values.sites?.split(',') ?? null,
		pages: Number(values.pages)
	};
}

if (isMain(import.meta.url)) {
	const args = parse(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
	} else if (args.dryRun) {
		console.log(JSON.stringify(plan(args), null, 2));
	} else {
		const rows = (JSON.parse(readFileSync(TRIM, 'utf8')) as { rows: TrimRow[] }).rows.filter(
			(r) => !args.sites || args.sites.some((part) => r.site.includes(part))
		);
		const brotliVersion = execFileSync('brotli', ['--version']).toString().trim();
		const work = mkdtempSync(join(tmpdir(), 'spool-dictionary-size-'));
		const all: Array<Record<string, unknown>> = [];
		const exclusions: string[] = [];
		for (const row of rows) {
			console.error(`site ${row.site}`);
			try {
				const done = await visit(row, args.pages, work);
				all.push(...done.rows);
				exclusions.push(...done.failures);
			} catch (error) {
				exclusions.push(`${row.site}: ${String(error).slice(0, 160)}`);
			}
		}
		rmSync(work, { recursive: true, force: true });
		console.error(JSON.stringify(dictionaryArms(all), null, 2));
		const draft: Draft = {
			rig: 'dictionary-size',
			date: utcDate(),
			layer: 'L1',
			question:
				'how many bytes of same-origin stylesheets and scripts a first view saves when each file new to the visit is compressed against an earlier file of the same site as a dictionary, against brotli 11 alone, when the dictionary is the best earlier file (an oracle), the file a browser would pick (the most recent one in the same directory), or one base file per directory that the server chose offline',
			instrument: `node:zlib zstd level 19 with a raw dictionary (window log ${WINDOW_LOG}) and node:zlib brotli quality 11; brotli command line ${brotliVersion} with -D for brotli dictionaries; every delta decoded and compared with the file; the transfer is the compressed size, no headers`,
			machine: localMachine(args.machine),
			software: { runtime: `Bun ${process.versions.bun}`, brotli: brotliVersion },
			method: {
				sites: rows.length,
				pages: `home plus the first ${args.pages} internal pages of measurements/trim/2026-10-19.json that loaded; the files are the same-origin <link rel=stylesheet> and <script src> of each page, fetched once each in visit order with identity encoding`,
				arms: {
					oracle: 'the earlier file of the same kind with the smallest zstd delta, any directory; the brotli delta uses the same file',
					browser:
						'the most recent earlier file of the same kind in the same directory, as a Use-As-Dictionary match of the directory would select',
					serverVisit: 'the directory base, only when the visit has already fetched it',
					serverHeld:
						'the directory base, as if an earlier visit had left it in the browser; chosen with every file of the crawl, the measured page included',
					serverOut:
						'the same, with the base chosen over the files of the other pages only, so the page measured did not pick its dictionary'
				},
				base: 'per site, kind and directory with at least two files: the file with the smallest sum over the other files of min(zstd delta against it, brotli 11 alone), computed over every file of the crawl and then applied to the visit',
				fallback: `a file whose delta is not smaller than brotli 11 alone is served plain, so an arm never costs bytes; the headline is the median over sites of the share of brotli 11 bytes saved over the site's new files`,
				'request pacing': `${DELAY_MS} ms between requests, one request at a time`
			},
			exclusions: [
				...exclusions,
				'a file the page names more than once, or on a later page, is counted at its first fetch only',
				'a file from another host',
				'a file the server answered with anything but 200'
			],
			rows: all
		};
		console.log(
			writeMeasurement(args.out, draft, {
				experiment: args.experiment,
				overwrite: args.force
			})
		);
	}
}
