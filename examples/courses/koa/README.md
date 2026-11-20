# Koa example

A course site on Koa 3. The first middleware answers spool's paths. The second sets `ctx.respond` to
`false` before it writes a course page, so Koa does not write a second response.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`. The site is defined in `../shared/site.ts`.

Run it:

```sh
npm install
node koa.ts
```

The server listens on port 3000.
