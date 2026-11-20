import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { build as viteBuild, type ResolvedConfig, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { policyFromHeadersFile } from '../../src/plugins/static';
import {
	BUNDLE_PREFIX,
	clientPath,
	defineRoute,
	navigatePath,
	PATHS,
	ProtocolError
} from '../../src/protocol/index';
import { createSpool, memoryBundleStore } from '../../src/server/index';
import { memoryStore } from '../../src/stores/index';
import { VERSION } from '../../src/version';
import { spoolVite, type SpoolViteOptions } from '../../src/vite/index';

class Reply extends Writable {
	statusCode = 200;
	body = '';

	setHeader(): this {
		return this;
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		done: (error?: Error | null) => void
	): void {
		this.body += chunk.toString();
		done();
	}
}

function request(url: string): IncomingMessage {
	return Object.assign(Readable.from([]), {
		method: 'GET',
		url,
		headers: { host: 'localhost' },
		socket: {}
	}) as unknown as IncomingMessage;
}

function setup() {
	const spool = createSpool({ routes: [], store: memoryStore() });
	const plugin = spoolVite({ spool });
	const uses: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => unknown> =
		[];
	const server = {
		middlewares: { use: (handler: never) => uses.push(handler) }
	} as unknown as ViteDevServer;
	(plugin.configureServer as (server: ViteDevServer) => void)(server);
	const transform = plugin.transformIndexHtml as (html: string) => string;
	return { spool, plugin, handler: uses[0]!, transform };
}

describe('spoolVite', () => {
	it('adds the page tag in serve and leaves a built page alone', () => {
		const { plugin, transform } = setup();
		const html = '<html><head></head><body></body></html>';
		plugin.configResolved({ command: 'serve' } as ResolvedConfig);
		expect(transform(html)).not.toBe(html);
		plugin.configResolved({ command: 'build' } as ResolvedConfig);
		expect(transform(html)).toBe(html);
	});

	it('injects the registration tag once, however often the page is transformed', () => {
		const { spool, transform } = setup();
		const once = transform('<html><head></head><body></body></html>');
		expect(once.split('data-spool-gate').length - 1).toBe(1);
		expect(once).toContain(spool.config.clientTag);
		expect(transform(once)).toBe(once);
	});

	it('answers the worker script with the spool stub', async () => {
		const { spool, handler } = setup();
		const reply = new Reply();
		const next = vi.fn();
		await handler(request('/spool-sw.js'), reply as unknown as ServerResponse, next);
		expect(next).not.toHaveBeenCalled();
		expect(reply.statusCode).toBe(200);
		expect(reply.body).toBe(await spool.stub().text());
	});

	it('answers a spool path through the spool instance', async () => {
		const { handler } = setup();
		const reply = new Reply();
		const next = vi.fn();
		await handler(request('/.spool/sync?from=0'), reply as unknown as ServerResponse, next);
		expect(next).not.toHaveBeenCalled();
		expect(reply.statusCode).toBe(200);
	});

	it('logs a fetch GET no data family covers once, and passes every request on', () => {
		const spool = createSpool({ routes: [], store: memoryStore() });
		const plugin = spoolVite({ spool });
		const uses: Array<
			(req: IncomingMessage, res: ServerResponse, next: () => void) => unknown
		> = [];
		const info = vi.fn();
		const server = {
			config: { logger: { info } },
			middlewares: { use: (handler: never) => uses.push(handler) }
		} as unknown as ViteDevServer;
		(plugin.configureServer as (server: ViteDevServer) => void)(server);
		const next = vi.fn();
		const seen = (url: string, dest: string) =>
			uses[1]?.(
				{
					method: 'GET',
					url,
					headers: { host: 'localhost', 'sec-fetch-dest': dest }
				} as never,
				{} as ServerResponse,
				next
			);
		seen('/api/x?a=1', 'empty');
		seen('/api/x?a=1', 'empty');
		seen('/', 'document');
		expect(info.mock.calls).toEqual([['spool: uncovered GET /api/x?a=1']]);
		expect(next).toHaveBeenCalledTimes(3);
	});

	it('passes a request that is not spool to the next middleware untouched', async () => {
		const { handler } = setup();
		const reply = new Reply();
		const next = vi.fn();
		await handler(request('/about'), reply as unknown as ServerResponse, next);
		expect(next).toHaveBeenCalledOnce();
		expect(reply.writableEnded).toBe(false);
		expect(reply.body).toBe('');
	});
});

const ORIGIN = new URL('https://example.test/');
const CSP = "default-src 'self'";
const SITE_HEADERS = `# the site's own rules\n/*\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n\n/admin/*\n  X-Robots-Tag: noindex\n`;

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'spool-vite-'));
	roots.push(root);
	await mkdir(join(root, 'dist'));
	return root;
}

