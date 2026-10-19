/** the origin of a URL, or null when it is not one */
export function safeOrigin(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

const PIXEL = Uint8Array.from(
	atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
	(c) => c.charCodeAt(0)
);

/**
 * What the page gets for a collector hit the worker holds: an empty 204 for a POST, a one-pixel
 * GIF for a GET. A CORS request also needs the allow headers, with the page's origin when the
 * request carries credentials, since a wildcard fails there.
 */
export function collectorAnswer(request: Request): Response {
	const headers = new Headers();
	if (request.mode === 'cors') {
		const origin = request.headers.get('origin') ?? safeOrigin(request.referrer);
		if (request.credentials === 'include' && origin) {
			headers.set('access-control-allow-origin', origin);
			headers.set('access-control-allow-credentials', 'true');
		} else headers.set('access-control-allow-origin', '*');
	}
	if (request.method === 'GET') {
		headers.set('content-type', 'image/gif');
		headers.set('cache-control', 'no-store');
		return new Response(PIXEL, { status: 200, headers });
	}
	return new Response(null, { status: 204, headers });
}
