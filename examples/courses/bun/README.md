# Bun example

A course site on Bun. The site is defined in `../shared/site.ts`. Bun serves the default export, which has a `fetch` function. `spool.handle` answers spool's paths and passes every other request to the site.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool passes through unchanged. The `courses` dataset is built into a pack at start, held in memory and served from `/.spool/bundle/1`.

Run it:

```sh
npm install
bun bun.ts
```

The server listens on port 3000.
