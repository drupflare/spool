import { spoolHono } from '@drupflare/spool/hono';
import { Hono } from 'hono';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

const app = new Hono();

app.use('*', spoolHono(spool));
app.get('*', (c) => page(c.req.raw));

export default app;
