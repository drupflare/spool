import { hits } from '../utils/hits';

export default defineEventHandler((event) => {
	const seen = [...hits];
	if (getQuery(event).reset !== undefined) hits.length = 0;
	return seen;
});
