import {
	addNitroPlugin,
	addServerHandler,
	addServerTemplate,
	addTemplate,
	defineNuxtModule,
	logger,
	resolvePath
} from '@nuxt/kit';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDevReport } from '../plugins/report.js';
import { publishStaticBuild, type StaticOption } from '../plugins/static.js';
import { PATHS } from '../protocol/config.js';
import type { Spool } from '../server/spool.js';
import { flattenPages, registerPage, type PageRegistration } from './pages.js';

export type { StaticBuildContext, StaticBuildOptions, StaticOption } from '../plugins/static.js';

/** what the module takes */
export type SpoolNuxtOptions = {
	/** a path, relative to the project, to a module whose default export is a `Spool` */
	spool: string;
	/**
	 * Publishes the static tier into Nitro's public directory (`.output/public`) when a production
	 * build runs: the page runtime, the worker script, the packs and a `_headers` rule. On by
	 * default; `false` turns it off, and an object sets `policy`, `url` or a `spool`. The build loads
	 * the `spool` module in Node, so its stores must be reachable from the build machine.
	 */
	static?: StaticOption;
};

type Jiti = {
	createJiti(
		id: string,
		options: { alias: Record<string, string>; moduleCache: boolean; interopDefault: boolean }
	): { import(id: string, options: { default: boolean }): Promise<unknown> };
};

/**
 * Loads the `spool` module the way Nitro will, in the build process. `#spool/pages` is a Nitro
 * virtual module, so it is written to the build directory for the load; the project's aliases carry over.
 */
async function loadSpool(
	entry: string,
	rootDir: string,
	buildDir: string,
	aliases: Record<string, string>,
	pages: PageRegistration[]
): Promise<Spool> {
	const file = join(buildDir, 'spool', 'pages.mjs');
	await mkdir(join(buildDir, 'spool'), { recursive: true });
	await writeFile(file, `export const pages = ${JSON.stringify(pages)};\n`);
	const jiti = createRequire(join(rootDir, 'package.json'))('jiti') as Jiti;
	const loaded = await jiti
		.createJiti(entry, {
			alias: { ...aliases, '#spool/pages': file },
			moduleCache: false,
			interopDefault: true
		})
		.import(entry, { default: true });
	const spool = loaded as Partial<Spool> | undefined;
	if (typeof spool?.publishStatic !== 'function') {
		throw new Error(`${entry} has no default export that is a Spool`);
	}
	return spool as Spool;
}

/**
 * A Nuxt module that serves spool from the Nitro server. It exposes the page registrations as
 * `#spool/pages`, serves `/spool-sw.js` and `/.spool/**` from the `spool` module, and adds the page
 * runtime tag to server-rendered HTML. The `spool` module imports `#spool/pages` to declare its routes.
 * A production build also publishes the static tier into Nitro's public directory (see `static`).
 */
export default defineNuxtModule<SpoolNuxtOptions>({
	meta: { name: '@drupflare/spool/nuxt', configKey: 'spool' },
	defaults: { spool: '' },
	async setup(options, nuxt) {
		if (!options.spool) {
			throw new Error(
				'the spool option is required: a path to a module that exports a Spool'
			);
		}
		const entry = await resolvePath(options.spool, { cwd: nuxt.options.rootDir });
		const runtime = fileURLToPath(new URL('./runtime/index.js', import.meta.url));
		let pages: PageRegistration[] = [];

		nuxt.hook('pages:resolved', (resolved) => {
			pages = flattenPages(resolved).map(registerPage);
			if (!nuxt.options.dev) return;
			logger.info(
				formatDevReport({
					registered: pages.flatMap((page) =>
						page.pattern && page.register !== 'network'
							? [
									{
										pattern: page.pattern,
										register: page.register,
										maxAge: page.maxAge
									}
								]
							: []
					),
					network: pages
						.filter((page) => page.register === 'network')
						.map((page) => ({ path: page.path, reason: page.reason })),
					uncovered: []
				})
			);
		});

		nuxt.hook('nitro:build:public-assets', async (nitro) => {
			if (nuxt.options.dev || options.static === false) return;
			await publishStaticBuild({
				spool: await loadSpool(
					entry,
					nuxt.options.rootDir,
					nuxt.options.buildDir,
					nuxt.options.alias,
					pages
				),
				option: options.static,
				outDir: nitro.options.output.publicDir,
				log: (line) => logger.info(line)
			});
		});

		addServerTemplate({
			filename: '#spool/entry',
			getContents: () => `export { default } from ${JSON.stringify(entry)};\n`
		});
		addServerTemplate({
			filename: '#spool/pages',
			getContents: () => `export const pages = ${JSON.stringify(pages)};\n`
		});
		addServerTemplate({
			filename: '#spool/handler',
			getContents: () =>
				`import spool from '#spool/entry';\n` +
				`import { spoolHandler } from ${JSON.stringify(runtime)};\n` +
				`export default spoolHandler(spool);\n`
		});
		// a Nitro plugin is a file path, so the plugin is written to the build directory
		const plugin = addTemplate({
			filename: 'spool/plugin.mjs',
			write: true,
			getContents: () =>
				`import spool from '#spool/entry';\n` +
				`import { spoolPlugin } from ${JSON.stringify(runtime)};\n` +
				`export default spoolPlugin(spool);\n`
		});

		addServerHandler({ route: PATHS.worker, handler: '#spool/handler' });
		addServerHandler({ route: '/.spool/**', handler: '#spool/handler' });
		addNitroPlugin(plugin.dst);
	}
});
