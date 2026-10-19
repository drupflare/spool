import { defineRoute } from '../../../src/server/index';

export const course = defineRoute('/api/courses/:id', {
	strategy: 'data',
	depends: (ctx) => [`course:${ctx.params['id']}`],
	load: (ctx) => ({ id: ctx.params['id'], title: 'Intro' }),
	provision: { reuse: 0.8, futureViews: 6 }
});

export const roster = defineRoute('/rosters/:id', {
	strategy: 'projection',
	depends: (ctx) => [`roster:${ctx.params['id']}`],
	load: (ctx) => ({ id: ctx.params['id'], names: ['Ada', 'Bo'] })
});
