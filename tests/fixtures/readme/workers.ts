import { createSpool } from '../../../src/server/index';
import { durableObjectStore } from '../../../src/stores/durable-object';
import { page, routes } from './routes';

export { SpoolVersions } from '../../../src/stores/durable-object';

export default {
	fetch(request: Request, env: Cloudflare.Env) {
		const spool = createSpool({ routes, store: durableObjectStore(env.SPOOL_VERSIONS) });
		return spool.handle(request, page);
	}
};
