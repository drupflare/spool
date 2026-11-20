import { createSpool, memoryBundleStore } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export const ORIGIN = 'https://status.test/';
// advance by one on each publish; the stub's bytes change and devices make a forced check
export const STAMP = 1;

// the module reads a synchronous Spool; this site declares no routes, so the page runtime
// answers no navigation and the static tier is the stub, the runtime and the pack
const spool = createSpool({
	routes: [],
	store: memoryStore(),
	bundles: memoryBundleStore(),
	// the stub is written before any page is answered, so the site policy is named here
	policy: {},
	stamp: STAMP
});
await spool.publish(new URL(ORIGIN));

export default spool;
