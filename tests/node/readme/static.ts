import { defineRoute } from '../../../src/server/index';

export const about = defineRoute('/about', {
	strategy: 'static',
	depends: () => ['site'],
	freshness: { maxStale: 3600, mode: 'soft' }
});
