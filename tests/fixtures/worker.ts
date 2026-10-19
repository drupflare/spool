import { createSpool, defineRoute } from '../../src/server/index';
import { durableObjectStore } from '../../src/stores/durable-object';

export { SpoolVersions } from '../../src/stores/durable-object';

export const NODE_PAGE = (id: string) =>
	`<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`;

const routes = [
	defineRoute('/node/:id', {
		strategy: 'template',
		template: {
			source: '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
		},
		depends: (ctx) => [`node:${ctx.params['id']}`],
		load: (ctx) => ({ id: ctx.params['id'] })
	})
];

export default {
	fetch(request, env) {
		const spool = createSpool({ routes, store: durableObjectStore(env.SPOOL_VERSIONS) });
		return spool.handle(request, (req) => {
			const id = new URL(req.url).pathname.split('/')[2] ?? '';
			return new Response(NODE_PAGE(id), { headers: { 'content-type': 'text/html' } });
		});
	}
} satisfies ExportedHandler<Cloudflare.Env>;
