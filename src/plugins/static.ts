import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileStaticSink } from '../node/listener.js';
import type { Spool } from '../server/spool.js';
import type { StaticSink } from '../server/static.js';
import { POLICY_HEADERS } from '../sw/policy.js';

/** what a build gives the `static` option of a plugin */
export type StaticBuildContext = {
	/** the public directory the build wrote, where the static tier goes */
	outDir: string;
};

/** the `static` option of a plugin that publishes the static tier at build time */
export type StaticBuildOptions = {
	/**
	 * The instance to publish from, or a function that makes it from the build output. Default: the
	 * `spool` the plugin was given. A single-page app passes a function when its shell routes must
	 * hold the built `index.html`, because the instance made at config time holds the dev one.
	 */
	spool?: Spool | ((context: StaticBuildContext) => Spool | Promise<Spool>);
	/**
	 * The site's security headers the worker replays on pages it renders locally; `{}` says the site
	 * sends none. Default: the `policy` option of the spool, the headers of a page it answered, then
	 * the `/*` block of the `_headers` file in the public directory. With none of them the stub
	 * names no policy, and a device makes one network view to learn it.
	 */
	policy?: Record<string, string>;
	/** the origin the seed functions of the datasets receive; default `http://localhost/` */
	url?: string | URL;
};

/** `false` turns the build step off, `true` or absent publishes with the defaults */
export type StaticOption = boolean | StaticBuildOptions;

type Block = { path: string; lines: string[] };

const isIndented = (line: string) => /^\s+\S/.test(line);
const isPathLine = (line: string) =>
	line.trim() !== '' && !isIndented(line) && !line.startsWith('#');

/** the blocks of a `_headers` file: a path line and the indented lines under it */
function blocksOf(text: string): Block[] {
	const blocks: Block[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (isPathLine(line)) blocks.push({ path: line.trim(), lines: [] });
		else if (isIndented(line)) blocks.at(-1)?.lines.push(line.trim());
	}
	return blocks;
}

/**
 * The policy headers of the `/*` block of a `_headers` file, or undefined when it names none. A
 * block that sends other headers says nothing about the policy, so it is not an empty policy.
 */
export function policyFromHeadersFile(text: string): Record<string, string> | undefined {
	const names: readonly string[] = POLICY_HEADERS;
	const out: Record<string, string> = {};
	for (const block of blocksOf(text)) {
		if (block.path !== '/*') continue;
		for (const line of block.lines) {
			const at = line.indexOf(':');
			if (at < 1) continue;
			const name = line.slice(0, at).trim().toLowerCase();
			if (!names.includes(name)) continue;
			const value = line.slice(at + 1).trim();
			out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const OURS = new Set(['/.spool/*', '/spool-sw.js']);

/** `existing` with the blocks spool wrote before taken out, every other line kept as it was */
function withoutSpoolBlocks(existing: string): string {
	const kept: string[] = [];
	let skipping = false;
	for (const line of existing.split(/\r?\n/)) {
		if (isPathLine(line)) skipping = OURS.has(line.trim());
		else if (skipping && (isIndented(line) || line.trim() === '')) continue;
		else skipping = false;
		if (!skipping) kept.push(line);
	}
	return kept.join('\n').trimEnd();
}

/** a sink for a directory whose `_headers` file the site may already own: spool's blocks are added to it */
function mergingSink(outDir: string): StaticSink {
	const files = fileStaticSink(outDir);
	return {
		has: (path) => files.has?.(path) ?? false,
		async put(path, bytes, contentType) {
			if (path !== '/_headers') return files.put(path, bytes, contentType);
			const existing = await readFile(join(outDir, path), 'utf8').catch(() => '');
			const site = withoutSpoolBlocks(existing);
			const ours = new TextDecoder().decode(bytes);
			await writeFile(join(outDir, path), site === '' ? ours : `${site}\n\n${ours}`);
		}
	};
}

/**
 * Publishes the static tier into `outDir` at the end of a build and logs one line. A failure
 * rejects, so the build fails with the library's error; a build that hid a missing tier would ship a
 * site that is slower than it looks. Does nothing when `option` is `false`.
 */
export async function publishStaticBuild(input: {
	spool: Spool;
	option: StaticOption | undefined;
	outDir: string;
	log: (line: string) => void;
}): Promise<void> {
	const { option, outDir, log } = input;
	if (option === false) return;
	const settings = typeof option === 'object' ? option : {};
	const spool =
		typeof settings.spool === 'function'
			? await settings.spool({ outDir })
			: (settings.spool ?? input.spool);
	const headersFile = await readFile(join(outDir, '_headers'), 'utf8').catch(() => undefined);
	const fallbackPolicy =
		headersFile === undefined ? undefined : policyFromHeadersFile(headersFile);
	const { paths, policy } = await spool.publishStatic(mergingSink(outDir), {
		url: new URL(settings.url ?? 'http://localhost/'),
		...(settings.policy ? { policy: settings.policy } : {}),
		...(fallbackPolicy ? { fallbackPolicy } : {})
	});
	log(`spool: wrote ${paths.length} static files to ${outDir}`);
	if (policy === 'none') {
		log(
			'spool: no site policy found, so the stub names none and a device makes one network view to learn it; set static.policy to name it'
		);
	}
}
