# Elysia example

A course site on Elysia. The site is defined in `../shared/site.ts`. The `onRequest` hook answers spool's paths and returns nothing for the rest. The hook is `async`, because Elysia does not await a promise that a plain function returns.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool passes through unchanged. The `courses` dataset is built into a pack at start, held in memory and served from `/.spool/bundle/1`.

Run it on Bun:

```sh
npm install
bun elysia.ts
```

The server listens on port 3000.
