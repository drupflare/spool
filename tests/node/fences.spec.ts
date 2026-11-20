import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	checkFences,
	docSlug,
	extractFences,
	fenceDocs,
	formatProblem,
	planFences,
	writeFences
} from '../../scripts/docs/fences';

const roots: string[] = [];
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'spool-fences-'));
	roots.push(dir);
	return dir;
};
const put = (root: string, path: string, text: string) => {
	mkdirSync(join(root, path, '..'), { recursive: true });
	writeFileSync(join(root, path), text);
};
afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('extractFences', () => {
	it('returns ts and typescript fences with their line and code', () => {
		const page = [
			'# Title',
			'',
			'```ts',
			'const a = 1;',
			'```',
			'',
			'```typescript',
			'a;',
			'```'
		].join('\n');
		const fences = extractFences(page, 'doc.md');
		expect(fences).toEqual([
			{ file: 'doc.md', line: 3, language: 'ts', flags: [], code: 'const a = 1;\n' },
			{ file: 'doc.md', line: 7, language: 'typescript', flags: [], code: 'a;\n' }
		]);
	});

	it('puts a statement on the doc line fence.line plus its line in the code', () => {
		const page = ['text', '', '```ts', 'a;', 'b;', '```'].join('\n');
		const [fence] = extractFences(page, 'doc.md');
		expect((fence?.line ?? 0) + 2).toBe(page.split('\n').indexOf('b;') + 1);
	});

	it('reads the words after the language as flags', () => {
		const [fence] = extractFences('```ts no-check\nawait x;\n```\n', 'doc.md');
		expect(fence?.flags).toEqual(['no-check']);
	});

	it('ignores unlabelled, json, sh and tsx fences', () => {
		const page = [
			'```',
			'a',
			'```',
			'```json',
			'{}',
			'```',
			'```sh',
			'ls',
			'```',
			'```tsx',
			'<a/>',
			'```'
		];
		expect(extractFences(page.join('\n'), 'doc.md')).toEqual([]);
	});

	it('reads a fence inside a list item and inside a blockquote', () => {
		const page = [
			'- item',
			'',
			'  ```ts',
			'  const inList = 1;',
			'',
			'  inList;',
			'  ```',
			'',
			'> ```ts',
			'> const quoted = 2;',
			'> ```'
		].join('\n');
		const fences = extractFences(page, 'doc.md');
		expect(fences.map((f) => f.code)).toEqual([
			'const inList = 1;\n\ninList;\n',
			'const quoted = 2;\n'
		]);
		expect(fences.map((f) => f.line)).toEqual([3, 9]);
	});

	it('does not open a fence on a ts line inside a longer fence', () => {
		const page = ['````md', '```ts', 'a;', '```', '````', '', '```ts', 'b;', '```'].join('\n');
		expect(extractFences(page, 'doc.md').map((f) => f.code)).toEqual(['b;\n']);
	});
});

describe('planFences', () => {
	const fence = (code: string, flags: string[] = []) => ({
		file: 'docs/adapters/vue.md',
		line: 1,
		language: 'ts' as const,
		flags,
		code
	});

	it('names a fence by its first-line path and the others by position', () => {
		const planned = planFences('docs/adapters/vue.md', [
			fence('// vite.config.ts\nexport {};\n'),
			fence('export {};\n'),
			fence('// server/spool.ts\nexport {};\n')
		]);
		expect(planned.map((p) => p.out)).toEqual([
			'adapters-vue/vite.config.ts',
			'adapters-vue/2.ts',
			'adapters-vue/server/spool.ts'
		]);
	});

	it('takes the first path of "a and b" and numbers a repeated path', () => {
		const planned = planFences('README.md', [
			fence('// app/a.ts and app/b.ts\n'),
			fence('// app/a.ts\n')
		]);
		expect(planned.map((p) => p.out)).toEqual(['readme/app/a.ts', 'readme/2.ts']);
	});

	it('numbers a path that climbs out of the folder instead of using it', () => {
		const planned = planFences('README.md', [fence('// ../escape.ts\n'), fence('// ./x.ts\n')]);
		expect(planned.map((p) => p.out)).toEqual(['readme/1.ts', 'readme/2.ts']);
	});

	it('skips a no-check fence and keeps the count', () => {
		const planned = planFences('README.md', [fence('a;\n', ['no-check']), fence('b;\n')]);
		expect(planned.map((p) => p.out)).toEqual(['readme/2.ts']);
	});

	it('slugs a page path', () => {
		expect(docSlug('README.md')).toBe('readme');
		expect(docSlug('ADVANCED_USAGE.md')).toBe('advanced-usage');
		expect(docSlug('docs/adapters/vue.md')).toBe('adapters-vue');
		expect(docSlug('docs/impact.src.md')).toBe('impact-src');
	});
});

