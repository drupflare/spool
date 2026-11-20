# Static Vite Vue Example

A Vue single-page app with Vue Router, built by Vite to `dist/`. `vite build` writes the static
tier into `dist/` beside the build, because `spoolVue` publishes by default. `server.ts` is the
origin: it serves the files in `dist/` first, then the spool, then the built `index.html` for every
other path. `publish.ts` runs the same step by hand with `publishStatic`, the form a host with no
build hook uses.

Vite fits the static tier because its build already emits a folder of files. The stub, the page
runtime, the packs and `_headers` sit next to the app's JavaScript and CSS. Every route renders
the same shell, so the origin needs no per-route render.

## Limits

- The app has constant routes only (`/`, `/articles`, `/about`). A route with a parameter needs a
  field in its template, and `createSpool` refuses a text-only shell under a parameter pattern
  (`bad-template`). The [Vue adapter page](../../../docs/adapters/vue.md) explains the same rule.
- Documents come from `server.ts`. The static tier holds the spool files and the app's assets.
- The instance made when `vite.config.ts` loads holds the dev `index.html` as its shell, so the config
  passes `static.spool`, a function that builds the instance from `dist/index.html`.
- `policy: {}` in `server/spool.ts` says the site sends no security headers. Without it the build logs
  one line, the stub names no policy, and a device makes one network view that teaches it the headers.
  The readings below were taken with `policy: {}`.

## Run

```sh
cd examples/static/vite-vue
bun install
npx vite build
node server.ts
```

The server listens on port 5711. The stamp is the `STAMP` constant in `server/spool.ts`. Raise it and
build again, so a device makes a forced check for a new stub. `node publish.ts` after the build writes
the same files by hand and leaves the files already there.

## After Publish

`dist/` holds the build plus these files:

| File                       | Contents                            |
| -------------------------- | ----------------------------------- |
| `.spool/1.0.0/client.js`   | the page runtime, immutable         |
| `.spool/1.0.0/navigate.js` | the in-page navigation script       |
| `.spool/1.0.0/boot/0.js`   | the boot script for pack 0          |
| `spool-sw.js`              | the stub, leased for 86400 seconds  |
| `.spool/bundle/0`          | the pack at version 0 (no datasets) |
| `_headers`                 | the cache rules for the files above |

The site declares no datasets, so the pack is empty.

## Results

One Chromium run per arm, from `node measure.ts` (L1, default 20-second lease). The 20-second table
was measured again on 2026-11-19 on a rebuilt library. Its counts match the two earlier runs; the
bytes rose by up to 330 B. Each cell is the requests that reached the origin, then the bytes before
compression. `static` is a file from `dist/`, `spool` is `spool.handle` without the page, `page` is
the shell. The phases run in order, and the lease waits sit between them.

| Phase                          | Spool, files from disk          | Spool, spool paths from the handler | No spool                        |
| ------------------------------ | ------------------------------- | ----------------------------------- | ------------------------------- |
| first view                     | 2: static 1, page 1 (152,903 B) | 2: static 1, page 1 (152,903 B)     | 2: static 1, page 1 (150,958 B) |
| 6 in-app clicks                | 0                               | 0                                   | 0                               |
| view that registers the worker | 3: static 2, page 1 (177,813 B) | 3: spool 2, page 1 (178,020 B)      | 1: page 1 (313 B)               |
| view inside the lease          | 2: spool 1, page 1 (2,363 B)    | 2: spool 1, page 1 (2,363 B)        | 1: page 1 (313 B)               |
| view after the lease           | 0                               | 1: spool 1 (138,287 B)              | 1: page 1 (313 B)               |
| publish, then the next contact | 0                               | 1: spool 1 (138,287 B)              | 1: page 1 (313 B)               |
| total                          | 7: static 3, spool 1, page 3    | 9: static 1, spool 5, page 3        | 6: static 1, page 5             |

The in-app clicks reach no tier in any arm, because Vue Router answers them. The static arm made no
request in the view after the lease or in the view after the publish. The handler arm fetched the stub
in both views. The stub's `max-age=86400` in `_headers` is the obvious difference, but the node
example's static arm, which uses the same header rule, did fetch its stub once after its lease (see
the node example's short-lease table). The mechanism is not established.

Bytes: static arm 333,079 B, handler arm 609,860 B, no-spool arm 152,210 B. The app bundle is about
150 KB and is the largest cost in every arm.

### Short lease (5 s) and a control

Run: `node measure.ts --lease 5 --arms static,handler`, then the same with `--control` (L1, one run
per row set, Chromium). The lease is 5 seconds, so the run crosses it. The stamp advances at each
publish in the first run. The control advances nothing: no stamp, no publish, so the stub's bytes
stay the same. The rows show requests per phase by tier, as above.

| Phase                          | Static, with stamp  | Handler, with stamp | Static, control     | Handler, control    |
| ------------------------------ | ------------------- | ------------------- | ------------------- | ------------------- |
| first view                     | 2: static 1, page 1 | 2: static 1, page 1 | 2: static 1, page 1 | 2: static 1, page 1 |
| 6 in-app clicks                | 0                   | 0                   | 0                   | 0                   |
| view that registers the worker | 3: static 2, page 1 | 3: spool 2, page 1  | 3: static 2, page 1 | 3: spool 2, page 1  |
| view inside the lease          | 2: spool 1, page 1  | 2: spool 1, page 1  | 2: spool 1, page 1  | 2: spool 1, page 1  |
| view after the lease           | 0                   | 1: spool 1 (stub)   | 0                   | 1: spool 1 (stub)   |
| publish, then the next contact | 0                   | 1: spool 1 (stub)   | 0                   | 1: spool 1 (stub)   |

The stub's bytes were 138,038 in each handler row after the lease. A stamp change alters the stub's
content, not its length, so the byte counts cannot show it; the request count is the figure that
matters here. Without a stamp, the static arm made no stub request after the lease, and the handler
arm made one. The control matches the stamp run row for row, so in these arms the lease, not the
stamp, decides whether a request is made.
