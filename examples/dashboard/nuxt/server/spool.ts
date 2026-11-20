import { pages } from '#spool/pages';
import { dashboardSite } from '../../shared/site.ts';

// the module needs the Spool at load, so the site is built here with top-level await; the board
// pages it declares are the ones Nuxt registered
const site = await dashboardSite({ pages });
for (const page of site.uncovered) console.info(`spool: no route declared for ${page.pattern}`);

export const page = site.page;
export default site.spool;
