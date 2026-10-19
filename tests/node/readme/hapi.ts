import Hapi from '@hapi/hapi';
import { toRequest, writeResponse } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const server = Hapi.server();

server.ext('onRequest', async (request, h) => {
	const { req, res } = request.raw;
	const spoolRequest = toRequest(req, res);
	const response =
		request.path === '/spool-sw.js' ? spool.stub() : await spool.respond(spoolRequest);
	if (!response) return h.continue;
	await writeResponse(res, response);
	return h.abandon;
});
server.route({
	method: 'GET',
	path: '/node/{id}',
	handler: async (request, h) => {
		const { req, res } = request.raw;
		const spoolRequest = toRequest(req, res);
		await writeResponse(res, await spool.decorate(spoolRequest, page(spoolRequest)));
		return h.abandon;
	}
});
