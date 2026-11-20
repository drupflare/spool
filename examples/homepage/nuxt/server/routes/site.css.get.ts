import { defineEventHandler, setHeader } from 'h3';
import { SITE_CSS } from '../../../shared/site.ts';

export default defineEventHandler((event) => {
	setHeader(event, 'content-type', 'text/css; charset=utf-8');
	return SITE_CSS;
});
