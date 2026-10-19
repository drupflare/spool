import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestFor, type CdnFileName } from '../../scripts/cdn-manifest';
import {
	checkDist,
	DEV_CACHE,
	devLabel,
	plan,
	prefixFor,
	publish,
	RELEASE_CACHE,
	remoteExists,
	remoteSame,
	summaryFor,
	verifyRemote,
	wranglerArgs,
	type Put
} from '../../scripts/publish-cdn';
import { cdnClientUrl, releasePrefix } from '../../src/cdn/location';
import { CLIENT_CORE, SW_CORE } from '../../src/server/embedded';
import { VERSION } from '../../src/version';

const root = join(import.meta.dirname, '../..');
const bytes = new TextEncoder().encode('console.log(1)');
const worker = new TextEncoder().encode('self.x=1');
const built = { 'client.js': bytes, 'spool-sw.js': worker };

function dist(version = '1.2.3', tamper = false): string {
	const dir = mkdtempSync(join(tmpdir(), 'spool-cdn-'));
	writeFileSync(join(dir, 'client.js'), bytes);
	writeFileSync(join(dir, 'spool-sw.js'), worker);
	const manifest = manifestFor(built, version);
	if (tamper) manifest.files['spool-sw.js'].bytes += 1;
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
	return dir;
}

function options(
	kind: 'release' | 'dev',
	existing: string[] = [],
	dryRun = false,
	identical: string[] = []
) {
	const calls = { exists: [] as string[], run: [] as string[][], log: [] as string[] };
	return {
		calls,
		options: {
			kind,
			dryRun,
			exists: async (key: string) => {
				calls.exists.push(key);
				return existing.includes(key);
			},
			same: async (put: Put) => identical.includes(put.key),
			run: (args: string[]) => void calls.run.push(args),
			log: (line: string) => void calls.log.push(line)
		}
	};
}

describe('CDN locations', () => {
	it('puts a release at spool/<version> on cdn.drupflare.com', () => {
		expect(releasePrefix('1.2.3')).toBe('spool/1.2.3');
		expect(cdnClientUrl('1.2.3')).toBe('https://cdn.drupflare.com/spool/1.2.3/client.js');
	});

	it('builds keys for a release and a branch', () => {
		expect(prefixFor('release', '1.2.3')).toBe('spool/1.2.3');
		expect(prefixFor('release', '1.0.0-rc.1')).toBe('spool/1.0.0-rc.1');
		expect(prefixFor('dev', 'feat/cdn')).toBe('spool/dev-feat-cdn');
		expect(prefixFor('dev', 'refs/heads/ver/1.1')).toBe('spool/dev-ver-1.1');
		expect(devLabel('  ')).toBe('dev-unknown');
		expect(devLabel('a b?c')).toBe('dev-a-b-c');
	});

	it('refuses a release label that is not a version', () => {
		for (const label of ['', 'v1.2.3', '1.2', '../x', '1.2.3/evil', 'dev-main']) {
			expect(() => prefixFor('release', label)).toThrow(/not a release version/);
		}
	});

	it('never lets a branch name land in a release prefix', () => {
		expect(prefixFor('dev', '1.2.3')).toBe('spool/dev-1.2.3');
	});
});

describe('the upload plan', () => {
	it('makes release keys immutable and dev keys five minutes', () => {
		const release = plan('release', 'spool/1.2.3', '/d');
		expect(release.map((p) => p.key)).toEqual([
			'spool/1.2.3/client.js',
			'spool/1.2.3/spool-sw.js',
			'spool/1.2.3/manifest.json'
		]);
		expect(release.every((p) => p.cacheControl === RELEASE_CACHE)).toBe(true);
		expect(RELEASE_CACHE).toBe('public, max-age=31536000, immutable');
		const dev = plan('dev', 'spool/dev-x', '/d');
		expect(dev.every((p) => p.cacheControl === DEV_CACHE)).toBe(true);
		expect(DEV_CACHE).toBe('public, max-age=300');
		expect(release.map((p) => p.contentType)).toEqual([
			'text/javascript; charset=utf-8',
			'text/javascript; charset=utf-8',
			'application/json'
		]);
	});

	it('writes the wrangler put with type, cache and --remote', () => {
		const [put] = plan('release', 'spool/1.2.3', '/d');
		expect(wranglerArgs(put!)).toEqual([
			'wrangler',
			'r2',
			'object',
			'put',
			'drupflare-cdn/spool/1.2.3/client.js',
			'--file=/d/client.js',
			'--content-type=text/javascript; charset=utf-8',
			`--cache-control=${RELEASE_CACHE}`,
			'--remote'
		]);
	});
});

