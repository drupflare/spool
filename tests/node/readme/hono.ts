import { Hono } from 'hono';
import { spoolHono } from '../../../src/hono/index';
import { page } from './routes';
import { spool } from './spool';

const app = new Hono();

app.use('*', spoolHono(spool));
app.get('/node/:id', (c) => page(c.req.raw));

export default app;
