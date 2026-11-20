import { createSpool, defineRoute } from '../../src/server/index';
import {
	durableObjectHub,
	durableObjectStore,
	SpoolLive,
	SpoolVersions
} from '../../src/stores/durable-object';

export { SpoolLive, SpoolVersions };

const routes = [
	defineRoute('/about', {
		strategy: 'template',
		template: { source: '<p>about</p>' },
		load: () => ({})
	})
];
const identity = { secret: 's', resolve: () => ({ principal: 'alice' }) };
const page = async () => new Response('ok');

export default {
	fetch(request: Request, env: Cloudflare.Env) {
		const spool = createSpool({
			routes,
			identity,
			store: durableObjectStore(env.SPOOL_VERSIONS),
			live: { hub: durableObjectHub(env.SPOOL_LIVE, { hibernate: true }) }
		});
		return spool.handle(request, page);
	}
};
