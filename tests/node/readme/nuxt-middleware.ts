import { defineEventHandler, toWebRequest } from 'h3';
import { spool } from './spool';

export default defineEventHandler((event) => {
	const request = toWebRequest(event);
	return new URL(request.url).pathname === '/spool-sw.js' ? spool.stub() : spool.respond(request);
});
