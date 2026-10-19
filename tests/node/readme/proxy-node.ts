import { createServer } from 'node:http';
import { toNodeListener } from '../../../src/node/listener';
import { spoolProxy } from '../../../src/proxy/index';
import { memoryStore } from '../../../src/stores/index';

const proxy = spoolProxy({
	origin: process.env['ORIGIN'] as string,
	spool: { store: memoryStore() },
	purgeSecret: process.env['PURGE_SECRET']
});

export const server = createServer(toNodeListener(proxy));
