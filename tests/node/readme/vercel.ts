import { page } from './routes';
import { spool } from './spool';

export default {
	fetch: (request: Request) => spool.handle(request, page)
};
