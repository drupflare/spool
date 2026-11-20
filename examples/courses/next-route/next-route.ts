import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const GET = (request: Request) => spool.handle(request, page);
