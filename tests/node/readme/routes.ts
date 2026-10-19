import { defineRoute } from '../../../src/server/index';

export const routes = [
	defineRoute('/node/:id', {
		strategy: 'template',
		template: {
			source: '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
		},
		depends: (ctx) => [`node:${ctx.params['id']}`],
		load: (ctx) => ({ id: ctx.params['id'] })
	})
];

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page = (request: Request) => {
	const id = escape(new URL(request.url).pathname.split('/')[2] ?? '');
	return new Response(
		`<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`,
		{ headers: { 'content-type': 'text/html; charset=utf-8' } }
	);
};
