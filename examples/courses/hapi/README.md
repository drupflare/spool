# hapi example

A course site on hapi. An `onRequest` extension answers spool's paths. The course routes write the page
with `writeResponse` and return `h.abandon`.

The site has a course list at `/courses`, a course page at `/courses/{id}` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`. The site is defined in `../shared/site.ts`.

Run it:

```sh
npm install
node hapi.ts
```

Run directly, hapi picks a free port and prints its address.
