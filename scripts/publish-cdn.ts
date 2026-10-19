import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CDN_ORIGIN, CDN_PREFIX, releasePrefix } from '../src/cdn/location';
import { VERSION } from '../src/version';
import { CDN_FILES, manifestFor, type CdnManifest } from './cdn-manifest';

export const BUCKET = 'drupflare-cdn';

export const RELEASE_CACHE = 'public, max-age=31536000, immutable';
export const DEV_CACHE = 'public, max-age=300';

export type Kind = 'release' | 'dev';

export type Put = { key: string; file: string; contentType: string; cacheControl: string };

const FILES = [
	{ name: 'client.js', contentType: 'text/javascript; charset=utf-8' },
	{ name: 'spool-sw.js', contentType: 'text/javascript; charset=utf-8' },
	{ name: 'manifest.json', contentType: 'application/json' }
] as const;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** a branch name as it appears in a key; `/` is flattened so `feat/x` is `dev-feat-x` */
export function devLabel(branch: string): string {
	const clean = branch
		.trim()
		.replace(/^refs\/heads\//, '')
		.replace(/[^A-Za-z0-9._/-]/g, '-')
		.replace(/\//g, '-')
		.replace(/^-+|-+$/g, '');
	return `dev-${clean === '' ? 'unknown' : clean}`;
}

/** the key prefix a publish writes under: `spool/<version>` or `spool/dev-<branch>` */
export function prefixFor(kind: Kind, label: string): string {
	if (kind === 'dev') return `${CDN_PREFIX}/${devLabel(label)}`;
	if (!SEMVER.test(label)) throw new Error(`"${label}" is not a release version`);
	return releasePrefix(label);
}

/** the uploads for a build in `dist`, keyed under `prefix`; a release is immutable, a dev key is not */
export function plan(kind: Kind, prefix: string, dist: string): Put[] {
	return FILES.map(({ name, contentType }) => ({
		key: `${prefix}/${name}`,
		file: join(dist, name),
		contentType,
		cacheControl: kind === 'release' ? RELEASE_CACHE : DEV_CACHE
	}));
}

/** the `bunx` arguments for one put */
export function wranglerArgs(put: Put): string[] {
	return [
		'wrangler',
		'r2',
		'object',
		'put',
		`${BUCKET}/${put.key}`,
		`--file=${put.file}`,
		`--content-type=${put.contentType}`,
		`--cache-control=${put.cacheControl}`,
		'--remote'
	];
}

/**
 * Reads `dist` and checks `manifest.json` against the built files, and for a release against the
 * version the package declares. Throws before anything is uploaded.
 */
export function checkDist(kind: Kind, dist: string, version: string): CdnManifest {
	const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as CdnManifest;
	const built = {
		'client.js': readFileSync(join(dist, 'client.js')),
		'spool-sw.js': readFileSync(join(dist, 'spool-sw.js'))
	};
	const expected = manifestFor(built, manifest.version);
	if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
		throw new Error('manifest.json does not describe the built files; run: bun run build:cdn');
	}
	if (kind === 'release' && manifest.version !== version) {
		throw new Error(`dist was built for ${manifest.version}, the package is ${version}`);
	}
	return manifest;
}

/** whether the public host already serves `key`; anything but 200 or 404 is an error */
export async function remoteExists(key: string, fetcher: typeof fetch = fetch): Promise<boolean> {
	const response = await fetcher(`${CDN_ORIGIN}/${key}?probe=${Date.now()}`, {
		method: 'HEAD',
		headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }
	});
	if (response.status === 200) return true;
	if (response.status === 404) return false;
	throw new Error(`${key}: could not tell whether it exists (HTTP ${response.status})`);
}

/** whether the public host serves exactly the bytes of `put.file` under `put.key` */
export async function remoteSame(put: Put, fetcher: typeof fetch = fetch): Promise<boolean> {
	const response = await fetcher(`${CDN_ORIGIN}/${put.key}?probe=${Date.now()}`, {
		headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' }
	});
	if (response.status !== 200) {
		throw new Error(`${put.key}: could not read it back (HTTP ${response.status})`);
	}
	return Buffer.from(await response.arrayBuffer()).equals(readFileSync(put.file));
}

export type PublishOptions = {
	kind: Kind;
	dryRun: boolean;
	exists: (key: string) => Promise<boolean>;
	/** whether the published `put.key` holds the same bytes as `put.file` */
	same: (put: Put) => Promise<boolean>;
	run: (args: string[]) => void;
	log: (line: string) => void;
};

