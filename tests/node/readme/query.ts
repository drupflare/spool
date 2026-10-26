import { datasetProof, defineRoute } from '../../../src/server/index';

const people = [
	{ name: 'Ada', department: 'math', age: 36 },
	{ name: 'Bo', department: 'cs', age: 25 }
];

export const directory = defineRoute('/people', {
	strategy: 'template',
	template: {
		source: '<h1>{{#if query}}Page {{query.page}} of {{query.pages}}{{else}}Everyone{{/if}}</h1><ul>{{#each people}}<li>{{name}}</li>{{/each}}</ul>'
	},
	depends: () => ['people'],
	load: async () => ({ people, proof: await datasetProof(people) }),
	query: {
		list: 'people',
		filter: { department: 'string', age: 'number' },
		sort: ['name', 'age'],
		pageSize: 20
	},
	provision: { reuse: 0.8, futureViews: 6 }
});
