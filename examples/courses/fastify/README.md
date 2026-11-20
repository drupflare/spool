# Fastify example

A course site on Fastify 5. An `onRequest` hook answers spool's paths before Fastify reads the body, and
`reply.send` takes the Fetch `Response` that spool returns.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`. The site is defined in `../shared/site.ts`.

Run it:

```sh
npm install
node fastify.ts
```

The server listens on port 3000.
