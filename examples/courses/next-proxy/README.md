# Next.js proxy example

The proxy for a Next.js site. It answers `/spool-sw.js` with the worker script and answers spool's
`/.spool/*` paths. Every other request gets `undefined`, so Next.js continues to the route handler. The pack comes from the course site in `../shared/site.ts`.

`proxy.ts` at the project root re-exports `proxy` from this file (Next.js 16; earlier versions call it
`middleware.ts`). `app/` holds a root page so `next dev` starts. Run alone, other paths return 404, because the
course pages come from `examples/courses/next-route`. The two examples pair in a real app and need the same store.

Run it:

```sh
npm install
next dev
```
