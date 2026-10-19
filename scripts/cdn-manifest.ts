import { createHash } from 'node:crypto';

/** the files `build:cdn` writes beside `manifest.json`, in the order the manifest lists them */
export const CDN_FILES = ['client.js', 'spool-sw.js'] as const;

export type CdnFileName = (typeof CDN_FILES)[number];

/** what `manifest.json` records about one built file */
export type CdnFile = {
	bytes: number;
	/** hex sha384 of the file */
	sha384: string;
	/** the value for an `integrity` attribute */
	integrity: string;
};

/** what `dist/cdn/manifest.json` holds for the page runtime and worker builds */
export type CdnManifest = {
	schema: 2;
	version: string;
	files: Record<CdnFileName, CdnFile>;
};

/** the record for the bytes of one file */
export function fileFor(bytes: Uint8Array): CdnFile {
	const raw = createHash('sha384').update(bytes).digest();
	return {
		bytes: bytes.byteLength,
		sha384: raw.toString('hex'),
		integrity: `sha384-${raw.toString('base64')}`
	};
}

/** the manifest for the built files at `version` */
export function manifestFor(files: Record<CdnFileName, Uint8Array>, version: string): CdnManifest {
	return {
		schema: 2,
		version,
		files: {
			'client.js': fileFor(files['client.js']),
			'spool-sw.js': fileFor(files['spool-sw.js'])
		}
	};
}
