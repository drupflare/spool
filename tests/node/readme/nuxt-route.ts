import { defineEventHandler, toWebRequest } from 'h3';
import { page } from './routes';
import { spool } from './spool';

export default defineEventHandler((event) => spool.handle(toWebRequest(event), page));