describe('the manifest', () => {
	it('records bytes, hex sha384, and the SRI string for the same digest, per file', () => {
		const manifest = manifestFor(built, '1.2.3');
		const digest = createHash('sha384').update(bytes).digest();
		const swDigest = createHash('sha384').update(worker).digest();
		expect(manifest).toEqual({
			schema: 2,
			version: '1.2.3',
			files: {
				'client.js': {
					bytes: bytes.byteLength,
					sha384: digest.toString('hex'),
					integrity: `sha384-${digest.toString('base64')}`
				},
				'spool-sw.js': {
					bytes: worker.byteLength,
					sha384: swDigest.toString('hex'),
					integrity: `sha384-${swDigest.toString('base64')}`
				}
			}
		});
	});

	it('is checked against the file before an upload', () => {
		expect(checkDist('release', dist(), '1.2.3').version).toBe('1.2.3');
		expect(() => checkDist('release', dist('1.2.3', true), '1.2.3')).toThrow(
			/does not describe the built files/
		);
		expect(() => checkDist('release', dist('1.2.4'), '1.2.3')).toThrow(/built for 1.2.4/);
		expect(checkDist('dev', dist('1.2.4'), '1.2.3').version).toBe('1.2.4');
	});

	it('is what bun run build:cdn writes for the embedded page runtime and worker', () => {
		const out = mkdtempSync(join(tmpdir(), 'spool-build-'));
		execFileSync('bun', ['scripts/build-cdn.ts', `--out=${out}`], { cwd: root });
		const file = readFileSync(join(out, 'client.js'));
		const sw = readFileSync(join(out, 'spool-sw.js'));
		expect(file.toString('utf8')).toBe(CLIENT_CORE);
		expect(sw.toString('utf8')).toBe(SW_CORE);
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
		expect(manifest).toEqual(manifestFor({ 'client.js': file, 'spool-sw.js': sw }, VERSION));
		expect(manifest.files['client.js'].sha384).toBe(
			createHash('sha384').update(file).digest('hex')
		);
	});
});

describe('the job summary', () => {
	it('names the served URL, the integrity hash and the cache policy', () => {
		const manifest = manifestFor(built, '1.2.3');
		const text = summaryFor('release', 'spool/1.2.3', manifest);
		expect(text).toContain('`https://cdn.drupflare.com/spool/1.2.3/client.js`');
		expect(text).toContain('`https://cdn.drupflare.com/spool/1.2.3/spool-sw.js`');
		expect(text).toContain(`\`${manifest.files['client.js'].integrity}\``);
		expect(text).toContain(`\`${manifest.files['spool-sw.js'].integrity}\``);
		expect(text).toContain(RELEASE_CACHE);
		expect(summaryFor('dev', 'spool/dev-x', manifest)).toContain(DEV_CACHE);
	});
});

