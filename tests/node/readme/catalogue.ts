import { createSpool, defineRoute } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';

export const home = defineRoute('/', {
	strategy: 'template',
	template: { source: '<h1>Courses</h1>' },
	load: () => ({}),
	catalogue: () => [
		{ path: '/courses/101', p: 0.3 },
		{ path: '/courses/102', p: 0.1 }
	]
});

export const course = defineRoute('/courses/:id', {
	strategy: 'template',
	template: { source: '<h1>{{title}}</h1>' },
	depends: (ctx) => [`course:${ctx.params['id']}`],
	load: (ctx) => ({ title: `Course ${ctx.params['id']}` }),
	documentBytes: 17_000
});

export const spool = createSpool({
	routes: [home, course],
	store: memoryStore(),
	catalogueBytes: 16_384
});
