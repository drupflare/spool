import { createSpool } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';
import { routes } from './routes';

export const spool = createSpool({
	routes,
	store: memoryStore(),
	assets: 'static-routing'
});
