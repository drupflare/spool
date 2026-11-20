# Blog Cloudflare Worker Example

Serves the blog from a Worker `fetch` export. The site comes from `../shared/site`.

Run it:

```sh
cd cloudflare-worker
npm install
npx wrangler dev
```

Each isolate keeps its own store and pack in memory. The example does not deploy and uses no account.
