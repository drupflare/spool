import { toNodeListener } from '@drupflare/spool/node';
import { spoolProxy } from '@drupflare/spool/proxy';
import { memoryStore } from '@drupflare/spool/stores';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { courseSpool } from '../shared/site.ts';

const { page } = await courseSpool();

// an origin that never loads spool
export const origin = createServer(toNodeListener(page));
await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));

const proxy = spoolProxy({
	origin: `http://127.0.0.1:${(origin.address() as AddressInfo).port}`,
	spool: { store: memoryStore() },
	purgeSecret: process.env['PURGE_SECRET']
});

// a request with a cookie or an Authorization header goes to the origin unchanged
export const server = createServer(toNodeListener(proxy));

if (import.meta.main) server.listen(3000);
