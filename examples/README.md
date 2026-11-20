# Examples

The examples show `@drupflare/spool` running on the runtimes it supports, and every adapter under `courses/` serves the same small courses site.

The directory is organised by site, then by runtime. `courses/<adapter>/` is the primary corpus. `campus/`, `blog/`, `homepage/`, `dashboard/` and `static/` are larger sites, each with its own README and runtime folders.

To run an example, install its dependencies in the example's folder, then run the command its README gives.

## Layout

```text
examples/
  courses/            primary corpus: one site, one folder per adapter
    shared/           the courses site
    <adapter>/        one runtime each (see Runtimes)
  campus/             larger site, Node and Cloudflare Workers
    shared/
    node/
    cloudflare-worker/
  blog/               read-heavy site, publish deltas
    shared/
    node/
    cloudflare-worker/
  homepage/           simulated college homepage, per-route freshness
    shared/
    node/
    cloudflare-worker/
    nuxt/
    next/
  dashboard/          write-heavy team board, declared writes
    shared/
    node/
    cloudflare-worker/
    express/
    hono/
    netlify-functions/
    nuxt/
    next/
  static/             changelog site, the stub, runtime and packs served as static files
    shared/
    node/
    cloudflare-worker/
    vite-vue/         Vite and Vue Router single-page app, spool files in dist/
    nuxt/             Nuxt 4 SSR build, spool files in .output/public
```

## Runtimes

Paths are relative to `examples/`. Run commands assume the folder is the current directory. The `shared/` folders hold site code and have no run command.

The Check column names the check that runs each folder. `spec` is `tests/node/examples.spec.ts`. `smoke` is `bun run smoke:examples`, which starts the folder and probes it. `both` is both.

