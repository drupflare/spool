import { spoolProxy, type SpoolProxy } from '../../../src/proxy/index';
import { durableObjectStore } from '../../../src/stores/durable-object';

export { SpoolVersions } from '../../../src/stores/durable-object';

let proxy: SpoolProxy | undefined;

export default {
	fetch(request: Request, env: Cloudflare.Env) {
		proxy ??= spoolProxy({
			origin: 'https://origin.example.edu',
			spool: { store: durableObjectStore(env.SPOOL_VERSIONS) },
			purgeSecret: env.PURGE_SECRET
		});
		return proxy(request);
	}
};
