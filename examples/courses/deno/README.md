# Deno example

A course site on Deno. The site is defined in `../shared/site.ts`. The default export has a `fetch` function, which `deno serve` runs. `spool.handle` answers spool's paths and passes every other request to the site.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool passes through unchanged. The `courses` dataset is built into a pack at start, held in memory and served from `/.spool/bundle/1`.

Run it:

```sh
npm install
deno serve deno.ts
```

Deno reads the `@drupflare/spool` package from `package.json`.
