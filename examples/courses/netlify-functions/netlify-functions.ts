import type { Config, Context } from '@netlify/functions';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export default (request: Request, context: Context) => spool.handle(request, page);

export const config: Config = {
	path: ['/', '/courses', '/courses/*', '/ping', '/spool-sw.js', '/.spool/*']
};
