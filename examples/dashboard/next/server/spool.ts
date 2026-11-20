import type { PageLike } from '@drupflare/spool/server';
import { dashboardSite } from '../../shared/site.ts';

// the catch-all route handler serves the board pages, so Next registers none; these records say which
const pages: PageLike[] = [
	{ path: '/', pattern: '/' },
	...['tasks', 'projects'].map((name) => ({
		path: `/board/${name}/[id]`,
		pattern: `/board/${name}/:id`
	}))
].map((page) => ({
	...page,
	register: 'network' as const,
	reason: 'served by the catch-all route handler'
}));

// the front process and the Next route are separate bundles; one site per process keeps their stores shared
const holder = globalThis as unknown as { spoolDashboard?: ReturnType<typeof dashboardSite> };
holder.spoolDashboard ??= dashboardSite({ pages });

export const { spool, page } = await holder.spoolDashboard;
