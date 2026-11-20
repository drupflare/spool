import { courseSpool } from '../shared/site.ts';

// workerd refuses I/O in global scope, so the pack is built on the first request
let site: ReturnType<typeof courseSpool> | undefined;

export default {
	async fetch(request: Request): Promise<Response> {
		site ??= courseSpool();
		const { spool, page } = await site;
		return spool.handle(request, page);
	}
};
