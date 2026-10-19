import { spool } from './spool';

export function proxy(request: Request) {
	const { pathname } = new URL(request.url);
	return pathname === '/spool-sw.js' ? spool.stub() : spool.respond(request);
}
