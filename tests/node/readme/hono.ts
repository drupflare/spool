import { Hono } from 'hono';
import { page } from './routes';
import { spool } from './spool';

const app = new Hono();

app.use('*', async (c, next) => {
	c.res = await spool.handle(c.req.raw, async () => {
		await next();
		return c.res;
	});
});
app.get('/node/:id', (c) => page(c.req.raw));

export default app;
