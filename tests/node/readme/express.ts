import express from 'express';
import { spoolExpress } from '../../../src/express/index';
import { toRequest, writeResponse } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const app = express();

app.use(spoolExpress(spool));
app.get('/node/:id', async (req, res) => {
	await writeResponse(res, page(toRequest(req, res)));
});
