# Next.js route example

A course site served by a Next.js route handler. `GET` answers spool's paths and renders the course
list and course pages. The site is defined in `../shared/site.ts`.

`app/[...path]/route.ts` re-exports `GET` from this file, so `next dev` finds a catch-all route. `next.config.ts`
sets the Turbopack root to the repository root, and `tsconfig.json` maps the `@drupflare/spool` subpaths to
`dist/`, because Turbopack does not resolve the package from `../shared`. The proxy in `examples/courses/next-proxy`
must use the same store as this route, so one store has to be shared in a real app. This example
keeps its own memory store.

Run it:

```sh
npm install
next dev
```
