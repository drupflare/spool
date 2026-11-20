import { spoolHono } from '@drupflare/spool/hono';
import { handle } from '@hono/aws-lambda';
import { Hono } from 'hono';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

const app = new Hono();

app.use('*', spoolHono(spool));
app.get('*', (c) => page(c.req.raw));

export const handler = handle(app);
