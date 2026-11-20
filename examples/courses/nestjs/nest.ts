import { toNodeListener, toRequest, writeResponse } from '@drupflare/spool/node';
import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import 'reflect-metadata';
import { courseSpool } from '../shared/site.ts';

const { spool, page } = await courseSpool();

@Controller()
class CourseController {
	@Get(['/', 'courses', 'courses/:id'])
	async show(@Req() req: ExpressRequest, @Res() res: ExpressResponse) {
		const request = toRequest(req, res);
		await writeResponse(res, await spool.decorate(request, page(request)));
	}

	@Get('ping')
	ping(@Res() res: ExpressResponse) {
		res.setHeader('content-type', 'text/plain');
		res.end('pong');
	}
}

@Module({ controllers: [CourseController] })
class AppModule {}

export async function bootstrap() {
	const app = await NestFactory.create(AppModule, { logger: false });
	app.use(toNodeListener((request) => spool.respond(request)));
	app.use('/spool-sw.js', async (req: ExpressRequest, res: ExpressResponse) =>
		writeResponse(res, await spool.stub(toRequest(req, res)))
	);
	return app;
}

if (import.meta.main) await (await bootstrap()).listen(3000);
