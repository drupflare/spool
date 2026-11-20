import type { AngularRoute, AngularServerRoute } from '@drupflare/spool/angular';

export const routes: AngularRoute[] = [];
export const serverRoutes: AngularServerRoute[] = [];
export const reqHandler = async (request: Request): Promise<Response> =>
	new Response(request.url);
