# Adapters

Each adapter is one page. The `routes`, `page` and `spool` in every example come from the
[Quick Start](../../README.md#quick-start). The [compatibility table](../../README.md#compatibility)
lists what each framework hands a handler.

Pick the adapter for your runtime. A runtime that takes a Fetch `fetch(request)` handler needs no
adapter beyond `spool.handle`. The Node adapter covers any `node:http` server.

| Adapter                                                     | Import                                    | What it needs                                                     | File                            |
| ----------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| [Cloudflare Workers](cloudflare-workers.md)                 | `@drupflare/spool/stores/durable-object`  | A Durable Object binding for the version vector                   | `cloudflare-workers.md`         |
| [Cloudflare Pages Functions](cloudflare-pages-functions.md) | none (`spool.handle`)                     | A function that calls `next()` for the static asset               | `cloudflare-pages-functions.md` |
| [Hono](hono.md)                                             | `@drupflare/spool/hono`                   | `app.use('*', spoolHono(spool))` before the routes                | `hono.md`                       |
| [Elysia](elysia.md)                                         | none (`spool.respond`, `spool.decorate`)  | An `async` `onRequest` hook                                       | `elysia.md`                     |
| [itty-router](itty-router.md)                               | none (`spool.respond`, `spool.decorate`)  | A route that returns `undefined` for non-spool requests           | `itty-router.md`                |
| [Bun](bun.md)                                               | none (`spool.handle`)                     | A default export with `fetch`                                     | `bun.md`                        |
| [Deno](deno.md)                                             | none (`spool.handle`)                     | A default export with `fetch`, run with `deno serve`              | `deno.md`                       |
| [Netlify Functions](netlify-functions.md)                   | none (`spool.handle`)                     | `config.path` that sends the spool paths and pages                | `netlify-functions.md`          |
| [Netlify Edge Functions](netlify-edge-functions.md)         | none (`spool.handle`)                     | `context.next()` for the site's response                          | `netlify-edge-functions.md`     |
| [Vercel Functions](vercel-functions.md)                     | none (`spool.handle`)                     | A `vercel.json` rewrite and a shared `VersionStore`               | `vercel-functions.md`           |
| [Next.js](nextjs.md)                                        | none (`spool.handle`, `spool.respond`)    | A `proxy` export and a route handler sharing one store            | `nextjs.md`                     |
| [Nuxt and Nitro](nuxt-and-nitro.md)                         | none (`spool.handle`, `spool.respond`)    | h3 `toWebRequest` in a middleware and a route                     | `nuxt-and-nitro.md`             |
| [Nuxt Module](nuxt-module.md)                               | `@drupflare/spool/nuxt`                   | `nuxt` and `@nuxt/kit`, and a `spool` module path                 | `nuxt-module.md`                |
| [React Router](react-router.md)                             | `@drupflare/spool/react-router`           | The route array and `react-router.config.ts`                      | `react-router.md`               |
| [Next Adapter](next-adapter.md)                             | `@drupflare/spool/next`                   | `adapterPath` in `next.config`, and the layout and route handlers | `next-adapter.md`               |
| [Vite](vite.md)                                             | `@drupflare/spool/vite`                   | A `spoolVite({ spool })` plugin in the dev server                 | `vite.md`                       |
| [Vue](vue.md)                                               | `@drupflare/spool/vue`                    | A vue-router instance for `spoolVue`                              | `vue.md`                        |
| [Angular](angular.md)                                       | `@drupflare/spool/angular`                | The `Routes` array and `serverRoutes`                             | `angular.md`                    |
| [AWS Lambda](aws-lambda.md)                                 | `@hono/aws-lambda`, with the Hono adapter | A Lambda handler around the Hono app                              | `aws-lambda.md`                 |
| [Azure Functions](azure-functions.md)                       | none (`spool.handle`)                     | An HTTP trigger routed with `{*path}`                             | `azure-functions.md`            |
| [Node](node.md)                                             | `@drupflare/spool/node`                   | Nothing beyond `node:http`                                        | `node.md`                       |
| [Express](express.md)                                       | `@drupflare/spool/express`                | `app.use(spoolExpress(spool))` before the routes                  | `express.md`                    |
| [Fastify](fastify.md)                                       | `@drupflare/spool/node`                   | An `onRequest` hook                                               | `fastify.md`                    |
| [Koa](koa.md)                                               | `@drupflare/spool/node`                   | `ctx.respond = false` before writing                              | `koa.md`                        |
| [hapi](hapi.md)                                             | `@drupflare/spool/node`                   | An `onRequest` extension and `h.abandon`                          | `hapi.md`                       |
| [NestJS](nestjs.md)                                         | `@drupflare/spool/node`                   | The Express adapter and `experimentalDecorators`                  | `nestjs.md`                     |
| [Google Cloud Functions](google-cloud-functions.md)         | `@drupflare/spool/node`                   | The Functions Framework `http` registration                       | `google-cloud-functions.md`     |
