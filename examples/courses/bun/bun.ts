import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export default {
	port: 3000,
	fetch: (request: Request) => spool.handle(request, page)
};
