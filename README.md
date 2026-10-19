# 🧵 spool

> An incremental application replica for the browser

[![Build](https://github.com/drupflare/spool/actions/workflows/build.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/build.yml)
[![Browser](https://github.com/drupflare/spool/actions/workflows/browser.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/browser.yml)
[![Prettier](https://github.com/drupflare/spool/actions/workflows/prettier.yml/badge.svg)](https://github.com/drupflare/spool/actions/workflows/prettier.yml)
[![codecov](https://codecov.io/gh/drupflare/spool/branch/master/graph/badge.svg)](https://codecov.io/gh/drupflare/spool)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

spool keeps a replica of what a page needs on the visitor's device. The server sends templates
and authorised, versioned data. A service worker stores them and computes eligible pages on the
device, so a repeat view makes no request and costs the server no work.

It runs on any runtime that speaks `Request` and `Response`, bridges `node:http` for the rest, and
has no runtime dependencies. A site with no server code can load it from two files and a manifest.

---

## 📋 Table of Contents

- [Why Spool](#-why-spool)
- [Install](#-install)
- [Quick Start](#-quick-start)
- [Page Runtime](#-page-runtime)
- [Runtimes](#-runtimes)
- [Compatibility](#-compatibility)
- [Static Sites](#-static-sites)
- [Strategies](#-strategies)
- [Freshness Contracts](#-freshness-contracts)
- [Authenticated Data](#-authenticated-data)
- [Analytics Batching](#-analytics-batching)
- [Third-Party Files](#-third-party-files)
- [Subresource Handling](#-subresource-handling)
- [Shadow Mode](#-shadow-mode)
- [Proxy Mode](#-proxy-mode)
- [Out of Scope](#-out-of-scope)
- [Browser Support](#-browser-support)
- [Subpath Exports](#-subpath-exports)
- [Testing](#-testing)
- [Related Repositories](#-related-repositories)
- [License](#-license)

---

## 🎯 Why Spool

A response is a deterministic transformation of a set of authorised, versioned dependencies. The
server half names those dependencies and sends the snapshot the visitor may hold. The worker keeps
a graph of records, projections and responses, with their versions, and syncs only what the next
page needs.

Your application keeps every write, every access decision and every page it cannot reproduce
safely on the device. A route the worker cannot answer goes to the network, so adopting spool
changes no page that was not declared.

[docs/impact.md](docs/impact.md) holds the energy model and the measurements behind it.

---

## 📥 Install

### Package

```sh
bun add @drupflare/spool
```

The package ships ES modules and type declarations. Node, Deno, Bun, Workers and bundlers import
it directly.

### CDN Script

A page can load the runtime from `cdn.drupflare.com` with a Subresource Integrity hash. The release
notes list the hash for each version.

```html
<script
  src="https://cdn.drupflare.com/spool/<version>/client.js"
  integrity="sha384-<hash from the release notes>"
  crossorigin="anonymous"
  defer
  data-spool-client
></script>
```

[Page Runtime](#-page-runtime) shows how `createSpool` injects the same tag.

### Direct Files

`spool-sw.js`, `client.js` and `manifest.json` are attached to every GitHub release and published
under `https://cdn.drupflare.com/spool/<version>/`. A site that serves them as plain files needs no
server library. See [Static Sites](#-static-sites).

---

## 🚀 Quick Start

Every runtime below makes the same three moves:

1. Declare the routes the device may answer, and the version store that tracks changes.
2. Wrap the application's handler with `spool.handle`. It answers `/.spool/*` and `/spool-sw.js`.
3. Send the client tag, which is the script tag for the page runtime. `handle` injects it into
   every HTML page the application returns, and `spool.decorate` does the same where there is no
   Fetch response to wrap.

### Declare Routes

A route has a path pattern, a strategy, the tags it depends on and a `load` function that returns
the data for one page. `load` runs on the server and may check the visitor's identity. Only its
result reaches the device.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const routes = [
  defineRoute('/node/:id', {
    strategy: 'template',
    template: {
      source:
        '<!doctype html><html><head><title>Node {{id}}</title></head><body><h1>Node {{id}}</h1></body></html>'
    },
    depends: (ctx) => [`node:${ctx.params['id']}`],
    load: (ctx) => ({ id: ctx.params['id'] })
  })
];

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const page = (request: Request) => {
  const id = escape(new URL(request.url).pathname.split('/')[2] ?? '');
  return new Response(
    `<!doctype html><html><head><title>Node ${id}</title></head><body><h1>Node ${id}</h1></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
};
```

`page` stands in for your application. The page it returns has to match what the template
renders from the route's data, because the device renders the same route without asking you.

The version store records which tags changed. `memoryStore` serves a single process. Every other
deployment needs a store that all instances share, which is any object with three methods:
`bump(tags)`, `cursor()` and `diff(from)`. On Cloudflare, `durableObjectStore` keeps the vector in
a Durable Object.

```ts
import { memoryStore } from '@drupflare/spool/stores';

export const store = memoryStore();
```

`createSpool` joins the two:

```ts
import { createSpool } from '@drupflare/spool/server';
import { routes } from './routes';
import { store } from './store';

export const spool = createSpool({ routes, store });
```

After a write, call `await spool.invalidate(['node:1'])` with the tags it touched. Devices
holding a page that depends on them fetch a fresh copy before they show it again.

---

## 📦 Page Runtime

`handle` and `decorate` inject one script tag into each HTML page. By default the script is
served from the same origin at `/.spool/<version>/client.js`, which suits a strict
`script-src 'self'` policy. To serve it from `cdn.drupflare.com` instead, pass the integrity hash
that the release notes list for your version. The URL defaults to that version's file.

```ts
import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  cdn: { integrity: 'sha384-<hash from the release notes>' }
});
```

The CDN copy carries `Cache-Control: public, max-age=31536000, immutable` and the browser checks
it against the hash, so a changed file never runs. Release files are never overwritten. If the
script fails to load, the page works as it did before.

The script registers `/spool-sw.js` and exposes `window.spool.ready`, which resolves to the client
handle or to `null` where service workers do not exist. To bundle the runtime yourself, import
`register` from `@drupflare/spool/client`.

---

## 🧩 Runtimes

Each example uses the `routes`, `page` and `spool` from [Quick Start](#-quick-start). The
[compatibility table](#-compatibility) lists what each framework hands a handler.

### Cloudflare Workers

Bind the Durable Object that holds the version vector, then pass its namespace to
`durableObjectStore`.

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "SPOOL_VERSIONS", "class_name": "SpoolVersions" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SpoolVersions"] }]
}
```

```ts
import { createSpool } from '@drupflare/spool/server';
import { durableObjectStore } from '@drupflare/spool/stores/durable-object';
import { page, routes } from './routes';

export { SpoolVersions } from '@drupflare/spool/stores/durable-object';

export default {
  fetch(request: Request, env: Cloudflare.Env) {
    const spool = createSpool({ routes, store: durableObjectStore(env.SPOOL_VERSIONS) });
    return spool.handle(request, page);
  }
};
```

### Cloudflare Pages Functions

A function takes a context with the request and a `next` that runs the next function or the
static asset server.

```ts
import { spool } from './spool';

export const onRequest = (context: { request: Request; next(): Promise<Response> }) =>
  spool.handle(context.request, () => context.next());
```

### Hono

Hono ignores the response a middleware returns once a route has answered, so assign it to
`c.res`.

```ts
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
```

### Elysia

`onRequest` answers the spool paths and returns nothing for the rest. The hook has to be an
`async` function, because Elysia does not await a promise that a plain function returns.

```ts
import { Elysia } from 'elysia';
import { page } from './routes';
import { spool } from './spool';

export const app = new Elysia()
  .onRequest(async ({ request }) => {
    const { pathname } = new URL(request.url);
    return pathname === '/spool-sw.js' ? spool.stub() : await spool.respond(request);
  })
  .get('/node/:id', ({ request }) => spool.decorate(request, page(request)));
```

### itty-router

A handler that returns `undefined` passes the request to the next one, which is what
`spool.respond` returns for a path that is not spool's.

```ts
import { IttyRouter } from 'itty-router';
import { page } from './routes';
import { spool } from './spool';

const router = IttyRouter();

router
  .all('*', (request) => spool.respond(request))
  .get('/spool-sw.js', () => spool.stub())
  .get('/node/:id', (request) => spool.decorate(request, page(request)));

export default { fetch: router.fetch };
```

### Bun

Bun serves a default export that has a `fetch` function.

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  port: 3000,
  fetch: (request: Request) => spool.handle(request, page)
};
```

### Deno

Run it with `deno serve`.

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  fetch: (request: Request) => spool.handle(request, page)
};
```

### Netlify Functions

A function takes a `Request` and returns a `Response`. `config.path` sends the spool paths and the
pages to it.

```ts
import type { Config, Context } from '@netlify/functions';
import { page } from './routes';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, page);

export const config: Config = { path: ['/node/*', '/spool-sw.js', '/.spool/*'] };
```

### Netlify Edge Functions

An edge function runs in front of the site. `context.next()` returns the response the site would
have sent, which `handle` decorates.

```ts
import type { Config, Context } from '@netlify/edge-functions';
import { spool } from './spool';

export default (request: Request, context: Context) => spool.handle(request, () => context.next());

export const config: Config = { path: '/*' };
```

### Vercel Functions

A function under `api/` takes a default export with `fetch`. Send every path to it from
`vercel.json`, so the function sees `/.spool/*` and `/spool-sw.js` as well as the pages. Function
instances do not share memory, so `store` has to be a shared `VersionStore`.

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/api" }] }
```

```ts
import { page } from './routes';
import { spool } from './spool';

export default {
  fetch: (request: Request) => spool.handle(request, page)
};
```

### Next.js

Next.js route handlers return `Response` objects, so `handle` wraps one directly. The spool
endpoints and the worker script go through the proxy, which returns `undefined` for every other
request. Next.js 16 calls the file `proxy.ts` and the export `proxy`. Earlier versions call them
`middleware.ts` and `middleware`. The proxy and the route handlers need the same shared store.

```ts
import { spool } from './spool';

export function proxy(request: Request) {
  const { pathname } = new URL(request.url);
  return pathname === '/spool-sw.js' ? spool.stub() : spool.respond(request);
}
```

```ts
import { page } from './routes';
import { spool } from './spool';

export const GET = (request: Request) => spool.handle(request, page);
```

### Nuxt and Nitro

h3 turns an event into a standard request with `toWebRequest`, and it sends a `Response` that a
handler returns. A server middleware that returns nothing passes the request on. Put the first
file in `server/middleware/` and the second in `server/routes/node/[id].ts`. Both share one store
from `./store`.

```ts
import { defineEventHandler, toWebRequest } from 'h3';
import { spool } from './spool';

export default defineEventHandler((event) => {
  const request = toWebRequest(event);
  return new URL(request.url).pathname === '/spool-sw.js' ? spool.stub() : spool.respond(request);
});
```

```ts
import { defineEventHandler, toWebRequest } from 'h3';
import { page } from './routes';
import { spool } from './spool';

export default defineEventHandler((event) => spool.handle(toWebRequest(event), page));
```

### AWS Lambda

Lambda gives a function a JSON event and expects a JSON result, so spool needs an adapter. Hono's
`hono/aws-lambda` converts Function URL, API Gateway HTTP API and ALB events. Save the Hono app
above as `hono.ts` and wrap it.

```ts
import { handle } from 'hono/aws-lambda';
import app from './hono';

export const handler = handle(app);
```

### Azure Functions

An Azure v4 HTTP function takes an `HttpRequest`, which follows the Fetch standard, and returns an
`HttpResponseInit`. Route every path to it with `{*path}`.

```ts
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { page } from './routes';
import { spool } from './spool';

export async function handler(request: HttpRequest): Promise<HttpResponseInit> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const response = await spool.handle(
    new Request(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: hasBody ? await request.arrayBuffer() : undefined
    }),
    page
  );
  return {
    status: response.status,
    headers: [...response.headers],
    body: await response.arrayBuffer()
  };
}

app.http('spool', {
  route: '{*path}',
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler
});
```

### Node

`toNodeListener` turns a Fetch-style handler into a `node:http` listener. Its `toRequest` and
`writeResponse` parts are what the frameworks below use to cross between Node and Fetch.

```ts
import { createServer } from 'node:http';
import { toNodeListener } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const server = createServer(toNodeListener((request) => spool.handle(request, page)));
```

### Express

Express responds through its own `res`, so it has no Fetch response to wrap. `spool.respond`
answers `/.spool/*` and returns `undefined` for everything else, which sends the request on to the
next Express handler. A route passes its page through `spool.decorate` to get the envelope and the
script tag.

```ts
import express from 'express';
import { toNodeListener, toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = express();

app.use(toNodeListener((request) => spool.respond(request)));
app.get('/spool-sw.js', (req, res) => writeResponse(res, spool.stub()));
app.get('/node/:id', async (req, res) => {
  const request = toRequest(req, res);
  await writeResponse(res, await spool.decorate(request, page(request)));
});
```

### Fastify

Fastify's `reply.send` takes a Fetch `Response`. An `onRequest` hook answers the spool paths from
the raw request before Fastify reads the body.

```ts
import Fastify from 'fastify';
import { toRequest } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = Fastify();

app.addHook('onRequest', async (req, reply) => {
  const response = await spool.respond(toRequest(req.raw, reply.raw));
  if (response) return reply.send(response);
});
app.get('/spool-sw.js', (req, reply) => reply.send(spool.stub()));
app.get('/node/:id', async (req, reply) => {
  const request = toRequest(req.raw, reply.raw);
  return reply.send(await spool.decorate(request, page(request)));
});
```

### Koa

Koa exposes the Node objects as `ctx.req` and `ctx.res`. Setting `ctx.respond` to `false` stops
Koa from writing a second response.

```ts
import Koa from 'koa';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const app = new Koa();

app.use(async (ctx, next) => {
  const request = toRequest(ctx.req, ctx.res);
  const response = ctx.path === '/spool-sw.js' ? spool.stub() : await spool.respond(request);
  if (!response) return next();
  ctx.respond = false;
  await writeResponse(ctx.res, response);
});
app.use(async (ctx) => {
  if (!ctx.path.startsWith('/node/')) return;
  const request = toRequest(ctx.req, ctx.res);
  ctx.respond = false;
  await writeResponse(ctx.res, await spool.decorate(request, page(request)));
});
```

### hapi

hapi keeps the Node objects at `request.raw`. Returning `h.abandon` tells it the response is
already written.

```ts
import Hapi from '@hapi/hapi';
import { toRequest, writeResponse } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

export const server = Hapi.server();

server.ext('onRequest', async (request, h) => {
  const { req, res } = request.raw;
  const spoolRequest = toRequest(req, res);
  const response =
    request.path === '/spool-sw.js' ? spool.stub() : await spool.respond(spoolRequest);
  if (!response) return h.continue;
  await writeResponse(res, response);
  return h.abandon;
});
server.route({
  method: 'GET',
  path: '/node/{id}',
  handler: async (request, h) => {
    const { req, res } = request.raw;
    const spoolRequest = toRequest(req, res);
    await writeResponse(res, await spool.decorate(spoolRequest, page(spoolRequest)));
    return h.abandon;
  }
});
```

### NestJS

On the Express adapter, `app.use` takes spool's listener and a controller method that injects
`@Req()` and `@Res()` writes the page. The example needs `experimentalDecorators` in
`tsconfig.json`.

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
  app.use('/spool-sw.js', (req: Request, res: Response) => writeResponse(res, spool.stub()));
  return app;
}
```

### Google Cloud Functions

The Functions Framework gives an HTTP function Express-style `req` and `res`, so the Node listener
fits as it is.

```ts
import { http } from '@google-cloud/functions-framework';
import { toNodeListener } from '@drupflare/spool/node';
import { page } from './routes';
import { spool } from './spool';

http(
  'spool',
  toNodeListener((request) => spool.handle(request, page))
);
```

---

## 📊 Compatibility

The gate column says how far each row is checked. **runs** means the fixture above drives the
framework's own package. **stand-in** means a fixture calls the platform's handler with a plain
object where the platform would pass its context. **not tested** means the adapter column comes
from the framework's documentation and nothing here has run it.

| Framework or host                    | What a handler receives                                        | Spool entry                                                  | Gate                                         |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Express                              | Node `req`, `res`                                              | `toNodeListener`, `respond`, `decorate`                      | runs                                         |
| Fastify                              | Node `req.raw`, `reply.raw`; `reply.send` takes a `Response`   | `toRequest`, `respond`, `decorate`                           | runs                                         |
| Koa                                  | Node `ctx.req`, `ctx.res`                                      | `toRequest`, `writeResponse`                                 | runs                                         |
| hapi                                 | Node `request.raw.req`, `request.raw.res`                      | `toRequest`, `writeResponse`                                 | runs                                         |
| NestJS, Express adapter              | Node, through Express                                          | `app.use` with `toNodeListener`; `toRequest` in a controller | runs                                         |
| NestJS, Fastify adapter              | Node, through Fastify                                          | the Fastify entry                                            | not tested                                   |
| AdonisJS                             | Node at `ctx.request.request` and `ctx.response.response`      | `toRequest`, `writeResponse` in a middleware                 | not tested                                   |
| Hono                                 | Fetch                                                          | `handle`                                                     | runs                                         |
| Elysia                               | Fetch                                                          | `respond`, `decorate`                                        | runs                                         |
| itty-router                          | Fetch                                                          | `respond`, `decorate`                                        | runs                                         |
| Oak                                  | Fetch, through `app.handle`; published on JSR only             | `handle`                                                     | not tested                                   |
| h3, Nitro, Nuxt                      | Fetch, through `toWebRequest`                                  | `respond`, `handle`                                          | runs                                         |
| Analog                               | Nitro and h3 routes                                            | as Nuxt                                                      | not tested                                   |
| Next.js                              | Fetch                                                          | `respond` in the proxy, `handle` in the route                | runs                                         |
| SvelteKit                            | Fetch `event.request` in the `handle` hook                     | `handle(event.request, () => resolve(event))`                | not tested                                   |
| Astro                                | `context.request` in `onRequest(context, next)`                | `handle(context.request, () => next())`                      | not tested                                   |
| React Router v7, Remix               | Fetch `request` in `handleRequest` and the server build        | `handle` around the request handler                          | not tested                                   |
| TanStack Start                       | Fetch, in the server entry's `fetch(request)`                  | `handle(request, () => handler.fetch(request))`              | not tested                                   |
| SolidStart                           | an event in `onRequest` that may return a `Response`           | `respond` in the middleware                                  | not tested                                   |
| Qwik City                            | `requestEv` in `onRequest`; `send(Response)`                   | `respond` in the middleware                                  | not tested                                   |
| Cloudflare Workers                   | Fetch                                                          | `handle`                                                     | runs, in workerd                             |
| Cloudflare Pages Functions           | Fetch, in `onRequest(context)`                                 | `handle(request, () => context.next())`                      | stand-in                                     |
| Netlify Functions                    | Fetch                                                          | `handle`                                                     | stand-in                                     |
| Netlify Edge Functions               | Fetch; returning `undefined` passes on                         | `handle(request, () => context.next())`                      | stand-in                                     |
| Deno, Deno Deploy                    | Fetch, through `Deno.serve` or `deno serve`                    | `handle`                                                     | stand-in                                     |
| Bun                                  | Fetch                                                          | `handle`                                                     | runs, under `Bun.serve`                      |
| Vercel Functions                     | Fetch                                                          | `handle`                                                     | stand-in                                     |
| AWS Lambda, Function URL or HTTP API | JSON event version 2.0                                         | `hono/aws-lambda` around a Hono app                          | stand-in event                               |
| AWS Lambda, API Gateway REST API     | JSON event version 1.0                                         | `hono/aws-lambda` around a Hono app                          | not tested                                   |
| Lambda@Edge                          | CloudFront event with header arrays                            | none; a converter to `Request` is needed                     | not tested                                   |
| Fastly Compute                       | Fetch, through `event.request` in a `fetch` listener           | `event.respondWith(spool.handle(event.request, next))`       | not tested                                   |
| Azure Functions v4                   | `HttpRequest`, which follows Fetch; returns `HttpResponseInit` | convert, then `handle`                                       | runs, with a real `HttpRequest`              |
| Google Cloud Functions               | Node `req`, `res` from the Functions Framework                 | `toNodeListener`                                             | runs, on the Functions Framework test server |
| Google Cloud Run                     | any HTTP server on `PORT`                                      | the Node example                                             | not tested                                   |

A host that serves static files and runs no code, such as an object store or a plain web server, uses
[Static Sites](#-static-sites).

---

## 🧱 Static Sites

A site with no spool server can still answer repeat views from the device. It serves three files
from one directory:

- `spool-sw.js`, the worker, from a release or `https://cdn.drupflare.com/spool/<version>/`.
- `client.js`, the page script, from the same place.
- `spool.json`, the list of files the worker may keep.

Each page loads the script with the tag from [CDN Script](#-install), or from the site's own copy.
The worker has no server to talk to, so it reads `spool.json` from the directory its own script
sits in.

```json
{
  "schema": 1,
  "routes": [
    {
      "pattern": "/",
      "strategy": "static",
      "version": "sha256-<base64 digest of the page>",
      "freshness": { "maxStale": 3600, "mode": "soft" }
    },
    { "pattern": "/about", "strategy": "static", "version": "sha256-<base64 digest of the page>" },
    { "pattern": "/css/site.css", "strategy": "static", "version": "build-42" },
    {
      "pattern": "/client.js",
      "strategy": "static",
      "version": "sha384-<base64 digest of the file>"
    }
  ]
}
```

A route names one path, or a `:name` pattern whose paths share one version. `version` says what
the file is now:

- A `sha256-`, `sha384-` or `sha512-` value is checked against the bytes the worker fetched. A
  mismatch keeps nothing.
- An entity tag such as `"abc"` is checked against the response's `ETag`.
- Any other string is a label you change when the file changes.

The first view of a path goes to the network, and the worker keeps a copy of the response as it
arrives: the bytes and the headers, including any `Content-Security-Policy`. Later views of that
path make no request until the route's `maxStale` passes, which defaults to 15 minutes. After that
a `soft` route shows the copy and fetches `spool.json` once, and a `hard` route fetches it first.
A file whose version changed, or whose route left the manifest, is dropped and the next view
fetches it again. Set `sync` to `deferred` to wait for a request the page makes anyway, and
`offline` to `refuse` to keep a hard route from showing a copy it cannot check.

The worker keeps files up to 4 MiB and never a redirect or an error. It sends no analytics batches
and makes no request to `/.spool/*`. Serve `spool-sw.js` with `Cache-Control: max-age=86400`; that
header is what lets Chromium and Firefox skip the update check. To pin the script to the CDN, make
`/spool-sw.js` a one-line file:

```js
importScripts('https://cdn.drupflare.com/spool/<version>/spool-sw.js');
```

`importScripts` has no integrity check, so this form trusts the CDN host with the worker.

---

## 🔀 Strategies

A route is answered locally in one of five ways. A `template` route stores JSON and renders it
through a compiled template. An `assembly` route stores a shell with named holes, fragment markup
for the holes and values for named slots. A `static` route stores a file as the server sent it. A
`data` route stores JSON and answers a GET for it. A `projection` route stores JSON and renders a
page from it with a function your site bundles into its own worker.

```ts
import { placeholder, slot } from '@drupflare/spool/protocol';
import { defineRoute } from '@drupflare/spool/server';

export const about = defineRoute('/about', {
  strategy: 'assembly',
  depends: () => ['menu'],
  load: () => ({
    shell: `<!doctype html><html><head><title>About</title></head><body>${placeholder('menu')}<main>Updated ${slot('updated')}</main></body></html>`,
    fragments: { menu: '<nav><a href="/">Home</a></nav>' },
    slots: { updated: '2026-10-19' }
  })
});
```

The worker leaves a hole it cannot fill in place and refuses to render a page with a gap, so the
request goes to the network instead.

### Records and Projections

Pages that read the same data share one stored copy. `ctx.record(id, data)` stores an
authoritative value once under its id, and `ctx.projection(id, data)` stores a value derived from
records. Both return a reference to put in the page's data. A record's id is its invalidation tag.
Invalidating `course:101` refreshes the records and projections that read it, and no others.

```ts
import { defineRoute } from '@drupflare/spool/server';

const courses: Record<string, string> = { '101': 'Intro', '102': 'Advanced' };

export const course = defineRoute('/courses/:id', {
  strategy: 'template',
  template: {
    source: '<h1>{{title}}</h1><nav>{{#each menu}}<a>{{this}}</a>{{/each}}</nav>'
  },
  load: (ctx) => {
    const id = ctx.params['id'] ?? '';
    return {
      title: ctx.record(`course:${id}`, courses[id]),
      menu: ctx.projection(
        'menu',
        Object.keys(courses).map((key) => ctx.record(`course:${key}`, courses[key]))
      )
    };
  }
});
```

The server sends only the records and projections the device does not already hold at a current
version. A sync for the next page transfers the entries that page reads and that changed.

### Templates

Templates use Mustache-shaped syntax with no expressions, so the worker needs no `eval`.

| Syntax                               | Meaning                                                  |
| ------------------------------------ | -------------------------------------------------------- |
| `{{field}}`                          | the field, HTML-escaped; `a.b` reaches into objects      |
| `{{{field}}}`                        | the field as markup; allowed only for names in `trusted` |
| `{{#each list}}...{{/each}}`         | repeats for each item; `{{this}}` and `{{@index}}` work  |
| `{{#if field}}...{{else}}...{{/if}}` | renders a branch on whether the field is truthy          |
| `{{! note }}`                        | a comment that renders nothing                           |

```ts
import { defineRoute } from '@drupflare/spool/server';

export const news = defineRoute('/news/:slug', {
  strategy: 'template',
  template: {
    source:
      '<article><h1>{{title}}</h1>{{#if byline}}<p>{{byline}}</p>{{else}}<p>Staff</p>{{/if}}<div>{{{body}}}</div><ul>{{#each tags}}<li>{{@index}} {{this}}</li>{{/each}}</ul></article>',
    trusted: ['body']
  },
  depends: (ctx) => [`news:${ctx.params['slug']}`],
  load: () => ({
    title: 'Hello',
    byline: null,
    body: '<p>Trusted markup</p>',
    tags: ['a', 'b']
  })
});
```

A template that names a field it does not trust for markup fails when the route is declared.

### Static Files

A `static` route has no `load` and no template. The application serves the file as it always did,
and `handle` or `decorate` marks the response for the worker, which keeps the bytes. A tag in
`depends` ties the file to a deploy, and `spool.invalidate` after one makes devices fetch the
file again. A static route is always public and is always answered from the device, so it takes no
`scope`, `persist` or `mode`.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const about = defineRoute('/about', {
  strategy: 'static',
  depends: () => ['site'],
  freshness: { maxStale: 3600, mode: 'soft' }
});
```

### Projection and Data Routes

A `data` route answers a GET for JSON, such as an API read, from the stored value, so the page's
`fetch` makes no request. The worker answers with `JSON.stringify` of what `load` returned, which
means the application's own handler has to return the same JSON. A navigation to the URL still goes
to the network.

A `projection` route needs a renderer. Spool ships no bundler: write a worker with `serve` from
`@drupflare/spool/sw`, bundle it with your own toolchain, and pass the bundle to `createSpool` as
`worker`. The server puts the config in front of your bundle as `self.__SPOOL_CONFIG__`, and
`spool.config` is the same object as JSON if you would rather inline it at build time. A route with
no renderer is refused by the worker and the network answers.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const course = defineRoute('/api/courses/:id', {
  strategy: 'data',
  depends: (ctx) => [`course:${ctx.params['id']}`],
  load: (ctx) => ({ id: ctx.params['id'], title: 'Intro' }),
  provision: { reuse: 0.8, futureViews: 6 }
});

export const roster = defineRoute('/rosters/:id', {
  strategy: 'projection',
  depends: (ctx) => [`roster:${ctx.params['id']}`],
  load: (ctx) => ({ id: ctx.params['id'], names: ['Ada', 'Bo'] })
});
```

```ts
import { serve } from '@drupflare/spool/sw';

declare const CONFIG: string;

serve(JSON.parse(CONFIG), {
  '/rosters/:id': (artifact) => {
    const { names } = (artifact.body as { data: { names: string[] } }).data;
    return `<!doctype html><html><head><title>Roster</title></head><body><ul>${names.map((name) => `<li>${name}</li>`).join('')}</ul></body></html>`;
  }
});
```

The server also decides whether to send an artifact at all. It weighs the bytes it would send,
records included, against what a local view saves: reuse times future views times the bytes a view
avoids, less the cost of the request. When that is not positive it answers `204` with
`Spool-Provision: declined`, and the worker leaves that path to the network until it restarts.
The priors are scenario assumptions: set them from your own telemetry in `provision`, or per route
as above. A `data` route weighs against its own size, so it needs reuse times future views above

1. With the defaults of 0.5 and 2 it breaks even and is left out.

---

## ⏳ Freshness Contracts

Each route declares how long a stored page may go without validation. `maxStale` is in seconds.

- **hard:** once `maxStale` passes, the worker validates the page with the server before it
  shows it. Offline, the route's `offline` rule decides.
- **soft:** the worker shows the stored page at once and syncs afterward. A soft bound is a
  stale-while-revalidate window and promises nothing about how fresh the shown page is.

Public routes default to 15 minutes soft, and routes with `scope: 'principal'` to five minutes
hard; [Authenticated Data](#-authenticated-data) covers how their pages are stored. `offline`
defaults to `serve` for public routes and `refuse` for principal routes. A soft route may set `sync: 'deferred'` to queue its refresh
for the next network request that happens anyway.

```ts
import { defineRoute } from '@drupflare/spool/server';

export const stock = defineRoute('/stock/:sku', {
  strategy: 'template',
  template: { source: '<p>{{sku}}: {{count}}</p>' },
  depends: (ctx) => [`stock:${ctx.params['sku']}`],
  load: (ctx) => ({ sku: ctx.params['sku'], count: 3 }),
  freshness: { maxStale: 60, mode: 'hard' },
  offline: 'refuse'
});

export const notice = defineRoute('/notices/:id', {
  strategy: 'template',
  template: { source: '<p>{{text}}</p>' },
  depends: (ctx) => [`notice:${ctx.params['id']}`],
  load: () => ({ text: 'Closed on Friday' }),
  freshness: { maxStale: 3600, mode: 'soft' },
  sync: 'deferred'
});
```

The worker syncs the smallest set of changed dependencies the next page needs. One worker
leads the sync for every tab of an origin. A response to a request that happens anyway can carry
invalidations, so a sync does not always need a request of its own.

---

## 🔐 Authenticated Data

Set `scope: 'principal'` on a route that depends on who is signed in, and give `createSpool` an
`identity` option. The server sends `Spool-Partition`, an HMAC of the principal under your secret,
so the browser can tell users apart without learning who they are. The worker keeps each partition
in its own IndexedDB database with the artifacts, records, projections and sync state sealed with
AES-GCM. Each value is bound to its partition, kind and id, so a row copied into another slot does
not decrypt.

`retention` picks the key. `persistent` is a non-extractable key in IndexedDB that survives a
restart and is deleted on logout or a change of partition. `session`, the default, is a key held in
the worker's memory, which the browser discards when it stops the worker. Deleting a key makes what
it sealed unreadable, which is crypto-shredding of data at rest. It does not protect against script
running on your origin, which can ask the worker for whatever the page can. The ids and versions
that serve as storage keys stay readable, so use opaque ids for anything sensitive.

A principal route defaults to a five-minute hard bound and `offline: 'refuse'`. Revocation rides
the same bound: tag a page with the permission it needs, call `spool.invalidate` when the
permission goes, and the first required sync past the bound finds the page invalid.

A different `Spool-Partition` wipes the partition before it. A login or account-switch handler has
to send the new value itself with `spool.partition(principal)`, because the request it answers
still carries the old identity. Paths in `logout` are wiped when the request reaches the worker,
before it is sent, so logout empties every tab even with the network down. The page runtime
dispatches a `spool:cleared` event on `window` in every tab when that happens, so a page can blank
what it shows. A response can also send
`Spool-Clear`: `*` wipes everything, a partition id wipes one. `decorate(request, response, { clear:
['*'], hardReset: true })` adds `Clear-Site-Data: "storage"` as well, the browser's own reset
of everything the origin holds, service worker included. Its Safari support is unverified, so rely
on the worker's wipe.

```ts
import { createSpool, defineRoute } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';

export const grades = defineRoute('/grades', {
  strategy: 'template',
  scope: 'principal',
  retention: 'persistent',
  template: { source: '<h1>Grades for {{owner}}</h1>' },
  depends: (ctx) => [`perm:${ctx.identity?.principal}`, `grades:${ctx.identity?.principal}`],
  load: (ctx) => ({ owner: ctx.identity?.principal })
});

export const spool = createSpool({
  routes: [grades],
  store: memoryStore(),
  identity: {
    secret: 'a long random value kept on the server',
    resolve: (request) => {
      const user = /user=(\w+)/.exec(request.headers.get('cookie') ?? '')?.[1];
      return user ? { principal: user } : null;
    }
  },
  logout: ['/logout']
});

export async function login(user: string): Promise<Response> {
  return new Response('Signed in', {
    headers: {
      'set-cookie': `user=${user}; Path=/`,
      'spool-partition': await spool.partition(user)
    }
  });
}
```

A sync that asks for everything changed lists the tags of every change, so tags for principal data
should be opaque too. The worker syncs a principal page with `need`, which names only the tags
that page reads.

---

## 📡 Analytics Batching

A page that keeps analytics scripts posting to an endpoint makes a request on every view, which
defeats a local view. List the same-origin POST paths in `beacons`. The worker answers each post
with a `204` and queues it in IndexedDB. At the next network request that happens anyway it sends
the post to the URL the page meant, with its method, content type, query and body, so the vendor
receives what the page sent. Spool's own events go to `/.spool/beacon` in one batch, where a
`sink` receives them. A held post goes out on its own at most once every 24 hours, when the oldest
is a day old. A body over 64 KiB, counted in bytes, or a binary body goes to the network at once.
Firefox does not route `fetch` calls made with `keepalive: true` through the worker, so a script
that posts that way is not queued there.

```ts
import { createSpool, jsonLinesSink } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  beacons: ['/cdn-cgi/rum'],
  sink: jsonLinesSink((line) => console.log(line))
});
```

`jsonLinesSink` writes one JSON line per event. `analyticsEngineSink` writes to a Workers
Analytics Engine dataset, splitting a long body across data points so nothing is cut off, and
`memorySink` keeps events for tests. The worker also queues one
`spool.view` event per page view with the tier, the reason and the staleness. `viewsOf` reads
those events back. Set `views: false` to turn that off. `workSeries` records how long each route's
handler took, for peak-work reports.

### Collectors

A `collectors` entry holds requests to another origin, such as an analytics host. The page gets an
empty answer at once and the request leaves at a network moment, inside `maxAgeMs`. An event past
the cap is dropped, never sent late, and each drop is counted and written to the sink as
`/.spool/dropped`. With `delivery: 'replay'` the worker sends the held request to the vendor with no
cookies, so identity has to be in the payload, and `stamp` writes the event's time into a query
parameter for a vendor that takes one. With `delivery: 'sink'` the server half forwards it.

GA4's browser collector takes no backdating. The Measurement Protocol accepts events with their
own timestamps up to 72 hours old and wants them within 48 hours to attribute them, and it needs an
API secret the page must not hold. `GA4_COLLECTOR` holds the `g/collect` hit for 48 hours and
`ga4Sink` sends it as a Measurement Protocol request carrying the original `timestamp_micros`.
`ga4Sink` checks its requests against the rules spool knows (`mpViolations`); set `debug: true` to
send them to `/debug/mp/collect` with your own measurement id and secret. Spool holds events
whether or not the visitor consented, so gate the analytics tag itself, and ask your counsel
whether holding an event in IndexedDB needs consent where you operate. Programmatic ads are never
held, replayed or answered locally.

```ts
import { GA4_COLLECTOR } from '@drupflare/spool/protocol';
import { combineSinks, createSpool, ga4Sink, jsonLinesSink } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  collectors: [
    GA4_COLLECTOR,
    {
      vendor: 'matomo',
      match: 'https://stats.example.edu/matomo.php',
      maxAgeMs: 23 * 3_600_000,
      delivery: 'replay',
      stamp: { param: 'cdt', kind: 'datetime-utc' }
    }
  ],
  sink: combineSinks(
    jsonLinesSink((line) => console.log(line)),
    ga4Sink({ measurementId: 'G-XXXXXXXXXX', apiSecret: 'kept on the server' })
  )
});
```

---

## 🧷 Third-Party Files

A view that loads a file from another origin is not zero-network. The page reports, when it is
hidden, how many cross-origin resources it loaded and from which origins (origins only, never
paths). `thirdPartyReport` reads those reports from `viewsOf` and ranks the origins by the views
each one alone blocks, with a class and a remedy from a short table you can replace. The counts
are an upper bound on network requests, since a cross-origin timing entry says nothing about cache
hits without `Timing-Allow-Origin`.

The opt-in `thirdParty` cache removes the request for files that name their own bytes. List the
origins in `allow`. The worker learns a file from the first view and keeps it only when the URL
carries a hash, a version or a `/v12/` segment, or the origin marks it immutable. A file versioned
only by a query parameter is checked again at a network moment once it is a day old. It keeps
nothing else, and nothing it cannot read: an opaque response counts about 7 MB against quota in
Chromium, so `allowOpaque` is off by default. WebKit does not send font requests from a stylesheet
through the worker, so fonts stay on the network there.

```ts
import { thirdPartyReport } from '@drupflare/spool/report';
import { createSpool, memorySink, viewsOf } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

const sink = memorySink();

export const spool = createSpool({
  routes,
  store: memoryStore(),
  sink,
  thirdParty: {
    allow: ['https://fonts.gstatic.com', 'https://cdn.example.edu'],
    maxEntries: 32
  }
});

export const report = () => thirdPartyReport(viewsOf(sink.events));
```

---

## ⚡ Subresource Handling

By default the worker answers an immutable same-origin asset from CacheStorage. `assets` changes
that. `passthrough` leaves assets to the browser's cache and never touches them. `static-routing`
asks the browser through `InstallEvent.addRoutes` to send only navigations, beacons and routed
paths to the worker and the rest of the origin to the network, and acts as `passthrough` where the
API does not exist: Chromium and WebKit have it in the Playwright builds spool is tested with,
Firefox does not. Both options cut the service worker's fetch events (Static Routing took them from
32 to 3 per view on a desktop Chromium rig); neither changes server-side Worker invocations. Neither is measured to save energy. In the same run, new-tab views drew 2.78 J,
2.83 J and 2.84 J of RAPL package energy above idle with CacheStorage, navigation-only handling
and Static Routing (8 rounds each), and the ranges overlap. Under Static Routing a same-origin write no
longer reaches the worker, so it is not a network moment and its response cannot carry
invalidations; navigations still are.

```ts
import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const spool = createSpool({
  routes,
  store: memoryStore(),
  assets: 'static-routing'
});
```

---

## 🔍 Shadow Mode

In shadow mode the worker decides whether it could serve a page locally, renders it, still fetches
the page from the server, compares the two with `normalise` and reports the result. It never
serves the local page. Use it to measure eligibility and mismatches on real traffic before turning
serving on. A `static` route has no shadow comparison.

```ts
import { createSpool } from '@drupflare/spool/server';
import { memoryStore } from '@drupflare/spool/stores';
import { routes } from './routes';

export const shadowed = createSpool({ routes, store: memoryStore(), mode: 'shadow' });
export const canary = createSpool({ routes, store: memoryStore(), shadowSample: 0.05 });
```

`mode: 'shadow'` applies to every route that does not name its own `mode`. `shadowSample` keeps a
share of views in shadow while the rest are served, which gives a standing canary. A mismatch
names its route, so a route whose template and application disagree shows up before a visitor
sees it. The worker records the shadow comparison for navigations only. Subresources and other
requests keep the browser's own path.

---

## 🔌 Proxy Mode

`spoolProxy` fronts an origin that cannot load the library, such as PHP, Drupal with no module,
or anything else that speaks HTTP. It returns a Fetch handler. The proxy answers `/.spool/*` and
`/spool-sw.js`. Every other request goes to the origin with its method, headers and body, and a
redirect is passed on, not followed. A page the proxy may keep is decorated like a `createSpool`
response, so the worker stores it and answers later views with no request.

`spool` takes the options `createSpool` takes, minus `routes`. The proxy adds one public
`assembly` route that matches every path (`/**`) and uses the origin's finished HTML as the
artifact. `routes` lists overrides, such as a shorter freshness bound for one pattern. They
match first and take the same fields as `defineRoute`, without `load`.

On Node the handler goes through `toNodeListener`. `origin` is the address of the real server
and has no path.

```ts
import { createServer } from 'node:http';
import { toNodeListener } from '@drupflare/spool/node';
import { spoolProxy } from '@drupflare/spool/proxy';
import { memoryStore } from '@drupflare/spool/stores';

const proxy = spoolProxy({
  origin: process.env['ORIGIN'] as string,
  spool: { store: memoryStore() },
  purgeSecret: process.env['PURGE_SECRET']
});

export const server = createServer(toNodeListener(proxy));
```

On Workers the proxy is built once per isolate and keeps the version vector in a Durable Object,
bound as in [Cloudflare Workers](#cloudflare-workers). Set the purge secret with
`wrangler secret put PURGE_SECRET`.

```ts
import { spoolProxy, type SpoolProxy } from '@drupflare/spool/proxy';
import { durableObjectStore } from '@drupflare/spool/stores/durable-object';

export { SpoolVersions } from '@drupflare/spool/stores/durable-object';

let proxy: SpoolProxy | undefined;

export default {
  fetch(request: Request, env: Cloudflare.Env) {
    proxy ??= spoolProxy({
      origin: 'https://origin.example.edu',
      spool: { store: durableObjectStore(env.SPOOL_VERSIONS) },
      purgeSecret: env.PURGE_SECRET
    });
    return proxy(request);
  }
};
```

### Tags

The tags the origin sends become the page's dependencies. The proxy reads `Cache-Tag` (comma
separated), `Surrogate-Key` and `X-Drupal-Cache-Tags` (space separated) and `xkey` (spaces or
commas), then removes them from the response unless `exposeTags` is true. A page with no tags
depends on one tag derived from its path.

### Eligibility

The proxy keeps a response only when all of these hold:

- the request is a GET or HEAD, has no query string and no `Authorization` header, and carries
  no cookie outside `publicCookies`, which is empty by default
- the response is a 200 `text/html`, or the answer of a `data` route
- the response sets no cookie outside `publicCookies`, has no `private` or `no-store` in
  `Cache-Control`, a `Vary` that names only `Accept-Encoding` and `Cookie`, no more than
  `maxTags` tags and no more than `maxBytes` bytes

Everything else is forwarded untouched. A page the proxy declines tells the worker to drop its
copy of that path, and a response that sets a cookie outside `publicCookies` tells the worker to
clear everything it holds, so a login leaves no anonymous copy to show. Put cookies that carry no
identity on the list, such as a bot-check or load-balancer cookie set on every response; otherwise
proxy mode never keeps a page on that site. Writes always go to the origin and are never
answered locally.

Principal routes are off unless `spool.identity` is set. With it, a route declared
`scope: 'principal'` follows the partitions in [Authenticated Data](#-authenticated-data). The
cookie, `Authorization` and `private` rules do not apply to it. `Set-Cookie` and `no-store`
still do.

### Invalidation

Two signals reach the proxy. When a page it forwards differs from the last body it saw, it bumps
that page's tags. The proxy hashes the body after `normalise`, and `ignore` takes patterns to
blank, such as a per-render form token. `POST /.spool/purge` bumps the tags it is given, so a CMS
hook or Drupal's purge module can call it. It needs `Authorization: Bearer <purgeSecret>` and a
JSON body, and it refuses every call when no secret is set.

```sh
curl -X POST https://example.edu/.spool/purge \
  -H "Authorization: Bearer $PURGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tags": ["node:1", "config:system.menu.main"]}'
```

### Limits

The proxy sees finished HTML, not the database behind it. An artifact is a whole page, the
replica holds no records, and two pages never share a fragment. A page stays on a device until its
route's `maxStale` passes and the next sync reports a change, so freshness is bounded by
`maxStale` plus the time a purge takes to arrive.

A tag shared by many pages invalidates all of them when one changes. The remembered bodies live
in the instance: a restart forgets them, and each instance of a scaled-out proxy keeps its own.
A whole page is a large artifact, and the provisioning rule declines one that costs more than the
priors say it saves, so set `provision` on the spool for large pages. A `Content-Security-Policy`
that allows only nonce or hash scripts blocks the injected client tag. A URL with a query string
always goes to the origin.

---

## 🚫 Out of Scope

- spool never authorises on the client. The device holds only what the server already sent that
  principal.
- It never shows a hard route past its bound without validating it first.
- It never writes. Your application owns every write, and `invalidate` only announces one.
- It never infers dependencies from opaque HTML. A route names its tags, or the records it
  reads, and in proxy mode the origin names them in its cache tag headers.
- It never replaces a published release file on the CDN.

---

## 🌐 Browser Support

| Engine   | Controlled navigation                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Chromium | no request, new tabs included                                                                                      |
| Firefox  | no request, new tabs included                                                                                      |
| WebKit   | one request to re-check `/spool-sw.js`, and one refetch of each cacheable subresource on the first controlled load |

The worker registers with `updateViaCache: 'all'` and the script is served at
`max-age=86400`, which is what lets Chromium and Firefox skip the update check. A deploy changes
the script bytes and reaches a browser within that day. A browser without service workers gets the
page it always got.

A page that loads a resource from another origin is not a zero-request view. spool counts those
loads per view and reports the view as such.

---

## 🧭 Subpath Exports

| Import                                   | What is in it                                                        |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `@drupflare/spool`                       | the protocol and report modules                                      |
| `@drupflare/spool/protocol`              | envelopes, artifacts, patterns, templates, the manifest, view events |
| `@drupflare/spool/server`                | `createSpool`, `defineRoute`, sinks, identity and work series        |
| `@drupflare/spool/node`                  | `toNodeListener`, `toRequest`, `writeResponse`                       |
| `@drupflare/spool/proxy`                 | `spoolProxy`, the tag readers and the eligibility verdict            |
| `@drupflare/spool/stores`                | `memoryStore` and the `VersionStore` type                            |
| `@drupflare/spool/stores/durable-object` | `durableObjectStore` and the `SpoolVersions` class                   |
| `@drupflare/spool/sw`                    | `serve`, for a site that bundles its own worker                      |
| `@drupflare/spool/client`                | `register` and the page handle                                       |
| `@drupflare/spool/report`                | the energy model                                                     |

---

## 🧪 Testing

```sh
bun run typecheck
bun run test
bun run test:coverage
bun run test:browser
bun run prettier:check
bun run docs:build
bun run build
```

`test` runs the unit project in workerd and the node project, which includes a test that packs the
package and imports every subpath in plain Node. `test:browser` runs Chromium, Firefox and WebKit
against real servers and counts the requests that reach them. `bunx playwright install chromium
firefox webkit` fetches the browsers.

---

## 🔗 Related Repositories

| Repository                                                      | What it is                                               |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| [`drupflare/worker`](https://github.com/drupflare/worker)       | Drupal on Cloudflare Workers                             |
| [`drupflare/cartridge`](https://github.com/drupflare/cartridge) | runs a blocking wasm interpreter inside a Durable Object |
| [`drupflare/durabledb`](https://github.com/drupflare/durabledb) | the limits of Durable Object SQLite, encoded as a codec  |
| [`drupflare/burrow`](https://github.com/drupflare/burrow)       | executes WebAssembly on Workers                          |

---

## 📄 License

MIT (c) Gregory Mitchell 2026. See [LICENSE](LICENSE).
