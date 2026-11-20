# Express example

A course site on Express 5. The site is defined in `../shared/site.ts`. `spoolExpress` answers spool's paths and tags HTML pages. Every other
request reaches the application's handler.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`.

Run it:

```sh
npm install
node app.ts
```

The server listens on port 3000.
