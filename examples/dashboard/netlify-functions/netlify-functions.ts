import type { Config, Context } from '@netlify/functions';
import { dashboardSite } from '../shared/site.ts';

const { spool, page } = await dashboardSite();

export default (request: Request, context: Context) => spool.handle(request, page);

export const config: Config = {
	path: [
		'/',
		'/board/*',
		'/tasks',
		'/tasks/*',
		'/tasks/*/*',
		'/projects/*',
		'/me',
		'/login',
		'/logout',
		'/healthz',
		'/spool-sw.js',
		'/.spool/*'
	]
};
