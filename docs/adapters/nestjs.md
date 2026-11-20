# NestJS

On the Express adapter, `app.use` takes spool's listener and a controller method that injects
`@Req()` and `@Res()` writes the page. The example needs `experimentalDecorators` in
`tsconfig.json`. Pass the request to `spool.stub(request)` so the browser can revalidate the worker
script with `If-None-Match` and get a `304`. `stub()` with no request sends no validator. The
[Economics](../economics.md) page has the reading.

```ts
import { Controller, Get, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import 'reflect-metadata';
import { toNodeListener, toRequest, writeResponse } from '@drupflare/spool/node';
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
  app.use('/spool-sw.js', async (req: Request, res: Response) =>
    writeResponse(res, await spool.stub(toRequest(req, res)))
  );
  return app;
}
```

## Example Project

`examples/courses/nestjs/` runs this shape. Run `npx tsx nest.ts` in that folder.
