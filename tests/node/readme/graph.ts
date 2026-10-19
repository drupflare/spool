import { defineRoute } from '../../../src/server/index';

const courses: Record<string, string> = { '101': 'Intro', '102': 'Advanced' };

export const course = defineRoute('/courses/:id', {
	strategy: 'template',
	template: {
		source: '<h1>{{title}}</h1><nav>{{#each menu}}<a>{{this}}</a>{{/each}}</nav>'
	},
	load: (ctx) => {
		const id = ctx.params['id'] ?? '';
		return {
			title: ctx.record(`course:${id}`, courses[id]),
			menu: ctx.projection(
				'menu',
				Object.keys(courses).map((key) => ctx.record(`course:${key}`, courses[key]))
			)
		};
	}
});
