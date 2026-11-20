import { defineEventHandler, toWebRequest } from 'h3';
import { courseSpool } from '../shared/site.ts';

// built on the first request: nitro's server build target has no top-level await
let site: ReturnType<typeof courseSpool> | undefined;

export default defineEventHandler((event) => {
	site ??= courseSpool();
	return site.then(({ spool }) => {
		const request = toWebRequest(event);
		return new URL(request.url).pathname === '/spool-sw.js'
			? spool.stub(request)
			: spool.respond(request);
	});
});
