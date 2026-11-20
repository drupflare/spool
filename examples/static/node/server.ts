import { toNodeListener, type FetchHandler } from '@drupflare/spool/node';
import type { Spool } from '@drupflare/spool/server';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticSite } from '../shared/site.ts';

export const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));

type Handler = (request: Request) => Response | Promise<Response>;

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

/** the file sink keeps no content type, so the extension and the delta folder give it back */
function typeOf(path: string): string {
	if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
	return path.includes('/delta/') ? 'application/json' : 'application/octet-stream';
}

/** a file under `root` with the headers `publish` wrote to its `_headers`, or `undefined` */
export function staticFiles(root: string): FetchHandler {
	return async (request) => {
		const { pathname } = new URL(request.url);
		const file = resolve(root, `.${pathname}`);
		const inside = file.startsWith(root + sep) && pathname !== '/_headers';
		const bytes =
			inside && request.method === 'GET' ? await readFile(file).catch(() => null) : null;
		if (!bytes) return undefined;
		const rules = await readFile(resolve(root, '_headers'), 'utf8').catch(() => '');
		return new Response(bytes, {
			headers: { 'content-type': typeOf(pathname), ...headersFor(rules, pathname) }
		});
	};
}

/** files first, then the spool and the page for everything else */
export const handle =
	(files: FetchHandler, spool: Spool, page: Handler): Handler =>
	async (request) =>
		(await files(request)) ?? spool.handle(request, page);

const { spool, page } = await staticSite();

export const server = createServer(toNodeListener(handle(staticFiles(PUBLIC), spool, page)));

if (import.meta.main) server.listen(5701);
