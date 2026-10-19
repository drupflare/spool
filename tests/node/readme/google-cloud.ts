import { http } from '@google-cloud/functions-framework';
import { toNodeListener } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

http(
	'spool',
	toNodeListener((request) => spool.handle(request, page))
);
