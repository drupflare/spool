import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import * as clientModule from '../../src/client/index';
import * as indexModule from '../../src/index';
import * as nodeModule from '../../src/node/listener';
import * as protocolModule from '../../src/protocol/index';
import * as proxyModule from '../../src/proxy/index';
import * as reportModule from '../../src/report/index';
import * as serverModule from '../../src/server/index';
import * as storesModule from '../../src/stores/index';
import * as swModule from '../../src/sw/index';
import * as trimModule from '../../src/trim/index';
import configSource from '../../vitest.config.ts?raw';

const root = join(import.meta.dirname, '../..');

type Exports = Record<string, { types: string; default: string } | string>;

/** each public subpath, the module it is built from, and a symbol that must be reachable through it */
const SUBPATHS: Array<[string, string, Record<string, unknown>, string]> = [
	['.', 'index', indexModule, 'joulesPerView'],
	['.', 'index', indexModule, 'defineRoute'],
	['./protocol', 'protocol/index', protocolModule, 'decodeEnvelope'],
	['./server', 'server/index', serverModule, 'createSpool'],
	['./server', 'server/index', serverModule, 'defineRoute'],
	['./node', 'node/listener', nodeModule, 'toNodeListener'],
	['./proxy', 'proxy/index', proxyModule, 'spoolProxy'],
	['./stores', 'stores/index', storesModule, 'memoryStore'],
	['./sw', 'sw/index', swModule, 'serve'],
	['./client', 'client/index', clientModule, 'register'],
	['./report', 'report/index', reportModule, 'fleetFor'],
	['./trim', 'trim/index', trimModule, 'trimCss']
];

describe('the package exports map', () => {
	it.each(SUBPATHS)('%s resolves to dist/%s and exposes %s', (subpath, file, module, symbol) => {
		expect((pkg.exports as Exports)[subpath]).toEqual({
			types: `./dist/${file}.d.ts`,
			default: `./dist/${file}.js`
		});
		expect(module[symbol]).toBeDefined();
	});

	it('maps the Durable Object entry to a file that exports SpoolVersions', () => {
		expect((pkg.exports as Exports)['./stores/durable-object']).toEqual({
			types: './dist/stores/durable-object.d.ts',
			default: './dist/stores/durable-object.js'
		});
		const source = readFileSync(
			new URL('../../src/stores/durable-object.ts', import.meta.url),
			'utf8'
		);
		expect(source).toContain('export class SpoolVersions');
	});

	it('keeps the Durable Object class out of the Node-safe stores entry', () => {
		expect(storesModule).not.toHaveProperty('SpoolVersions');
	});

	it('keeps main and types on the root entry', () => {
		expect(pkg.main).toBe('./dist/index.js');
		expect(pkg.types).toBe('./dist/index.d.ts');
	});

	it('ships dist, the license and the readme, and builds before a publish', () => {
		expect(pkg.files).toEqual(['dist', 'LICENSE', 'README.md']);
		const scripts = pkg.scripts as Record<string, string>;
		expect(scripts['prepublishOnly']).toContain('bun run build');
		expect(scripts['prepublishOnly']).toContain('bun run build:cdn');
	});

	it('is in the 0.x window until 1.0.0 ships with drupflare v1.1', () => {
		expect(pkg.version).toMatch(/^0\./);
	});
});

