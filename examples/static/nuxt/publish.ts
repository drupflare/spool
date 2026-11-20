import { fileStaticSink } from '@drupflare/spool/node';
import { fileURLToPath } from 'node:url';
import spool from './server/spool.ts';

// nuxt build copies public/ into .output/public and lists it; a file added after the build is not served
const root = fileURLToPath(new URL('./public', import.meta.url));
const { version, paths } = await spool.publishStatic(fileStaticSink(root));

console.log(`wrote ${paths.length} files for pack version ${version} to ${root}`);
for (const path of paths) console.log(path);
