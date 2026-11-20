# Node example

A course site served with `node:http`. `toNodeListener` turns the spool handler into a listener. The site is defined in `../shared/site.ts`.

The site has a course list at `/courses`, a course page at `/courses/:id` and a `/ping` route that spool
passes through unchanged. The `courses` dataset is built into a pack at start and served from
`/.spool/bundle/1`. The item page is a family route: the device renders it from the rows it holds.

Run it:

```sh
npm install
node server.ts
```

The server listens on port 3000.
