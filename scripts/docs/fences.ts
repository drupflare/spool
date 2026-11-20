import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Fence {
	/** doc path relative to the repo root, with forward slashes */
	file: string;
	/** 1-based line of the opening fence; code line k sits on doc line `line + k` */
	line: number;
	language: 'ts' | 'typescript';
	/** words after the language, for example `no-check` */
	flags: string[];
	code: string;
}

export interface PlannedFence {
	fence: Fence;
	/** path under the output folder, with forward slashes */
	out: string;
}

const OPEN = /^(?<prefix>[ \t>]*)(?<ticks>`{3,})[ \t]*(?<language>[^\s`]*)[ \t]*(?<info>.*)$/;
const NAMED = /^\/\/ (?<path>[\w@.[\]-]+(?:\/[\w@.[\]-]+)*\.(?:ts|mts))(?: and .*)?$/;

/** the `ts` and `typescript` fences of a Markdown page, including those inside lists and quotes */
export function extractFences(markdown: string, file: string): Fence[] {
	const lines = markdown.split(/\r?\n/);
	const fences: Fence[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = OPEN.exec(lines[i] ?? '');
		if (!open?.groups) continue;
		const { prefix = '', ticks = '', language = '', info = '' } = open.groups;
		const quotes = prefix.split('>').length - 1;
		const indent = (prefix.split('>').pop() ?? '').length;
		const strip = (text: string) => {
			let rest = text;
			for (let q = 0; q < quotes; q++) rest = rest.replace(/^[ \t]*>[ \t]?/, '');
			return rest.replace(new RegExp(`^[ \\t]{0,${indent}}`), '');
		};
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const text = strip(lines[j] ?? '');
			if (new RegExp(`^[ \\t]*\`{${ticks.length},}[ \\t]*$`).test(text)) break;
			body.push(text);
		}
		if (language === 'ts' || language === 'typescript') {
			fences.push({
				file,
				line: i + 1,
				language,
				flags: info.split(/\s+/).filter(Boolean),
				code: `${body.join('\n')}\n`
			});
		}
		i = j;
	}
	return fences;
}

/** the pages whose fences are checked: sources only, never a page generated from a `.src.md` */
export function fenceDocs(root: string): string[] {
	const listed = (dir: string) =>
		readdirSync(join(root, dir))
			.filter((name) => name.endsWith('.md'))
			.map((name) => `${dir}/${name}`);
	const docs = listed('docs');
	const generated = new Set(
		docs.filter((doc) => doc.endsWith('.src.md')).map((doc) => doc.replace(/\.src\.md$/, '.md'))
	);
	return [
		'README.md',
		'ADVANCED_USAGE.md',
		...docs.filter((doc) => !generated.has(doc)),
		...listed('docs/adapters'),
		'SECURITY.md',
		'TECHNICAL_REPORT.md'
	].filter((doc) => existsSync(join(root, doc)));
}

/** `docs/adapters/vue.md` becomes `adapters-vue`, `README.md` becomes `readme` */
export function docSlug(file: string): string {
	return file
		.replace(/^docs\//, '')
		.replace(/\.md$/, '')
		.replaceAll('/', '-')
		.replaceAll('.', '-')
		.replaceAll('_', '-')
		.toLowerCase();
}

/**
 * Names each checked fence. A fence whose first line is `// path/to/file.ts` is written at that
 * path inside its page's folder, so the relative imports its siblings make resolve. Any other fence,
 * and a repeated path, is `<n>.ts` with n counting the page's ts fences from 1.
 */
export function planFences(file: string, fences: Fence[]): PlannedFence[] {
	const slug = docSlug(file);
	const taken = new Set<string>();
	const planned: PlannedFence[] = [];
	fences.forEach((fence, index) => {
		if (fence.flags.includes('no-check')) return;
		const named = NAMED.exec(fence.code.split('\n')[0] ?? '')?.groups?.['path'];
		const usable = named && !named.split('/').some((part) => part === '.' || part === '..');
		const name = usable && !taken.has(named) ? named : `${index + 1}.ts`;
		taken.add(name);
		planned.push({ fence, out: `${slug}/${name}` });
	});
	return planned;
}

/** empties `outDir` and writes every planned fence under it; refuses a path that leaves the folder */
export function writeFences(outDir: string, planned: PlannedFence[]): void {
	const base = resolve(outDir);
	const targets = planned.map(({ fence, out }) => {
		const target = resolve(base, out);
		if (!target.startsWith(base + sep)) {
			throw new Error(`${fence.file}:${fence.line} would write outside ${outDir}: ${out}`);
		}
		return { target, code: fence.code };
	});
	rmSync(base, { recursive: true, force: true });
	for (const { target, code } of targets) {
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, code);
	}
}

