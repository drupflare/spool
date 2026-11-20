export const dynamic = 'force-dynamic';

export function GET() {
	return new Response('User-agent: *\nAllow: /', {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}