| Folder                            | Runtime                                       | Follows                                                                      | Run                                                                  | Check |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----- |
| `courses/aws-lambda/`             | AWS Lambda, Hono adapter                      | [AWS Lambda](../docs/adapters/aws-lambda.md)                                 | Tested through its handler                                           | spec  |
| `courses/azure-functions/`        | Azure Functions v4 HTTP trigger               | [Azure Functions](../docs/adapters/azure-functions.md)                       | `func start`                                                         | spec  |
| `courses/bun/`                    | Bun                                           | [Bun](../docs/adapters/bun.md)                                               | `bun bun.ts`                                                         | spec  |
| `courses/cloudflare-pages/`       | Cloudflare Pages Functions                    | [Cloudflare Pages Functions](../docs/adapters/cloudflare-pages-functions.md) | `npx wrangler pages dev <build directory>`, in a Pages project       | both  |
| `courses/cloudflare-worker/`      | Cloudflare Worker                             | [Cloudflare Workers](../docs/adapters/cloudflare-workers.md)                 | `npx wrangler dev`                                                   | both  |
| `courses/deno/`                   | Deno                                          | [Deno](../docs/adapters/deno.md)                                             | `deno serve deno.ts`                                                 | spec  |
| `courses/elysia/`                 | Elysia                                        | [Elysia](../docs/adapters/elysia.md)                                         | `bun elysia.ts`                                                      | spec  |
| `courses/express/`                | Express 5                                     | [Express](../docs/adapters/express.md)                                       | `node app.ts`                                                        | spec  |
| `courses/fastify/`                | Fastify 5                                     | [Fastify](../docs/adapters/fastify.md)                                       | `node fastify.ts`                                                    | spec  |
| `courses/google-cloud-functions/` | Google Cloud Functions                        | [Google Cloud Functions](../docs/adapters/google-cloud-functions.md)         | `npx functions-framework --target=spool`                             | spec  |
| `courses/hapi/`                   | hapi                                          | [hapi](../docs/adapters/hapi.md)                                             | `node hapi.ts`                                                       | spec  |
| `courses/hono/`                   | Hono                                          | [Hono](../docs/adapters/hono.md)                                             | `bun app.ts`                                                         | spec  |
| `courses/itty-router/`            | itty-router                                   | [itty-router](../docs/adapters/itty-router.md)                               | `bun itty-router.ts`                                                 | spec  |
| `courses/koa/`                    | Koa 3                                         | [Koa](../docs/adapters/koa.md)                                               | `node koa.ts`                                                        | spec  |
| `courses/nestjs/`                 | NestJS 12 on Express                          | [NestJS](../docs/adapters/nestjs.md)                                         | `npx tsx nest.ts`                                                    | spec  |
| `courses/netlify-edge/`           | Netlify Edge Functions                        | [Netlify Edge Functions](../docs/adapters/netlify-edge-functions.md)         | `netlify dev`, in a Netlify project                                  | spec  |
| `courses/netlify-functions/`      | Netlify Functions                             | [Netlify Functions](../docs/adapters/netlify-functions.md)                   | `netlify dev`, in a Netlify project                                  | spec  |
| `courses/next-proxy/`             | Next.js 16 proxy                              | [Next.js](../docs/adapters/nextjs.md)                                        | `next dev`, in a Next.js project                                     | spec  |
| `courses/next-route/`             | Next.js 16 route handler                      | [Next.js](../docs/adapters/nextjs.md)                                        | `next dev`, in a Next.js project                                     | spec  |
| `courses/node/`                   | `node:http`                                   | [Node](../docs/adapters/node.md)                                             | `node server.ts`                                                     | spec  |
| `courses/nuxt-middleware/`        | Nuxt 4 server middleware                      | [Nuxt and Nitro](../docs/adapters/nuxt-and-nitro.md)                         | `npx nuxi dev`, in a Nuxt project                                    | spec  |
| `courses/nuxt-route/`             | Nuxt 4 Nitro route                            | [Nuxt and Nitro](../docs/adapters/nuxt-and-nitro.md)                         | `npx nuxi dev`, in a Nuxt project                                    | spec  |
| `courses/proxy/`                  | `spoolProxy` in front of a `node:http` origin | [Proxy Mode](../ADVANCED_USAGE.md#proxy-mode)                                | `node proxy-node.ts`                                                 | spec  |
| `courses/vercel/`                 | Vercel Functions                              | [Vercel Functions](../docs/adapters/vercel-functions.md)                     | `vercel dev`, or `PORT=3000 bun api/index.ts` locally                | spec  |
| `campus/node/`                    | `node:http`                                   | [Node](../docs/adapters/node.md)                                             | `node server.ts`                                                     | spec  |
| `campus/cloudflare-worker/`       | Cloudflare Worker                             | [Cloudflare Workers](../docs/adapters/cloudflare-workers.md)                 | `npx wrangler dev`                                                   | both  |
| `blog/node/`                      | `node:http`                                   | [Node](../docs/adapters/node.md)                                             | `node server.ts`                                                     | spec  |
| `blog/cloudflare-worker/`         | Cloudflare Worker                             | [Cloudflare Workers](../docs/adapters/cloudflare-workers.md)                 | `npx wrangler dev`                                                   | both  |
| `homepage/node/`                  | `node:http`                                   | [Node](../docs/adapters/node.md)                                             | `node server.ts`                                                     | spec  |
| `homepage/cloudflare-worker/`     | Cloudflare Worker                             | [Cloudflare Workers](../docs/adapters/cloudflare-workers.md)                 | `npx wrangler dev`                                                   | both  |
| `homepage/nuxt/`                  | Nuxt 4                                        | [Nuxt Module](../docs/adapters/nuxt-module.md)                               | `npx nuxi dev`, after `npm install`                                  | smoke |
| `homepage/next/`                  | Next.js 16 adapter                            | [Next Adapter](../docs/adapters/next-adapter.md)                             | `npx next build`, then `node server.ts`                              | smoke |
| `dashboard/node/`                 | `node:http`                                   | [Node](../docs/adapters/node.md)                                             | `node server.ts`                                                     | spec  |
| `dashboard/cloudflare-worker/`    | Cloudflare Worker                             | [Cloudflare Workers](../docs/adapters/cloudflare-workers.md)                 | `npx wrangler dev`                                                   | both  |
| `dashboard/express/`              | Express 5                                     | [Express](../docs/adapters/express.md)                                       | `node app.ts`                                                        | spec  |
| `dashboard/hono/`                 | Hono                                          | [Hono](../docs/adapters/hono.md)                                             | `bun app.ts`                                                         | spec  |
| `dashboard/netlify-functions/`    | Netlify Functions                             | [Netlify Functions](../docs/adapters/netlify-functions.md)                   | `netlify dev`, in a Netlify project                                  | spec  |
| `dashboard/nuxt/`                 | Nuxt 4 Nitro routes                           | [Nuxt Module](../docs/adapters/nuxt-module.md)                               | `npx nuxt build`, then `node .output/server/index.mjs`               | smoke |
| `dashboard/next/`                 | Next.js 16 route handler                      | [Next Adapter](../docs/adapters/next-adapter.md)                             | `npx next build`, then `node server.ts`                              | smoke |
| `static/node/`                    | `node:http` with a static folder in front     | [Static Tier](../docs/protocol.md#static-tier)                               | `node publish.ts`, then `node server.ts`                             | spec  |
| `static/cloudflare-worker/`       | Cloudflare Worker with static assets          | [Static Tier](../docs/protocol.md#static-tier)                               | `node publish.ts`, then `npx wrangler dev`                           | both  |
| `static/vite-vue/`                | Vite and Vue Router app, `dist/` as the host  | [Vue](../docs/adapters/vue.md)                                               | `npx vite build`, `node publish.ts`, `node server.ts`                | smoke |
| `static/nuxt/`                    | Nuxt 4 SSR build, `.output/public` as host    | [Nuxt Module](../docs/adapters/nuxt-module.md)                               | `node publish.ts`, `npx nuxt build`, `node .output/server/index.mjs` | smoke |

## Shared Site

`courses/shared/site.ts` holds the courses site. `courses(count)` returns the rows; ids start at 101, and the first three titles are fixed. `courseSpool(count)` builds the `courses` dataset into a pack at version 1 and returns `{ spool, page }`.

The site has a course list at `/courses`, an item route at `/courses/:id`, and a `/ping` route that spool passes through unchanged. The pack is served from `/.spool/bundle/1`.

## Advanced

`campus/` is the bigger site: more routing and authenticated routes. It runs on Node (`campus/node/`) and Cloudflare Workers (`campus/cloudflare-worker/`) only. Both runtimes import `campus/shared/site.ts`.

The public routes follow [Strategies](../ADVANCED_USAGE.md#strategies), [Query Routes](../ADVANCED_USAGE.md#query-routes), [Projection and Data Routes](../ADVANCED_USAGE.md#projection-and-data-routes), [Freshness Contracts](../ADVANCED_USAGE.md#freshness-contracts) and [Datasets](../ADVANCED_USAGE.md#datasets). The signed-in routes, `/account` and `/classmates/:id`, follow [Principal Datasets](../ADVANCED_USAGE.md#principal-datasets) and [Authenticated Data](../ADVANCED_USAGE.md#authenticated-data). Login is `POST /login?as=ada`, and the identity comes from a `user` cookie.

## Other Sites

- `blog/` is a read-heavy site with posts, authors and tags. `addPost` publishes a new pack version, and a device that holds the previous version receives only the change. The routes follow [Strategies](../ADVANCED_USAGE.md#strategies), [Dataset Routes](../ADVANCED_USAGE.md#dataset-routes), [Query Routes](../ADVANCED_USAGE.md#query-routes) and [Datasets](../ADVANCED_USAGE.md#datasets).
- `homepage/` is a simulated college homepage. `updateEvent` changes one event row and publishes a new pack. The routes follow [Strategies](../ADVANCED_USAGE.md#strategies), [Query Routes](../ADVANCED_USAGE.md#query-routes), [Projection and Data Routes](../ADVANCED_USAGE.md#projection-and-data-routes), [Freshness Contracts](../ADVANCED_USAGE.md#freshness-contracts) and [Datasets](../ADVANCED_USAGE.md#datasets).
- `dashboard/` is a write-heavy team board of projects, tasks and members. Each write answers with `Spool-Delta`. The runtimes follow [Declared Writes](../ADVANCED_USAGE.md#declared-writes), [Authenticated Data](../ADVANCED_USAGE.md#authenticated-data), [Datasets](../ADVANCED_USAGE.md#datasets) and [Strategies](../ADVANCED_USAGE.md#strategies).
- `static/` is a changelog site whose stub, page runtime and packs are written to a folder by `spool.publishStatic` and served as files, so the host answers them with no handler call. Documents still come from the origin. The runtimes follow [Static Tier](../docs/protocol.md#static-tier). `static/vite-vue/` and `static/nuxt/` put the same files beside a Vite and a Nuxt build; `static/vite-vue/` has the Results table for the three arms.

## Tests

`tests/node/examples.spec.ts` boots each `spec` folder through its exports and asserts exact counts, such as the rows in a pack.

`bun run smoke:examples` builds and starts each folder with a smoke check, then checks the page, the worker script, the client and the spool paths. The Nuxt and Next dashboards also check a declared write. The script skips a folder whose `node_modules` is missing and prints the install command.

```sh
bunx vitest run tests/node/examples.spec.ts
bun run smoke:examples
```

`bun run test` runs the spec file with the other Node tests.
