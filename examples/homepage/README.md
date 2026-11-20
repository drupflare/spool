# Homepage example

A simulated college homepage of about 150 pages from invented data. `shared/site.ts` defines the
site; `node/` serves it through `toNodeListener` and `cloudflare-worker/` as a Worker `fetch`. `nuxt/` and `next/` serve it through Nuxt 4 and Next 16.

What the site shows:

- A projection home page. It holds the latest stories and the next events as row references.
- Freshness per route. News and events are `soft` with a five-minute window. Programs and about
  pages are `hard` with a one-day window.
- One-row updates. `updateEvent` changes one event and republishes the pack. A device that
  holds the events dataset gets a patch with that one row, and the pages that show the event
  read it from that row.

```ts
const site = await homepageSite();
await site.updateEvent('event-01', { title: 'Chapel talk, moved to Main Hall' });
```

The test in `tests/node/examples.spec.ts` makes this call and checks the patch and the pages.
The site follows the README sections "Strategies", "Query Routes", "Projection and Data Routes",
"Freshness Contracts" and "Datasets".

Run the Node runtime:

```sh
cd node
npm install
node server.ts
```

Run the Worker runtime:

```sh
cd cloudflare-worker
npm install
npx wrangler dev
```

The Worker example does not deploy. The home page is answered by the origin until a renderer is
bundled into the worker; see `node/README.md`.
