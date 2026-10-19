import { GA4_COLLECTOR } from '../../../src/protocol/index';
import { combineSinks, createSpool, ga4Sink, jsonLinesSink } from '../../../src/server/index';
import { memoryStore } from '../../../src/stores/index';
import { routes } from './routes';

export const spool = createSpool({
	routes,
	store: memoryStore(),
	collectors: [
		GA4_COLLECTOR,
		{
			vendor: 'matomo',
			match: 'https://stats.example.edu/matomo.php',
			maxAgeMs: 23 * 3_600_000,
			delivery: 'replay',
			stamp: { param: 'cdt', kind: 'datetime-utc' }
		}
	],
	sink: combineSinks(
		jsonLinesSink((line) => console.log(line)),
		ga4Sink({ measurementId: 'G-XXXXXXXXXX', apiSecret: 'kept on the server' })
	)
});
