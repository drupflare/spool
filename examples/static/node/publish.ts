import { fileStaticSink } from '@drupflare/spool/node';
import { fileURLToPath } from 'node:url';
import { staticSite } from '../shared/site.ts';

const root = fileURLToPath(new URL('./public', import.meta.url));
const { publish } = await staticSite();
const { version, paths } = await publish(fileStaticSink(root));

console.log(`wrote ${paths.length} files for pack version ${version} to ${root}`);
for (const path of paths) console.log(path);