function shellSpool(options: { policy?: Record<string, string> } = {}) {
	return createSpool({
		routes: [
			defineRoute('/p/:id', {
				strategy: 'template',
				template: { source: '<html><head></head><body>{{row.title}}</body></html>' },
				load: () => ({ row: { title: 'x' } })
			})
		],
		store: memoryStore(),
		bundles: memoryBundleStore(),
		...options
	});
}

/** runs a client build of the plugin against a temporary project; returns what it logged */
async function build(
	root: string,
	options: Partial<SpoolViteOptions> = {},
	config: Record<string, unknown> = {},
	environment?: { config: { consumer: string; build: { outDir: string } } }
) {
	const info = vi.fn();
	const plugin = spoolVite({ spool: shellSpool(), ...options });
	plugin.configResolved({
		command: 'build',
		root,
		build: { outDir: 'dist', ssr: false },
		logger: { info },
		...config
	} as unknown as ResolvedConfig);
	await (plugin.closeBundle as (this: unknown) => Promise<void>).call({ environment });
	return { info, lines: info.mock.calls.map((call) => String(call[0])) };
}

const stubConfig = (text: string) =>
	JSON.parse(/self\.__SPOOL_CONFIG__=(.*?);\n/s.exec(text)![1]!) as {
		policy?: Array<[string, string]>;
	};
const stubOf = (root: string) => readFile(join(root, 'dist', 'spool-sw.js'), 'utf8');
const exists = (path: string) =>
	readFile(path).then(
		() => true,
		() => false
	);

describe('spoolVite in a client build', () => {
	it('writes the stub, the runtime, a pack and the headers into the output directory', async () => {
		const root = await outDir();
		const { lines } = await build(root);
		const dist = join(root, 'dist');
		for (const path of [
			clientPath(VERSION),
			navigatePath(VERSION),
			PATHS.worker,
			`${BUNDLE_PREFIX}0`,
			'/_headers'
		]) {
			expect(await exists(join(dist, path)), path).toBe(true);
		}
		expect(lines[0]).toMatch(/^spool: wrote \d+ static files to .*dist$/);
	});

	it('writes nothing with static: false', async () => {
		const root = await outDir();
		const { info } = await build(root, { static: false });
		expect(await readdir(join(root, 'dist'))).toEqual([]);
		expect(info).not.toHaveBeenCalled();
	});

	it('publishes a stub with no policy field and logs one line naming static.policy', async () => {
		const root = await outDir();
		const { lines } = await build(root);
		expect(Object.hasOwn(stubConfig(await stubOf(root)), 'policy')).toBe(false);
		expect(lines.filter((line) => line.includes('static.policy'))).toHaveLength(1);
	});

	it('carries an explicit static.policy into the stub and logs no warning', async () => {
		const root = await outDir();
		const { lines } = await build(root, {
			static: { policy: { 'content-security-policy': CSP } }
		});
		expect(stubConfig(await stubOf(root)).policy).toEqual([['content-security-policy', CSP]]);
		expect(lines.some((line) => line.includes('static.policy'))).toBe(false);
	});

	it('publishes an explicit empty policy as a known-empty one', async () => {
		const root = await outDir();
		await build(root, { static: { policy: {} } });
		expect(stubConfig(await stubOf(root)).policy).toEqual([]);
	});

	it('uses the policy of a page the instance already answered', async () => {
		const root = await outDir();
		const spool = shellSpool();
		await spool.handle(
			new Request(ORIGIN),
			() =>
				new Response('<html><head></head><body>x</body></html>', {
					headers: { 'content-type': 'text/html', 'content-security-policy': CSP }
				})
		);
		await build(root, { spool });
		expect(stubConfig(await stubOf(root)).policy).toEqual([['content-security-policy', CSP]]);
	});

	it('reads the policy from the /* block of the _headers file, and keeps the site rules', async () => {
		const root = await outDir();
		await writeFile(join(root, 'dist', '_headers'), SITE_HEADERS);
		await build(root);
		expect(stubConfig(await stubOf(root)).policy).toEqual([['x-frame-options', 'DENY']]);
		const headers = await readFile(join(root, 'dist', '_headers'), 'utf8');
		expect(headers.startsWith(SITE_HEADERS.trimEnd())).toBe(true);
		expect(headers).toContain(
			'/.spool/*\n  Cache-Control: public, max-age=31536000, immutable'
		);
		expect(headers).toContain('/spool-sw.js\n');
	});

	it('takes an explicit policy over the _headers file', async () => {
		const root = await outDir();
		await writeFile(join(root, 'dist', '_headers'), SITE_HEADERS);
		await build(root, { static: { policy: { 'referrer-policy': 'no-referrer' } } });
		expect(stubConfig(await stubOf(root)).policy).toEqual([['referrer-policy', 'no-referrer']]);
	});

	it('fails the build with the library error when the publish fails', async () => {
		const root = await outDir();
		const failure = await build(root, {
			static: { policy: { 'cache-control': 'no-store' } }
		}).catch((error) => error);
		expect(failure).toBeInstanceOf(ProtocolError);
		expect(failure.message).toContain('not a policy header');
		expect(await readdir(join(root, 'dist'))).toEqual([]);
	});

	it('keeps the immutable files of an earlier build, rewrites the stub and adds the headers once', async () => {
		const root = await outDir();
		const dist = join(root, 'dist');
		await writeFile(join(dist, '_headers'), SITE_HEADERS);
		await build(root);
		await writeFile(join(dist, clientPath(VERSION)), 'kept');
		await writeFile(join(dist, 'spool-sw.js'), 'stale');
		await build(root);
		expect(await readFile(join(dist, clientPath(VERSION)), 'utf8')).toBe('kept');
		expect(await stubOf(root)).toContain('__SPOOL_CONFIG__');
		const headers = await readFile(join(dist, '_headers'), 'utf8');
		expect(headers.split('/.spool/*').length - 1).toBe(1);
		expect(headers.split('/spool-sw.js').length - 1).toBe(1);
		expect(headers).toContain('/admin/*\n  X-Robots-Tag: noindex');
	});

	it('writes the new pack and the stub when the data changed between builds', async () => {
		const root = await outDir();
		const spool = shellSpool();
		await build(root, { spool });
		const before = await stubOf(root);
		await spool.invalidate(['rows']);
		await build(root, { spool });
		expect(await exists(join(root, 'dist', `${BUNDLE_PREFIX}1`))).toBe(true);
		expect(await stubOf(root)).not.toBe(before);
	});

	it('publishes from a spool made from the build output', async () => {
		const root = await outDir();
		const made = vi.fn(() => shellSpool({ policy: {} }));
		await build(root, { static: { spool: made } });
		expect(made).toHaveBeenCalledWith({ outDir: join(root, 'dist') });
		expect(stubConfig(await stubOf(root)).policy).toEqual([]);
	});

	it('does not publish in serve, in an SSR build or in a server environment', async () => {
		const root = await outDir();
		await build(root, {}, { command: 'serve' });
		await build(root, {}, { build: { outDir: 'dist', ssr: true } });
		await build(root, {}, {}, { config: { consumer: 'server', build: { outDir: 'dist' } } });
		expect(await readdir(join(root, 'dist'))).toEqual([]);
	});

	it('publishes into the client environment output directory when the build has environments', async () => {
		const root = await outDir();
		await mkdir(join(root, 'build', 'client'), { recursive: true });
		await build(
			root,
			{},
			{},
			{ config: { consumer: 'client', build: { outDir: 'build/client' } } }
		);
		expect(await exists(join(root, 'build', 'client', 'spool-sw.js'))).toBe(true);
		expect(await readdir(join(root, 'dist'))).toEqual([]);
	});
});

