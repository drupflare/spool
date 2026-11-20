import { staticSite } from '../shared/site.ts';

// the assets binding answers every file in public/ first; this Worker runs only for the rest
// built on the first request: workers reject async work in global scope
let site: ReturnType<typeof staticSite> | undefined;

export default {
	fetch(request: Request): Promise<Response> {
		site ??= staticSite();
		return site.then(({ spool, page }) => spool.handle(request, page));
	}
};
