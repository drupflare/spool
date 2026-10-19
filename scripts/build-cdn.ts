import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLIENT_CORE, SW_CORE } from '../src/server/embedded';
import { VERSION } from '../src/version';
import { manifestFor } from './cdn-manifest';

const root = join(import.meta.dir, '..');
const given = process.argv.find((a) => a.startsWith('--out='));
const out = given ? resolve(given.slice('--out='.length)) : join(root, 'dist/cdn');

async function bundle(entry: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [join(root, entry)],
		target: 'browser',
		format: 'iife',
		minify: true
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	return (await result.outputs[0]?.text()) ?? '';
}

const client = await bundle('src/cdn/client.ts');
const worker = await bundle('src/sw/core.ts');

if (client !== CLIENT_CORE || worker !== SW_CORE) {
	console.error('the CDN build differs from the embedded bundles; run: bun run build:sw');
	process.exit(1);
}

const encoder = new TextEncoder();
const files = { 'client.js': encoder.encode(client), 'spool-sw.js': encoder.encode(worker) };
const manifest = manifestFor(files, VERSION);
mkdirSync(out, { recursive: true });
for (const [name, bytes] of Object.entries(files)) writeFileSync(join(out, name), bytes);
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
for (const [name, file] of Object.entries(manifest.files)) {
	console.log(`${name} ${file.bytes} bytes ${file.integrity}`);
}
