import { hits } from '../utils/hits';

export default defineEventHandler((event) => {
	const { pathname } = getRequestURL(event);
	if (!pathname.startsWith('/api/')) hits.push(pathname);
});
