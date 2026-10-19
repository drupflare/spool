import type { Config, Context } from '@netlify/edge-functions';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, () => context.next());

export const config: Config = { path: '/*' };
