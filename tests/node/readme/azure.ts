import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { page } from './routes';
import { spool } from './spool';

export async function handler(request: HttpRequest): Promise<HttpResponseInit> {
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
	const response = await spool.handle(
		new Request(request.url, {
			method: request.method,
			headers: [...request.headers],
			body: hasBody ? await request.arrayBuffer() : undefined
		}),
		page
	);
	return {
		status: response.status,
		headers: [...response.headers],
		body: await response.arrayBuffer()
	};
}

app.http('spool', {
	route: '{*path}',
	methods: ['GET', 'POST'],
	authLevel: 'anonymous',
	handler
});
