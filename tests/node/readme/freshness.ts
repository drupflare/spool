import { defineRoute } from '../../../src/server/index';

export const stock = defineRoute('/stock/:sku', {
	strategy: 'template',
	template: { source: '<p>{{sku}}: {{count}}</p>' },
	depends: (ctx) => [`stock:${ctx.params['sku']}`],
	load: (ctx) => ({ sku: ctx.params['sku'], count: 3 }),
	freshness: { maxStale: 60, mode: 'hard' },
	offline: 'refuse'
});

export const notice = defineRoute('/notices/:id', {
	strategy: 'template',
	template: { source: '<p>{{text}}</p>' },
	depends: (ctx) => [`notice:${ctx.params['id']}`],
	load: () => ({ text: 'Closed on Friday' }),
	freshness: { maxStale: 3600, mode: 'soft' },
	sync: 'deferred'
});
