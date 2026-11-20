import { courseSpool } from '../shared/site.ts';

const { spool } = await courseSpool();

export function proxy(request: Request) {
	const { pathname } = new URL(request.url);
	return pathname === '/spool-sw.js' ? spool.stub(request) : spool.respond(request);
}
