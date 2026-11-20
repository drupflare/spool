import { spoolHono } from '@drupflare/spool/hono';
import { Hono } from 'hono';
import { dashboardSite } from '../shared/site.ts';

const { spool, page } = await dashboardSite();

const app = new Hono();

app.use('*', spoolHono(spool));
app.all('*', (c) => page(c.req.raw));

export default app;
