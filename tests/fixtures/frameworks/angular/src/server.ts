import { AngularAppEngine, createRequestHandler } from '@angular/ssr';

export { routes } from './app/app.routes';
export { serverRoutes } from './app/app.routes.server';

const engine = new AngularAppEngine();

export const reqHandler = createRequestHandler(async (request) => {
	const response = await engine.handle(request);
	return response ?? new Response('Not found', { status: 404 });
});
