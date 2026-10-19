import type { Config, Context } from '@netlify/functions';
import { page } from './routes';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, page);

export const config: Config = { path: ['/node/*', '/spool-sw.js', '/.spool/*'] };
