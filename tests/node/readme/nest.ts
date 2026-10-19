import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import 'reflect-metadata';
import { toNodeListener, toRequest, writeResponse } from '../../../src/node/listener';
import { page } from './routes';
import { spool } from './spool';

@Controller()
class NodeController {
	@Get('node/:id')
	async show(@Req() req: Request, @Res() res: Response) {
		const request = toRequest(req, res);
		await writeResponse(res, await spool.decorate(request, page(request)));
	}
}

@Module({ controllers: [NodeController] })
class AppModule {}

export async function bootstrap() {
	const app = await NestFactory.create(AppModule, { logger: false });
	app.use(toNodeListener((request) => spool.respond(request)));
	app.use('/spool-sw.js', (req: Request, res: Response) => writeResponse(res, spool.stub()));
	return app;
}
