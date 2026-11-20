import { renderToReadableStream } from 'react-dom/server';
import { ServerRouter, type EntryContext } from 'react-router';

export default async function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext
) {
	const body = await renderToReadableStream(
		<ServerRouter
			context={routerContext}
			url={request.url}
		/>,
		{
			signal: request.signal,
			onError(error: unknown) {
				console.error(error);
			}
		}
	);
	await body.allReady;
	responseHeaders.set('Content-Type', 'text/html');
	return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
