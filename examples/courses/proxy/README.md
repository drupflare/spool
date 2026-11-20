# Proxy example

`spoolProxy` in front of an origin that never loads spool. The origin is a second `node:http` server in
the same file. It serves the pages of the course site in `../shared/site.ts`.

The proxy answers `/.spool/*` and `/spool-sw.js`. A GET with no query string and no cookie or
`Authorization` header is eligible: the proxy decorates the origin's 200 HTML page. A request with a
cookie or an `Authorization` header goes to the origin unchanged.

`PURGE_SECRET` enables `POST /.spool/purge`, which bumps the tags it is given. Without it the endpoint
refuses every call.

Run it:

```sh
npm install
node proxy-node.ts
```

The proxy listens on port 3000. The origin listens on a port the system picks.
