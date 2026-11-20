import { h } from 'vue';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';

export const ARTICLES = [
	{ id: 'routes', title: 'Routes are shells', body: 'Each route renders the same app shell.' },
	{
		id: 'stamps',
		title: 'Stamps move the stub',
		body: 'A new stamp makes devices check for a stub.'
	},
	{ id: 'packs', title: 'Packs are files', body: 'Packs and deltas sit beside the build output.' }
];

const Home = () => h('h1', 'Field Notes');
const About = () => h('p', 'A single-page app whose static files come from the static tier.');
const ArticleList = () =>
	h(
		'ul',
		ARTICLES.map((article) => h('li', [h('h2', article.title), h('p', article.body)]))
	);

// constant routes only: a parameter route needs a field in its template (see README)
export const routes: RouteRecordRaw[] = [
	{ path: '/', component: Home },
	{ path: '/articles', component: ArticleList },
	{ path: '/about', component: About }
];

/** a router for the server and the Vite config; it never touches the DOM */
export function memoryRouter() {
	return createRouter({ history: createMemoryHistory(), routes });
}
