# Campus portal example

A campus portal with a public part and a signed-in part. Both parts are defined once in
`shared/site.ts` and served by two runtimes: `node/` (`node:http` through `toNodeListener`) and
`cloudflare-worker/` (a Worker `fetch` export).

The public part serves courses, people and news from three public datasets, built into one pack
at version 1 and served from `/.spool/bundle/1`. It has a template list and item routes, a query
route with a department filter and pages, nested news paths, a projection route, a data route and a
static stylesheet. The signed-in part serves `/account` and `/classmates/:id`, with login (`POST
/login?as=ada`) and logout (`/logout`). The identity comes from a `user` cookie.

The public routes follow the README sections "Strategies", "Query Routes", "Projection and Data
Routes", "Freshness Contracts" and "Datasets". The signed-in routes follow "Principal Datasets" and
"Authenticated Data". Principal datasets are off by default and unreviewed in the tree today, so
the site passes `principalDatasets: true` to `createSpool` and to `defineDataset`. The `profiles`
dataset holds each person and the people who share a course with them. The `fields(viewer, row)`
projection and the `auth: 'principal'` route option are not in the tree, so the site does not use them.

Run the Node runtime:

```sh
cd node
npm install
node server.ts
```

It listens on port 3000.

Run the Worker runtime:

```sh
cd cloudflare-worker
npm install
npx wrangler dev
```

The Worker example does not deploy. Each isolate keeps its version store and pack in memory; the
Durable Object store is not used because the node test project cannot load `cloudflare:workers`.
