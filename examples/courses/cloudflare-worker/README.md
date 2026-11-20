# Cloudflare Worker example

A course site as a Worker `fetch` export. The site is defined in `../shared/site.ts`. The Worker calls `spool.handle` for each request.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack on each isolate's first request, held in
memory, and served from `/.spool/bundle/1`. A deployed Worker with several isolates builds one pack per
isolate. The build waits for the first request because workerd refuses I/O at global scope.

Run it locally:

```sh
npm install
npx wrangler dev
```

The example does not deploy. `wrangler deploy` needs an account and is not part of the example.
