import { page } from './routes';
import { spool } from './spool';

export default {
	port: 3000,
	fetch: (request: Request) => spool.handle(request, page)
};
