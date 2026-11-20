import { defineEventHandler, toWebRequest } from 'h3';
import spool, { page } from '../spool.ts';

export default defineEventHandler((event) => spool.handle(toWebRequest(event), page));
