import { createMemoryHistory, createRouter } from 'vue-router';

export function memoryRouter() {
	return createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/', component: { render: () => null } },
			{ path: '/articles', component: { render: () => null } },
			{ path: '/about', component: { render: () => null } }
		]
	});
}
