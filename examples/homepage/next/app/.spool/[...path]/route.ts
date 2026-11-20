import { spoolRouteHandler } from '@drupflare/spool/next';
import { spool } from '../../../server/spool.ts';

export const dynamic = 'force-dynamic';
export const GET = spoolRouteHandler(spool);
