# Blog Node Example

Serves the blog with `node:http` through `toNodeListener`. The site comes from `../shared/site`.

Run it:

```sh
cd node
npm install
node server.ts
```

It listens on port 3000. The store and the pack live in memory, so a restart rebuilds them from
the generated posts.