describe('writeFences', () => {
	it('writes each fence and removes what an earlier run left', () => {
		const out = join(scratch(), '.fences');
		put(out, 'stale/old.ts', 'old');
		const [planned] = planFences('README.md', [
			{ file: 'README.md', line: 5, language: 'ts', flags: [], code: 'export {};\n' }
		]);
		writeFences(out, [planned!]);
		expect(readFileSync(join(out, 'readme/1.ts'), 'utf8')).toBe('export {};\n');
		expect(existsSync(join(out, 'stale/old.ts'))).toBe(false);
	});

	it('refuses a path outside the folder and leaves the folder as it was', () => {
		const root = scratch();
		const out = join(root, '.fences');
		put(out, 'kept.ts', 'kept');
		const fence = { file: 'README.md', line: 9, language: 'ts' as const, flags: [], code: 'x' };
		expect(() => writeFences(out, [{ fence, out: '../escape.ts' }])).toThrow(
			'README.md:9 would write outside'
		);
		expect(existsSync(join(root, 'escape.ts'))).toBe(false);
		expect(readFileSync(join(out, 'kept.ts'), 'utf8')).toBe('kept');
	});
});

describe('fenceDocs', () => {
	it('lists sources and skips a page generated from a .src.md', () => {
		const root = scratch();
		for (const path of [
			'README.md',
			'ADVANCED_USAGE.md',
			'docs/guide.md',
			'docs/impact.md',
			'docs/impact.src.md',
			'docs/adapters/vue.md',
			'docs/adapters/README.md'
		]) {
			put(root, path, '');
		}
		expect(fenceDocs(root)).toEqual([
			'README.md',
			'ADVANCED_USAGE.md',
			'docs/guide.md',
			'docs/impact.src.md',
			'docs/adapters/README.md',
			'docs/adapters/vue.md'
		]);
	});
});

describe('checkFences', () => {
	const options = { lib: ['lib.es5.d.ts'], types: [] as string[] };

	const project = (readme: string) => {
		const root = scratch();
		put(
			root,
			'tsconfig.json',
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: 'es2022',
					module: 'esnext',
					moduleResolution: 'bundler',
					skipLibCheck: true
				},
				include: []
			})
		);
		put(root, 'README.md', readme);
		put(root, 'support/routes.ts', 'export const routes = [1, 2];\n');
		put(root, 'support/adapters-x/stub.ts', 'export const stub = 1;\n');
		return root;
	};
	const run = (root: string, docs = ['README.md']) =>
		checkFences(root, {
			outDir: join(root, 'fences'),
			tsconfig: join(root, 'tsconfig.json'),
			supportDir: join(root, 'support'),
			docs,
			options
		});

	it('compiles a good fence, resolving a relative import from the support folder', () => {
		const root = project(
			[
				'# Doc',
				'',
				'```ts',
				"import { routes } from './routes';",
				'export const n: number = routes.length;',
				'```'
			].join('\n')
		);
		const report = run(root);
		expect(report.problems).toEqual([]);
		expect([...report.checked]).toEqual([['README.md', 1]]);
	});

	it('names the doc and line of a fence that does not compile', () => {
		const root = project(
			[
				'# Doc',
				'',
				'text',
				'',
				'```ts',
				'const a = 1;',
				"const b: number = 'x';",
				'```'
			].join('\n')
		);
		const report = run(root);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toMatch(/^README\.md:7:7 error TS2322: /);
	});

	it('does not compile a no-check fence and counts it', () => {
		const root = project(['```ts no-check', "const b: number = 'x';", '```'].join('\n'));
		const report = run(root);
		expect(report.problems).toEqual([]);
		expect(report.skipped).toEqual(['README.md:1']);
		expect(report.checked.size).toBe(0);
	});

	it('reports an import no folder can resolve', () => {
		const root = project(
			['```ts', "import { x } from './missing';", 'export { x };', '```'].join('\n')
		);
		expect(run(root).problems[0]).toMatch(/^README\.md:2:19 error TS2307: /);
	});
});

describe('formatProblem', () => {
	it('adds the fence line to the line inside the fence', () => {
		const fence = {
			file: 'docs/a.md',
			line: 129,
			language: 'ts' as const,
			flags: [],
			code: ''
		};
		expect(formatProblem({ fence, out: 'a/1.ts' }, { line: 3, column: 7 }, 2322, 'bad')).toBe(
			'docs/a.md:132:7 error TS2322: bad'
		);
	});

	it('keeps the file position for an error outside a fence', () => {
		expect(formatProblem(undefined, undefined, 2307, 'no module', 'a.d.ts:1:1')).toBe(
			'a.d.ts:1:1 error TS2307: no module'
		);
	});
});
