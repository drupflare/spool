import { SITE_CSS } from '../../../shared/site.ts';

export const dynamic = 'force-dynamic';

export function GET() {
	return new Response(SITE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8' } });
}
