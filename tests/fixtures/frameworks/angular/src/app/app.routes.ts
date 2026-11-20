import type { Routes } from '@angular/router';
import { PageComponent } from './page';

export const routes: Routes = [
	{ path: '', component: PageComponent, data: { title: 'Home' } },
	{ path: 'about', component: PageComponent, data: { title: 'About' } },
	{ path: 'shell', component: PageComponent, data: { title: 'Shell' } },
	{ path: 'news', component: PageComponent, data: { title: 'News' } },
	{ path: 'articles/:id', component: PageComponent, data: { title: 'Article' } },
	{ path: 'users/:id', component: PageComponent, data: { title: 'User' } },
	{ path: 'docs/**', component: PageComponent, data: { title: 'Docs' } },
	{
		path: 'blog',
		children: [
			{ path: '', component: PageComponent, data: { title: 'Blog' } },
			{ path: ':slug', component: PageComponent, data: { title: 'Post' } }
		]
	},
	{ path: 'old', redirectTo: 'about' }
];