export interface FenceReport {
	/** fences compiled, by page */
	checked: Map<string, number>;
	/** fences skipped with `no-check`, as `file:line` */
	skipped: string[];
	/** one line per compile error, in doc coordinates for a fence */
	problems: string[];
}

export interface FenceOptions {
	outDir?: string;
	tsconfig?: string;
	/** where stand-in modules live; defaults to `tests/node/readme` */
	supportDir?: string;
	docs?: string[];
	/** compiler options applied over the tsconfig, for a faster program in a test */
	options?: ts.CompilerOptions;
}

/** a compile error in doc coordinates: `README.md:134:7 error TS2322: ...` */
export function formatProblem(
	planned: PlannedFence | undefined,
	where: { line: number; column: number } | undefined,
	code: number,
	message: string,
	fallbackFile = ''
): string {
	if (!planned || !where)
		return `${fallbackFile}${fallbackFile ? ' ' : ''}error TS${code}: ${message}`;
	const { fence } = planned;
	return `${fence.file}:${fence.line + where.line}:${where.column} error TS${code}: ${message}`;
}

/** writes every fence of every page to the output folder and compiles them as written */
export function checkFences(root: string, config: FenceOptions = {}): FenceReport {
	const outDir = resolve(root, config.outDir ?? 'tests/node/.fences');
	const tsconfig = resolve(root, config.tsconfig ?? 'tests/node/tsconfig.fences.json');
	const support = resolve(root, config.supportDir ?? 'tests/node/readme');
	const checked = new Map<string, number>();
	const skipped: string[] = [];
	const planned: PlannedFence[] = [];
	for (const doc of config.docs ?? fenceDocs(root)) {
		const fences = extractFences(readFileSync(join(root, doc), 'utf8'), doc);
		for (const fence of fences) {
			if (fence.flags.includes('no-check')) skipped.push(`${doc}:${fence.line}`);
		}
		const plan = planFences(doc, fences);
		if (plan.length > 0) checked.set(doc, plan.length);
		planned.push(...plan);
	}
	writeFences(outDir, planned);

	const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
	const options = { ...parsed.options, ...config.options };
	const host = ts.createCompilerHost(options);
	host.resolveModuleNameLiterals = (literals, containing, _redirect, opts) =>
		literals.map((literal) => {
			const direct = ts.resolveModuleName(literal.text, containing, opts, host);
			const rel = relative(outDir, dirname(containing));
			if (direct.resolvedModule || !literal.text.startsWith('.') || rel.startsWith('..')) {
				return direct;
			}
			const [slug = '', ...inside] = rel.split(sep);
			for (const dir of [join(support, slug, ...inside), join(support, ...inside)]) {
				const found = ts.resolveModuleName(
					literal.text,
					join(dir, basename(containing)),
					opts,
					host
				);
				if (found.resolvedModule) return found;
			}
			return direct;
		});
	const ambient = parsed.fileNames.filter((name) => name.endsWith('.d.ts'));
	const rootNames = [...planned.map(({ out }) => resolve(outDir, out)), ...ambient];
	const program = ts.createProgram({ rootNames, options, host });
	const byFile = new Map(planned.map((p) => [resolve(outDir, p.out), p]));
	const problems = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
		const file = diagnostic.file;
		if (!file || diagnostic.start === undefined)
			return formatProblem(undefined, undefined, diagnostic.code, message);
		const at = file.getLineAndCharacterOfPosition(diagnostic.start);
		const where = { line: at.line + 1, column: at.character + 1 };
		const plan = byFile.get(resolve(file.fileName));
		if (plan) return formatProblem(plan, where, diagnostic.code, message);
		const name = relative(root, file.fileName);
		return formatProblem(
			undefined,
			undefined,
			diagnostic.code,
			message,
			`${name}:${where.line}:${where.column}`
		);
	});
	return { checked, skipped, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const report = checkFences(root);
	const total = [...report.checked.values()].reduce((sum, n) => sum + n, 0);
	console.log(
		`fences: ${total} compiled in ${report.checked.size} pages, ${report.skipped.length} no-check`
	);
	for (const problem of report.problems) console.error(problem);
	if (report.problems.length > 0) process.exitCode = 1;
}
