/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Cloudflare.Env {}
}

declare namespace Cloudflare {
	interface Env {
		SPOOL_VERSIONS: DurableObjectNamespace<
			import('../src/stores/durable-object').SpoolVersions
		>;
		PURGE_SECRET?: string;
	}
}

/** vite's `?raw` suffix: workerd has no `node:fs`, so a spec reads a source file this way */
declare module '*?raw' {
	const src: string;
	export default src;
}
