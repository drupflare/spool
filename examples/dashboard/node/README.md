# Team task board, Node

The board served by `node:http` through `toNodeListener`. `server.ts` passes every request to
`spool.handle` with the site's origin page.

Run it:

```sh
npm install
node server.ts
```

The server listens on port 3000. Try a write:

```sh
curl -X POST 'localhost:3000/login?as=ada' -i
curl -X POST localhost:3000/tasks -H 'content-type: application/json' -H 'cookie: user=ada' \
  -d '{"project":"site","title":"Write the FAQ","due":"2999-12-05","assignee":"bo"}' -i
```

The `-i` flag shows the `Spool-Delta` header on the answer.
