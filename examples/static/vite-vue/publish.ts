import { fileStaticSink } from '@drupflare/spool/node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST } from './server.ts';
import { appSpool, ORIGIN } from './server/spool.ts';

const spool = appSpool(readFileSync(join(DIST, 'index.html'), 'utf8'));
await spool.publish(new URL(ORIGIN));
const { version, paths } = await spool.publishStatic(fileStaticSink(DIST));

console.log(`wrote ${paths.length} files for pack version ${version} to ${DIST}`);
for (const path of paths) console.log(path);
