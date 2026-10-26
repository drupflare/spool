import { promisify } from 'node:util';
import { brotliCompressSync, zstdCompress } from 'node:zlib';
import { baseMatcher, chooseBases, spoolProxy } from '../../../src/proxy/index';
import { memoryStore } from '../../../src/stores/index';

const compress = promisify(zstdCompress);

const crawl = [
	{
		url: 'https://origin.example.edu/css/a.css',
		kind: 'style',
		text: '.a{color:red}.b{margin:0}'
	},
	{
		url: 'https://origin.example.edu/css/b.css',
		kind: 'style',
		text: '.a{color:red}.c{margin:1px}'
	},
	{
		url: 'https://origin.example.edu/css/c.css',
		kind: 'style',
		text: '.a{color:red}.d{margin:2px}'
	}
] as const;

const bytes = (index: number) => Buffer.from(crawl[index]?.text ?? '');

const choices = await chooseBases(
	crawl.map(({ url, kind, text }) => ({ url, kind, plain: brotliCompressSync(text).length })),
	async (file, dictionary) =>
		(await compress(bytes(file), { dictionary: bytes(dictionary) })).length
);

export const proxy = spoolProxy({
	origin: 'https://origin.example.edu',
	spool: { store: memoryStore() },
	dictionary: {
		encoder: async (dictionary, input) => new Uint8Array(await compress(input, { dictionary })),
		base: baseMatcher(choices)
	}
});
