import { spoolExpress } from '@drupflare/spool/express';
import { writeResponse } from '@drupflare/spool/node';
import express from 'express';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

export const app = express();

app.use(spoolExpress(spool));
app.use(async (req, res) => {
	// spoolExpress already converted this request; the page reads only its url
	await writeResponse(res, page(new Request(new URL(req.url, 'http://localhost'))));
});

if (import.meta.main) app.listen(3000);
