import { page } from '../../server/spool.ts';

// spool.handle in server.ts answers spool's paths and writes the delta; the route serves the site's pages
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => page(request);
export const POST = (request: Request) => page(request);
export const PATCH = (request: Request) => page(request);
export const DELETE = (request: Request) => page(request);
