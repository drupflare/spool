# Hono example

A course site on Hono. The site is defined in `../shared/site.ts`. `spoolHono` is a `*` middleware that answers spool's paths and tags HTML pages.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`.

Run it on Bun, which serves the default export on port 3000:

```sh
npm install
bun app.ts
```
