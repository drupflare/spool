import { IttyRouter } from 'itty-router';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

const router = IttyRouter();

router
	.all('*', (request) => spool.respond(request))
	.get('/spool-sw.js', (request) => spool.stub(request))
	.get('/', (request) => spool.decorate(request, page(request)))
	.get('/courses', (request) => spool.decorate(request, page(request)))
	.get('/courses/:id', (request) => spool.decorate(request, page(request)))
	.all('*', (request) => page(request));

export default { fetch: router.fetch };
