import { type BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { App } from './app/app';
import { routes } from './app/app.routes';
import { serverRoutes } from './app/app.routes.server';

export default function bootstrap(context: BootstrapContext) {
	return bootstrapApplication(
		App,
		{
			providers: [provideRouter(routes), provideServerRendering(withRoutes(serverRoutes))]
		},
		context
	);
}
