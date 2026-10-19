import { page } from './routes';
import { spool } from './spool';

export const GET = (request: Request) => spool.handle(request, page);
