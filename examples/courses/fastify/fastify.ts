import { toRequest } from '@drupflare/spool/node';
import Fastify from 'fastify';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const app = Fastify();

app.addHook('onRequest', async (req, reply) => {
	const response = await spool.respond(toRequest(req.raw, reply.raw));
	if (response) return reply.send(response);
});
app.get('/spool-sw.js', async (req, reply) =>
	reply.send(await spool.stub(toRequest(req.raw, reply.raw)))
);
app.get('/', async (req, reply) => {
	const request = toRequest(req.raw, reply.raw);
	return reply.send(await spool.decorate(request, page(request)));
});
app.get('/courses', async (req, reply) => {
	const request = toRequest(req.raw, reply.raw);
	return reply.send(await spool.decorate(request, page(request)));
});
app.get('/courses/:id', async (req, reply) => {
	const request = toRequest(req.raw, reply.raw);
	return reply.send(await spool.decorate(request, page(request)));
});
app.get('/ping', (req, reply) => reply.header('content-type', 'text/plain').send('pong'));

if (import.meta.main) await app.listen({ port: 3000 });
