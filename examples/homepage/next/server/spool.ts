import { SPOOL_PAGES_FILE } from '@drupflare/spool/next';
import type { PageLike } from '@drupflare/spool/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homepageSite } from '../../shared/site.ts';

// the layout and the route handlers read a synchronous Spool; the site is built once at import. Next
// writes the page registrations when a build ends, so the build itself and `next dev` find no file
// and keep the shared site's own route list
const file = join(process.cwd(), '.next', SPOOL_PAGES_FILE);
const pages: PageLike[] | undefined = existsSync(file)
	? JSON.parse(readFileSync(file, 'utf8'))
	: undefined;
const site = await homepageSite(pages ? { pages } : {});
for (const page of site.uncovered) console.info(`spool: no route declared for ${page.pattern}`);

export const spool = site.spool;