describe('spoolVite in a real vite build', () => {
	it('leaves the static tier beside the build, with the site headers from public/', async () => {
		const root = await mkdtemp(join(tmpdir(), 'spool-vite-real-'));
		roots.push(root);
		await mkdir(join(root, 'public'));
		await writeFile(join(root, 'public', '_headers'), SITE_HEADERS);
		await writeFile(
			join(root, 'index.html'),
			'<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>'
		);
		await writeFile(join(root, 'main.js'), 'console.log("app");\n');
		await viteBuild({
			root,
			configFile: false,
			logLevel: 'silent',
			plugins: [spoolVite({ spool: shellSpool() })]
		});
		const dist = join(root, 'dist');
		for (const path of [
			clientPath(VERSION),
			navigatePath(VERSION),
			'spool-sw.js',
			'index.html'
		]) {
			expect(await exists(join(dist, path)), path).toBe(true);
		}
		expect(stubConfig(await readFile(join(dist, 'spool-sw.js'), 'utf8')).policy).toEqual([
			['x-frame-options', 'DENY']
		]);
		const headers = await readFile(join(dist, '_headers'), 'utf8');
		expect(headers).toContain('/admin/*\n  X-Robots-Tag: noindex');
		expect(headers).toContain('/.spool/*');
		expect(await readFile(join(dist, 'index.html'), 'utf8')).not.toContain('data-spool-gate');
	});
});

describe('policyFromHeadersFile', () => {
	it('reads the policy headers of the /* block only, joining repeats', () => {
		const text = `/*\n  Content-Security-Policy: a\n  content-security-policy: b\n  Cache-Control: x\n\n/admin/*\n  X-Frame-Options: DENY\n`;
		expect(policyFromHeadersFile(text)).toEqual({ 'content-security-policy': 'a, b' });
	});

	it('returns nothing for a file with no policy header in the /* block', () => {
		expect(policyFromHeadersFile('/*\n  Cache-Control: x\n')).toBeUndefined();
		expect(policyFromHeadersFile('')).toBeUndefined();
	});
});
