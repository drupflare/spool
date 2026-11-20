import { createApp, h } from 'vue';
import { createRouter, createWebHistory, RouterLink, RouterView } from 'vue-router';
import { routes } from './routes.ts';

const router = createRouter({ history: createWebHistory(), routes });
const nav = () =>
	h('nav', [
		h(RouterLink, { to: '/' }, () => 'Home'),
		' ',
		h(RouterLink, { to: '/articles' }, () => 'Articles'),
		' ',
		h(RouterLink, { to: '/about' }, () => 'About')
	]);

createApp({ render: () => h('div', [nav(), h(RouterView)]) })
	.use(router)
	.mount('#app');
