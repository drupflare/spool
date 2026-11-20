import { dashboardSite } from '../shared/site.ts';

// each isolate keeps its own pack and version store in memory
// workerd rejects async work in global scope, so the site builds on the first request
let site: ReturnType<typeof dashboardSite> | undefined;

export default {
	async fetch(request: Request): Promise<Response> {
		site ??= dashboardSite();
		const { spool, page } = await site;
		return spool.handle(request, page);
	}
};
