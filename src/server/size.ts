/** measures the compressed size of some bytes, in bytes */
export type Sizer = (bytes: Uint8Array) => number | Promise<number>;

type Format = ConstructorParameters<typeof CompressionStream>[0];

let format: Format | undefined;

/**
 * Brotli size through `CompressionStream`, which Node, Bun and Deno have. A runtime that refuses
 * `brotli` gets gzip, which is larger, so it ships fewer entries and never more.
 */
export const compressedSize: Sizer = async (bytes) => {
	if (format === undefined) {
		try {
			new CompressionStream('brotli' as Format);
			format = 'brotli' as Format;
		} catch {
			format = 'gzip';
		}
	}
	const stream = new Response(bytes as BodyInit).body?.pipeThrough(new CompressionStream(format));
	return (await new Response(stream).arrayBuffer()).byteLength;
};