/**
 * Uploads the plan. A release key that already holds other bytes is refused, every key checked
 * before the first upload, so a re-run never half-replaces a published version. A key that holds
 * the same bytes is left as it is, so a run that uploaded and then failed its read-back can be
 * re-run.
 * ponytail: check then put is not atomic; two concurrent releases of one version could race.
 */
export async function publish(puts: readonly Put[], options: PublishOptions): Promise<void> {
	const published = new Set<string>();
	if (options.kind === 'release' && !options.dryRun) {
		for (const put of puts) {
			if (!(await options.exists(put.key))) continue;
			if (!(await options.same(put))) {
				throw new Error(
					`${put.key} exists with other bytes; release keys are immutable and are never overwritten`
				);
			}
			published.add(put.key);
		}
	}
	for (const put of puts) {
		if (published.has(put.key)) {
			options.log(`kept ${BUCKET}/${put.key}, already published with the same bytes`);
			continue;
		}
		const args = wranglerArgs(put);
		if (options.dryRun) {
			options.log(
				`would run: bunx ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`
			);
			continue;
		}
		options.run(args);
		options.log(`put ${BUCKET}/${put.key}`);
	}
}

/**
 * Reads each built file back over the public host with an `Origin` header and checks the bytes
 * against the manifest. `client.js` is also checked for the cross-origin answer an SRI tag needs;
 * `spool-sw.js` reaches a site through `importScripts`, which needs none.
 */
export async function verifyRemote(
	prefix: string,
	manifest: CdnManifest,
	fetcher: typeof fetch = fetch
): Promise<{ bytes: number; cors: string }> {
	let cors = '';
	let bytes = 0;
	for (const name of CDN_FILES) {
		const url = `${CDN_ORIGIN}/${prefix}/${name}?probe=${Date.now()}`;
		const response = await fetcher(url, {
			headers: {
				origin: 'https://verify.example',
				'accept-encoding': 'identity',
				'cache-control': 'no-cache'
			}
		});
		if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
		const body = new Uint8Array(await response.arrayBuffer());
		const sha384 = createHash('sha384').update(body).digest('hex');
		const file = manifest.files[name];
		if (body.byteLength !== file.bytes || sha384 !== file.sha384) {
			throw new Error(`${url}: the served bytes do not match the manifest`);
		}
		bytes += body.byteLength;
		if (name !== 'client.js') continue;
		cors = response.headers.get('access-control-allow-origin') ?? '';
		if (cors !== '*' && cors !== 'https://verify.example') {
			throw new Error(
				`${url}: no Access-Control-Allow-Origin, so an SRI script tag would fail`
			);
		}
	}
	return { bytes, cors };
}

/** the job summary for a publish: where the files are served and the hashes a site pins */
export function summaryFor(kind: Kind, prefix: string, manifest: CdnManifest): string {
	return [
		`## CDN files (${kind})`,
		'',
		...CDN_FILES.flatMap((name) => [
			`- ${name}: \`${CDN_ORIGIN}/${prefix}/${name}\``,
			`  - Integrity: \`${manifest.files[name].integrity}\``,
			`  - Bytes: ${manifest.files[name].bytes}`
		]),
		`- Cache: \`${kind === 'release' ? RELEASE_CACHE : DEV_CACHE}\``,
		''
	].join('\n');
}

const flag = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
	if (flag('release') === flag('dev')) throw new Error('pass --release or --dev');
	const kind: Kind = flag('dev') ? 'dev' : 'release';
	const root = join(import.meta.dirname, '..');
	const dist = arg('dist') ?? join(root, 'dist/cdn');
	const label =
		kind === 'release'
			? VERSION
			: (arg('branch') ??
				process.env['GITHUB_REF_NAME'] ??
				// symbolic-ref also answers before the first commit, where rev-parse fails
				execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
					cwd: root,
					encoding: 'utf8'
				}).trim());
	const prefix = prefixFor(kind, label);
	const manifest = checkDist(kind, dist, VERSION);
	console.log(`publishing ${dist} -> ${BUCKET}/${prefix}`);
	await publish(plan(kind, prefix, dist), {
		kind,
		dryRun: flag('dry-run'),
		exists: remoteExists,
		same: remoteSame,
		run: (args) => void execFileSync('bunx', args, { cwd: root, stdio: 'inherit' }),
		log: console.log
	});
	if (flag('verify') && !flag('dry-run')) {
		const read = await verifyRemote(prefix, manifest);
		console.log(`verified ${read.bytes} bytes, sha384 match, CORS ${read.cors}`);
	}
	const summary = arg('summary');
	if (summary && !flag('dry-run')) appendFileSync(summary, summaryFor(kind, prefix, manifest));
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
