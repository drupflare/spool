import { thirdPartyReport } from '../../../src/report/index';
import { createSpool, memorySink, viewsOf } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';
import { routes } from './routes';

const sink = memorySink();

export const spool = createSpool({
	routes,
	store: memoryStore(),
	sink,
	thirdParty: {
		allow: ['https://fonts.gstatic.com', 'https://cdn.example.edu'],
		maxEntries: 32
	}
});

export const report = () => thirdPartyReport(viewsOf(sink.events));
