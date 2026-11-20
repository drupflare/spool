# itty-router example

A course site on itty-router. The site is defined in `../shared/site.ts`. A handler that returns `undefined` passes the request to the next one. `spool.respond` returns `undefined` for every path that is not spool's, so the site's own routes run after it.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool passes through unchanged. The `courses` dataset is built into a pack at start, held in memory and served from `/.spool/bundle/1`.

Run it on Bun, which serves the default export on port 3000:

```sh
npm install
bun itty-router.ts
```
