import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';
import { spoolProxy } from '../../../src/proxy/index';
import { memoryStore } from '../../../src/stores/index';

const compress = promisify(zstdCompress);

export const proxy = spoolProxy({
	origin: 'https://origin.example.edu',
	spool: { store: memoryStore() },
	dictionary: {
		encoder: async (dictionary, input) => new Uint8Array(await compress(input, { dictionary }))
	}
});
