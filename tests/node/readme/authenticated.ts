import { createSpool, defineRoute } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';

export const grades = defineRoute('/grades', {
	strategy: 'template',
	scope: 'principal',
	retention: 'persistent',
	template: { source: '<h1>Grades for {{owner}}</h1>' },
	depends: (ctx) => [`perm:${ctx.identity?.principal}`, `grades:${ctx.identity?.principal}`],
	load: (ctx) => ({ owner: ctx.identity?.principal })
});

export const spool = createSpool({
	routes: [grades],
	store: memoryStore(),
	identity: {
		secret: 'a long random value kept on the server',
		resolve: (request) => {
			const user = /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1];
			return user ? { principal: user } : null;
		}
	},
	logout: ['/logout']
});

export async function login(user: string): Promise<Response> {
	return new Response('Signed in', {
		headers: {
			'set-cookie': `user=${user}; Path=/`,
			'spool-partition': await spool.partition(user)
		}
	});
}
