import { spoolExpress } from '@drupflare/spool/express';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import express from 'express';
import { dashboardSite } from '../shared/site.ts';

const { spool, page } = await dashboardSite();

export const app = express();

app.use(spoolExpress(spool));
app.use(async (req, res) => {
	await writeResponse(res, await page(toRequest(req, res)));
});

if (import.meta.main) app.listen(3000);
