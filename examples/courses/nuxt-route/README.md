# Nuxt and Nitro route example

A course page served by a Nitro route. `toWebRequest` turns the h3 event into a Fetch request, and
`spool.handle` answers spool's paths and renders the pages. The site is defined in `../shared/site.ts`.

`server/routes/[...].ts` re-exports the handler from this file, so every path reaches it. The handler builds the
site on the first request, because Nitro's server build does not allow top-level await. `examples/courses/nuxt-middleware` is
the server middleware, which must share the store with this route. This example keeps its own
memory store, so the two do not share state.

Run it:

```sh
npm install
npx nuxi dev
```
