import { toNodeListener } from '@drupflare/spool/node';
import { http } from '@google-cloud/functions-framework';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

http(
	'spool',
	toNodeListener((request) => spool.handle(request, page))
);
