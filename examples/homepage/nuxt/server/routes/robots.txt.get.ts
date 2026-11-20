import { defineEventHandler, setHeader } from 'h3';

export default defineEventHandler((event) => {
	setHeader(event, 'content-type', 'text/plain; charset=utf-8');
	return 'User-agent: *\nAllow: /';
});
