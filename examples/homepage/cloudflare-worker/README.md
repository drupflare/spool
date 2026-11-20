# Homepage Cloudflare Worker example

The same site as `../node`, exported as a Worker `fetch` handler. The site is defined in
`../shared/site.ts`.

The version store and the pack are in memory, so each isolate keeps its own. The Durable Object
store is not used; the node test project cannot load `cloudflare:workers`.

Run it locally:

```sh
npm install
npx wrangler dev
```

The example does not deploy. `wrangler deploy` needs an account and is not part of the example.
