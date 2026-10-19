import express from 'express';
import { toNodeListener, toRequest, writeResponse } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

export const app = express();

app.use(toNodeListener((request) => spool.respond(request)));
app.get('/spool-sw.js', (req, res) => writeResponse(res, spool.stub()));
app.get('/node/:id', async (req, res) => {
	const request = toRequest(req, res);
	await writeResponse(res, await spool.decorate(request, page(request)));
});
