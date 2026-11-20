# Cloudflare Workers

Bind the Durable Object that holds the version vector, then pass its namespace to
`durableObjectStore`. The class is exported from the Worker's entry module, so the runtime can
construct it. The Worker's `fetch` handler stays a plain function that calls `spool.handle`.

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "SPOOL_VERSIONS", "class_name": "SpoolVersions" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SpoolVersions"] }]
}
```

```ts
import { createSpool } from '@drupflare/spool/server';
import { durableObjectStore } from '@drupflare/spool/stores/durable-object';
import { page, routes } from './routes';

export { SpoolVersions } from '@drupflare/spool/stores/durable-object';

export default {
  fetch(request: Request, env: Cloudflare.Env) {
    const spool = createSpool({ routes, store: durableObjectStore(env.SPOOL_VERSIONS) });
    return spool.handle(request, page);
  }
};
```

## Live Stream

A signed-in page can hold one stream that renews its lease and carries `revoked`. A Worker needs a
hub every isolate can reach, so bind the `SpoolLive` Durable Object and pass its namespace to
`durableObjectHub`. Add the class to the migration list and export it from the entry module.

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "SPOOL_VERSIONS", "class_name": "SpoolVersions" },
      { "name": "SPOOL_LIVE", "class_name": "SpoolLive" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SpoolVersions", "SpoolLive"] }]
}
```

```ts
import { createSpool } from '@drupflare/spool/server';
import { durableObjectHub, durableObjectStore } from '@drupflare/spool/stores/durable-object';
import { identity, page, routes } from './routes';

export { SpoolLive, SpoolVersions } from '@drupflare/spool/stores/durable-object';

export default {
  fetch(request: Request, env: Cloudflare.Env) {
    const spool = createSpool({
      routes,
      identity,
      store: durableObjectStore(env.SPOOL_VERSIONS),
      live: { hub: durableObjectHub(env.SPOOL_LIVE, { hibernate: true }) }
    });
    return spool.handle(request, page);
  }
};
```

`durableObjectHub(env.SPOOL_LIVE)` holds each stream as a Server-Sent Events response. The object
stays in memory, and is billed for duration, while any stream is open. With `{ hibernate: true }`
the same `/.spool/live` path also accepts a WebSocket upgrade, and the site's config tells pages to
open one. A page whose upgrade fails opens the stream as SSE instead. The sockets hold no timer: a
page sends `ping` every 25 seconds and the runtime answers it with a `lease` frame without waking the
object, so an idle object can hibernate. The object wakes for a connect, a version bump, a
`spool.revoke` and one alarm for `live.maxAge`. `docs/economics.md` has the request and duration
figures for both transports; at 5, 100 and 2,000 sessions a day neither passes the included
allowances.

The hub cannot call back into your app. Call `spool.revoke(principal)` when a session ends, and
`live.maxAge` cuts off one you forgot. A deploy that replaces the object closes its sockets and the
page connects again after three seconds. The opening frames travel in one request header, so a page
that holds a cursor far behind the server's gets a `413` on its first socket attempt and opens SSE,
which catches it up.

## Example Project

`examples/courses/cloudflare-worker/` runs this shape. Run `npx wrangler dev` in that folder.
The campus and dashboard examples also have Worker folders (`examples/campus/cloudflare-worker/`,
`examples/dashboard/cloudflare-worker/`).
