import { h } from 'vue';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';

const view = (text: string) => () => h('h1', text);

export const routes: RouteRecordRaw[] = [
	{ path: '/', component: view('Home') },
	{ path: '/about', component: view('About') },
	{ path: '/articles', component: view('Articles') },
	{ path: '/:opt?', component: view('Optional') },
	{ path: '/docs/:slug(.*)*', component: view('Docs') }
];

/** a router for the server and the Vite config; it never touches the DOM */
export function memoryRouter() {
	return createRouter({ history: createMemoryHistory(), routes });
}
