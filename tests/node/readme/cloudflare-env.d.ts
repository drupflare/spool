declare namespace Cloudflare {
	interface Env {
		SPOOL_VERSIONS: DurableObjectNamespace<
			import('../../../src/stores/durable-object').SpoolVersions
		>;
		SPOOL_LIVE: DurableObjectNamespace<import('../../../src/stores/durable-object').SpoolLive>;
		PURGE_SECRET?: string;
	}
}
