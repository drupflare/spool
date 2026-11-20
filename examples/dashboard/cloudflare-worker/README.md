# Team task board, Cloudflare Worker

The board as a Worker `fetch` export. `worker.ts` passes every request to `spool.handle`.

Run it:

```sh
npm install
npx wrangler dev
```

The Worker example does not deploy. Each isolate keeps its version store and pack in memory, so a
write moves the version inside that isolate only. The Durable Object store is not used.
