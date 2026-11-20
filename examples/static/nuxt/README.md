# Static Nuxt Example

A Nuxt 4 app that serves a small status page. `nuxt build` writes the client assets to
`.output/public`, and the Nitro server in `.output/server` answers the documents. The spool module
writes the static tier into `.output/public` during the build, before Nitro lists the public files,
so Nitro serves them as static files. `publish.ts` writes the same files into the project's
`public/` folder by hand, the form a host with no build hook uses.

Nuxt fits the static tier because its build already emits a folder that Nitro serves as files.
The stub, the page runtime and the pack sit beside the client assets. The documents stay on the
Nitro server.

## Why an SSR build, not a prerender

The example does not run `nuxt generate` or a prerender preset. Those write each page as HTML.
The static tier in this lane holds the stub, the runtime, the packs and the headers, and documents
come from the origin. A prerendered page would be a contentful static entry, which is out of scope.
So the documents come from the Nitro server, and only the spool files and the client assets are
static.

## Limits

- The site declares no spool routes. The page runtime answers no navigation, and the Nuxt client
  router handles every click. The static tier here is the stub, the runtime and the pack.
- Nitro lists the public files at build time. A file added to `.output/public` after the build is
  not listed, so the server answers it through the spool handler. The module publishes before Nitro
  lists them; rebuild after each stamp change.
- `policy: {}` in `server/spool.ts` says the site sends no security headers. Without it the build
  logs one line, the stub names no policy, and a device makes one network view that teaches it the
  headers. The readings below were taken with `policy: {}`.
- The module loads `server/spool.ts` in Node at build time, with `#spool/pages` resolved, so the
  spool's stores must be reachable from the build machine.
- The Nuxt module reads a synchronous `Spool` from `server/spool.ts`, which uses top-level await.
  `nuxt.config.ts` sets the Nitro target to `es2022` for that.

## Run

```sh
cd examples/static/nuxt
bun install --force --ignore-scripts
npx nuxt build
node .output/server/index.mjs
```

The server listens on the `PORT` environment variable. The stamp is the `STAMP` constant in
`server/spool.ts`. Raise it and run `nuxt build` again.

## After Publish

`.output/public` holds these files beside the client assets:

| File                       | Contents                            |
| -------------------------- | ----------------------------------- |
| `.spool/1.0.0/client.js`   | the page runtime, immutable         |
| `.spool/1.0.0/navigate.js` | the in-page navigation script       |
| `.spool/1.0.0/boot/0.js`   | the boot script for pack 0          |
| `spool-sw.js`              | the stub, leased for 86400 seconds  |
| `.spool/bundle/0`          | the pack at version 0 (no datasets) |
| `_headers`                 | the cache rules for the files above |

The `_headers` file is served as a file at `/_headers`, like any file in `public/`.

## Results

One Chromium run from `node measure.ts` (L1, one run, not repeated). Nitro serves the spool files and
the server runs the spool handler in one process, so the example cannot count the two tiers itself.
The visit script puts a counting proxy in front of `node .output/server/index.mjs` and calls a
response a file when its path is a file under `.output/public`, which is what Nitro serves first.
The origin column is the Nitro server: the document and anything else that is not a file. The
lease is the default one day, so the table has no view after a lease, and there is no publish phase:
Nitro lists the public files at build time, so a publish needs a rebuild.

| Phase                          | Files in `.output/public` | Nitro server | Bytes   |
| ------------------------------ | ------------------------- | ------------ | ------- |
| first view                     | 8                         | 1            | 208,261 |
| 2 in-app clicks                | 0                         | 0            | 0       |
| view that registers the worker | 2                         | 1            | 177,107 |
| view inside the lease          | 0                         | 1            | 3,366   |
| total                          | 10                        | 3            | 388,734 |

The stub and the runtime came from the files in the registration view, and the document from the
server in every view that loads a page. Bytes are before compression. The smoke run checks the stub,
the runtime and the pack: the served stub equals the published file and `spool.stub()` for the same
stamp. The file-first order was checked by hand: a swapped file in `.output/public` was served in
place of the stub.