describe('publishing', () => {
	const puts = plan('release', 'spool/1.2.3', '/d');

	it('refuses a release when any key holds other bytes, before it uploads anything', async () => {
		for (const existing of [
			['spool/1.2.3/client.js'],
			['spool/1.2.3/spool-sw.js'],
			['spool/1.2.3/manifest.json']
		]) {
			const { calls, options: opts } = options('release', existing);
			await expect(publish(puts, opts)).rejects.toThrow(
				/other bytes; release keys are immutable and are never overwritten/
			);
			expect(calls.run).toEqual([]);
		}
	});

	it('keeps keys that already hold the same bytes, so a failed read-back can be re-run', async () => {
		const done = ['spool/1.2.3/client.js', 'spool/1.2.3/spool-sw.js'];
		const { calls, options: opts } = options('release', done, false, done);
		await publish(puts, opts);
		expect(calls.run.map((a) => a[4])).toEqual(['drupflare-cdn/spool/1.2.3/manifest.json']);
		expect(calls.log.filter((line) => line.startsWith('kept'))).toHaveLength(2);
	});

	it('refuses the whole release when one existing key differs, even beside identical ones', async () => {
		const existing = ['spool/1.2.3/client.js', 'spool/1.2.3/spool-sw.js'];
		const { calls, options: opts } = options('release', existing, false, [
			'spool/1.2.3/client.js'
		]);
		await expect(publish(puts, opts)).rejects.toThrow(/spool-sw\.js exists with other bytes/);
		expect(calls.run).toEqual([]);
	});

	it('uploads a new release in order, client first', async () => {
		const { calls, options: opts } = options('release');
		await publish(puts, opts);
		expect(calls.exists).toEqual([
			'spool/1.2.3/client.js',
			'spool/1.2.3/spool-sw.js',
			'spool/1.2.3/manifest.json'
		]);
		expect(calls.run.map((a) => a[4])).toEqual([
			'drupflare-cdn/spool/1.2.3/client.js',
			'drupflare-cdn/spool/1.2.3/spool-sw.js',
			'drupflare-cdn/spool/1.2.3/manifest.json'
		]);
	});

	it('overwrites dev keys without asking the bucket', async () => {
		const { calls, options: opts } = options('dev', ['spool/dev-x/client.js']);
		await publish(plan('dev', 'spool/dev-x', '/d'), opts);
		expect(calls.exists).toEqual([]);
		expect(calls.run).toHaveLength(3);
	});

	it('prints the commands on --dry-run and runs nothing', async () => {
		const { calls, options: opts } = options('release', [], true);
		await publish(puts, opts);
		expect(calls.run).toEqual([]);
		expect(calls.exists).toEqual([]);
		expect(calls.log).toHaveLength(3);
		expect(calls.log[0]).toContain(
			'bunx wrangler r2 object put drupflare-cdn/spool/1.2.3/client.js'
		);
		expect(calls.log[0]).toContain(`"--cache-control=${RELEASE_CACHE}"`);
	});
});

describe('reading the public host', () => {
	const reply = (status: number, body = '', headers: Record<string, string> = {}) =>
		(async () => new Response(body, { status, headers })) as typeof fetch;

	it('tells a present key from a missing one and fails closed on anything else', async () => {
		expect(await remoteExists('spool/1.2.3/client.js', reply(200))).toBe(true);
		expect(await remoteExists('spool/1.2.3/client.js', reply(404))).toBe(false);
		await expect(remoteExists('spool/1.2.3/client.js', reply(503))).rejects.toThrow(/HTTP 503/);
		const failing = (async () => {
			throw new Error('offline');
		}) as typeof fetch;
		await expect(remoteExists('spool/1.2.3/client.js', failing)).rejects.toThrow(/offline/);
	});

	it('compares a published key with the local file byte for byte', async () => {
		const [put] = plan('release', 'spool/1.2.3', dist()) as [Put];
		const body = readFileSync(put.file);
		expect(await remoteSame(put, reply(200, body.toString()))).toBe(true);
		expect(await remoteSame(put, reply(200, `${body.toString()};`))).toBe(false);
		await expect(remoteSame(put, reply(404))).rejects.toThrow(/HTTP 404/);
	});

	it('verifies bytes, digest and the CORS header of the page runtime', async () => {
		const manifest = manifestFor(built, '1.2.3');
		const texts: Record<string, string> = {
			'client.js': new TextDecoder().decode(bytes),
			'spool-sw.js': new TextDecoder().decode(worker)
		};
		const serve = (over: Record<string, string> = {}, cors: Record<string, string> = {}) =>
			(async (url: string) => {
				const name = new URL(url).pathname.split('/').pop() as CdnFileName;
				return new Response(over[name] ?? texts[name], {
					headers: name === 'client.js' ? cors : {}
				});
			}) as unknown as typeof fetch;
		const open = { 'access-control-allow-origin': '*' };
		const ok = await verifyRemote('spool/1.2.3', manifest, serve({}, open));
		expect(ok).toEqual({ bytes: bytes.byteLength + worker.byteLength, cors: '*' });
		await expect(
			verifyRemote('spool/1.2.3', manifest, serve({ 'client.js': 'console.log(2)' }, open))
		).rejects.toThrow(/do not match the manifest/);
		await expect(
			verifyRemote('spool/1.2.3', manifest, serve({ 'spool-sw.js': 'self.x=2' }, open))
		).rejects.toThrow(/spool-sw.js.*do not match the manifest/);
		await expect(verifyRemote('spool/1.2.3', manifest, serve())).rejects.toThrow(
			/Access-Control-Allow-Origin/
		);
		await expect(verifyRemote('spool/1.2.3', manifest, reply(404))).rejects.toThrow(/HTTP 404/);
	});
});
