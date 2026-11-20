import type { Config, Context } from '@netlify/edge-functions';
import { courseSpool } from '../shared/site.ts';

const { spool } = await courseSpool();

export default (request: Request, context: Context) => spool.handle(request, () => context.next());

export const config: Config = { path: '/*' };