describe('the packed package', () => {
	let consumer = '';
	let installed = '';
	let files: string[] = [];

	beforeAll(() => {
		const work = mkdtempSync(join(tmpdir(), 'spool-pack-'));
		const stage = join(work, 'stage');
		const tsc = join(root, 'node_modules/.bin/tsc');
		for (const project of ['tsconfig.build.json', 'tsconfig.build.dom.json']) {
			execFileSync(tsc, ['-p', join(root, project), '--outDir', join(stage, 'dist')], {
				cwd: root
			});
		}
		execFileSync('bun', ['scripts/build-cdn.ts', `--out=${join(stage, 'dist/cdn')}`], {
			cwd: root
		});
		for (const name of ['LICENSE', 'README.md']) {
			writeFileSync(join(stage, name), readFileSync(join(root, name)));
		}
		// npm 10 runs `prepare` (husky) on pack despite --ignore-scripts and prints into the json
		const { scripts: _, ...manifest } = pkg;
		writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, '\t'));
		const out = join(work, 'out');
		mkdirSync(out);
		const packed = JSON.parse(
			execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], {
				cwd: stage,
				encoding: 'utf8'
			})
		) as Array<{ filename: string; files: Array<{ path: string }> }>;
		files = (packed[0]?.files ?? []).map((f) => f.path);
		consumer = join(work, 'consumer');
		installed = join(consumer, 'node_modules/@drupflare/spool');
		mkdirSync(installed, { recursive: true });
		execFileSync(
			'tar',
			[
				'-xzf',
				join(out, packed[0]?.filename as string),
				'-C',
				installed,
				'--strip-components=1'
			],
			{ cwd: work }
		);
	}, 120_000);

	it('holds a compiled file and a declaration file for every subpath', () => {
		for (const [subpath, target] of Object.entries(pkg.exports as Exports)) {
			if (typeof target === 'string') continue;
			expect(files, subpath).toContain(target.default.slice(2));
			expect(files, subpath).toContain(target.types.slice(2));
		}
		expect(files.some((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))).toBe(false);
		expect(files).toEqual(expect.arrayContaining(['LICENSE', 'README.md', 'package.json']));
	});

	it('imports every subpath in plain Node with the exports its source has', () => {
		const wanted = new Map<string, string[]>();
		for (const [subpath, , module] of SUBPATHS) {
			wanted.set(subpath, Object.keys(module).sort());
		}
		for (const [subpath, names] of wanted) {
			const specifier =
				subpath === '.' ? '@drupflare/spool' : `@drupflare/spool/${subpath.slice(2)}`;
			const printed = execFileSync(
				'node',
				[
					'--input-type=module',
					'-e',
					`const m = await import(${JSON.stringify(specifier)}); console.log(JSON.stringify(Object.keys(m).sort()))`
				],
				{ cwd: consumer, encoding: 'utf8' }
			);
			expect(JSON.parse(printed), subpath).toEqual(names);
		}
	});

	it('resolves the Durable Object entry to a file that defines SpoolVersions', () => {
		const resolved = execFileSync(
			'node',
			[
				'--input-type=module',
				'-e',
				"console.log(import.meta.resolve('@drupflare/spool/stores/durable-object'))"
			],
			{ cwd: consumer, encoding: 'utf8' }
		).trim();
		const file = new URL(resolved);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, 'utf8')).toContain('class SpoolVersions');
	});

	it('exposes the package version through the server entry', () => {
		const printed = execFileSync(
			'node',
			[
				'--input-type=module',
				'-e',
				"const { createSpool, defineRoute } = await import('@drupflare/spool/server'); const { memoryStore } = await import('@drupflare/spool/stores'); const spool = createSpool({ routes: [defineRoute('/a', { strategy: 'template', template: { source: '<p>{{a}}</p>' }, load: () => ({ a: 1 }) })], store: memoryStore() }); console.log(spool.config.version)"
			],
			{ cwd: consumer, encoding: 'utf8' }
		).trim();
		expect(printed).toBe(pkg.version);
	});

	it('type-checks for a Node16 consumer', () => {
		const lines = SUBPATHS.map(([subpath]) => subpath)
			.filter((subpath, i, all) => all.indexOf(subpath) === i)
			.map((subpath, i) => {
				const specifier =
					subpath === '.' ? '@drupflare/spool' : `@drupflare/spool/${subpath.slice(2)}`;
				return `import * as m${i} from '${specifier}';\nexport { m${i} };`;
			});
		writeFileSync(
			join(consumer, 'index.ts'),
			[
				...lines,
				"import { defineRoute } from '@drupflare/spool/server';",
				"export const route: string = defineRoute('/a', { strategy: 'template', template: { source: '' }, load: () => ({}) }).pattern;"
			].join('\n')
		);
		writeFileSync(
			join(consumer, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					module: 'nodenext',
					moduleResolution: 'nodenext',
					target: 'ES2022',
					lib: ['ES2022', 'DOM', 'DOM.Iterable'],
					strict: true,
					skipLibCheck: false,
					noEmit: true,
					typeRoots: [join(root, 'node_modules/@types')],
					types: ['node']
				},
				include: ['index.ts']
			})
		);
		const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', consumer], {
			cwd: consumer,
			encoding: 'utf8'
		});
		expect(result.stdout.split('\n').slice(0, 5)).toEqual(['']);
		expect(result.status).toBe(0);
	}, 60_000);
});

describe('the gate scripts', () => {
	// a vitest project no script selects reads as untested code in coverage
	const projects = [...configSource.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);

	it('finds both projects in the config', () => {
		expect(projects).toEqual(['unit', 'node']);
	});

	it.each(['test', 'test:coverage'])('%s runs every vitest project', (script) => {
		for (const name of projects) {
			expect((pkg.scripts as Record<string, string>)[script]).toContain(`--project=${name}`);
		}
	});

	it('typechecks every tsconfig', () => {
		const typecheck = (pkg.scripts as Record<string, string>)['typecheck'] as string;
		for (const config of [
			'tsconfig.json',
			'tsconfig.dom.json',
			'tests/node/tsconfig.json',
			'tests/browser/tsconfig.json',
			'scripts/tsconfig.json'
		]) {
			expect(typecheck).toContain(`-p ${config}`);
		}
	});

	it('builds both emit projects', () => {
		const build = (pkg.scripts as Record<string, string>)['build'] as string;
		expect(build).toContain('-p tsconfig.build.json');
		expect(build).toContain('-p tsconfig.build.dom.json');
	});
});
