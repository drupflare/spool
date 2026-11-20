import { toRequest, writeResponse } from '@drupflare/spool/node';
import Hapi, { type Request as HapiRequest, type ResponseToolkit } from '@hapi/hapi';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const server = Hapi.server();

// course pages convert their own request in the handler, so the extension skips them
server.ext('onRequest', async (request, h) => {
	const { path } = request;
	if (path !== '/spool-sw.js' && !path.startsWith('/.spool/')) return h.continue;
	const { req, res } = request.raw;
	const spoolRequest = toRequest(req, res);
	const response =
		path === '/spool-sw.js'
			? await spool.stub(spoolRequest)
			: await spool.respond(spoolRequest);
	if (!response) return h.continue;
	await writeResponse(res, response);
	return h.abandon;
});

const course = async (request: HapiRequest, h: ResponseToolkit) => {
	const { req, res } = request.raw;
	const spoolRequest = toRequest(req, res);
	await writeResponse(res, await spool.decorate(spoolRequest, page(spoolRequest)));
	return h.abandon;
};

server.route([
	{ method: 'GET', path: '/', handler: course },
	{ method: 'GET', path: '/courses', handler: course },
	{ method: 'GET', path: '/courses/{id}', handler: course },
	{
		method: 'GET',
		path: '/ping',
		// hapi adds a charset to text types unless charset() clears it
		handler: (request, h) => h.response('pong').header('content-type', 'text/plain').charset()
	}
]);

if (import.meta.main) {
	await server.start();
	console.log(server.info.uri);
}
