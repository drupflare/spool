import Fastify from 'fastify';
import { toRequest } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const app = Fastify();

app.addHook('onRequest', async (req, reply) => {
	const response = await spool.respond(toRequest(req.raw, reply.raw));
	if (response) return reply.send(response);
});
app.get('/spool-sw.js', (req, reply) => reply.send(spool.stub()));
app.get('/node/:id', async (req, reply) => {
	const request = toRequest(req.raw, reply.raw);
	return reply.send(await spool.decorate(request, page(request)));
});
