import { createServer } from 'node:http';
import { toNodeListener } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const server = createServer(toNodeListener((request) => spool.handle(request, page)));
