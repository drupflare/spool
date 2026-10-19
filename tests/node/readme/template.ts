import { defineRoute } from '../../../src/server/index';

export const news = defineRoute('/news/:slug', {
	strategy: 'template',
	template: {
		source: '<article><h1>{{title}}</h1>{{#if byline}}<p>{{byline}}</p>{{else}}<p>Staff</p>{{/if}}<div>{{{body}}}</div><ul>{{#each tags}}<li>{{@index}} {{this}}</li>{{/each}}</ul></article>',
		trusted: ['body']
	},
	depends: (ctx) => [`news:${ctx.params['slug']}`],
	load: () => ({
		title: 'Hello',
		byline: null,
		body: '<p>Trusted markup</p>',
		tags: ['a', 'b']
	})
});
