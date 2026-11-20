# Static Tier Example

A changelog site: a list of release entries, one page per entry and an area filter. `shared/site.ts`
holds the data, the routes and two functions for the static tier. `node/` and `cloudflare-worker/`
serve the same site.

## What It Shows

- `publish(sink)` calls `spool.publishStatic(sink)` and advances the stub's stamp. The sink receives
  the page runtime, the stub at `/spool-sw.js`, the pack and a `_headers` file.
- A host that serves those files answers the stub, the runtime and the pack with no handler call.
  The documents still come from the origin.
- `addEntry` builds the next pack. A second `publish` then writes only the stub, the new pack, its
  delta and the headers.

## Publish

```ts
import { fileStaticSink } from '@drupflare/spool/node';
import { staticSite } from './shared/site.ts';

const { publish, addEntry } = await staticSite();
await publish(fileStaticSink('public'));
await addEntry({
  title: 'Added the export command in 2.0',
  area: 'cli',
  date: '2026-01-05',
  body: 'Release 2.0 of the library.'
});
await publish(fileStaticSink('public'));
```

The stamp is a counter the stub carries. Each `publish` advances it, so the stub's bytes change and
the browser's next check after the lease installs the new stub. That install is the contact. Without
the stamp the stub changes only when a pack changes.

The site sets `policy: {}` in `createSpool`. The stub is written before any page is answered, so
`publishStatic` takes the policy from its `policy` option, then from `createSpool`, then from a page
already answered. With none of them the stub carries no `policy` field, and a device makes one network
view to learn the headers. `{}` is the documented setting for a site with no security headers; a real
site names its headers there.

## Runtimes

- [node](node/README.md): `node:http` with a folder of files in front of the spool.
- [cloudflare-worker](cloudflare-worker/README.md): a Worker with an `assets` directory.

## Visit Script

`measure.ts` counts requests by tier for one Chromium visit: a first view, six in-page clicks, a
document view that registers the worker, a view inside the lease, a view after the lease, and a
publish followed by the next contact. Run it from the repo root after `bun run build`:

```sh
bun examples/static/measure.ts --runtime node
bun examples/static/measure.ts --runtime worker
```

The lease is 12 seconds. The script exits non-zero when no stub, runtime or pack request was seen in
the static arm, or when one reached the handler. It is a quick single-run check; the committed
figures come from the reading below.

## Results

The `static-host` reading ran this site on a Worker with an assets folder under
`wrangler dev --local`, one reader per engine and arm: a first view, views 2 and 3, the 121 read
views of the demand reader, five lease periods of 90 seconds with one document view each, and a
publish that adds an entry. A counting Worker kept its own invocation count. Counts are L1 (Linux, one
run per arm and engine); ratios are L2. The files are
[`measurements/static-host/`](../../measurements/static-host), one per engine and arm.

| Arm                    | Worker invocations | In the five lease periods | Asset requests | Asset bytes      |
| ---------------------- | ------------------ | ------------------------- | -------------- | ---------------- |
| Worker only            | 13, 14             | 5, 5                      | 0, 0           | 0, 0             |
| Static files, no stamp | 5, 6               | 0, 0                      | 8, 8           | 345,413; 345,413 |
| Static files, stamped  | 5, 6               | 0, 0                      | 8, 8           | 1,049,058; same  |
| No spool               | 130, 131           | 5, 5                      | 0, 0           | 0, 0             |

Each cell is Chromium, then Firefox. Asset bytes are response bodies before compression.

- The Worker answers the first three documents and, after the publish, the changed document and one
  more spool request. With the stub, runtime and pack in the assets folder those are the only
  invocations (5 in Chromium, 6 in Firefox, whose first view made one extra request). Serving
  them from the Worker adds 8 in each engine: the stub and boot script at view 3, the stub check in
  each of the five lease periods, and the stub after the publish.
- The 121 read views made no request at all in the three spool arms. The no-spool arm made 121.
- Stamping did not change the Worker count against no stamp. It changed the bytes: in the lease
  periods every stub request of the stamped arm returned the new 140,729 B stub, where the unstamped arm sent a
  conditional request and got a 304 with no body.
- Chromium made a stub request in 3 of the 5 periods of the stamped arm and 4 of 5 without a stamp;
  Firefox made one in all 5 periods of both. The periods with no request are in the reading's phase
  rows.
- The stamped arm advanced the stamp before each period, and the Worker reloaded each time under
  `wrangler dev`. Each republish therefore stands in for a deploy of files and Worker together.

The lease is 90 seconds so the reading crosses lease periods without a faked clock; the library
default is 86,400. Local workerd shows which side answered a request. It is not what Cloudflare
bills. The four Chromium arms ran at the same time on one machine; the counts do not depend on timing, but
the lease crossings do.

## Limits

- The documents are not static files. Every page view that is not held still reaches the handler.
- `publishStatic` writes `/.spool/<version>/boot/<pack>.js` for each kept pack, so the second-view
  bootstrap is a file, served from the assets folder in the static arms of the reading above.
- `publishStatic` writes the pack for the store cursor and up to four before it. A device further
  behind asks the handler.
- `public/` is build output. The repo ignores it.
