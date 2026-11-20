import { pages } from '#spool/pages';
import { homepageSite } from '../../shared/site.ts';

// the module reads a synchronous Spool; the site is built once when the server starts, and its
// routes are the pages Nuxt registered plus the data routes over `/api`
const site = await homepageSite({ pages, api: true });
for (const page of site.uncovered) console.info(`spool: no route declared for ${page.pattern}`);

export const page = site.page;
export default site.spool;
