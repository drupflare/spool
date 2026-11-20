import { RenderMode, type ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
	{ path: '', renderMode: RenderMode.Prerender },
	{ path: 'about', renderMode: RenderMode.Prerender },
	{ path: 'shell', renderMode: RenderMode.Client },
	{ path: 'news', renderMode: RenderMode.Server },
	{
		path: 'articles/:id',
		renderMode: RenderMode.Prerender,
		getPrerenderParams: () => Promise.resolve([{ id: '1' }, { id: '2' }])
	},
	{ path: 'users/:id', renderMode: RenderMode.Server },
	{ path: 'docs/**', renderMode: RenderMode.Server },
	{ path: 'blog', renderMode: RenderMode.Prerender },
	{ path: 'blog/:slug', renderMode: RenderMode.Server },
	{ path: '**', renderMode: RenderMode.Server }
];
