# NestJS example

A course site on NestJS 12 with the Express adapter. `app.use` takes spool's listener, and a controller
injects `@Req()` and `@Res()` to write the course pages. The example needs `experimentalDecorators`,
which its `tsconfig.json` sets.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`. The site is defined in `../shared/site.ts`.

Run it with tsx. Bun 1.4.4 fails at start on the method decorators, and Node does not compile decorators:

```sh
npm install
npx tsx nest.ts
```

The server listens on port 3000.
