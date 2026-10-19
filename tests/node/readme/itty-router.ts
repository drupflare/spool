import { IttyRouter } from 'itty-router';
import { page } from './routes';
import { spool } from './spool';

const router = IttyRouter();

router
	.all('*', (request) => spool.respond(request))
	.get('/spool-sw.js', () => spool.stub())
	.get('/node/:id', (request) => spool.decorate(request, page(request)));

export default { fetch: router.fetch };
