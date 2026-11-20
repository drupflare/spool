import { toNodeListener, type FetchHandler } from '@drupflare/spool/node';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSpool, ORIGIN, STAMP } from './server/spool.ts';

export const DIST = fileURLToPath(new URL('./dist', import.meta.url));

/** `static`: spool paths are files; `handler`: spool paths go to the spool; `none`: no spool at all */
export type Arm = 'static' | 'handler' | 'none';
export type Tier = 'static' | 'spool' | 'page';
export type Note = (path: string, tier: Tier, bytes: number) => void;

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml'
};
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isSpoolPath = (pathname: string) =>
	pathname === '/spool-sw.js' || pathname.startsWith('/.spool/');

/** the header rules of a `_headers` file that apply to `path` */
function headersFor(text: string, path: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const block of text.trim().split('\n\n')) {
		const [pattern = '', ...lines] = block.split('\n');
		const hit = pattern.endsWith('*')
			? path.startsWith(pattern.slice(0, -1))
			: path === pattern;
		for (const line of hit ? lines : []) {
			const [name = '', ...value] = line.trim().split(': ');
			out[name] = value.join(': ');
		}
	}
	return out;
}

/** the file at `pathname` under `root`, or `undefined` when the request goes on to the spool */
function fromFiles(root: string, arm: Arm): FetchHandler {
	return async (request) => {
		const { pathname } = new URL(request.url);
		if (arm !== 'static' && isSpoolPath(pathname)) return undefined;
		const file = resolve(root, `.${pathname}`);
		const inside = file.startsWith(root + sep) && pathname !== '/_headers';
		const bytes =
			inside && request.method === 'GET' ? await readFile(file).catch(() => null) : null;
		if (!bytes) return undefined;
		const rules = await readFile(join(root, '_headers'), 'utf8').catch(() => '');
		const headers: Record<string, string> = {
			'content-type': TYPES[extname(pathname)] ?? 'application/octet-stream',
			...headersFor(rules, pathname)
		};
		if (pathname.startsWith('/assets/')) headers['cache-control'] = IMMUTABLE;
		return new Response(bytes, { headers });
	};
}

/** the origin: files first, then the spool, then the built shell for every other path */
export async function origin(
	options: {
		lease?: number;
		stamp?: number | (() => number);
		root?: string;
		arm?: Arm;
		note?: Note;
	} = {}
) {
	const { lease, stamp = STAMP, root = DIST, arm = 'static', note } = options;
	const shell = readFileSync(join(root, 'index.html'), 'utf8');
	const spool = appSpool(shell, lease, stamp);
	await spool.publish(new URL(ORIGIN));
	const files = fromFiles(root, arm);
	const document = () =>
		new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } });
	const size = async (response: Response) =>
		note ? (await response.clone().arrayBuffer()).byteLength : 0;

	const handle = async (request: Request): Promise<Response> => {
		const { pathname } = new URL(request.url);
		const file = await files(request);
		if (file) {
			note?.(pathname, 'static', await size(file));
			return file;
		}
		if (arm === 'none') {
			const response = document();
			note?.(pathname, 'page', await size(response));
			return response;
		}
		let ran = false;
		const response = await spool.handle(request, async () => {
			ran = true;
			return document();
		});
		note?.(pathname, ran ? 'page' : 'spool', await size(response));
		return response;
	};
	return { spool, handle };
}

if (import.meta.main) {
	const { handle } = await origin();
	createServer(toNodeListener(handle)).listen(Number(process.env.PORT ?? 5711), '127.0.0.1');
}
