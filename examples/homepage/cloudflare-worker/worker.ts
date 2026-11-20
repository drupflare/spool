import { homepageSite } from '../shared/site.ts';

// each isolate keeps its own pack and version store in memory
// built on the first request: workers reject async work in global scope
let site: ReturnType<typeof homepageSite> | undefined;

export default {
	fetch(request: Request): Promise<Response> {
		site ??= homepageSite();
		return site.then(({ spool, page }) => spool.handle(request, page));
	}
};
