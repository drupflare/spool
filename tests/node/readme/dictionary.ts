import { spoolProxy } from '@drupflare/spool/proxy';
import { memoryStore } from '@drupflare/spool/stores';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

const compress = promisify(zstdCompress);

export const proxy = spoolProxy({
	origin: 'https://origin.example.edu',
	spool: { store: memoryStore() },
	dictionary: {
		encoder: async (dictionary, input) => new Uint8Array(await compress(input, { dictionary }))
	}
});
