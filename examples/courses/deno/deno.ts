import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export default {
	fetch: (request: Request) => spool.handle(request, page)
};
