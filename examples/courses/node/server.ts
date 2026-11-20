import { toNodeListener } from '@drupflare/spool/node';
import { createServer } from 'node:http';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const server = createServer(toNodeListener((request) => spool.handle(request, page)));

if (import.meta.main) server.listen(3000);
