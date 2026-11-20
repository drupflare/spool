/** where `publishStatic` writes its files: a host folder, an object store or memory */
export type StaticSink = {
	put(path: string, bytes: Uint8Array, contentType: string): void | Promise<void>;
	/** whether a file is already there; `publishStatic` leaves the immutable ones it finds alone */
	has?(path: string): boolean | Promise<boolean>;
};

/** where the stub's site policy came from; `none` means the stub carries no `policy` field */
export type StaticPolicySource = 'call' | 'option' | 'page' | 'fallback' | 'none';

/** what `publishStatic` takes beside the sink */
export type PublishStaticOptions = {
	/** the stub's site policy for this call, ahead of the `policy` option and a learned page; `{}` names no headers */
	policy?: Record<string, string>;
	/** the stub's site policy when the call, the option and a learned page give none */
	fallbackPolicy?: Record<string, string>;
	/** builds the pack at the store cursor first, as `publish(url)` does; ignored without `bundles` */
	url?: URL;
	/**
	 * With `cdn.worker`, reads the core's URL before anything is written and throws unless its bytes
	 * are this build's core. `true` uses the global `fetch`; pass a function to supply the read. Off
	 * by default, so a publish makes no request of its own.
	 */
	verifyCore?: boolean | typeof fetch;
};

/** what `publishStatic` returns: the store cursor, the paths written and where the policy came from */
export type PublishStaticResult = {
	version: number;
	paths: string[];
	policy: StaticPolicySource;
};

/** a sink that keeps every file in memory, with the paths it was asked to write in `puts` */
export function memoryStaticSink(): StaticSink & {
	files: Map<string, { bytes: Uint8Array; contentType: string }>;
	puts: string[];
} {
	const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
	const puts: string[] = [];
	return {
		files,
		puts,
		put(path, bytes, contentType) {
			puts.push(path);
			files.set(path, { bytes, contentType });
		},
		has: (path) => files.has(path)
	};
}

/**
 * The `_headers` file a static host reads: everything under `/.spool/` is immutable, and the stub
 * lives for `maxAge` seconds, the same lease its own response names.
 */
export function staticHeaders(maxAge: number): string {
	return [
		'/.spool/*',
		'  Cache-Control: public, max-age=31536000, immutable',
		'',
		'/spool-sw.js',
		`  Cache-Control: max-age=${maxAge}`,
		'  Service-Worker-Allowed: /',
		''
	].join('\n');
}
