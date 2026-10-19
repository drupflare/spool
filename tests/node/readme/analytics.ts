import { createSpool, jsonLinesSink } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';
import { routes } from './routes';

export const spool = createSpool({
	routes,
	store: memoryStore(),
	beacons: ['/cdn-cgi/rum'],
	sink: jsonLinesSink((line) => console.log(line))
});
