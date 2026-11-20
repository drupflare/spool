# Static Node Example

Serves the changelog with `node:http`. A small static handler answers files in `public/` first, and
everything else goes to `spool.handle` and the page function. The site comes from `../shared/site`.

Run it:

```sh
cd node
npm install
node publish.ts
node server.ts
```

The server listens on port 5701.

## After Publish

`public/` holds five files for a store at pack version 1:

| File                       | Contents                            |
| -------------------------- | ----------------------------------- |
| `.spool/1.0.0/client.js`   | the page runtime, immutable         |
| `.spool/1.0.0/navigate.js` | the in-page navigation script       |
| `spool-sw.js`              | the stub, leased for 86400 seconds  |
| `.spool/bundle/1`          | the pack at version 1, immutable    |
| `_headers`                 | the cache rules for the files above |

`staticFiles` in `server.ts` reads a file under `public/`, refuses a path outside it, and sends the
headers the `_headers` file names for that path. The file sink keeps no content type, so the handler
infers it from the extension and the `delta` folder.

## Results

The counts for this site on a static tier come from the `static-host` reading, which ran the
changelog on a Worker with an assets folder under `wrangler dev --local`. See
[Static Tier Example](../README.md#results). This example has no reading of its own under
`measurements/`.
