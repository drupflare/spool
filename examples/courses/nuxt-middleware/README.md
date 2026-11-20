# Nuxt and Nitro middleware example

The server middleware for a Nuxt site. It answers `/spool-sw.js` and spool's `/.spool/*` paths and
returns nothing for every other request, so Nitro continues to the route. The pack comes from the course site in `../shared/site.ts`.

`server/middleware/spool.ts` re-exports the middleware from this file. It pairs with `examples/courses/nuxt-route`, which needs the same
store.

Run it:

```sh
npm install
npx nuxi dev
```
